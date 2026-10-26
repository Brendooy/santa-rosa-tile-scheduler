const { contextBridge, ipcRenderer } = require('electron');
const call = (name, ...a) => ipcRenderer.invoke(name, ...a).then(r => { if (!r.ok) { const e = new Error(r.error); e.code = r.code; throw e; } return r.value; });
contextBridge.exposeInMainWorld('api', {
  load: () => call('app:load'),
  save: d => call('data:save', d),
  listBackups: () => call('backup:list'),
  backupNow: () => call('backup:now'),
  restoreBackup: n => call('backup:restore', n),
  openDataFolder: () => call('folder:open'),
  exportAll: (d, name) => call('data:export', d, name),
  importPick: cur => call('data:importPick', cur),
  importApply: f => call('data:importApply', f),
  google: {
    status: () => call('google:status'),
    saveClient: (id, s) => call('google:saveClient', id, s),
    connect: () => call('google:connect'),
    disconnect: () => call('google:disconnect'),
    calendars: () => call('google:calendars'),
    fetchPto: (emps, settings) => call('google:fetchPto', emps, settings),
  },
  update: {
    status: () => call('update:status'),
    check: () => call('update:check'),
    download: () => call('update:download'),
    apply: () => call('update:apply'),
    page: () => call('update:page'),
  },
  printPdf: (html, name) => call('print:pdf', html, name),
  print: html => call('print:print', html),
  reveal: f => call('shell:reveal', f),
  onFlush: cb => ipcRenderer.on('app:flush', async () => { try { await cb(); } finally { ipcRenderer.send('app:flushed'); } }),
});
