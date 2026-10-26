const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const store = require('./src/store');
const google = require('./src/google');
const Logic = require('./src/logic');
const updater = require('./src/updater');

app.setName('Santa Rosa Tile Scheduler');
const TEST = !!process.env.SRTS_DATA_DIR;   // automated tests use an isolated data folder
const dataDir = process.env.SRTS_DATA_DIR || app.getPath('userData');
let win = null, lastSaved = null, saveError = null;

if (!TEST && !app.requestSingleInstanceLock()) { app.quit(); }
else app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

// Test-only: scripted answers for native file dialogs (set by test/e2e.js, never set for real users).
const testPaths = process.env.SRTS_TEST_PATHS ? JSON.parse(process.env.SRTS_TEST_PATHS) : null;
const pickPath = async (kind, opts) => {
  if (testPaths && testPaths.length) return testPaths.shift();
  const r = kind === 'open' ? await dialog.showOpenDialog(win, opts) : await dialog.showSaveDialog(win, opts);
  if (r.canceled) return null;
  return kind === 'open' ? r.filePaths[0] : r.filePath;
};

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 640, title: 'Santa Rosa Tile Scheduler', backgroundColor: '#f4f4f2', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  // Let the window ask for a final flush before closing so the last keystroke is never lost.
  let closing = false;
  win.on('close', e => {
    if (closing) return;
    e.preventDefault(); closing = true;
    const finish = () => { autoBackup('on exit'); win && win.destroy(); };
    try { win.webContents.send('app:flush'); } catch (_) {}
    ipcMain.once('app:flushed', finish);
    setTimeout(finish, 2500);
  });
}

// ---------- automatic backups ----------
function autoBackup(reason) {
  try {
    const cur = path.join(dataDir, 'data.json'); if (!fs.existsSync(cur)) return;
    const last = store.listBackups()[0];
    if (last && Buffer.compare(fs.readFileSync(cur), fs.readFileSync(path.join(dataDir, 'backups', last.name))) === 0) return; // nothing changed
    store.backupNow(reason, backupKeep);
  } catch (e) { console.error('auto backup failed', e); }
}
let backupKeep = 30;

// ---------- IPC ----------
const h = (name, fn) => ipcMain.handle(name, async (_e, ...a) => { try { return { ok: true, value: await fn(...a) }; } catch (err) { return { ok: false, error: err.message || String(err), code: err.code }; } });
const send = (ch, payload) => { try { win.webContents.send(ch, payload); } catch (_) {} };

h('app:load', () => {
  const r = store.load();
  backupKeep = r.data.settings.backupKeep || 30;
  if (!r.firstRun) autoBackup('on start');
  else store.save(r.data);
  return { ...r, dataDir, version: app.getVersion(), backups: store.listBackups(), google: google.status(), test: TEST, autoUpdateCheck: !TEST || !!process.env.SRTS_UPDATE_BASE };
});
h('data:save', async data => { backupKeep = (data.settings && data.settings.backupKeep) || 30; return await store.save(data); });
h('backup:list', () => store.listBackups());
h('backup:now', () => { store.backupNow('manual', backupKeep); return store.listBackups(); });
h('backup:restore', async name => { const data = store.restoreBackup(name, backupKeep); const r = await store.save(data); if (!r.ok) throw new Error(r.error); return { data, backups: store.listBackups() }; });
h('folder:open', () => shell.openPath(dataDir));

h('data:export', async (data, name) => {
  const file = await pickPath('save', { title: 'Export All Data', defaultPath: name, filters: [{ name: 'Scheduler backup', extensions: ['srts.json', 'json'] }] });
  if (!file) return { canceled: true };
  await store.save(data);
  return { ...store.exportAll(file, data, app.getVersion()), file };
});
h('data:importPick', async current => {
  const file = await pickPath('open', { title: 'Import Data', properties: ['openFile'], filters: [{ name: 'Scheduler backup', extensions: ['json'] }] });
  if (!file) return { canceled: true };
  return { file, ...store.importPreview(file, current) };
});
h('data:importApply', async file => {
  const r = store.importApply(file, backupKeep);
  const s = await store.save(r.data); if (!s.ok) throw new Error(s.error);
  return { data: r.data, backup: r.backup, backups: store.listBackups() };
});

// Google
google.init({ dir: dataDir, safeStorage, extraDirs: [path.dirname(process.execPath), __dirname], openExternal: u => TEST && process.env.SRTS_GOOGLE_TEST_BASE ? fetch(u).catch(() => {}) : shell.openExternal(u) });
h('google:status', () => google.status());
h('google:saveClient', (id, secret) => { google.saveClient(id, secret); return google.status(); });
h('google:connect', () => google.connect());
h('google:disconnect', () => google.disconnect());
h('google:calendars', () => google.listCalendars());
h('google:fetchPto', async (employees, settings) => {
  const ids = settings.google.calendarIds || [];
  if (!ids.length) throw Object.assign(new Error('Choose at least one calendar first.'), { code: 'no_calendar' });
  const today = Logic.iso(new Date());
  const timeMin = new Date(Logic.addDays(today, -(settings.google.daysBack || 7)) + 'T00:00:00').toISOString();
  const timeMax = new Date(Logic.addDays(today, settings.google.daysAhead || 180) + 'T00:00:00').toISOString();
  const events = await google.fetchEvents(ids, timeMin, timeMax);
  return { ...Logic.eventsToPto(events, employees, settings), eventCount: events.length, windowStart: Logic.addDays(today, -(settings.google.daysBack || 7)), windowEnd: Logic.addDays(today, settings.google.daysAhead || 180), at: new Date().toISOString() };
});

// Print / PDF: render the schedule HTML in a hidden window.
async function withPrintWindow(html, fn) {
  const f = path.join(os.tmpdir(), `srts-print-${Date.now()}.html`);
  fs.writeFileSync(f, html, 'utf8');
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  try { await w.loadFile(f); return await fn(w); }
  finally { w.destroy(); try { fs.unlinkSync(f); } catch (_) {} }
}
h('print:pdf', async (html, name) => {
  const file = await pickPath('save', { title: 'Save schedule as PDF', defaultPath: name, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (!file) return { canceled: true };
  const buf = await withPrintWindow(html, w => w.webContents.printToPDF({ landscape: true, pageSize: 'Letter', printBackground: true, margins: { marginType: 'default' } }));
  fs.writeFileSync(file, buf);
  return { file, bytes: buf.length };
});
h('print:print', async html => {
  if (TEST) return { printed: false, test: true };
  return await withPrintWindow(html, w => new Promise(res => w.webContents.print({ silent: false, landscape: true, printBackground: true, pageSize: 'Letter' }, (ok, why) => res({ printed: ok, reason: why }))));
});
h('shell:reveal', f => shell.showItemInFolder(f));

// Updates (GitHub Releases)
updater.init({ dir: dataDir, app, version: app.getVersion(), electronVersion: process.versions.electron });
h('update:status', () => updater.status());
h('update:check', () => updater.check());
h('update:download', () => updater.download());
h('update:apply', async () => {
  store.backupNow('before-update', backupKeep);
  updater.applyAndRestart();
  setTimeout(() => app.quit(), 300);   // quitting flushes the last edits (window close handler), then the swap script runs
  return true;
});
h('update:page', () => shell.openExternal(updater.RELEASES_PAGE));

app.whenReady().then(() => { if (TEST || app.hasSingleInstanceLock()) { store.init(dataDir); createWindow(); } });
app.on('window-all-closed', () => app.quit());
// Safety net: periodic backup while the app stays open all day.
setInterval(() => autoBackup('periodic'), 4 * 3600 * 1000);
