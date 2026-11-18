/* Writes a published week into the shared Google Spreadsheet, one tab per week ("Week of YYYY-MM-DD").
   Uses the separate "sheets" Google sign-in (src/google.js). Only tabs this app created for a week are ever touched:
   a week's tab is found by its stored sheetId, else by its exact title; anything else in the spreadsheet is left alone. */
const google = require('./google');
const { SHEET_NOTE, parseSpreadsheetId } = require('./logic');

// SRTS_GOOGLE_TEST_BASE points at a local fake Google server; used only by the automated tests.
const TB = process.env.SRTS_DATA_DIR && process.env.SRTS_GOOGLE_TEST_BASE;
const API = TB ? TB + '/sheets/v4' : 'https://sheets.googleapis.com/v4';

class SheetsError extends Error { constructor(msg, code) { super(msg); this.code = code; } }

const sleep = ms => new Promise(r => setTimeout(r, ms));

function explain(status, body) {
  const err = (body && body.error) || {};
  const text = `${err.message || ''} ${JSON.stringify(err.details || '')}`;
  if (status === 401) return new SheetsError('Reconnect Google Sheets.', 'reauth');
  if (status === 403 && /SERVICE_DISABLED|has not been used|is disabled/i.test(text)) return new SheetsError('The Google Sheets API is not turned on in your Google Cloud project. See GOOGLE-SETUP.txt (step: enable the Google Sheets API).', 'api_disabled');
  if (status === 403) { const who = google.status('sheets').account; return new SheetsError(`The connected Google account can’t edit this Sheet. Share it with ${who || 'that account'} as Editor.`, 'forbidden'); }
  if (status === 404) return new SheetsError('Sheet not found. Check the link.', 'notfound');
  if (status === 429) return new SheetsError('Google is busy right now (too many requests). It will be retried.', 'busy');
  if (status >= 500) return new SheetsError('Google Sheets is having trouble right now. It will be retried.', 'busy');
  return new SheetsError(`Google Sheets refused the request (${status}${err.message ? ': ' + err.message : ''}).`, 'api');
}

