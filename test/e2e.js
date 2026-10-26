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
const fake = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const json = (o, c = 200) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (googleDown) { res.writeHead(500); return res.end('down'); }
  if (u.pathname === '/auth') { const r = new URL(u.searchParams.get('redirect_uri')); r.searchParams.set('code', 'code123'); r.searchParams.set('state', u.searchParams.get('state')); assert(u.searchParams.get('code_challenge')); assert.strictEqual(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/calendar.readonly'); res.writeHead(302, { Location: r.href }); return res.end(); }
  if (u.pathname === '/token') { let b = ''; req.on('data', d => b += d); req.on('end', () => { const p = new URLSearchParams(b); if (p.get('grant_type') === 'authorization_code') assert(p.get('code_verifier')); json({ access_token: 'access-abc', refresh_token: 'refresh-token-xyz', expires_in: 3600 }); }); return; }
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
  const app = await electron.launch({ executablePath: EXE, args: ARGS, env: { ...process.env, ...(process.env.SRTS_CLEAN_PATH ? { PATH: String.raw`C:\Windows\System32;C:\Windows` } : {}), SRTS_DATA_DIR: dataDir, SRTS_GOOGLE_TEST_BASE: `http://127.0.0.1:${fake.address().port}`, ...extraEnv } });
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
  await page.click('[data-act="publish"]');                      // empty week must NOT publish
  assert.match(await dlg(page), /Cannot publish yet/); await page.click('#modalRoot .acts button');
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
  ok('auto-fill produces a valid week; publish blocked when invalid, allowed when valid, final week locks');
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

  // ===== 8. credentials are protected and not exported
  const authBin = fs.readFileSync(path.join(A, 'google-auth.bin'));
  assert.ok(!authBin.includes('refresh-token-xyz'), 'token must be encrypted at rest');
  ok('Google token is stored encrypted (not plaintext)');
  await tab(page, 'data');
  await app.close();
  ({ app, page } = await launch(A, { SRTS_TEST_PATHS: JSON.stringify([exportFile]) }));
  await tab(page, 'data'); await page.click('[data-act="export"]');
  await dlg(page, 'OK');
  const exp = fs.readFileSync(exportFile, 'utf8');
  assert.ok(!/refresh-token-xyz|access-abc|fake-secret-123|fake-client/.test(exp), 'export must contain no Google credentials');
  assert.ok(/Brendan/.test(exp) && /"pto"/.test(exp));
  ok(`Export All Data wrote ${(exp.length / 1024).toFixed(0)} KB with no Google credentials`);
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
  assert.strictEqual(await cell(page, 'Denis', 'Monday').inputValue(), '9-5');
  await tab(page, 'pto'); assert.match(await page.textContent('#view'), /Brendan[\s\S]*2026-10-28/);
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
