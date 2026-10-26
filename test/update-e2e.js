/* Update flow test against a fake GitHub release server, using a COPY of the packaged app (SRTS_EXE = path to the built exe).
   Checks: update is detected, downloaded, checksum verified (bad checksum rejected), swapped in after the app exits, new version runs,
   and the user's data is untouched. */
const { _electron: electron } = require('playwright-core');
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), assert = require('assert');
const asar = require('@electron/asar');

const EXE_SRC = process.env.SRTS_EXE; if (!EXE_SRC) { console.error('Set SRTS_EXE to the built exe.'); process.exit(1); }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'srts-upd-'));
const APP = path.join(TMP, 'app'); fs.cpSync(path.dirname(EXE_SRC), APP, { recursive: true });
const EXE = path.join(APP, path.basename(EXE_SRC)), TARGET = path.join(APP, 'resources', 'app.asar');
const DATA = path.join(TMP, 'data');
const step = (() => { let n = 0; return m => console.log(`  ok  ${++n}. ${m}`); })();
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // build a "1.9.9" asar from the shipped one
  const cur = JSON.parse(asar.extractFile(TARGET, 'package.json').toString());
  const ex = path.join(TMP, 'x'); asar.extractAll(TARGET, ex);
  const pj = path.join(ex, 'package.json'); const j = JSON.parse(fs.readFileSync(pj)); j.version = '1.9.9'; fs.writeFileSync(pj, JSON.stringify(j));
  const NEW = path.join(TMP, 'new.asar'); await asar.createPackage(ex, NEW);
  const buf = fs.readFileSync(NEW), sha = crypto.createHash('sha256').update(buf).digest('hex');
  let badSum = true, mode = 'ok';   // mode: 'ok' | 'wrongkey' (signed by someone else) | 'evil-tag'
  const mk = () => crypto.generateKeyPairSync('ed25519'), good = mk(), evil = mk();
  const sign = (i, key) => crypto.sign(null, Buffer.from(['srts-update', i.version, i.electron, i.sha256, i.size].join('\n')), key.privateKey).toString('base64');
  const electronV = require('electron/package.json').version;
  const srv = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${srv.address().port}`;
    if (req.url === '/latest') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ tag_name: mode === 'evil-tag' ? 'v1.9.9" & calc & "' : 'v1.9.9', body: 'test', assets: [{ name: 'update.json', browser_download_url: base + '/update.json' }, { name: 'app.asar', browser_download_url: base + '/app.asar' }] })); }
    if (req.url === '/update.json') { const i = { version: '1.9.9', electron: electronV, sha256: badSum ? '0'.repeat(64) : sha, size: buf.length }; i.sig = sign(i, mode === 'wrongkey' ? evil : good); res.writeHead(200); return res.end(JSON.stringify(i)); }
    if (req.url === '/app.asar') { res.writeHead(200); return res.end(buf); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const env = { ...process.env, SRTS_DATA_DIR: DATA, SRTS_UPDATE_BASE: `http://127.0.0.1:${srv.address().port}`, SRTS_UPDATE_TARGET: TARGET, SRTS_UPDATE_PUBKEY: good.publicKey.export({ type: 'spki', format: 'pem' }), ...(process.env.SRTS_CLEAN_PATH ? { PATH: String.raw`C:\Windows\System32;C:\Windows` } : {}) };
  const open = async () => { const app = await electron.launch({ executablePath: EXE, args: [], env }); const page = await app.firstWindow(); await page.waitForSelector('#view .sheet, #view .card'); return { app, page }; };

  // 0. releases that are not signed by the publisher, or have a hostile version name, are ignored
  for (const m of ['wrongkey', 'evil-tag']) {
    mode = m; const t = await open();
    await t.page.click('#tabs button[data-tab="data"]'); await t.page.click('[data-act="upd-check"]');
    await t.page.waitForSelector('#updText:has-text("Could not check")');
    assert.ok(!(await t.page.textContent('#banner')).includes('1.9.9'));
    await t.app.close();
  }
  step('an update signed with the wrong key, or with a hostile version name, is ignored');
  mode = 'ok';
  // 1. bad checksum is rejected
  let { app, page } = await open();
  await page.waitForSelector('#banner:has-text("Version 1.9.9")');
  assert.match(await page.textContent('#banner'), new RegExp(`you have ${cur.version.replace(/\./g, '\\.')}`));
  step(`a newer release (1.9.9) is detected at start; banner shows it (installed ${cur.version})`);
  await page.click('#banner [data-act="upd-install"]');
  await page.waitForSelector('#modalRoot .dlg, #modalRoot .acts'); // failure alert
  assert.match(await page.textContent('#modalRoot .dlg'), /checksum/);
  await page.click('#modalRoot .acts button');
  assert.ok(!fs.existsSync(path.join(DATA, 'updates', 'app-1.9.9.update')));
  step('a download with a wrong checksum is rejected and discarded');

  // 2. good checksum -> download -> restart to update
  badSum = false;
  await page.click('#tabs button[data-tab="data"]'); await page.click('[data-act="upd-check"]');
  await page.waitForSelector('#updText:has-text("1.9.9")');
  await page.click('#banner [data-act="upd-install"]');
  await page.waitForSelector('#modalRoot .dlg:has-text("Restart to update")');
  assert.ok(fs.existsSync(path.join(DATA, 'updates', 'app-1.9.9.update')));
  step('good download is verified and staged; restart prompt shown');
  const before = fs.readFileSync(path.join(DATA, 'data.json'), 'utf8');
  await page.click('#modalRoot .acts button:has-text("OK")'); 
  await app.process().once('exit', () => {}); // app quits by itself
  for (let i = 0; i < 100 && !(fs.existsSync(TARGET) && crypto.createHash('sha256').update(fs.readFileSync(TARGET)).digest('hex') === sha); i++) await sleep(300);
  assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(TARGET)).digest('hex'), sha);
  assert.ok(fs.existsSync(TARGET + '.bak'));
  step('after the app exits, app.asar is swapped for the new one and the old one kept as app.asar.bak');
  assert.ok(fs.readdirSync(path.join(DATA, 'backups')).some(n => /before-update/.test(n)));
  step('a "before update" data backup was made');

  // 3. new version runs, data untouched
  ({ app, page } = await open());
  await page.click('#tabs button[data-tab="data"]');
  assert.match(await page.textContent('#view'), /Scheduler 1\.9\.9/);
  step('relaunch runs version 1.9.9');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(DATA, 'data.json'), 'utf8')).employees, JSON.parse(before).employees);
  step('staff data identical after the update');
  await page.waitForSelector('#updText:has-text("latest version")'); step('update check now reports "latest version"');
  await app.close(); srv.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\nALL UPDATE CHECKS PASSED');
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