/** One API call with the Sheets token; retries once on 429 / 5xx. */
async function call(method, pathAndQuery, body) {
  let tok;
  try { tok = await google.accessToken('sheets'); }
  catch (e) {
    if (e.code === 'reauth') throw new SheetsError('Reconnect Google Sheets.', 'reauth');
    if (e.code === 'not_connected') throw new SheetsError('Google Sheets is not connected. Click “Connect Google Sheets”.', 'not_connected');
    if (e.code === 'offline') throw new SheetsError('No internet connection. It will be sent when you are back online.', 'offline');
    throw e;
  }
  for (let attempt = 0; ; attempt++) {
    let res;
    try { res = await fetch(API + pathAndQuery, { method, headers: { Authorization: `Bearer ${tok}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); }
    catch (_) { throw new SheetsError('No internet connection. It will be sent when you are back online.', 'offline'); }
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt === 0) { await sleep(TB ? 60 : 1500); continue; }
    throw explain(res.status, await res.json().catch(() => ({})));
  }
}

const META_FIELDS = 'properties.title,sheets.properties(sheetId,title,index,gridProperties)';
const getMeta = async id => {
  const j = await call('GET', `/spreadsheets/${encodeURIComponent(id)}?fields=${encodeURIComponent(META_FIELDS)}`);
  return { title: (j.properties || {}).title || '', sheets: (j.sheets || []).map(s => s.properties) };
};

/** Connection test: the spreadsheet's title and the connected account. */
async function test(spreadsheetId) {
  if (!spreadsheetId) throw new SheetsError('Paste the Google Sheet link first.', 'no_sheet');
  const m = await getMeta(spreadsheetId);
  return { title: m.title, tabs: m.sheets.length, account: google.status('sheets').account };
}

// ---------- building the batchUpdate ----------
const rgb = h => ({ red: parseInt(h.slice(1, 3), 16) / 255, green: parseInt(h.slice(3, 5), 16) / 255, blue: parseInt(h.slice(5, 7), 16) / 255 });
const FILL = { band: '#d4d4d0', off: '#c4c4c0', pto: '#f1dd9e' };

function cellData(kind, c, first) {
  const fmt = { horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE', textFormat: { bold: !['note', 'dates'].includes(kind), fontSize: kind === 'title' ? 18 : 10 } };
  if (FILL[c.style]) fmt.backgroundColor = rgb(FILL[c.style]);
  if (typeof c.v === 'number') fmt.numberFormat = { type: 'NUMBER', pattern: '0.0' };
  const out = { userEnteredFormat: fmt };
  // stringValue is stored literally (never parsed), so "8-5" stays text and is not turned into a date or a formula
  if (typeof c.v === 'number') out.userEnteredValue = { numberValue: c.v };
  else if (c.v !== '') out.userEnteredValue = { stringValue: String(c.v) };
  if (first) out.note = SHEET_NOTE;
  return out;
}

/** The requests that clear a tab completely and rewrite it from the model. */
function rewriteRequests(sheet, model) {
  const id = sheet.sheetId, cols = model.cols, n = model.rows.length;
  const g = sheet.gridProperties || {};
  const black = { red: 0, green: 0, blue: 0 }, line = { style: 'SOLID', width: 1, color: black };
  return [
    { unmergeCells: { range: { sheetId: id } } },
    { updateCells: { range: { sheetId: id }, fields: 'userEnteredValue,userEnteredFormat,note' } },     // clears values, formatting and notes
    { updateSheetProperties: { properties: { sheetId: id, gridProperties: { rowCount: Math.max(g.rowCount || 0, n + 2), columnCount: Math.max(g.columnCount || 0, cols), frozenRowCount: model.frozenRows } }, fields: 'gridProperties(rowCount,columnCount,frozenRowCount)' } },
    { updateDimensionProperties: { range: { sheetId: id, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 150 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId: id, dimension: 'COLUMNS', startIndex: 1, endIndex: cols - 1 }, properties: { pixelSize: 115 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId: id, dimension: 'COLUMNS', startIndex: cols - 1, endIndex: cols }, properties: { pixelSize: 70 }, fields: 'pixelSize' } },
    ...[0, 1, 2].map(r => ({ mergeCells: { range: { sheetId: id, startRowIndex: r, endRowIndex: r + 1, startColumnIndex: 0, endColumnIndex: cols }, mergeType: 'MERGE_ALL' } })),
    { updateCells: { start: { sheetId: id, rowIndex: 0, columnIndex: 0 }, fields: 'userEnteredValue,userEnteredFormat,note', rows: model.rows.map((r, ri) => ({ values: r.cells.map((c, ci) => cellData(r.kind, c, ri === 0 && ci === 0)) })) } },
    { updateBorders: { range: { sheetId: id, startRowIndex: model.frozenRows - 2, endRowIndex: n, startColumnIndex: 0, endColumnIndex: cols }, top: line, bottom: line, left: line, right: line, innerHorizontal: line, innerVertical: line } },
  ];
}

/**
 * Writes the week into the spreadsheet. prior = {sheetId} remembered from the last send (may be absent).
 * Returns {sheetId, title, sentAt, created}. Safe to call again: the same tab is overwritten, never duplicated.
 */
async function sendWeek({ spreadsheetId, model, prior }) {
  if (!spreadsheetId) throw new SheetsError('Paste the Google Sheet link first.', 'no_sheet');
  const id = encodeURIComponent(spreadsheetId);
  const meta = await getMeta(spreadsheetId);
  let sheet = (prior && prior.sheetId != null && meta.sheets.find(s => s.sheetId === prior.sheetId)) || meta.sheets.find(s => s.title === model.title) || null;
  let created = false;
  if (!sheet) {
    const r = await call('POST', `/spreadsheets/${id}:batchUpdate`, { requests: [{ addSheet: { properties: { title: model.title, index: 0, gridProperties: { rowCount: model.rows.length + 2, columnCount: model.cols, frozenRowCount: model.frozenRows } } } }] });   // rows only: Sheets refuses to freeze a column that cuts through the merged title cells
    sheet = r.replies[0].addSheet.properties; created = true;
  }
  await call('POST', `/spreadsheets/${id}:batchUpdate`, { requests: rewriteRequests(sheet, model) });
  return { sheetId: sheet.sheetId, title: sheet.title, sentAt: new Date().toISOString(), created };
}

module.exports = { parseSpreadsheetId, test, sendWeek, SheetsError, rewriteRequests };
