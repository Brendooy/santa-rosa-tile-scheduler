/* Self-update from GitHub Releases. A release carries app.asar (the app's code) plus update.json
   {version, electron, sha256, size}. We download app.asar, verify its SHA-256, and on "Restart to update"
   a tiny hidden .cmd swaps it into place after the app exits and starts the app again.
   Only app code is replaced: the .exe, google-client.json and the user's data are never touched.
   A release built on a different Electron version cannot be applied this way; the user is sent to the download page. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO = 'Brendooy/santa-rosa-tile-scheduler';
// SRTS_UPDATE_BASE points at a local fake release server; honoured only by the automated tests.
const TB = process.env.SRTS_DATA_DIR && process.env.SRTS_UPDATE_BASE;
const LATEST = TB ? TB + '/latest' : `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

let ctx = null; // {dir, app, electronVersion}
let state = { status: 'idle', current: null, latest: null, error: null, checkedAt: null, page: RELEASES_PAGE };
const init = c => { ctx = c; state.current = c.version; };

const cmp = (a, b) => { const x = String(a).replace(/^v/, '').split('.').map(Number), y = String(b).replace(/^v/, '').split('.').map(Number); for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };
const get = async (url, opts = {}) => {
  const r = await fetch(url, { headers: { 'User-Agent': 'SantaRosaTileScheduler', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(opts.timeout || 15000), redirect: 'follow' });
  if (!r.ok) throw new Error(r.status === 404 ? 'No release has been published yet.' : `GitHub answered ${r.status}.`);
  return r;
};
const updDir = () => path.join(ctx.dir, 'updates');
const staged = v => path.join(updDir(), `app-${v}.asar`);

/** Ask GitHub for the newest release. Never throws: problems end up in state.error (offline is normal). */
async function check() {
  state = { ...state, status: 'checking', error: null };
  try {
    const rel = await (await get(LATEST)).json();
    const meta = (rel.assets || []).find(a => a.name === 'update.json'), asar = (rel.assets || []).find(a => a.name === 'app.asar');
    const tag = String(rel.tag_name || '').replace(/^v/, '');
    state.checkedAt = new Date().toISOString();
    if (!tag || cmp(tag, ctx.version) <= 0) { state = { ...state, status: 'current', latest: tag || ctx.version }; return state; }
    if (!meta || !asar) { state = { ...state, status: 'manual', latest: tag }; return state; }
    const info = await (await get(meta.browser_download_url)).json();
    if (info.electron && info.electron !== ctx.electronVersion) { state = { ...state, status: 'manual', latest: tag, notes: 'This version also needs a newer app engine, so it cannot be applied automatically. Download the full ZIP from the releases page.' }; return state; }
    state = { ...state, status: fs.existsSync(staged(tag)) ? 'ready' : 'available', latest: tag, info: { ...info, url: asar.browser_download_url }, notes: rel.body || '' };
  } catch (e) {
    state = { ...state, status: 'error', error: e.name === 'TimeoutError' || /fetch failed/i.test(e.message) ? 'Could not reach GitHub (no internet?).' : e.message, checkedAt: new Date().toISOString() };
  }
  return state;
}

async function download() {
  if (!state.info) throw new Error('Check for updates first.');
  const { info, latest } = state;
  fs.mkdirSync(updDir(), { recursive: true });
  const r = await get(info.url, { timeout: 300000 });
  const buf = Buffer.from(await r.arrayBuffer());
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (info.sha256 && sha !== String(info.sha256).toLowerCase()) throw new Error('The downloaded update did not match its checksum, so it was discarded. Try again.');
  if (info.size && buf.length !== info.size) throw new Error('The downloaded update was incomplete. Try again.');
  fs.writeFileSync(staged(latest) + '.part', buf); fs.renameSync(staged(latest) + '.part', staged(latest));
  state = { ...state, status: 'ready' };
  return state;
}

/** Spawn the swap script. Caller must quit the app right afterwards. */
function applyAndRestart() {
  if (state.status !== 'ready') throw new Error('No update has been downloaded.');
  if (!ctx.app.isPackaged && !TB) throw new Error('Updates only apply to the installed (packaged) app.');
  const target = TB ? process.env.SRTS_UPDATE_TARGET : path.join(process.resourcesPath, 'app.asar');
  if (!target) throw new Error('No update target.');
  fs.accessSync(path.dirname(target), fs.constants.W_OK);
  const bat = path.join(updDir(), 'apply-update.cmd');
  const q = s => `"${s}"`;
  fs.writeFileSync(bat, [
    '@echo off',
    `set "NEW=${staged(state.latest)}"`, `set "TARGET=${target}"`, `set "EXE=${process.execPath}"`,
    'set N=0',
    ':retry',
    // the old file stays locked until the app has exited, so keep trying for up to ~60 s
    'move /Y "%TARGET%" "%TARGET%.bak" >nul 2>&1 && goto swap',
    'set /a N+=1',
    'if %N% GEQ 60 goto fail',
    'ping -n 2 127.0.0.1 >nul',
    'goto retry',
    ':swap',
    'copy /Y "%NEW%" "%TARGET%" >nul 2>&1 || ( move /Y "%TARGET%.bak" "%TARGET%" >nul & goto fail )',
    'del "%NEW%" >nul 2>&1',
    ':fail',
    TB ? 'exit /b 0' : 'start "" "%EXE%"',
    'exit /b 0', '',
  ].join('\r\n'), 'utf8');
  spawn(process.env.ComSpec || 'cmd.exe', ['/c', q(bat)], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
}

const status = () => state;
module.exports = { init, check, download, applyAndRestart, status, cmp, RELEASES_PAGE };
