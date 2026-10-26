(() => {
  'use strict';
  const L = window.Logic, api = window.api;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const S = { data: null, tab: 'schedule', week: L.mondayOf(L.iso(new Date())), staffSel: null, info: {}, save: { state: 'idle' }, cals: null, notice: null, busy: '', focusKey: null };
  const LOCS = () => Object.keys(S.data.settings.locations);
  const isFinal = wk => wk && wk.status === 'final';
  const fmtDT = iso => iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never';
  const ago = iso => { if (!iso) return 'never'; const m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} hours ago` : `${Math.round(m / 1440)} days ago`; };
  const timeOnly = iso => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  // ---------------------------------------------------------------- saving
  let saveTimer = null, ver = 0;
  function renderSave() {
    const el = $('#saveState'), s = S.save;
    el.className = 'save ' + (s.state === 'saving' ? 'saving' : s.state === 'fail' ? 'fail' : '');
    el.textContent = s.state === 'saved' ? `✓ All changes saved · ${timeOnly(s.at)}` : s.state === 'saving' ? 'Saving…' : s.state === 'fail' ? `⚠ NOT SAVED — ${s.error} (click to retry)` : 'Ready';
    el.title = s.state === 'fail' ? 'Your latest changes are only in memory. Click to try saving again.' : 'Data is saved automatically to this computer.';
  }
  function touch() { ver++; S.save = { state: 'saving' }; renderSave(); clearTimeout(saveTimer); saveTimer = setTimeout(flush, 300); }
  async function flush() {
    clearTimeout(saveTimer); saveTimer = null;
    const v = ver;
    try { const r = await api.save(S.data); if (v === ver) S.save = r.ok ? { state: 'saved', at: r.at } : { state: 'fail', error: r.error }; }
    catch (e) { if (v === ver) S.save = { state: 'fail', error: e.message }; }
    renderSave();
    return S.save.state === 'saved';
  }
  const edit = fn => { fn(S.data); touch(); };
  $('#saveState').addEventListener('click', () => { if (S.save.state === 'fail') flush(); });
  api.onFlush(async () => { await flush(); });

  // ---------------------------------------------------------------- helpers: modal / toast
  function modal({ title, html, buttons }) {
    return new Promise(res => {
      const root = $('#modalRoot');
      root.innerHTML = `<div class="back"><div class="dlg" role="dialog" aria-modal="true" aria-label="${esc(title)}"><h3>${esc(title)}</h3><div>${html}</div><div class="acts">${buttons.map((b, i) => `<button class="btn ${b.cls || ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div></div></div>`;
      const done = v => { root.innerHTML = ''; document.removeEventListener('keydown', onKey, true); res(v); };
      const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
      document.addEventListener('keydown', onKey, true);
      $$('.acts button', root).forEach(b => b.addEventListener('click', () => done(buttons[+b.dataset.i].value)));
      const first = $('.acts .primary', root) || $('.acts button:last-child', root); if (first) first.focus();
    });
  }
  const confirmBox = (title, html, ok = 'OK', cls = 'primary') => modal({ title, html, buttons: [{ label: 'Cancel', value: false }, { label: ok, value: true, cls }] });
  const alertBox = (title, html) => modal({ title, html, buttons: [{ label: 'OK', value: true, cls: 'primary' }] });
  let toastT;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3500); }

  // ---------------------------------------------------------------- week data
  const blankWeek = () => ({ start: S.week, status: 'draft', cells: {}, support: {}, publishedAt: null, updatedAt: null });
  const getWeek = () => S.data.schedules[S.week] || blankWeek();
  const ensureWeek = () => { const w = S.data.schedules[S.week] || (S.data.schedules[S.week] = blankWeek()); w.cells ||= {}; w.support ||= {}; return w; };
  const stampWeek = w => { w.updatedAt = new Date().toISOString(); };
  const sched = () => S.data.employees.filter(e => e.active && e.location !== 'Support');
  const issuesNow = () => L.validate(getWeek(), S.data.employees, S.data.pto, S.data.settings);
  function normalizeCell(raw) {
    const p = L.parseCell(raw);
    if (p.kind === 'off') return 'OFF'; if (p.kind === 'pto') return 'PTO'; if (p.kind === 'late') return 'IN LATE';
    if (p.kind === 'shift') return p.openEnded ? L.fmtTime(p.start) : `${L.fmtTime(p.start)}-${L.fmtTime(p.end)}`;
    return raw.trim();
  }

  // ---------------------------------------------------------------- banners
  function renderBanner() {
    const b = [], m = S.data.ptoMeta, g = S.info.google || {};
    if (S.notice) b.push(`<div class="b err">${esc(S.notice)} <button class="btn sm" data-act="dismiss-notice">Dismiss</button></div>`);
    if (S.data.meta && S.data.meta.seeded) b.push(`<div class="b info">Sample staff and the week of 26 Oct were loaded from the posted schedule. Please check each person's qualifications (Staff tab) and store hours (Store rules tab). <button class="btn sm" data-act="dismiss-seed">Got it</button></div>`);
    if (m.lastError) b.push(`<div class="b err">Google Calendar time off could not be refreshed (${esc(fmtDT(m.lastAttempt))}): ${esc(m.lastError)} Time off shown is from ${m.lastRefreshed ? esc(fmtDT(m.lastRefreshed)) : 'manual entries only'} and may be out of date.</div>`);
    else if (S.tab === 'schedule') {
      const stale = m.lastRefreshed && Date.now() - new Date(m.lastRefreshed) > 24 * 3600e3;
      if (!m.lastRefreshed && g.connected) b.push(`<div class="b warn">Time off has not been imported from Google Calendar yet. <button class="btn sm" data-act="go-pto">Open Time off &amp; Google</button></div>`);
      else if (stale) b.push(`<div class="b warn">Google Calendar time off was last refreshed ${esc(ago(m.lastRefreshed))}. Requests added since then may be missing (needs internet to refresh). <button class="btn sm" data-act="go-pto">Refresh</button></div>`);
    }
    const u = S.upd;
    if (u && u.status === 'available') b.push(`<div class="b info">Version ${esc(u.latest)} of this app is available (you have ${esc(S.info.version)}). <button class="btn sm primary" data-act="upd-install">Update now</button></div>`);
    else if (u && u.status === 'ready') b.push(`<div class="b info">Version ${esc(u.latest)} is downloaded and ready. <button class="btn sm primary" data-act="upd-install">Restart to update</button></div>`);
    else if (u && u.status === 'manual') b.push(`<div class="b info">Version ${esc(u.latest)} is available but must be installed by hand. <button class="btn sm" data-act="upd-page">Open download page</button></div>`);
    $('#banner').innerHTML = b.join('');
  }
  async function checkUpdates(manual) {
    if (manual) { S.upd = { ...(S.upd || {}), status: 'checking' }; render(); }
    try { S.upd = await api.update.check(); } catch (e) { S.upd = { status: 'error', error: e.message }; }
    render();
  }
  async function installUpdate() {
    try {
      if (S.upd.status === 'available') { toast('Downloading the update…'); S.upd = await api.update.download(); render(); }
      const ok = await confirmBox('Restart to update?', `<p>The app will close and reopen on version ${esc(S.upd.latest)} in a few seconds. Your data is backed up first and is not changed by the update.</p>`);
      if (!ok) return;
      await flush(); await api.update.apply();
    } catch (e) { alertBox('Update failed', esc(e.message)); }
  }
  const updText = () => {
    const u = S.upd || {};
    return u.status === 'checking' ? 'Checking…' : u.status === 'available' ? `Version ${esc(u.latest)} is available.` : u.status === 'ready' ? `Version ${esc(u.latest)} is downloaded and ready.` :
      u.status === 'manual' ? `Version ${esc(u.latest)} is available but needs a manual download.` : u.status === 'error' ? `Could not check: ${esc(u.error)}` :
      u.status === 'current' ? `You have the latest version (checked ${esc(fmtDT(u.checkedAt))}).` : 'Not checked yet.';
  };

  // ---------------------------------------------------------------- render dispatcher
  function render() {
    $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
    renderBanner(); renderSave();
    const v = $('#view'), scroll = v.scrollTop;
    v.innerHTML = ({ schedule: viewSchedule, staff: viewStaff, pto: viewPto, rules: viewRules, data: viewData })[S.tab]();
    v.scrollTop = scroll;
    if (S.focusKey) { const el = $(`[data-key="${S.focusKey}"]`); if (el && document.activeElement !== el) { el.focus(); try { el.select(); } catch (_) {} } }
  }

  // ================================================================ SCHEDULE
  function viewSchedule() {
    const wk = getWeek(), fin = isFinal(wk), dates = L.weekDates(S.week);
    const issues = issuesNow(), errs = issues.filter(i => i.severity === 'error'), warns = issues.filter(i => i.severity === 'warn');
    const sevAt = {}; for (const i of issues) if (i.empId != null && i.day != null) { const k = i.empId + ':' + i.day; if (sevAt[k] !== 'error') sevAt[k] = i.severity; }
    const msgAt = {}; for (const i of issues) if (i.empId != null && i.day != null) (msgAt[i.empId + ':' + i.day] ||= []).push(i.msg);
    const grid = L.weekGrid(wk, S.data.employees, S.data.pto, S.data.settings);
    const s = S.data.settings;
    const stl = { fin };
    let body = '';
    for (const loc of LOCS()) {
      const rows = grid.rows.filter(r => r.emp.location === loc);
      body += `<tr class="band"><td colspan="8">${esc(loc.toUpperCase())}</td></tr>`;
      for (const r of rows) {
        let hrs = 0;
        const tds = r.cells.map((c, i) => {
          const k = c.parsed.kind; if (c.shift) hrs += L.paidHours(c.shift, s);
          const sev = sevAt[r.emp.id + ':' + i];
          const cls = ['cell', k === 'off' ? 'off' : '', k === 'pto' ? 'pto' : '', k === 'late' ? 'late' : '', sev === 'error' ? 'bad' : sev === 'warn' ? 'warnc' : ''].join(' ');
          const tip = (msgAt[r.emp.id + ':' + i] || []).join('\n') || (c.pto ? `Time off: ${c.pto.note}` : c.work ? `Calendar: ${c.work.note}` : '');
          const key = `${r.emp.id}:${c.dk}`;
          return `<td class="${cls}" title="${esc(tip)}"><input type="text" list="shiftlist" data-cell="${r.emp.id}|${c.dk}" data-key="${key}" value="${esc(c.raw)}" placeholder="${c.pto ? 'PTO' : ''}" ${fin ? 'readonly' : ''} autocomplete="off" aria-label="${esc(r.emp.name)} ${L.DAY_NAMES[i]}"></td>`;
        }).join('');
        const over = r.emp.maxHours && hrs > r.emp.maxHours;
        body += `<tr><td class="nm">${esc(r.emp.name)}</td>${tds}<td class="hrs ${over ? 'over' : ''}" title="Scheduled hours after unpaid lunch">${hrs ? hrs.toFixed(1) : ''}</td></tr>`;
      }
      const cov = L.DAYS.map((dk, i) => {
        const h = L.hoursFor(s, loc, dk); if (!h) return '<td class="muted">closed</td>';
        const c = L.coverageOf(rows, i, h, s.rampMinutes || 0);
        return `<td title="Warehouse and Showroom people on the floor through the day / fewest people on the floor"><span class="${c.warehouseOk ? 'cv-ok' : 'cv-bad'}">Warehouse ${c.warehouseOk ? '✓' : '✗'}</span> · <span class="${c.showroomOk ? 'cv-ok' : 'cv-bad'}">Showroom ${c.showroomOk ? '✓' : '✗'}</span>${c.keyTracked ? ` · <span class="${c.keyOpenOk && c.keyCloseOk ? 'cv-ok' : 'cv-bad'}">Keys ${c.keyOpenOk && c.keyCloseOk ? '✓' : '✗ ' + (!c.keyOpenOk && !c.keyCloseOk ? 'open+close' : !c.keyOpenOk ? 'open' : 'close')}</span>` : ''} · <span class="${c.min >= h.minStaff ? 'cv-ok' : 'cv-warn'}">min ${c.min}</span></td>`;
      }).join('');
      body += `<tr class="cov"><td class="nm">Coverage</td>${cov}<td></td></tr>`;
    }
    const sup = L.DAYS.map(dk => `<td class="cell sup"><input type="text" data-sup="${dk}" value="${esc((wk.support || {})[dk] || '')}" ${fin ? 'readonly' : ''} aria-label="Support ${dk}" autocomplete="off"></td>`).join('');
    body += `<tr class="band"><td colspan="8">SUPPORT</td></tr><tr><td class="nm"></td>${sup}<td></td></tr>`;

    const defaults = new Set(['OFF', 'PTO', 'IN LATE']);
    for (const loc of LOCS()) Object.values(s.locations[loc].defaultShift || {}).forEach(x => defaults.add(x));
    const list = `<datalist id="shiftlist">${[...defaults].map(x => `<option value="${esc(x)}">`).join('')}</datalist>`;
    const a = dates[0], z = dates[5];
    const rangeLbl = `${L.dayLabel(a)} – ${L.dayLabel(z)} ${L.parseISO(z).getFullYear()}`;

    return `
    <div class="toolbar">
      <div class="weeknav"><button class="btn" data-act="week-prev" aria-label="Previous week">◀</button><div class="range">${esc(rangeLbl)}</div><button class="btn" data-act="week-next" aria-label="Next week">▶</button>
        <button class="btn sm" data-act="week-today">This week</button><input type="date" id="weekPick" value="${S.week}" aria-label="Jump to week"></div>
      <span class="pill ${fin ? 'final' : 'draft'}">${fin ? 'FINAL' : 'DRAFT'}</span>
      <span class="muted">${fin ? 'Published ' + esc(fmtDT(wk.publishedAt)) + ' (locked)' : (S.data.schedules[S.week] ? 'Not published' : 'Empty week')}</span>
      <span class="grow"></span>
      <button class="btn" data-act="autofill" ${fin ? 'disabled' : ''} title="Fill the week using availability, PTO, qualifications and coverage rules">Auto-fill</button>
      <button class="btn" data-act="copy-last" ${fin ? 'disabled' : ''}>Copy last week</button>
      <button class="btn" data-act="clear-week" ${fin ? 'disabled' : ''}>Clear</button>
      <button class="btn" data-act="print">Print</button>
      <button class="btn" data-act="pdf">Save PDF</button>
      ${fin ? '<button class="btn" data-act="reopen">Reopen as draft</button>' : '<button class="btn primary" data-act="publish">Publish as final</button>'}
    </div>
    <div class="sheet ${fin ? 'final-lock' : ''}">
      <h1>${esc(s.printTitle)}</h1><div class="note">${esc(s.printNote)}</div>
      <table class="grid"><colgroup><col class="name">${'<col>'.repeat(6)}<col class="hrs"></colgroup>
        <thead><tr class="dates"><th></th>${dates.map(d => `<th>${esc(L.dayLabel(d))}</th>`).join('')}<th></th></tr>
        <tr><th></th>${L.DAY_NAMES.map(n => `<th>${n}</th>`).join('')}<th>Hrs</th></tr></thead>
        <tbody>${body}</tbody></table>${list}
    </div>
    <div class="issues">
      <div class="card"><h3>${errs.length ? `Problems to fix (${errs.length})` : 'No problems'}</h3>${errs.length ? `<ul>${errs.map(i => `<li>${esc(i.msg)}</li>`).join('')}</ul>` : '<div class="ok">✓ Everyone is entered, no PTO or availability conflicts, Warehouse and Showroom are covered.</div>'}</div>
      <div class="card"><h3>Warnings (${warns.length})</h3>${warns.length ? `<ul>${warns.map(i => `<li>${esc(i.msg)}</li>`).join('')}</ul>` : '<span class="muted">None. Warnings do not block publishing.</span>'}</div>
    </div>
    <p class="muted">Type shifts like <b>8-5</b>, <b>7:30-4:30</b>, <b>10-3</b>; a start time alone (<b>7:30</b>) means start to close. Also: <b>OFF</b>, <b>PTO</b>, <b>IN LATE</b>. Press Enter to move down a column.</p>`;
  }

  async function commitCell(input) {
    const [empId, dk] = input.dataset.cell.split('|');
    const val = normalizeCell(input.value);
    const wk = S.data.schedules[S.week];
    if (((wk && wk.cells[empId] || {})[dk] || '') === val) { input.value = val; return; }
    edit(() => { const w = ensureWeek(); (w.cells[empId] ||= {})[dk] = val; stampWeek(w); });
    setTimeout(render, 0);
  }

  async function autofill() {
    const wk = getWeek(); if (isFinal(wk)) return;
    const hasAny = Object.values(wk.cells || {}).some(r => Object.values(r).some(v => String(v).trim()));
    let mode = 'all';
    if (hasAny) {
      mode = await modal({ title: 'Auto-fill this week', html: '<p>This week already has entries. How should the scheduler proceed?</p><p class="muted">Time off (PTO) and each person\'s availability, qualifications, usual shifts and target days are always respected. Check the result afterwards: you can edit any cell.</p>', buttons: [{ label: 'Cancel', value: null }, { label: 'Fill empty cells only', value: 'empty' }, { label: 'Rebuild whole week', value: 'all', cls: 'primary' }] });
      if (!mode) return;
    }
    const r = L.autoSchedule(wk.cells ? wk : blankWeek(), S.data.employees, S.data.pto, S.data.settings, { onlyEmpty: mode === 'empty' });
    edit(() => { const w = ensureWeek(); w.cells = r.cells; stampWeek(w); });
    render();
    const left = issuesNow().filter(i => i.severity === 'error').length;
    if (r.notes.length || left) await alertBox('Auto-fill finished', `<p>The week was filled in, but a few things need your attention:</p><ul>${[...new Set(r.notes)].map(n => `<li>${esc(n)}</li>`).join('')}</ul>${left ? `<p>${left} problem(s) are listed under the grid.</p>` : ''}`);
    else toast('Week filled in. No problems found.');
  }
  async function copyLast() {
    const prev = S.data.schedules[L.addDays(S.week, -7)];
    if (!prev) return alertBox('Nothing to copy', '<p>There is no schedule saved for the previous week.</p>');
    if (Object.keys(getWeek().cells || {}).length && !await confirmBox('Replace this week?', '<p>This week already has entries. Copying last week will replace them.</p><p class="muted">PTO is not copied, so run the checks afterwards.</p>', 'Replace')) return;
    edit(() => { const w = ensureWeek(); w.cells = JSON.parse(JSON.stringify(prev.cells)); w.support = { ...prev.support }; stampWeek(w); });
    render(); toast('Copied last week\'s shifts. Check them against this week\'s PTO.');
  }
  async function clearWeek() {
    if (!S.data.schedules[S.week]) return;
    if (!await confirmBox('Clear this week?', '<p>All entries for this week will be erased. (A backup is kept automatically each time the app starts and closes.)</p>', 'Clear week', 'danger')) return;
    edit(() => { const w = ensureWeek(); w.cells = {}; w.support = {}; stampWeek(w); }); render();
  }
  async function publish() {
    const issues = issuesNow(), errs = issues.filter(i => i.severity === 'error'), warns = issues.filter(i => i.severity === 'warn');
    if (errs.length) return alertBox('Cannot publish yet', `<p>Fix these ${errs.length} problem(s) first:</p><ul>${errs.slice(0, 12).map(i => `<li>${esc(i.msg)}</li>`).join('')}</ul>${errs.length > 12 ? `<p class="muted">…and ${errs.length - 12} more.</p>` : ''}`);
    const m = S.data.ptoMeta, stale = m.lastError || !m.lastRefreshed || Date.now() - new Date(m.lastRefreshed) > 24 * 3600e3;
    const html = `${warns.length ? `<p>${warns.length} warning(s):</p><ul>${warns.slice(0, 8).map(i => `<li>${esc(i.msg)}</li>`).join('')}</ul>` : '<p>No problems or warnings.</p>'}${stale ? `<p class="muted"><b>Note:</b> Google Calendar time off was ${m.lastError ? 'not refreshed successfully' : m.lastRefreshed ? 'last refreshed ' + esc(ago(m.lastRefreshed)) : 'never refreshed'}; newer requests may be missing.</p>` : ''}<p>Publishing marks this week as final and locks it. You can reopen it as a draft later. Use Print or Save PDF to share it.</p>`;
    if (!await confirmBox('Publish as final?', html, 'Publish')) return;
    edit(() => { const w = ensureWeek(); w.status = 'final'; w.publishedAt = new Date().toISOString(); stampWeek(w); }); render();
  }
  async function reopen() {
    if (!await confirmBox('Reopen as draft?', '<p>The schedule becomes editable again and is no longer marked final.</p>', 'Reopen')) return;
    edit(() => { const w = ensureWeek(); w.status = 'draft'; w.publishedAt = null; stampWeek(w); }); render();
  }

  // ---------------------------------------------------------------- printing
  function printHtml() {
    const wk = getWeek(), s = S.data.settings, dates = L.weekDates(S.week), fin = isFinal(wk);
    const grid = L.weekGrid(wk, S.data.employees, S.data.pto, s);
    let rows = '';
    for (const loc of LOCS()) {
      rows += `<tr class="band"><td colspan="7">${esc(loc.toUpperCase())}</td></tr>`;
      for (const r of grid.rows.filter(x => x.emp.location === loc)) rows += `<tr><td class="nm">${esc(r.emp.name)}</td>${r.cells.map(c => `<td class="${c.parsed.kind === 'off' ? 'off' : c.parsed.kind === 'pto' ? 'pto' : ''}">${esc(c.raw)}</td>`).join('')}</tr>`;
    }
    rows += `<tr class="band"><td colspan="7">SUPPORT</td></tr><tr><td class="nm">&nbsp;</td>${L.DAYS.map(dk => `<td class="sup">${esc((wk.support || {})[dk] || '')}</td>`).join('')}</tr>`;
    return `<!doctype html><html><head><meta charset="utf-8"><title>Schedule ${S.week}</title><style>
      @page { size: letter landscape; margin: 0.5in; }
      body { font-family: Arial, Helvetica, sans-serif; color: #000; margin: 0; }
      h1 { text-align: center; font-size: 30px; margin: 0 0 2px; } .note { text-align: center; font-size: 11px; margin-bottom: 6px; }
      .draft { text-align: center; color: #b00; font-weight: 700; letter-spacing: .2em; font-size: 14px; margin-bottom: 4px; }
      table { width: 100%; border-collapse: collapse; table-layout: fixed; } th, td { border: 1px solid #000; text-align: center; padding: 6px 2px; font-size: 18px; font-weight: 700; }
      th { font-size: 15px; padding: 3px; } th.d { font-weight: 400; font-size: 12px; padding: 2px; } col.n { width: 115px; }
      td.nm { font-size: 19px; } tr.band td { background: #d4d4d0; padding: 3px; font-size: 17px; } td.off { background: #c4c4c0; } td.pto { background: #f1dd9e; } td.sup { font-size: 15px; }
      * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    </style></head><body>
      <h1>${esc(s.printTitle)}</h1><div class="note">${esc(s.printNote)}</div>${fin ? '' : '<div class="draft">DRAFT — NOT FINAL</div>'}
      <table><colgroup><col class="n">${'<col>'.repeat(6)}</colgroup>
      <thead><tr><th class="d"></th>${dates.map(d => `<th class="d">${esc(L.dayLabel(d))}</th>`).join('')}</tr><tr><th></th>${L.DAY_NAMES.map(n => `<th>${n}</th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody></table></body></html>`;
  }
  async function doPrint() { try { const r = await api.print(printHtml()); if (r && r.printed === false && r.reason && r.reason !== 'cancelled' && !r.test) toast('Printing did not start: ' + r.reason); } catch (e) { alertBox('Could not print', esc(e.message)); } }
  async function doPdf() {
    try { const r = await api.printPdf(printHtml(), `Schedule ${S.week}${isFinal(getWeek()) ? '' : ' DRAFT'}.pdf`); if (!r.canceled) toast('PDF saved: ' + r.file); }
    catch (e) { alertBox('Could not save the PDF', esc(e.message)); }
  }

  // ================================================================ STAFF
  const selEmp = () => S.data.employees.find(e => e.id === S.staffSel) || null;
  function viewStaff() {
    const emps = S.data.employees;
    if (!selEmp() && emps.length) S.staffSel = emps[0].id;
    const e = selEmp();
    const groups = [...LOCS(), 'Support'].map(loc => {
      const m = emps.filter(x => x.location === loc); if (!m.length) return '';
      return `<h4>${esc(loc)}</h4>${m.map(x => `<button class="item ${x.id === S.staffSel ? 'on' : ''}" data-act="sel-emp" data-id="${x.id}"><span>${esc(x.name)}</span><span class="tag">${x.active ? [x.canWarehouse ? 'warehouse' : '', x.canShowroom ? 'showroom' : '', x.keyholder ? 'keys' : ''].filter(Boolean).join(' · ') : 'inactive'}</span></button>`).join('')}`;
    }).join('');
    let editor = '<div class="card muted">No employees yet. Click “Add employee”.</div>';
    if (e) {
      const av = L.DAYS.map((dk, i) => { const a = L.availFor(e, dk); return `<tr><td>${L.DAY_NAMES[i]}</td>
        <td><input type="checkbox" data-av="${dk}|available" ${a.available ? 'checked' : ''} aria-label="Available ${dk}"></td>
        <td><input type="text" data-av="${dk}|earliest" value="${esc(a.earliest)}" placeholder="any" aria-label="Earliest ${dk}"></td>
        <td><input type="text" data-av="${dk}|latest" value="${esc(a.latest)}" placeholder="any" aria-label="Latest ${dk}"></td>
        <td><input type="text" data-av="${dk}|shift" value="${esc(a.shift)}" placeholder="store default" aria-label="Usual shift ${dk}"></td>
        <td><input type="checkbox" data-pref="${dk}" ${(e.preferOff || []).includes(dk) ? 'checked' : ''} aria-label="Prefer off ${dk}"></td></tr>`; }).join('');
      editor = `<div class="card"><h3>${esc(e.name)}</h3>
        <div class="fields">
          <label>Name<input type="text" data-f="name" value="${esc(e.name)}"></label>
          <label>Location<select data-f="location">${[...LOCS(), 'Support'].map(l => `<option ${l === e.location ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
          <label>Target days / week<input type="number" min="0" max="6" data-f="targetDays" value="${e.targetDays ?? 5}"></label>
          <label>Max days / week<input type="number" min="0" max="6" data-f="maxDays" value="${e.maxDays ?? 6}"></label>
          <label>Max hours / week (0 = no limit)<input type="number" min="0" max="80" data-f="maxHours" value="${e.maxHours || 0}"></label>
          <label class="chk"><input type="checkbox" data-f="active" ${e.active ? 'checked' : ''}> Active (shows on schedule)</label>
          <label class="chk"><input type="checkbox" data-f="canWarehouse" ${e.canWarehouse ? 'checked' : ''}> Can work Warehouse</label>
          <label class="chk"><input type="checkbox" data-f="canShowroom" ${e.canShowroom ? 'checked' : ''}> Can work Showroom</label>
          <label class="chk"><input type="checkbox" data-f="keyholder" ${e.keyholder ? 'checked' : ''}> Keyholder (can open and close the store)</label>
        </div></div>
        ${e.location === 'Support' ? '<div class="card muted">Support staff appear in the Support row of the schedule (type names in the grid). Availability and qualifications do not apply.</div>' : `
        <div class="card"><h3>Availability</h3><p class="muted" style="margin:0 0 6px">Auto-fill and the checks never schedule someone on an unavailable day or outside these times. “Usual shift” is what Auto-fill uses for that day (e.g. 10-3). Times like 8:30 or 5.</p>
        <table class="plain"><thead><tr><th>Day</th><th>Available</th><th>Earliest start</th><th>Latest end</th><th>Usual shift</th><th>Prefer off</th></tr></thead><tbody>${av}</tbody></table></div>`}
        <div class="row"><button class="btn danger" data-act="del-emp">Delete employee…</button><span class="muted">Tip: untick “Active” instead to keep their history.</span></div>`;
    }
    return `<div class="split"><div><div class="list">${groups}</div><p><button class="btn" data-act="add-emp">+ Add employee</button></p></div><div>${editor}</div></div>`;
  }
  function setEmpField(el) {
    const e = selEmp(); if (!e) return;
    const f = el.dataset.f;
    edit(() => {
      if (f === 'name') { const v = el.value.trim(); if (v) e.name = v; }
      else if (el.type === 'checkbox') e[f] = el.checked;
      else if (el.type === 'number') e[f] = Math.max(0, +el.value || 0);
      else e[f] = el.value;
    });
    render();
  }
  function setAvail(el) {
    const e = selEmp(); if (!e) return;
    if (el.dataset.pref) { edit(() => { const s = new Set(e.preferOff || []); el.checked ? s.add(el.dataset.pref) : s.delete(el.dataset.pref); e.preferOff = [...s]; }); return; }
    const [dk, f] = el.dataset.av.split('|');
    let v = el.type === 'checkbox' ? el.checked : el.value.trim();
    if (f === 'earliest' || f === 'latest') { if (v && L.parseClock(v, f === 'latest', 0) == null) { toast(`“${v}” is not a time. Use something like 8:30 or 5.`); el.value = L.availFor(e, dk)[f]; return; } }
    if (f === 'shift' && v) { const p = L.parseCell(v); if (p.kind !== 'shift') { toast(`“${v}” is not a shift. Use something like 8-5.`); el.value = L.availFor(e, dk).shift; return; } v = normalizeCell(v); }
    edit(() => { ((e.availability ||= {})[dk] ||= { available: true })[f] = v; });
    render();
  }
  async function delEmp() {
    const e = selEmp(); if (!e) return;
    if (!await confirmBox(`Delete ${e.name}?`, '<p>They will be removed from the staff list and all their saved schedule entries and time off will be dropped.</p>', 'Delete', 'danger')) return;
    edit(d => { d.employees = d.employees.filter(x => x.id !== e.id); d.pto = d.pto.filter(p => p.empId !== e.id); for (const w of Object.values(d.schedules)) delete w.cells[e.id]; });
    S.staffSel = null; render();
  }

  // ================================================================ TIME OFF & GOOGLE
  function viewPto() {
    const g = S.info.google || {}, m = S.data.ptoMeta, gs = S.data.settings.google, emps = S.data.employees.filter(e => e.location !== 'Support');
    const nm = id => (S.data.employees.find(e => e.id === id) || { name: '(deleted)' }).name;
    let gbox;
    if (!g.configured) gbox = `<p>Google Calendar is not set up on this computer yet. This is a one-time step: paste the Client ID your administrator created (see <b>GOOGLE-SETUP.txt</b> in the app folder). Everything else in the app works without it.</p>
      <div class="fields"><label>Client ID<input type="text" id="gClientId" placeholder="123…apps.googleusercontent.com"></label><label>Client secret<input type="text" id="gClientSecret"></label></div><p><button class="btn primary" data-act="g-saveclient">Save</button></p>`;
    else if (!g.connected) gbox = `<p>Not connected. Connecting opens your web browser so you can sign in to Google and allow <b>read-only</b> access to your calendar. Requires internet.</p><p><button class="btn primary" data-act="g-connect" ${S.busy ? 'disabled' : ''}>${S.busy === 'connect' ? 'Waiting for browser…' : 'Connect Google Calendar'}</button></p>`;
    else gbox = `<p>✓ Connected${g.account ? ' as <b>' + esc(g.account) + '</b>' : ''}. Access is read-only. The sign-in is stored encrypted on this computer only and is never included in exports.</p>
      <div class="row"><button class="btn" data-act="g-cals" ${S.busy ? 'disabled' : ''}>${S.cals ? 'Reload calendar list' : 'Choose calendars'}</button><button class="btn danger sm" data-act="g-disconnect">Disconnect</button></div>
      ${S.cals ? `<div style="margin:8px 0">${S.cals.map(c => `<label class="chk" style="display:flex"><input type="checkbox" data-cal="${esc(c.id)}" ${gs.calendarIds.includes(c.id) ? 'checked' : ''}> ${esc(c.name)}${c.primary ? ' (primary)' : ''}</label>`).join('')}</div>` : (gs.calendarIds.length ? `<p class="muted">Using ${gs.calendarIds.length} calendar(s): ${gs.calendarIds.map(esc).join(', ')}</p>` : '<p class="muted">No calendar chosen yet. Click “Choose calendars”.</p>')}
      <div class="fields"><label>Words that mark time off<input type="text" data-g="keywords" value="${esc(gs.keywords)}"></label>
        <label class="chk"><input type="checkbox" data-g="requireKeyword" ${gs.requireKeyword ? 'checked' : ''}> Only count events containing those words</label>
        <label>Look back (days)<input type="number" min="0" max="60" data-g="daysBack" value="${gs.daysBack}"></label><label>Look ahead (days)<input type="number" min="14" max="400" data-g="daysAhead" value="${gs.daysAhead}"></label></div>
      <p class="muted">An all-day event whose title contains an employee's name (e.g. “Brendan – PTO”) becomes time off for those dates. Timed events (appointments) are ignored.</p>
      <p><button class="btn primary" data-act="g-refresh" ${S.busy ? 'disabled' : ''}>${S.busy === 'refresh' ? 'Refreshing…' : 'Refresh time off now'}</button></p>`;
    const status = `<table class="plain"><tr><td>Last successful refresh</td><td><b>${m.lastRefreshed ? esc(fmtDT(m.lastRefreshed)) + ' (' + esc(ago(m.lastRefreshed)) + ')' : 'never'}</b></td></tr>
      <tr><td>Last attempt</td><td>${m.lastAttempt ? esc(fmtDT(m.lastAttempt)) : 'never'}</td></tr>
      ${m.lastError ? `<tr><td>Problem</td><td style="color:var(--err)"><b>${esc(m.lastError)}</b><br>Your existing time-off records were kept.</td></tr>` : ''}
      ${m.lastSummary ? `<tr><td>Last result</td><td>${esc(m.lastSummary)}</td></tr>` : ''}</table>
      <p class="muted">Time off is stored on this computer. Without internet you can still schedule using what was last imported; it may not include newer requests.</p>`;
    const list = [...S.data.pto].sort((a, b) => b.start.localeCompare(a.start));
    const ptoRows = list.map(p => `<tr><td>${esc(nm(p.empId))}</td><td>${p.type === 'work' ? '<b>Works</b>' : 'Off'}</td><td>${esc(p.start)}</td><td>${esc(p.end)}</td><td>${p.source === 'google' ? 'Google Calendar' : 'Entered here'}</td><td>${esc(p.note || '')}</td><td>${p.source === 'google' ? '' : `<button class="btn sm danger" data-act="del-pto" data-id="${esc(p.id)}">Remove</button>`}</td></tr>`).join('');
    const un = (m.unmatched || []).slice(0, 30);
    return `<div class="page">
      <div class="card"><h3>Google Calendar</h3>${gbox}</div>
      <div class="card"><h3>Refresh status</h3>${status}</div>
      <div class="card"><h3>Time off on file (${list.length})</h3>
        <div class="row" style="margin-bottom:8px"><select id="pEmp">${emps.map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}</select><input type="date" id="pFrom" aria-label="From"><input type="date" id="pTo" aria-label="To"><select id="pType" aria-label="Type"><option value="off">Off</option><option value="work">Works</option></select><input type="text" id="pNote" placeholder="Note (optional)"><button class="btn" data-act="add-pto">Add time off</button></div>
        <table class="plain"><thead><tr><th>Employee</th><th>Type</th><th>From</th><th>To</th><th>Source</th><th>Note</th><th></th></tr></thead><tbody>${ptoRows || '<tr><td colspan="7" class="muted">No time off recorded.</td></tr>'}</tbody></table>
        <p class="muted">“Works” entries (calendar titles like “Brendan Works”) are extra work days, not time off: availability is ignored for that day and Auto-fill schedules the person.</p></div>
      ${un.length ? `<div class="card"><h3>Calendar events that were not matched to an employee</h3><table class="plain"><tbody>${un.map(u => `<tr><td>${esc(u.start)}</td><td>${esc(u.summary)}</td><td class="muted">${esc(u.reason)}</td></tr>`).join('')}</tbody></table><p class="muted">If one of these is someone's time off, make sure their name in the Staff tab matches the event title.</p></div>` : ''}</div>`;
  }
  async function gRefresh() {
    S.busy = 'refresh'; render();
    try {
      const r = await api.google.fetchPto(S.data.employees.map(e => ({ id: e.id, name: e.name, active: e.active })), S.data.settings);
      edit(d => {
        d.pto = d.pto.filter(p => p.source !== 'google').concat(r.pto);
        d.ptoMeta = { ...d.ptoMeta, lastRefreshed: r.at, lastAttempt: r.at, lastError: null, unmatched: r.unmatched.slice(0, 100),
          lastSummary: `${r.pto.length} time-off entr${r.pto.length === 1 ? 'y' : 'ies'} from ${r.eventCount} calendar event(s)${r.ignoredTimed ? `; ${r.ignoredTimed} timed event(s) ignored` : ''}.` };
      });
      toast('Time off refreshed from Google Calendar.');
    } catch (e) {
      edit(d => { d.ptoMeta = { ...d.ptoMeta, lastAttempt: new Date().toISOString(), lastError: e.message }; });
    }
    S.busy = ''; S.info.google = await api.google.status(); render();
  }
  async function gConnect() {
    S.busy = 'connect'; render();
    try { S.info.google = await api.google.connect(); toast('Google Calendar connected.'); S.busy = ''; render(); await gCals(); }
    catch (e) { S.busy = ''; render(); alertBox('Could not connect', esc(e.message)); }
  }
  async function gCals() {
    S.busy = 'cals'; render();
    try { S.cals = await api.google.calendars(); if (!S.data.settings.google.calendarIds.length) { const p = S.cals.find(c => c.primary); if (p) edit(d => { d.settings.google.calendarIds = [p.id]; }); } }
    catch (e) { alertBox('Could not load calendars', esc(e.message)); }
    S.busy = ''; render();
  }

  // ================================================================ STORE RULES
  function viewRules() {
    const s = S.data.settings;
    const loc = LOCS().map(name => {
      const l = s.locations[name];
      const rows = L.DAYS.map((dk, i) => { const h = l.hours[dk] || { open: '', close: '' }; return `<tr><td>${L.DAY_NAMES[i]}</td>
        <td><input type="checkbox" data-hr="${name}|${dk}|closed" ${h.closed ? 'checked' : ''} aria-label="Closed"></td>
        <td><input type="text" data-hr="${name}|${dk}|open" value="${esc(h.open)}"></td><td><input type="text" data-hr="${name}|${dk}|close" value="${esc(h.close)}"></td>
        <td><input type="text" data-hr="${name}|${dk}|shift" value="${esc((l.defaultShift || {})[dk] || '')}"></td></tr>`; }).join('');
      return `<div class="card"><h3>${esc(name)}</h3><div class="fields" style="margin-bottom:8px">
        <label>Minimum people on the floor<input type="number" min="0" max="20" data-lc="${name}|minStaff" value="${l.minStaff}"></label>
        <label>Warehouse people required<input type="number" min="0" max="9" data-lc="${name}|minWarehouse" value="${l.minWarehouse}"></label>
        <label>Showroom people required<input type="number" min="0" max="9" data-lc="${name}|minShowroom" value="${l.minShowroom}"></label></div>
        <table class="plain"><thead><tr><th>Day</th><th>Closed</th><th>Opens</th><th>Closes</th><th>Default shift</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    }).join('');
    return `<div class="page"><p class="muted" style="margin-top:0">These rules drive the coverage checks, Auto-fill and the publish rule. Missing Warehouse or Showroom coverage blocks publishing; low headcount is a warning.</p>${loc}
      <div class="card"><h3>General</h3><div class="fields">
        <label>Unpaid lunch for shifts of 6+ hours (minutes)<input type="number" min="0" max="120" data-gs="lunchMinutes" value="${s.lunchMinutes ?? 30}"></label>
        <label>Unpaid lunch for shifts of 9+ hours, e.g. 8-5 (minutes)<input type="number" min="0" max="180" data-gs="longLunchMinutes" value="${s.longLunchMinutes ?? 60}"></label>
        <label class="chk"><input type="checkbox" data-gs="warnLongDay" ${s.warnLongDay !== false ? 'checked' : ''}> Warn when one person is scheduled over the daily hours below</label>
        <label>Daily paid-hours limit for that warning<input type="number" min="1" max="24" step="0.5" data-gs="maxDayHours" value="${s.maxDayHours ?? 8}"></label>
        <label class="chk"><input type="checkbox" data-gs="warnSixDays" ${s.warnSixDays !== false ? 'checked' : ''}> Warn when one person is scheduled 6 days in a row</label>
        <label>“IN LATE” counts as starting (minutes after opening)<input type="number" min="0" max="480" data-gs="lateStartMinutes" value="${s.lateStartMinutes}"></label>
        <label>Ignore headcount in first/last (minutes)<input type="number" min="0" max="180" data-gs="rampMinutes" value="${s.rampMinutes ?? 60}"></label>
        <label>Automatic backups to keep<input type="number" min="5" max="200" data-gs="backupKeep" value="${s.backupKeep}"></label>
        <label>Printed title<input type="text" data-gs="printTitle" value="${esc(s.printTitle)}"></label>
        <label>Printed note<input type="text" data-gs="printNote" value="${esc(s.printNote)}"></label></div></div></div>`;
  }

  // ================================================================ DATA & BACKUPS
  function viewData() {
    const b = S.info.backups || [];
    return `<div class="page">
      <div class="card"><h3>Where your data lives</h3>
        <p>Everything (staff, availability, time off, schedules, settings) is saved automatically in this folder on <b>this computer</b>:</p>
        <p><code>${esc(S.info.dataDir)}</code> <button class="btn sm" data-act="open-folder">Open folder</button></p>
        <p class="muted">Other computers have their own separate copies. Changes do not appear on another computer unless you export here and import there.</p></div>
      <div class="card"><h3>Move to another computer</h3>
        <div class="row"><button class="btn primary" data-act="export">Export All Data…</button><button class="btn" data-act="import">Import Data…</button></div>
        <p class="muted">Export saves one file containing employees, settings, time off and schedules. Copy it (USB stick, email, cloud drive) to the other computer, open the app there and click Import Data. Google sign-in is <b>not</b> included; reconnect Google Calendar on the new computer.</p></div>
      <div class="card"><h3>Backups</h3>
        <div class="row"><button class="btn" data-act="backup-now">Back up now</button><span class="muted">Automatic backups are made when the app starts and closes, and every few hours if something changed. The newest ${S.data.settings.backupKeep} are kept.</span></div>
        <table class="plain" style="margin-top:8px"><thead><tr><th>When</th><th>Why</th><th>Size</th><th></th></tr></thead><tbody>
        ${b.map(x => `<tr><td>${esc(new Date(x.time).toLocaleString())}</td><td>${esc(x.reason)}</td><td>${Math.max(1, Math.round(x.size / 1024))} KB</td><td><button class="btn sm" data-act="restore" data-name="${esc(x.name)}">Restore…</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No backups yet.</td></tr>'}</tbody></table></div>
      <div class="card"><h3>Updates</h3>
        <div class="row"><button class="btn" data-act="upd-check">Check for updates</button>${S.upd && ['available', 'ready'].includes(S.upd.status) ? '<button class="btn primary" data-act="upd-install">Update now</button>' : ''}${S.upd && S.upd.status === 'manual' ? '<button class="btn" data-act="upd-page">Open download page</button>' : ''}<span class="muted" id="updText">${updText()}</span></div>
        <p class="muted">The app checks for a newer version when it starts (needs internet) and only updates when you click. Your data, backups and Google sign-in are not touched.</p></div>
      <p class="muted">Santa Rosa Tile Scheduler ${esc(S.info.version)}</p></div>`;
  }
  const countRow = (label, cur, inc) => `<tr><td>${label}</td><td>${cur}</td><td class="${String(cur) !== String(inc) ? 'chg' : ''}">${inc}</td></tr>`;
  async function doExport() {
    try { await flush(); const r = await api.exportAll(S.data, `SRTS Scheduler backup ${L.iso(new Date())}.srts.json`); if (!r.canceled) alertBox('Export complete', `<p>Saved to:</p><p><code>${esc(r.file)}</code></p><p class="muted">Copy this file to the other computer and use Import Data there.</p>`); }
    catch (e) { alertBox('Export failed', esc(e.message)); }
  }
  async function doImport() {
    try {
      await flush();
      const p = await api.importPick(S.data); if (p.canceled) return;
      const a = p.current, b = p.incoming;
      const ok = await confirmBox('Replace this computer\'s data?', `<p>File exported ${p.exportedAt ? esc(fmtDT(p.exportedAt)) : '(date unknown)'}. Importing will <b>replace</b> the following with the contents of the file:</p>
        <table class="cmp"><tr><th></th><th>On this computer now</th><th>In the file</th></tr>
        ${countRow('Employees', a.employees, b.employees)}${countRow('Schedules (weeks)', a.schedules, b.schedules)}${countRow('Published weeks', a.published, b.published)}${countRow('Time-off records', a.pto, b.pto)}
        ${countRow('Time off last refreshed', a.ptoRefreshed ? esc(fmtDT(a.ptoRefreshed)) : 'never', b.ptoRefreshed ? esc(fmtDT(b.ptoRefreshed)) : 'never')}${countRow('Settings', 'current', 'from file')}</table>
        <p>Your current data is <b>backed up first</b> and can be restored from the Backups list. Your Google sign-in on this computer is not touched.</p>`, 'Replace with file', 'danger');
      if (!ok) return;
      const r = await api.importApply(p.file);
      S.data = r.data; S.info.backups = r.backups; S.staffSel = null; S.cals = null; S.save = { state: 'saved', at: new Date().toISOString() };
      render(); alertBox('Import complete', `<p>Data replaced from the file. Your previous data was saved as a backup.</p><p class="muted">If you use Google Calendar on this computer, go to Time off &amp; Google and click Refresh.</p>`);
    } catch (e) { alertBox('Import failed', `<p>${esc(e.message)}</p><p>Nothing was changed.</p>`); }
  }
  async function doRestore(name) {
    const b = (S.info.backups || []).find(x => x.name === name); if (!b) return;
    if (!await confirmBox('Restore this backup?', `<p>Restore the data saved <b>${esc(new Date(b.time).toLocaleString())}</b> (${esc(b.reason)})?</p><p>Your current data is backed up first, so this can be undone.</p>`, 'Restore', 'danger')) return;
    try { await flush(); const r = await api.restoreBackup(name); S.data = r.data; S.info.backups = r.backups; S.staffSel = null; S.save = { state: 'saved', at: new Date().toISOString() }; render(); toast('Backup restored.'); }
    catch (e) { alertBox('Restore failed', `<p>${esc(e.message)}</p><p>Nothing was changed.</p>`); }
  }

  // ================================================================ events
  document.addEventListener('click', async ev => {
    const t = ev.target.closest('[data-act],[data-tab]'); if (!t) return;
    if (t.dataset.tab) { S.tab = t.dataset.tab; S.focusKey = null; return render(); }
    const a = t.dataset.act;
    switch (a) {
      case 'dismiss-notice': S.notice = null; return render();
      case 'dismiss-seed': edit(d => { d.meta.seeded = false; }); return render();
      case 'go-pto': S.tab = 'pto'; return render();
      case 'week-prev': S.week = L.addDays(S.week, -7); return render();
      case 'week-next': S.week = L.addDays(S.week, 7); return render();
      case 'week-today': S.week = L.mondayOf(L.iso(new Date())); return render();
      case 'autofill': return autofill();
      case 'copy-last': return copyLast();
      case 'clear-week': return clearWeek();
      case 'publish': return publish();
      case 'reopen': return reopen();
      case 'print': return doPrint();
      case 'pdf': return doPdf();
      case 'sel-emp': S.staffSel = t.dataset.id; return render();
      case 'add-emp': { const e = { id: L.newId('e'), name: 'New employee', location: LOCS()[0], active: true, canWarehouse: true, canShowroom: true, keyholder: false, targetDays: 5, maxDays: 6, maxHours: 0, availability: {} }; edit(d => d.employees.push(e)); S.staffSel = e.id; return render(); }
      case 'del-emp': return delEmp();
      case 'g-saveclient': try { S.info.google = await api.google.saveClient($('#gClientId').value, $('#gClientSecret').value); render(); } catch (e) { alertBox('Could not save', esc(e.message)); } return;
      case 'g-connect': return gConnect();
      case 'g-cals': return gCals();
      case 'g-refresh': return gRefresh();
      case 'g-disconnect': if (await confirmBox('Disconnect Google Calendar?', '<p>The sign-in is removed from this computer. Time off already imported stays on file.</p>', 'Disconnect', 'danger')) { S.info.google = await api.google.disconnect(); S.cals = null; render(); } return;
      case 'add-pto': {
        const empId = $('#pEmp').value, from = $('#pFrom').value, to = $('#pTo').value || from;
        if (!empId || !from) return alertBox('Missing information', '<p>Choose an employee and a start date.</p>');
        if (to < from) return alertBox('Check the dates', '<p>The end date is before the start date.</p>');
        { const type = $('#pType').value; edit(d => d.pto.push({ id: L.newId('p'), source: 'manual', type, empId, start: from, end: to, note: $('#pNote').value.trim() || (type === 'work' ? 'Works' : 'PTO') })); } return render();
      }
      case 'del-pto': edit(d => { d.pto = d.pto.filter(p => p.id !== t.dataset.id); }); return render();
      case 'upd-check': return checkUpdates(true);
      case 'upd-install': return installUpdate();
      case 'upd-page': return api.update.page();
      case 'open-folder': return api.openDataFolder();
      case 'export': return doExport();
      case 'import': return doImport();
      case 'backup-now': S.info.backups = await api.backupNow(); render(); return toast('Backup created.');
      case 'restore': return doRestore(t.dataset.name);
    }
  });
  document.addEventListener('change', ev => {
    const el = ev.target;
    if (el.id === 'weekPick') { if (el.value) { S.week = L.mondayOf(el.value); render(); } return; }
    if (el.dataset.cell) return commitCell(el);
    if (el.dataset.sup) { edit(() => { const w = ensureWeek(); w.support[el.dataset.sup] = el.value.trim(); stampWeek(w); }); return; }
    if (el.dataset.f) return setEmpField(el);
    if (el.dataset.av || el.dataset.pref) return setAvail(el);
    if (el.dataset.cal) { edit(d => { const s = new Set(d.settings.google.calendarIds); el.checked ? s.add(el.dataset.cal) : s.delete(el.dataset.cal); d.settings.google.calendarIds = [...s]; }); return; }
    if (el.dataset.g) { const k = el.dataset.g; edit(d => { d.settings.google[k] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? +el.value : el.value; }); return; }
    if (el.dataset.gs) { const k = el.dataset.gs; edit(d => { d.settings[k] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Math.max(0, +el.value || 0) : el.value; }); return; }
    if (el.dataset.lc) { const [loc, k] = el.dataset.lc.split('|'); edit(d => { d.settings.locations[loc][k] = Math.max(0, +el.value || 0); }); return; }
    if (el.dataset.hr) {
      const [loc, dk, f] = el.dataset.hr.split('|'), l = S.data.settings.locations[loc];
      if (f === 'closed') edit(() => { (l.hours[dk] ||= { open: '8', close: '5' }).closed = el.checked; });
      else if (f === 'shift') { const v = el.value.trim(); if (v && L.parseCell(v).kind !== 'shift') { toast('Use a shift like 8-5.'); return render(); } edit(() => { (l.defaultShift ||= {})[dk] = v ? normalizeCell(v) : ''; }); }
      else { const v = el.value.trim(); if (L.parseClock(v, f === 'close', 0) == null) { toast('Use a time like 8 or 7:30.'); return render(); } edit(() => { (l.hours[dk] ||= {})[f] = v; }); }
      return render();
    }
  });
  document.addEventListener('focusin', ev => { const k = ev.target.dataset && ev.target.dataset.key; if (k) S.focusKey = k; });
  document.addEventListener('keydown', ev => {
    const el = ev.target;
    if (!(el.dataset && el.dataset.cell !== undefined) || !['Enter', 'ArrowDown', 'ArrowUp'].includes(ev.key)) return;
    ev.preventDefault();
    const col = $$(`input[data-cell$="|${el.dataset.cell.split('|')[1]}"]`), i = col.indexOf(el);
    const next = col[i + (ev.key === 'ArrowUp' ? -1 : 1)];
    if (next) { next.focus(); next.select(); }
  });
  document.addEventListener('blur', ev => { if (ev.target.dataset && ev.target.dataset.key) setTimeout(() => { if (!document.activeElement || !document.activeElement.dataset.key) S.focusKey = null; }, 50); }, true);

  // ================================================================ boot
  (async () => {
    try {
      const r = await api.load();
      S.data = r.data; S.notice = r.notice; S.info = { dataDir: r.dataDir, version: r.version, backups: r.backups, google: r.google };
      S.save = { state: 'saved', at: new Date().toISOString() };
      // jump to the newest saved week if "this week" has nothing yet
      render();
      if (r.autoUpdateCheck) checkUpdates(false);
    } catch (e) { $('#view').innerHTML = `<div class="card"><h3>The app could not start</h3><p>${esc(e.message)}</p></div>`; }
  })();
})();
