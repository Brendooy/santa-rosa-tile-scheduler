/* End-to-end test: drives the real app (dev Electron, or the packaged exe via SRTS_EXE) with Playwright.
   Google is replaced by a local fake server (SRTS_GOOGLE_TEST_BASE) so the full OAuth + refresh path runs without credentials. */
const { _electron: electron } = require('playwright-core');
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const EXE = process.env.SRTS_EXE || require('electron');
const ARGS = process.env.SRTS_EXE ? [] : [ROOT];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'srts-e2e-'));
const SHOTS = path.join(__dirname, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
let step = 0, failed = 0;
const ok = (name) => console.log(`  ok  ${++step}. ${name}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- fake Google ----------
let googleDown = false;
// Fake Google Sheets API. It enforces two real Sheets rules so the app's requests are checked: you cannot freeze a column that cuts through
// merged cells, and you cannot write outside the tab's grid.
const SS_ID = 'FAKESPREADSHEETID1234567890';
let sheetsMode = null;                      // null | '429once' | '503' | '403' | '401'
let served429 = 0, nextSheetId = 100;
const ss = { title: 'Staff Schedules', tabs: [] };
const manualTab = { properties: { sheetId: 7, title: 'My own notes', index: 0, gridProperties: { rowCount: 50, columnCount: 6 } }, cells: { '0,0': { v: 'hands off' } }, merges: [] };
ss.tabs.push(manualTab);
const tabByTitle = t => ss.tabs.find(x => x.properties.title === t);
const cellsOf = t => JSON.stringify(t.cells);
const cv = (t, r, c) => (t.cells[`${r},${c}`] || {}).v;
const fakeJwt = email => ['x', Buffer.from(JSON.stringify({ email })).toString('base64'), 'y'].join('.');
function sheetsApi(req, res, u, body) {
  const json = (o, c = 200) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.headers.authorization !== 'Bearer sheets-access' || sheetsMode === '401') return json({ error: { code: 401, message: 'Invalid credentials' } }, 401);
  if (sheetsMode === '403') return json({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } }, 403);
  if (sheetsMode === '503') return json({ error: { code: 503, message: 'unavailable' } }, 503);
  if (sheetsMode === '429once') { sheetsMode = null; served429++; return json({ error: { code: 429, message: 'quota' } }, 429); }
  const m = /^\/sheets\/v4\/spreadsheets\/([^/:]+)(:batchUpdate)?$/.exec(u.pathname);
  if (!m || decodeURIComponent(m[1]) !== SS_ID) return json({ error: { code: 404, message: 'Requested entity was not found.' } }, 404);
  if (req.method === 'GET') return json({ properties: { title: ss.title }, sheets: ss.tabs.map(t => ({ properties: t.properties })) });
  const reqs = JSON.parse(body).requests, replies = [];
  const tabOf = id => { const t = ss.tabs.find(x => x.properties.sheetId === id); if (!t) throw Object.assign(new Error('No grid with id: ' + id), { status: 400 }); return t; };
  try {
    for (const r of reqs) {
      if (r.addSheet) {
        const pr = { ...r.addSheet.properties, sheetId: nextSheetId++ };
        if (ss.tabs.some(t => t.properties.title === pr.title)) throw Object.assign(new Error('A sheet with the name "' + pr.title + '" already exists.'), { status: 400 });
        ss.tabs.forEach(t => t.properties.index++); pr.index = 0; ss.tabs.unshift({ properties: pr, cells: {}, merges: [] }); replies.push({ addSheet: { properties: pr } });
      } else if (r.unmergeCells) { tabOf(r.unmergeCells.range.sheetId).merges = []; replies.push({}); }
      else if (r.updateCells && !r.updateCells.start) { const t = tabOf(r.updateCells.range.sheetId); t.cells = {}; replies.push({}); }
      else if (r.updateSheetProperties) {
        const t = tabOf(r.updateSheetProperties.properties.sheetId), g = r.updateSheetProperties.properties.gridProperties;
        if (g.frozenColumnCount && t.merges.length) throw Object.assign(new Error('You can\'t freeze columns which contain merged cells.'), { status: 400 });
        Object.assign(t.properties.gridProperties, g); replies.push({});
      } else if (r.mergeCells) { tabOf(r.mergeCells.range.sheetId).merges.push(r.mergeCells.range); replies.push({}); }
      else if (r.updateCells) {
        const t = tabOf(r.updateCells.start.sheetId); const g = t.properties.gridProperties;
        r.updateCells.rows.forEach((row, ri) => {
          if (ri >= g.rowCount) throw Object.assign(new Error('Range exceeds grid limits.'), { status: 400 });
          row.values.forEach((c, ci) => {
            const v = c.userEnteredValue ? (c.userEnteredValue.stringValue !== undefined ? c.userEnteredValue.stringValue : c.userEnteredValue.numberValue) : undefined;
            if (v !== undefined || c.note || c.userEnteredFormat) t.cells[`${ri},${ci}`] = { v, note: c.note, bg: c.userEnteredFormat && c.userEnteredFormat.backgroundColor };
          });
        });
        replies.push({});
      } else if (r.updateDimensionProperties || r.updateBorders) replies.push({});
      else throw Object.assign(new Error('unsupported request ' + Object.keys(r)[0]), { status: 400 });
    }
  } catch (e) { return json({ error: { code: e.status || 400, message: e.message } }, e.status || 400); }
  json({ replies });
}
const fake = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const json = (o, c = 200) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (googleDown) { res.writeHead(500); return res.end('down'); }
  if (u.pathname === '/auth') {
    const r = new URL(u.searchParams.get('redirect_uri')); const scope = u.searchParams.get('scope');
    // the calendar sign-in must stay read-only and never ask for Sheets; the Sheets sign-in asks for the spreadsheets scope (plus openid/email to show the account)
    const sheets = /spreadsheets/.test(scope);
    assert.strictEqual(scope, sheets ? 'openid email https://www.googleapis.com/auth/spreadsheets' : 'https://www.googleapis.com/auth/calendar.readonly');
    r.searchParams.set('code', sheets ? 'code-sheets' : 'code123'); r.searchParams.set('state', u.searchParams.get('state')); assert(u.searchParams.get('code_challenge')); res.writeHead(302, { Location: r.href }); return res.end();
  }
  if (u.pathname === '/token') { let b = ''; req.on('data', d => b += d); req.on('end', () => { const p = new URLSearchParams(b); if (p.get('grant_type') === 'authorization_code') assert(p.get('code_verifier'));
    const sheets = p.get('code') === 'code-sheets' || p.get('refresh_token') === 'sheets-refresh-token-xyz';
    if (sheets) return json({ access_token: 'sheets-access', refresh_token: 'sheets-refresh-token-xyz', expires_in: 3600, id_token: fakeJwt('sheets-user@example.com') });
    json({ access_token: 'access-abc', refresh_token: 'refresh-token-xyz', expires_in: 3600 }); }); return; }
  if (u.pathname === '/revoke') { res.writeHead(200); return res.end(); }
  if (u.pathname.startsWith('/sheets/v4/')) { let b = ''; req.on('data', d => b += d); req.on('end', () => sheetsApi(req, res, u, b)); return; }
  if (req.headers.authorization !== 'Bearer access-abc') return json({ error: 'unauth' }, 401);
  if (u.pathname === '/calendar/v3/calendars/primary') return json({ id: 'manager@example.com' });
  if (u.pathname === '/calendar/v3/users/me/calendarList') return json({ items: [{ id: 'manager@example.com', summary: 'Manager', primary: true }, { id: 'timeoff@example.com', summary: 'Staff Time Off' }] });
  if (u.pathname.startsWith('/calendar/v3/calendars/') && u.pathname.endsWith('/events')) return json({ items: [
    { id: 'ev1', summary: 'Brendan - PTO', start: { date: '2026-10-28' }, end: { date: '2026-10-30' } },
    { id: 'ev2', summary: 'Haley dentist', start: { dateTime: '2026-10-27T09:00:00-07:00' }, end: { dateTime: '2026-10-27T10:00:00-07:00' } },
    { id: 'ev5', summary: 'Store closed', start: { date: '2026-11-03' }, end: { date: '2026-11-04' } },
    { id: 'ev4', summary: 'Brendan Works', start: { date: '2026-10-31' }, end: { date: '2026-11-01' } },
    { id: 'ev3', summary: 'Staff party', start: { date: '2026-12-18' }, end: { date: '2026-12-19' } },
  ] });
  json({ error: 'nf' }, 404);
});

async function launch(dataDir, extraEnv = {}) {
  const app = await electron.launch({ executablePath: EXE, args: ARGS, env: { ...process.env, ...(process.env.SRTS_CLEAN_PATH ? { PATH: String.raw`C:\Windows\System32;C:\Windows` } : {}), SRTS_DATA_DIR: dataDir, SRTS_TODAY: '2026-10-26', SRTS_GOOGLE_TEST_BASE: `http://127.0.0.1:${fake.address().port}`, ...extraEnv } });
  const page = await app.firstWindow();
  await page.waitForSelector('#view .sheet, #view .card');
  return { app, page };
}
const saved = page => page.waitForFunction(() => /All changes saved/.test(document.querySelector('#saveState').textContent), null, { timeout: 8000 });
const tab = (page, name) => page.click(`#tabs button[data-tab="${name}"]`);
const cell = (page, n, d) => page.getByLabel(`${n} ${d}`, { exact: true });
const shot = (page, n) => page.screenshot({ path: path.join(SHOTS, n + '.png') });
async function setCell(page, n, d, v) { const c = cell(page, n, d); await c.fill(v); await c.press('Tab'); await page.waitForTimeout(80); }
const dlg = async (page, btn) => { await page.waitForSelector('#modalRoot .dlg'); const t = await page.textContent('#modalRoot .dlg'); if (btn) await page.click(`#modalRoot .acts button:has-text("${btn}")`); return t; };

(async () => {
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const A = path.join(TMP, 'A'), B = path.join(TMP, 'B'), exportFile = path.join(TMP, 'move-me.srts.json'), pdfFile = path.join(TMP, 'week.pdf');
  console.log('Using', process.env.SRTS_EXE || 'dev electron', '\nData:', TMP);

  // ===== 1. first launch, sample data, clean schedule
  let { app, page } = await launch(A);
  assert.strictEqual(await page.title(), 'Santa Rosa Tile Scheduler');
  assert.match(await page.textContent('.sheet h1'), /SANTA ROSA TILE SUPPLY SCHEDULE/);
  assert.strictEqual(await cell(page, 'Buddy', 'Monday').inputValue(), '7:30');
  assert.strictEqual(await cell(page, 'Brendan', 'Monday').inputValue(), 'OFF');
  assert.match(await page.textContent('.issues'), /No problems/);
  assert.match(await page.textContent('.range'), /26 October – 31 October 2026/);
  await shot(page, '01-schedule'); ok('first launch shows the photographed week with no problems');

  // ===== 2. edit + autosave + persistence
  await setCell(page, 'Denis', 'Monday', '9-5'); await saved(page);
  assert.match(await page.textContent('#saveState'), /All changes saved/);
  ok('edit autosaves and shows "saved"');
  await app.close();
  ({ app, page } = await launch(A));
  assert.strictEqual(await cell(page, 'Denis', 'Monday').inputValue(), '9-5');
  ok('data survives close and reopen');

  // ===== 3. validation: bad entries
  await setCell(page, 'Sandee', 'Saturday', '8-3');
  assert.match(await page.textContent('.issues'), /Sandee Saturday: not available/);
  await setCell(page, 'Sandee', 'Saturday', 'OFF');
  await setCell(page, 'Freya', 'Tuesday', 'banana');
  assert.match(await page.textContent('.issues'), /not a valid entry/);
  await setCell(page, 'Freya', 'Tuesday', '8:30-5');
  assert.match(await page.textContent('.issues'), /No problems/);
  ok('availability + invalid-entry checks work and clear when fixed');

  // ===== 4. offline scheduling features: auto-fill next week, publish rules, print/PDF
  await page.click('[data-act="week-next"]');
  assert.match(await page.textContent('.pill'), /DRAFT/);
  await page.click('[data-act="publish"]');                      // empty week: allowed only after the user confirms they understand
  assert.match(await dlg(page), /Publish with problems\?[\s\S]*I understand/);
  assert.strictEqual(await page.isDisabled('#modalRoot .acts button:has-text("Publish anyway")'), true);
  await page.check('#modalRoot .gate');
  assert.strictEqual(await page.isDisabled('#modalRoot .acts button:has-text("Publish anyway")'), false);
  await page.click('#modalRoot .acts button:has-text("Cancel")');
  assert.match(await page.textContent('.pill'), /DRAFT/);
  await page.click('[data-act="publish"]'); await dlg(page); await page.check('#modalRoot .gate'); await page.click('#modalRoot .acts button:has-text("Publish anyway")');
  assert.match(await page.textContent('.pill'), /FINAL/); assert.match(await page.textContent('.pubinfo, #view'), /unresolved problem/);
  await page.click('[data-act="reopen"]'); await dlg(page, 'Reopen');
  assert.match(await page.textContent('.pill'), /DRAFT/);
  await page.click('[data-act="autofill"]');
  const t = await page.waitForSelector('#modalRoot .dlg, #toast.show', { timeout: 5000 }); if (await page.$('#modalRoot .dlg')) { await dlg(page, 'OK'); }
  assert.notStrictEqual(await cell(page, 'Buddy', 'Tuesday').inputValue(), '');
  await shot(page, '02-autofilled');
  const errs = await page.$$eval('.issues .card:first-child li', l => l.length);
  assert.strictEqual(errs, 0, 'auto-filled week should have no errors');
  await page.click('[data-act="publish"]'); await dlg(page, 'Publish');
  assert.match(await page.textContent('.pill'), /FINAL/);
  assert.strictEqual(await cell(page, 'Buddy', 'Tuesday').getAttribute('readonly'), '');
  await shot(page, '03-final');
  ok('auto-fill produces a valid week; publishing with problems needs an "I understand" tick, a clean week publishes directly, final week locks');
  process.env.SRTS_TEST_PATHS = JSON.stringify([pdfFile]);
  await app.close();
  ({ app, page } = await launch(A, { SRTS_TEST_PATHS: JSON.stringify([pdfFile]) }));
  await page.click('[data-act="week-next"]');
  assert.match(await page.textContent('.pill'), /FINAL/);
  ok('final status persisted');
  await page.click('[data-act="pdf"]');
  await page.waitForSelector('#toast.show');
  assert.ok(fs.existsSync(pdfFile) && fs.statSync(pdfFile).size > 5000 && fs.readFileSync(pdfFile).slice(0, 4).toString() === '%PDF');
  ok(`PDF export wrote a real PDF (${fs.statSync(pdfFile).size} bytes)`);

  // ===== 5. manual PTO conflicts with scheduled shift
  await page.click('[data-act="week-prev"]');
  await tab(page, 'pto');
  await page.selectOption('#pEmp', { label: 'Denis' }); await page.fill('#pFrom', '2026-10-27'); await page.fill('#pTo', '2026-10-27');
  await page.click('[data-act="add-pto"]'); await saved(page);
  await tab(page, 'schedule');
  assert.match(await page.textContent('.issues'), /Denis Tuesday: scheduled but has PTO|Denis Tuesday.*PTO/);
  ok('manual PTO is applied to the checks');
  await page.click('[data-act="week-next"]'); // keep week index sane
  await page.click('[data-act="week-prev"]');

  // ===== 6. Google: setup, connect (fake), choose calendar, refresh
  await tab(page, 'pto');
  if (await page.$('#gClientId')) {            // no google-client.json bundled: paste path
    await page.fill('#gClientId', 'fake-client.apps.googleusercontent.com'); await page.fill('#gClientSecret', 'fake-secret-123');
    await page.click('[data-act="g-saveclient"]');
  }
  await page.waitForSelector('[data-act="g-connect"]');
  await page.click('[data-act="g-connect"]');
  await page.waitForSelector('[data-act="g-refresh"]', { timeout: 15000 });
  assert.match(await page.textContent('#view'), /Connected as manager@example.com/);
  await page.waitForSelector('[data-cal]');
  await page.check('[data-cal="timeoff@example.com"]'); await page.uncheck('[data-cal="manager@example.com"]');
  await page.click('[data-act="g-refresh"]');
  await page.waitForFunction(() => /Last result/.test(document.querySelector('#view').textContent), null, { timeout: 10000 });
  const txt = await page.textContent('#view');
  assert.match(txt, /Brendan[\s\S]*2026-10-28[\s\S]*2026-10-29[\s\S]*Google Calendar/);
  assert.match(txt, /Staff party/); assert.match(txt, /1 timed event\(s\) ignored/);
  await shot(page, '04-google'); ok('Google connect + calendar choice + PTO refresh (fake Google); unmatched/timed events reported');
  await tab(page, 'schedule');
  assert.match(await page.textContent('.issues'), /Brendan Wednesday: scheduled but has PTO/);
  assert.doesNotMatch(await page.textContent('.issues'), /Brendan Saturday/);   // "Brendan Works" is not a problem
  await tab(page, 'pto'); assert.match(await page.textContent('#view'), /Brendan[\s\S]{0,40}Works[\s\S]{0,40}2026-10-31/); assert.match(await page.textContent('#view'), /Whole store[\s\S]{0,40}Store closed[\s\S]{0,40}2026-11-03/); await tab(page, 'schedule');
  ok('Google PTO feeds the schedule checks');

  // ===== 7. refresh failure keeps existing PTO and flags it
  googleDown = true;
  await tab(page, 'pto'); await page.click('[data-act="g-refresh"]');
  await page.waitForSelector('#banner .err', { timeout: 10000 });
  assert.match(await page.textContent('#banner'), /could not be refreshed/);
  assert.match(await page.textContent('#view'), /Brendan[\s\S]*2026-10-28/);
  await shot(page, '05-google-failed'); ok('failed refresh is flagged and existing PTO is preserved');
  googleDown = false;
  await page.click('[data-act="g-refresh"]');
  await page.waitForFunction(() => !document.querySelector('#banner .err'), null, { timeout: 10000 });
  ok('later successful refresh clears the failure flag');
  await saved(page);

  // ===== 7b. Google Sheets: connect, link, test, send on publish, overwrite, second week, failures, retry
  await tab(page, 'pto');
  assert.ok(await page.$('[data-act="sh-connect"]'));
  await page.click('[data-act="sh-connect"]');
  await page.waitForFunction(() => /Connected as\s*sheets-user@example.com/.test(document.querySelector('#view').textContent), null, { timeout: 15000 });
  assert.match(await page.textContent('#view'), /Connected as manager@example.com/);           // the calendar sign-in is untouched
  assert.match(await page.textContent('#view'), /view and edit your Google Sheets/);           // the permission is explained in plain words
  ok('Connect Google Sheets is a separate sign-in (calendar sign-in unchanged; calendar scope stayed read-only)');
  await page.fill('input[data-sh="url"]', `https://docs.google.com/spreadsheets/d/${SS_ID}/edit#gid=0`); await page.press('input[data-sh="url"]', 'Tab'); await saved(page);
  assert.ok(await page.isChecked('input[data-sh="sendOnPublish"]'));
  await page.click('[data-act="sh-test"]');
  await page.waitForFunction(() => /Staff Schedules/.test((document.querySelector('#shTestText') || {}).textContent || ''), null, { timeout: 8000 });
  assert.match(await page.textContent('#shTestText'), /sheets-user@example.com/);
  sheetsMode = '403'; await page.click('[data-act="sh-test"]');
  await page.waitForFunction(() => /Share it with sheets-user@example.com as Editor/.test((document.querySelector('#shTestText') || {}).textContent || ''));
  sheetsMode = null; await page.fill('input[data-sh="url"]', 'https://docs.google.com/spreadsheets/d/SOMEOTHERSHEETID123456789/edit'); await page.press('input[data-sh="url"]', 'Tab');
  await page.click('[data-act="sh-test"]'); await page.waitForFunction(() => /Sheet not found. Check the link./.test((document.querySelector('#shTestText') || {}).textContent || ''));
  sheetsMode = '401'; await page.fill('input[data-sh="url"]', SS_ID); await page.press('input[data-sh="url"]', 'Tab'); await page.click('[data-act="sh-test"]');
  await page.waitForFunction(() => /Reconnect Google Sheets\./.test((document.querySelector('#shTestText') || {}).textContent || ''));
  assert.ok(await page.$('button[data-act="sh-connect"]:has-text("Reconnect Google Sheets")'));
  sheetsMode = null; await page.click('[data-act="sh-connect"]'); await page.waitForFunction(() => !document.querySelector('button[data-act="sh-connect"]'), null, { timeout: 15000 });
  await page.click('[data-act="sh-test"]'); await page.waitForFunction(() => /Staff Schedules/.test((document.querySelector('#shTestText') || {}).textContent || ''));
  ok('link is parsed from the URL; Test connection shows the title + account; 403 / 404 / 401 give the friendly messages; Reconnect works');

  // publish a week -> it appears as a new tab
  await tab(page, 'schedule');
  assert.match(await page.textContent('.range'), /26 October/);
  await page.click('[data-act="publish"]'); await dlg(page); await page.check('#modalRoot .gate'); await page.click('#modalRoot .acts button:has-text("Publish anyway")');
  await page.waitForFunction(() => /Sent to Google Sheet/.test(document.querySelector('.toolbar, #view').textContent), null, { timeout: 10000 });
  assert.match(await page.textContent('.pill'), /FINAL/);
  const wk1 = tabByTitle('Week of 2026-10-26'); assert.ok(wk1, 'tab for the published week exists');
  assert.strictEqual(wk1.properties.index, 0); assert.strictEqual(ss.tabs.length, 2);
  assert.strictEqual(cv(wk1, 0, 0), 'SANTA ROSA TILE SUPPLY SCHEDULE'); assert.match(cv(wk1, 2, 0), /^FINAL – published/);
  assert.deepStrictEqual([0, 1, 2, 3, 4, 5, 6, 7].map(c => cv(wk1, 3, c) || ''), ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Hrs']);
  assert.match(wk1.cells['0,0'].note, /Generated by Santa Rosa Tile Scheduler/);
  const buddyRow = [...Array(30).keys()].find(r => cv(wk1, r, 0) === 'Buddy'); assert.ok(buddyRow, 'Buddy row');
  assert.strictEqual(cv(wk1, buddyRow, 1), '7:30'); assert.strictEqual(typeof cv(wk1, buddyRow, 7), 'number');
  assert.ok([...Array(30).keys()].some(r => cv(wk1, r, 0) === 'DELIVERY DRIVER'));
  assert.deepStrictEqual(cellsOf(manualTab), JSON.stringify({ '0,0': { v: 'hands off' } }));     // tabs the app did not create are never touched
  const firstId = wk1.properties.sheetId, firstSnapshot = cellsOf(wk1);
  ok('publishing sends the week to a new "Week of 2026-10-26" tab (title, header, rows, hours as numbers, Delivery Driver, A1 note); other tabs untouched');

  // reopen, edit, publish again -> the SAME tab is overwritten
  await page.click('[data-act="reopen"]'); await dlg(page, 'Reopen');
  assert.strictEqual(ss.tabs.length, 2); assert.strictEqual(cellsOf(tabByTitle('Week of 2026-10-26')), firstSnapshot);      // reopening does not touch the Sheet
  await setCell(page, 'Denis', 'Monday', '10-4'); await saved(page);
  await page.click('[data-act="publish"]'); await dlg(page); await page.check('#modalRoot .gate'); await page.click('#modalRoot .acts button:has-text("Publish anyway")');
  await page.waitForFunction(() => /Sent to Google Sheet/.test(document.querySelector('.toolbar, #view').textContent));
  await page.waitForFunction(() => true);
  const again = ss.tabs.filter(t => t.properties.title === 'Week of 2026-10-26');
  assert.strictEqual(again.length, 1); assert.strictEqual(again[0].properties.sheetId, firstId); assert.strictEqual(ss.tabs.length, 2);
  const denisRow = [...Array(30).keys()].find(r => cv(again[0], r, 0) === 'Denis'); assert.strictEqual(cv(again[0], denisRow, 1), '10-4');
  ok('republishing after an edit overwrites the same tab (still one tab for that week)');

  // a second week adds a second tab and leaves the first alone
  const wk1Snap = cellsOf(again[0]);
  await page.click('[data-act="week-next"]');
  assert.match(await page.textContent('.pill'), /FINAL/);                       // published earlier (before Sheets was linked)
  await page.click('[data-act="sheet-send"]');
  await page.waitForFunction(() => /Sent to Google Sheet/.test(document.querySelector('.toolbar, #view').textContent));
  assert.deepStrictEqual(ss.tabs.map(t => t.properties.title), ['Week of 2026-11-02', 'Week of 2026-10-26', 'My own notes']);
  assert.strictEqual(cellsOf(tabByTitle('Week of 2026-10-26')), wk1Snap);
  ok('a second week adds a second tab (newest on the left) and the first tab is untouched; manual "Send this week" works');

  // renamed tab is still found by its sheetId (no duplicate)
  tabByTitle('Week of 2026-11-02').properties.title = 'Nov 2 (renamed by someone)';
  await page.click('[data-act="sheet-send"]');
  await page.waitForFunction(() => /Sent to Google Sheet/.test(document.querySelector('.toolbar, #view').textContent));
  assert.strictEqual(ss.tabs.length, 3); assert.ok(tabByTitle('Nov 2 (renamed by someone)'));
  tabByTitle('Nov 2 (renamed by someone)').properties.title = 'Week of 2026-11-02';
  ok('a renamed tab is found by its stored sheetId (no duplicate)');

  // 429 is retried once; a failed upload leaves the week published and pending, and it is retried later
  await page.click('[data-act="reopen"]'); await dlg(page, 'Reopen');
  await setCell(page, 'Denis', 'Tuesday', '9-3'); await saved(page);
  sheetsMode = '429once';
  await page.click('[data-act="publish"]'); await dlg(page); await page.check('#modalRoot .gate'); await page.click('#modalRoot .acts button:has-text("Publish anyway")');
  await page.waitForFunction(() => /Sent to Google Sheet/.test(document.querySelector('.toolbar, #view').textContent), null, { timeout: 10000 });
  assert.strictEqual(served429, 1);
  ok('a 429 from Google is retried once and then succeeds');
  await page.click('[data-act="reopen"]'); await dlg(page, 'Reopen');
  await setCell(page, 'Denis', 'Wednesday', '9-4'); await saved(page);
  sheetsMode = '503';
  await page.click('[data-act="publish"]'); await dlg(page); await page.check('#modalRoot .gate'); await page.click('#modalRoot .acts button:has-text("Publish anyway")');
  await page.waitForFunction(() => /Not sent:/.test(document.querySelector('.toolbar, #view').textContent), null, { timeout: 15000 });
  assert.match(await page.textContent('.pill'), /FINAL/);                      // the local publish was NOT blocked or rolled back
  await saved(page);
  const pend = JSON.parse(fs.readFileSync(path.join(A, 'data.json'), 'utf8')).schedules['2026-11-02'];
  assert.strictEqual(pend.status, 'final'); assert.strictEqual(pend.sheet.pending, true); assert.ok(pend.sheet.lastError);
  assert.notStrictEqual(cv(tabByTitle('Week of 2026-11-02'), [...Array(30).keys()].find(r => cv(tabByTitle('Week of 2026-11-02'), r, 0) === 'Denis'), 3), '9-4');
  ok('a failed upload leaves the week published and "pending" with the reason shown');
  sheetsMode = null;
  await app.close();
  ({ app, page } = await launch(A));
  await page.click('[data-act="week-next"]');
  await page.waitForFunction(() => /Sent to Google Sheet/.test(document.querySelector('.toolbar, #view').textContent), null, { timeout: 15000 });
  const dRow = [...Array(30).keys()].find(r => cv(tabByTitle('Week of 2026-11-02'), r, 0) === 'Denis');
  assert.strictEqual(cv(tabByTitle('Week of 2026-11-02'), dRow, 3), '9-4'); assert.strictEqual(ss.tabs.length, 3);
  ok('pending weeks are retried automatically on the next app start (still one tab per week)');
  await tab(page, 'schedule');

  // ===== 8. credentials are protected and not exported
  const authBin = fs.readFileSync(path.join(A, 'google-auth.bin'));
  assert.ok(!authBin.includes('refresh-token-xyz'), 'token must be encrypted at rest');
  const sheetsBin = fs.readFileSync(path.join(A, 'google-sheets-auth.bin'));
  assert.ok(!sheetsBin.includes('sheets-refresh-token-xyz') && !sheetsBin.includes('sheets-user@example.com'), 'Sheets token must be encrypted at rest');
  ok('Google tokens (Calendar and Sheets) are stored encrypted, each in its own file');
  await tab(page, 'data');
  await app.close();
  ({ app, page } = await launch(A, { SRTS_TEST_PATHS: JSON.stringify([exportFile]) }));
  await tab(page, 'data'); await page.click('[data-act="export"]');
  await dlg(page, 'OK');
  const exp = fs.readFileSync(exportFile, 'utf8');
  assert.ok(!/refresh-token-xyz|access-abc|fake-secret-123|fake-client|sheets-access|sheets-refresh|sheets-user@example|google-sheets-auth/.test(exp), 'export must contain no Google credentials');
  assert.ok(exp.includes(SS_ID), 'the spreadsheet ID (not a secret) is exported with the settings');
  assert.ok(/Brendan/.test(exp) && /"pto"/.test(exp));
  ok(`Export All Data wrote ${(exp.length / 1024).toFixed(0)} KB with no Google credentials (no Calendar or Sheets token)`);
  const dataBefore = JSON.parse(fs.readFileSync(path.join(A, 'data.json'), 'utf8'));
  await app.close();

  // ===== 9. "another computer": fresh data folder, import with confirmation + backup
  ({ app, page } = await launch(B, { SRTS_TEST_PATHS: JSON.stringify([exportFile]) }));
  assert.match(await page.textContent('#view'), /Not published|Empty week|DRAFT/);
  await tab(page, 'pto'); assert.doesNotMatch(await page.textContent('#view'), /Connected as/);  // google sign-in not carried over
  await tab(page, 'data'); await page.click('[data-act="import"]');
  const dtxt = await dlg(page);
  assert.match(dtxt, /Replace this computer's data\?/); assert.match(dtxt, /backed up first/); assert.match(dtxt, /Employees/);
  await shot(page, '06-import-confirm');
  await page.click('#modalRoot .acts button:has-text("Replace with file")');
  await dlg(page, 'OK');
  await tab(page, 'schedule');
  assert.strictEqual(await cell(page, 'Denis', 'Monday').inputValue(), '10-4');
  await tab(page, 'pto'); assert.match(await page.textContent('#view'), /Brendan[\s\S]*2026-10-28/);   // Denis's Monday as edited during the Sheets steps
  await tab(page, 'data');
  assert.match(await page.textContent('#view'), /before import/);
  const imported = JSON.parse(fs.readFileSync(path.join(B, 'data.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(imported.schedules).sort(), Object.keys(dataBefore.schedules).sort());
  assert.strictEqual(imported.employees.length, dataBefore.employees.length);
  assert.strictEqual(imported.pto.length, dataBefore.pto.length);
  ok('import on a second data folder: confirmation shown, pre-import backup made, employees/schedules/PTO/settings restored, no Google link carried over');

  // ===== 10. restore from backup UI
  await page.click('[data-act="restore"] >> nth=0');
  await dlg(page, 'Restore');
  await page.waitForSelector('#toast.show');
  ok('restore from backup list works');
  await app.close();

  // ===== 11. damaged data file recovers from backup
  fs.writeFileSync(path.join(B, 'data.json'), '{ this is not json');
  ({ app, page } = await launch(B));
  assert.match(await page.textContent('#banner'), /damaged/);
  await tab(page, 'schedule');
  assert.ok((await page.$$('input[data-cell]')).length > 0);
  await shot(page, '07-recovered'); ok('a corrupted data file is detected and recovered from the latest backup');
  await app.close();

  console.log(`\nALL ${step} E2E CHECKS PASSED`);
  fake.close(); fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error('\nE2E FAILED at step', step + 1, '\n', e); fake.close(); process.exit(1); });
