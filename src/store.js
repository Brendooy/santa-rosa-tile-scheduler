/* Local persistence: atomic saves, rolling backups, export/import. Never touches Google credentials. */
const fs = require('fs');
const path = require('path');
const { initialData, defaultSettings } = require('./defaults');

const FORMAT = 'srts-scheduler-backup';
let dir = null;
let writeChain = Promise.resolve();

const p = (...a) => path.join(dir, ...a);
const stamp = (d = new Date()) => { const z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`; };

function init(dataDir) {
  dir = dataDir;
  fs.mkdirSync(p('backups'), { recursive: true });
  return dir;
}

/** Fill in anything an older / hand-edited file might be missing, so the UI never crashes. */
function normalize(d) {
  const def = defaultSettings();
  d.version = 1;
  d.employees = Array.isArray(d.employees) ? d.employees : [];
  // Older data used "can open / can close". Warehouse and Showroom replace them; start everyone qualified for both
  // so nothing is wrongly flagged until the manager sets who works where.
  for (const e of d.employees) { if (e.canWarehouse === undefined) e.canWarehouse = true; if (e.canShowroom === undefined) e.canShowroom = true; delete e.canOpen; delete e.canClose; delete e.role; if (e.keyholder === undefined) e.keyholder = false; }
  d.schedules = d.schedules && typeof d.schedules === 'object' ? d.schedules : {};
  d.pto = Array.isArray(d.pto) ? d.pto : [];
  // Calendar entries imported before the "Works" type existed have no type: work it out from the event title.
  for (const p of d.pto) if (!p.type) p.type = p.source === 'google' ? require('./logic').ptoTypeFromTitle(p.note) : 'off';
  d.settings = { ...def, ...(d.settings || {}) };
  d.settings.google = { ...def.google, ...(d.settings.google || {}) };
  d.settings.locations = d.settings.locations && Object.keys(d.settings.locations).length ? d.settings.locations : def.locations;
  for (const l of Object.values(d.settings.locations)) { if (l.minWarehouse === undefined) l.minWarehouse = 1; if (l.minShowroom === undefined) l.minShowroom = 1; delete l.minOpeners; delete l.minClosers; }
  d.ptoMeta = { lastRefreshed: null, lastError: null, lastAttempt: null, lastSummary: null, unmatched: [], ...(d.ptoMeta || {}) };
  d.meta = d.meta || {};
  return d;
}
function validateShape(d) {
  if (!d || typeof d !== 'object') throw new Error('The file is not a scheduler backup.');
  if (!Array.isArray(d.employees)) throw new Error('The backup has no employee list.');
  if (!d.settings || typeof d.settings !== 'object' || !d.settings.locations) throw new Error('The backup has no settings.');
  if (!d.schedules || typeof d.schedules !== 'object') throw new Error('The backup has no schedules.');
}
const readJSON = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));

function load() {
  const f = p('data.json');
  let notice = null, data;
  if (fs.existsSync(f)) {
    try { data = readJSON(f); validateShape(data); }
    catch (err) {
      // data.json is damaged: keep the bad file for inspection, then fall back to the newest good backup.
      try { fs.copyFileSync(f, p(`data-damaged-${stamp()}.json`)); } catch (_) {}
      const good = listBackups().map(b => { try { const x = readJSON(p('backups', b.name)); validateShape(x); return { b, x }; } catch (_) { return null; } }).filter(Boolean)[0];
      if (good) { data = good.x; notice = `The saved data file was damaged, so the most recent backup (${good.b.label}) was loaded instead.`; }
      else { data = initialData(); notice = 'The saved data file was damaged and no usable backup was found. Starting with sample data.'; }
    }
  } else { data = initialData(); }
  data = normalize(data);
  return { data, notice, firstRun: !fs.existsSync(f) };
}

/** Atomic write (temp file + rename) serialised through a queue. Resolves {ok, at} or {ok:false, error}. */
function save(data) {
  const run = () => new Promise(resolve => {
    try {
      const tmp = p('data.json.tmp');
      fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
      fs.renameSync(tmp, p('data.json'));
      resolve({ ok: true, at: new Date().toISOString() });
    } catch (err) { resolve({ ok: false, error: friendlyErr(err) }); }
  });
  writeChain = writeChain.then(run, run);
  return writeChain;
}
const friendlyErr = err => err.code === 'EPERM' || err.code === 'EACCES' ? `Windows will not let the app write to ${dir}. (${err.code})`
  : err.code === 'ENOSPC' ? 'The disk is full.' : err.message;

// ---------- backups ----------
function listBackups() {
  if (!dir || !fs.existsSync(p('backups'))) return [];
  return fs.readdirSync(p('backups')).filter(n => n.endsWith('.json')).map(name => {
    const st = fs.statSync(p('backups', name));
    const m = /^backup-(\d{8}-\d{6})-(.*)\.json$/.exec(name);
    const reason = m ? m[2].replace(/-/g, ' ') : 'backup';
    return { name, size: st.size, time: st.mtime.toISOString(), reason, label: `${st.mtime.toLocaleString()} (${reason})` };
  }).sort((a, b) => b.time.localeCompare(a.time) || b.name.localeCompare(a.name));
}
function backupNow(reason, keep = 30) {
  const f = p('data.json');
  if (!fs.existsSync(f)) return null;
  const name = `backup-${stamp()}-${reason.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`;
  fs.copyFileSync(f, p('backups', name));
  const all = listBackups();
  // protect pre-import / pre-restore backups from pruning; prune oldest of the rest
  const prunable = all.filter(b => !/before/.test(b.reason));
  for (const b of prunable.slice(Math.max(1, keep))) { try { fs.unlinkSync(p('backups', b.name)); } catch (_) {} }
  return name;
}
function lastBackupTime() { const b = listBackups()[0]; return b ? b.time : null; }

function previewFile(file) {
  const raw = readJSON(file);
  const d = raw && raw.format === FORMAT ? raw.data : raw;
  validateShape(d);
  return { raw, data: d };
}
const summarise = d => ({
  employees: d.employees.length,
  schedules: Object.keys(d.schedules).length,
  published: Object.values(d.schedules).filter(s => s.status === 'final').length,
  pto: (d.pto || []).length,
  ptoRefreshed: d.ptoMeta ? d.ptoMeta.lastRefreshed : null,
  weeks: Object.keys(d.schedules).sort(),
});

function restoreBackup(name, keep) {
  if (name !== path.basename(name)) throw new Error('Invalid backup name.');
  const { data } = previewFile(p('backups', name));
  backupNow('before-restore', keep);
  const d = normalize(data);
  return d;
}

// ---------- export / import ----------
function exportAll(file, data, appVersion) {
  const env = { format: FORMAT, formatVersion: 1, app: 'Santa Rosa Tile Scheduler', appVersion, exportedAt: new Date().toISOString(),
    note: 'Business data only. Google sign-in information is never included.', data };
  fs.writeFileSync(file, JSON.stringify(env, null, 1), 'utf8');
  return { ok: true, bytes: fs.statSync(file).size };
}
function importPreview(file, currentData) {
  const { raw, data } = previewFile(file);
  return { exportedAt: raw.exportedAt || null, incoming: summarise(data), current: summarise(currentData) };
}
function importApply(file, keep) {
  const { data } = previewFile(file);
  const backup = backupNow('before-import', keep);
  return { data: normalize(data), backup };
}

module.exports = { init, load, save, normalize, listBackups, backupNow, lastBackupTime, restoreBackup, exportAll, importPreview, importApply, summarise, dir: () => dir, friendlyErr };
