/* Pure scheduling logic. Runs in the app window and in Node tests (UMD). No I/O here. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Logic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const STEP = 30; // coverage is checked in 30-minute blocks

  // ---------- dates (all local, as yyyy-mm-dd strings) ----------
  const pad = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, n) => { const d = parseISO(s); d.setDate(d.getDate() + n); return iso(d); };
  const mondayOf = s => { const d = parseISO(s); const k = (d.getDay() + 6) % 7; d.setDate(d.getDate() - k); return iso(d); };
  const weekDates = monday => DAYS.map((_, i) => addDays(monday, i));
  const dayLabel = s => { const d = parseISO(s); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
  const weekIndex = monday => Math.floor(parseISO(monday).getTime() / (7 * 864e5));

  // ---------- times ----------
  const fmtTime = m => { const h = Math.floor(m / 60), mm = m % 60; return mm ? `${h > 12 ? h - 12 : h}:${pad(mm)}` : `${h > 12 ? h - 12 : h}`; };
  function parseClock(str, isEnd, startMin) {
    const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(str.trim());
    if (!m) return null;
    let h = +m[1]; const mi = m[2] ? +m[2] : 0;
    if (h > 23 || mi > 59) return null;
    if (h < 7) h += 12;                       // 1-6 is always afternoon in a store schedule
    let t = h * 60 + mi;
    if (isEnd && startMin != null && t <= startMin) t += 12 * 60;
    return t;
  }
  /** Parse a grid cell. Returns {kind:'blank'|'off'|'pto'|'late'|'shift'|'invalid', start, end, openEnded} */
  function parseCell(text) {
    const t = (text || '').trim();
    if (!t) return { kind: 'blank' };
    const u = t.toUpperCase();
    if (u === 'OFF') return { kind: 'off' };
    if (u === 'PTO') return { kind: 'pto' };
    if (u === 'IN LATE' || u === 'LATE') return { kind: 'late' };
    const parts = t.replace(/\s+/g, '').split(/[-–—]/);
    if (parts.length === 1) {
      const s = parseClock(parts[0], false);
      if (s == null) return { kind: 'invalid' };
      return { kind: 'shift', start: s, end: null, openEnded: true };
    }
    if (parts.length === 2) {
      const s = parseClock(parts[0], false); if (s == null) return { kind: 'invalid' };
      const e = parseClock(parts[1], true, s); if (e == null || e <= s) return { kind: 'invalid' };
      return { kind: 'shift', start: s, end: e, openEnded: false };
    }
    return { kind: 'invalid' };
  }
  /** Resolve a parsed cell to concrete minutes for a given store day. */
  function resolveShift(p, hours, settings) {
    if (p.kind === 'late') return { start: Math.min(hours.close, hours.open + (settings.lateStartMinutes || 90)), end: hours.close };
    if (p.kind === 'shift') return { start: p.start, end: p.openEnded ? hours.close : p.end };
    return null;
  }
  function paidHours(sh, settings) {
    if (!sh) return 0;
    const span = (sh.end - sh.start) / 60;
    // unpaid lunch: 30 min once a shift reaches 6 hours, a full hour once it reaches 9 hours (e.g. 8-5)
    const long = span >= (settings.longLunchAfterHours ?? 9), mid = span >= (settings.lunchAfterHours ?? 6);
    const lunch = long ? (settings.longLunchMinutes ?? 60) : mid ? (settings.lunchMinutes ?? 30) : 0;
    return Math.max(0, span - lunch / 60);
  }

  // ---------- PTO ----------
  // Calendar entries are either time off (default) or "works": an extra day the person is scheduled to work.
  function ptoOn(pto, empId, date) {
    return (pto || []).find(p => p.type !== 'work' && p.empId === empId && p.start <= date && date <= p.end) || null;
  }
  function workOn(pto, empId, date) {
    return (pto || []).find(p => p.type === 'work' && p.empId === empId && p.start <= date && date <= p.end) || null;
  }

  // ---------- availability ----------
  function availFor(emp, dayKey) {
    const a = (emp.availability || {})[dayKey] || {};
    return { available: a.available !== false, earliest: a.earliest || '', latest: a.latest || '', shift: a.shift || '' };
  }
  function availWindow(emp, dayKey) {
    const a = availFor(emp, dayKey);
    return {
      available: a.available,
      earliest: a.earliest ? parseClock(a.earliest, false) : null,
      latest: a.latest ? parseClock(a.latest, true, 0) : null,
    };
  }

  // ---------- store hours ----------
  function hoursFor(settings, loc, dayKey) {
    const l = (settings.locations[loc] || {});
    const h = (l.hours || {})[dayKey];
    if (!h || h.closed) return null;
    return { open: parseClock(h.open, false), close: parseClock(h.close, true, 0), minStaff: l.minStaff || 1, minWarehouse: l.minWarehouse ?? 1, minShowroom: l.minShowroom ?? 1 };
  }

  /** Build a lookup of everything validation / autofill needs for one week. */
  function weekGrid(week, employees, pto, settings) {
    const dates = weekDates(week.start);
    const rows = [];
    for (const e of employees) {
      if (!e.active || e.location === 'Support') continue;
      const cells = DAYS.map((dk, i) => {
        const raw = ((week.cells || {})[e.id] || {})[dk] || '';
        const p = parseCell(raw);
        const hours = hoursFor(settings, e.location, dk);
        const sh = hours ? resolveShift(p, hours, settings) : null;
        return { dk, date: dates[i], raw, parsed: p, hours, shift: sh, pto: ptoOn(pto, e.id, dates[i]), work: workOn(pto, e.id, dates[i]) };
      });
      rows.push({ emp: e, cells });
    }
    return { dates, rows };
  }

  /**
   * Position coverage for one half-hour slot. `people` = [{canWarehouse, canShowroom}] on the floor.
   * Someone qualified for both can fill either position, but only one at a time.
   */
  function slotCoverage(people, minW, minS) {
    const wo = people.filter(p => p.canWarehouse && !p.canShowroom).length;
    const so = people.filter(p => p.canShowroom && !p.canWarehouse).length;
    const both = people.filter(p => p.canWarehouse && p.canShowroom).length;
    const dw = Math.max(0, minW - wo), ds = Math.max(0, minS - so);
    const ok = dw + ds <= both;
    return { ok, wShort: !ok && dw > 0, sShort: !ok && ds > 0, n: people.length };
  }
  /** Warehouse / Showroom coverage and lowest headcount for one location-day, from weekGrid rows. */
  function coverageOf(locRows, i, hours, ramp = 0) {
    const on = locRows.map(r => ({ r, c: r.cells[i] })).filter(x => x.c.shift && !x.c.pto);
    let min = Infinity, minAt = hours.open, wShort = false, sShort = false, posAt = null;
    // judged after the opening ramp-up and before the closing wind-down, so people arriving/leaving don't trigger noise
    for (let t = hours.open + ramp; t + STEP <= hours.close - ramp; t += STEP) {
      const here = on.filter(x => x.c.shift.start <= t && x.c.shift.end >= t + STEP).map(x => x.r.emp);
      const sc = slotCoverage(here, hours.minWarehouse, hours.minShowroom);
      if (here.length < min) { min = here.length; minAt = t; }
      if (!sc.ok && posAt == null) posAt = t;
      wShort = wShort || sc.wShort; sShort = sShort || sc.sShort;
    }
    // A keyholder must be there at opening and at closing. Not enforced until someone at the location is marked keyholder.
    const keys = on.filter(x => x.r.emp.keyholder);
    const keyTracked = locRows.some(r => r.emp.keyholder);
    const keyOpenOk = !keyTracked || keys.some(x => x.c.shift.start <= hours.open);
    const keyCloseOk = !keyTracked || keys.some(x => x.c.shift.end >= hours.close);
    return { warehouseOk: !wShort, showroomOk: !sShort, posAt, min: min === Infinity ? 99 : min, minAt, keyTracked, keyOpenOk, keyCloseOk };
  }

  // ---------- validation ----------
  /** Returns [{severity:'error'|'warn', day:0-5|null, empId, loc, msg}] */
  function validate(week, employees, pto, settings) {
    const issues = [];
    const add = (severity, day, e, loc, msg) => issues.push({ severity, day, empId: e ? e.id : null, loc: loc || (e && e.location) || null, msg });
    const { rows } = weekGrid(week, employees, pto, settings);
    const dayTag = i => DAY_NAMES[i];

    for (const r of rows) {
      const e = r.emp; let hrs = 0, worked = 0;
      r.cells.forEach((c, i) => {
        const k = c.parsed.kind;
        if (k === 'blank') return add('error', i, e, null, `${e.name} ${dayTag(i)}: nothing entered (use OFF, PTO or a shift).`);
        if (k === 'invalid') return add('error', i, e, null, `${e.name} ${dayTag(i)}: "${c.raw}" is not a valid entry.`);
        const aw = availWindow(e, c.dk);
        const working = k === 'shift' || k === 'late';
        if (c.pto && working) add('error', i, e, null, `${e.name} ${dayTag(i)}: scheduled but has PTO (${c.pto.note || 'time off'}).`);
        if (c.pto && k === 'off') add('warn', i, e, null, `${e.name} ${dayTag(i)}: has PTO but is marked OFF; mark it PTO so it is tracked.`);
        if (c.work && !working) add('warn', i, e, null, `${e.name} ${dayTag(i)}: the calendar says they work this day, but they are not scheduled.`);
        if (!working) return;
        if (!c.hours) return add('error', i, e, null, `${e.name} ${dayTag(i)}: scheduled while ${e.location} is closed.`);
        worked++; const ph = paidHours(c.shift, settings); hrs += ph;
        const dayMax = settings.maxDayHours ?? 8;
        if (dayMax && ph > dayMax + 1e-9) add('warn', i, e, null, `${e.name} ${dayTag(i)}: ${+ph.toFixed(2)} hours scheduled in one day (over ${dayMax}).`);
        if (c.work) { /* the calendar explicitly says they work this day, so normal availability does not apply */ }
        else if (!aw.available) add('error', i, e, null, `${e.name} ${dayTag(i)}: not available this day.`);
        else {
          if (aw.earliest != null && c.shift.start < aw.earliest) add('error', i, e, null, `${e.name} ${dayTag(i)}: starts before their earliest time (${e.availability[c.dk].earliest}).`);
          if (aw.latest != null && c.shift.end > aw.latest) add('error', i, e, null, `${e.name} ${dayTag(i)}: works past their latest time (${e.availability[c.dk].latest}).`);
        }
        if (c.shift.start < c.hours.open - 30 || c.shift.end > c.hours.close + 30) add('warn', i, e, null, `${e.name} ${dayTag(i)}: shift falls well outside store hours.`);
      });
      let run = 0, best = 0;
      r.cells.forEach(c => { run = (c.parsed.kind === 'shift' || c.parsed.kind === 'late') && c.hours ? run + 1 : 0; best = Math.max(best, run); });
      if (best >= 6) add('warn', null, e, null, `${e.name}: scheduled ${best} days in a row (Monday to Saturday with no day off).`);
      if (e.maxDays && worked > e.maxDays) add('warn', null, e, null, `${e.name}: ${worked} days scheduled (max ${e.maxDays}).`);
      if (e.maxHours && hrs > e.maxHours) add('warn', null, e, null, `${e.name}: ${hrs.toFixed(1)} hours scheduled (max ${e.maxHours}).`);
    }

    // coverage per location per day
    const locs = Object.keys(settings.locations);
    for (const loc of locs) {
      const locRows = rows.filter(r => r.emp.location === loc);
      DAYS.forEach((dk, i) => {
        const hours = hoursFor(settings, loc, dk);
        if (!hours) return;
        const cv = coverageOf(locRows, i, hours, settings.rampMinutes || 0);
        if (!cv.warehouseOk || !cv.showroomOk) {
          const what = !cv.warehouseOk && !cv.showroomOk ? 'Warehouse and Showroom' : !cv.warehouseOk ? 'Warehouse' : 'Showroom';
          add('error', i, null, loc, `${loc} ${dayTag(i)}: not enough ${what} coverage at ${fmtTime(cv.posAt)} (needs ${hours.minWarehouse} Warehouse + ${hours.minShowroom} Showroom).`);
        }
        if (!cv.keyOpenOk) add('error', i, null, loc, `${loc} ${dayTag(i)}: no keyholder at opening (${fmtTime(hours.open)}).`);
        if (!cv.keyCloseOk) add('error', i, null, loc, `${loc} ${dayTag(i)}: no keyholder at closing (${fmtTime(hours.close)}).`);
        if (cv.min < hours.minStaff) add('warn', i, null, loc, `${loc} ${dayTag(i)}: only ${cv.min} on the floor at ${fmtTime(cv.minAt)} (minimum ${hours.minStaff}).`);
      });
    }
    return issues;
  }

  // ---------- auto-schedule ----------
  /**
   * Fills week.cells. opts.onlyEmpty keeps anything already typed.
   * Returns {cells, notes[]}. Always re-run validate() afterwards.
   */
  function autoSchedule(week, employees, pto, settings, opts = {}) {
    const notes = [];
    const dates = weekDates(week.start);
    const cells = JSON.parse(JSON.stringify(week.cells || {}));
    const wi = weekIndex(week.start);
    const staff = employees.filter(e => e.active && e.location !== 'Support');
    const locked = (e, dk) => opts.onlyEmpty && ((cells[e.id] || {})[dk] || '').trim() !== '';
    const set = (e, dk, v) => { (cells[e.id] = cells[e.id] || {})[dk] = v; };

    for (const loc of Object.keys(settings.locations)) {
      const group = staff.filter(e => e.location === loc).sort((a, b) => a.name.localeCompare(b.name));
      if (!group.length) continue;
      // rotate who gets trimmed first so days off shift from week to week
      const order = group.map((e, i) => group[(i + wi) % group.length]);
      const state = {}; // empId -> {dk: 'work'|'off'|'pto'|'fixed'}
      const forced = {}; // "empId:dk" -> true when the calendar says this person works that day
      for (const e of group) {
        state[e.id] = {};
        DAYS.forEach((dk, i) => {
          const h = hoursFor(settings, loc, dk);
          const aw = availWindow(e, dk);
          const pt = ptoOn(pto, e.id, dates[i]);
          if (locked(e, dk)) state[e.id][dk] = 'fixed';
          else if (pt) { state[e.id][dk] = 'pto'; set(e, dk, 'PTO'); }
          else if (h && workOn(pto, e.id, dates[i])) { state[e.id][dk] = 'work'; forced[e.id + ':' + dk] = true; }
          else if (!h || !aw.available) { state[e.id][dk] = 'off'; set(e, dk, 'OFF'); }
          else state[e.id][dk] = 'work';
        });
      }
      const shiftFor = (e, dk) => {
        const h = hoursFor(settings, loc, dk);
        const a = availFor(e, dk);
        const lh = (settings.locations[loc].defaultShift || {})[dk] || `${fmtTime(h.open)}-${fmtTime(h.close)}`;
        let txt = a.shift || lh;
        let p = parseCell(txt);
        if (p.kind !== 'shift') p = parseCell(lh);
        const aw = availWindow(e, dk);
        let s = p.start, en = p.openEnded ? h.close : p.end;
        if (aw.earliest != null && s < aw.earliest) s = aw.earliest;
        if (aw.latest != null && en > aw.latest) en = aw.latest;
        if (en <= s) return null;
        return { start: s, end: en };
      };
      const sh = {}; // empId -> dk -> {start,end}
      group.forEach(e => { sh[e.id] = {}; DAYS.forEach(dk => { if (state[e.id][dk] === 'work') sh[e.id][dk] = shiftFor(e, dk); if (!sh[e.id][dk] && state[e.id][dk] === 'work') state[e.id][dk] = 'off'; }); });
      const working = (e, dk) => state[e.id][dk] === 'work' ? sh[e.id][dk] : (state[e.id][dk] === 'fixed' ? fixedShift(e, dk) : null);
      const fixedShift = (e, dk) => { const h = hoursFor(settings, loc, dk); return h ? resolveShift(parseCell(cells[e.id][dk]), h, settings) : null; };
      const cover = dk => {
        const h = hoursFor(settings, loc, dk); if (!h) return null;
        const on = group.map(e => ({ e, s: working(e, dk) })).filter(x => x.s);
        let min = Infinity, wShort = false, sShort = false, posAt = null; const ramp = settings.rampMinutes || 0;
        for (let t = h.open + ramp; t + STEP <= h.close - ramp; t += STEP) {
          const here = on.filter(x => x.s.start <= t && x.s.end >= t + STEP).map(x => x.e);
          min = Math.min(min, here.length);
          const sc = slotCoverage(here, h.minWarehouse, h.minShowroom);
          if (!sc.ok && posAt == null) posAt = t;
          wShort = wShort || sc.wShort; sShort = sShort || sc.sShort;
        }
        const keyed = group.some(e => e.keyholder), keys = on.filter(x => x.e.keyholder);
        return { h, wShort, sShort, posAt, min: min === Infinity ? 99 : min,
          keyOpenShort: keyed && !keys.some(x => x.s.start <= h.open), keyCloseShort: keyed && !keys.some(x => x.s.end >= h.close) };
      };
      const ok = dk => { const c = cover(dk); return !c || (!c.wShort && !c.sShort && !c.keyOpenShort && !c.keyCloseShort); };
      // ---- hours: paid hours per day / week, and trimming shifts so people stay within their limits ----
      const paidOf = x => x ? paidHours(x, settings) : 0;
      const dayPaid = (e, dk) => paidOf(working(e, dk));
      const weekPaid = e => DAYS.reduce((t, dk) => t + dayPaid(e, dk), 0);
      const hoursOK = (e, dk, ns) => !e.maxHours || weekPaid(e) - dayPaid(e, dk) + paidOf(ns) <= e.maxHours + 1e-9;
      const capDay = settings.maxDayHours ?? 8;
      // shorten one auto-scheduled shift by 30 minutes (end first, then start) if coverage and keyholder rules still hold
      const shrink = (e, dk) => {
        const x = state[e.id][dk] === 'work' ? sh[e.id][dk] : null; if (!x || x.end - x.start <= 240) return false;
        for (const side of ['end', 'start']) {
          const old = x[side]; x[side] = side === 'end' ? old - STEP : old + STEP;
          if (ok(dk)) return true;
          x[side] = old;
        }
        return false;
      };
      const fitHours = report => {
        for (const e of group) {
          if (capDay) for (const dk of DAYS) while (state[e.id][dk] === 'work' && dayPaid(e, dk) > capDay + 1e-9) if (!shrink(e, dk)) break;
          if (!e.maxHours) continue;
          for (let guard = 0; guard < 60 && weekPaid(e) > e.maxHours + 1e-9; guard++) {
            let done = false;
            for (const dk of DAYS.filter(d => state[e.id][d] === 'work').sort((a, b) => dayPaid(e, b) - dayPaid(e, a))) if (shrink(e, dk)) { done = true; break; }
            if (!done) for (const dk of DAYS.filter(d => state[e.id][d] === 'work' && !forced[e.id + ':' + d])) {
              state[e.id][dk] = 'off'; if (ok(dk)) { done = true; break; } state[e.id][dk] = 'work';
            }
            if (!done) { if (report) notes.push(`${e.name}: ${+weekPaid(e).toFixed(1)} hours scheduled, over their maximum of ${e.maxHours} (cutting more would leave a coverage gap)`); break; }
          }
        }
      };

      // 1) trim to each person's target number of days, taking days off where coverage has the most slack
      for (const e of order) {
        const target = e.targetDays || 5;
        const days = () => DAYS.filter(dk => ['work', 'fixed', 'pto'].includes(state[e.id][dk]));
        while (days().length > target) {
          const cand = DAYS.filter(dk => state[e.id][dk] === 'work' && !forced[e.id + ':' + dk]);
          if (!cand.length) break;
          let best = null, bestScore = -Infinity;
          for (const dk of cand) {
            const saved = state[e.id][dk]; state[e.id][dk] = 'off';
            const safe = ok(dk); const c = cover(dk);
            const slack = c ? c.min - c.h.minStaff : 0;
            state[e.id][dk] = saved;
            const score = (safe ? 100 : 0) + slack * 10 - (DAYS.indexOf(dk) === 5 ? 3 : 0) + ((e.preferOff || []).includes(dk) ? 50 : 0);
            if (score > bestScore) { bestScore = score; best = dk; }
          }
          state[e.id][best] = 'off';
        }
      }
      fitHours(false);
      // 2) repair keyholder / Warehouse / Showroom / headcount gaps
      const days = e => DAYS.filter(dk => ['work', 'fixed', 'pto'].includes(state[e.id][dk])).length;
      DAYS.forEach((dk, i) => {
        const h = hoursFor(settings, loc, dk); if (!h) return;
        let keyGaveUp = false;
        for (let guard = 0; guard < 10; guard++) {
          const c = cover(dk);
          const needKO = c.keyOpenShort && !keyGaveUp, needKC = c.keyCloseShort && !keyGaveUp;
          if (needKO || needKC) {
            // a keyholder must open and close: first stretch a keyholder who already works, else bring one in
            let fixed = false;
            for (const strict of [true, false]) {   // first try without pushing anyone over their weekly maximum
              for (const e of group) {
                const s = e.keyholder && state[e.id][dk] === 'work' ? sh[e.id][dk] : null; if (!s) continue;
                const aw = availWindow(e, dk);
                if (needKO && s.start > h.open && (aw.earliest == null || aw.earliest <= h.open) && !(strict && !hoursOK(e, dk, { start: h.open, end: s.end }))) { s.start = h.open; fixed = true; break; }
                if (needKC && s.end < h.close && (aw.latest == null || aw.latest >= h.close) && !(strict && !hoursOK(e, dk, { start: s.start, end: h.close }))) { s.end = h.close; fixed = true; break; }
              }
              if (fixed) break;
            }
            if (fixed) continue;
            const kp = group.filter(e => e.keyholder && state[e.id][dk] === 'off' && !ptoOn(pto, e.id, dates[i]) && !locked(e, dk) && availWindow(e, dk).available && shiftFor(e, dk) &&
              days(e) < (e.maxDays || e.targetDays || 5) &&
              (!needKO || shiftFor(e, dk).start <= h.open) && (!needKC || shiftFor(e, dk).end >= h.close))
              .sort((a, b) => (hoursOK(b, dk, shiftFor(b, dk)) - hoursOK(a, dk, shiftFor(a, dk))) || (days(a) >= 5) - (days(b) >= 5) || days(a) - days(b));
            if (kp.length) { const e = kp[0]; state[e.id][dk] = 'work'; sh[e.id][dk] = shiftFor(e, dk); continue; }
            notes.push(`${loc} ${DAY_NAMES[i]}: no keyholder available to ${needKO && needKC ? 'open and close' : needKO ? 'open' : 'close'}`);
            keyGaveUp = true; continue;
          }
          const needW = c.wShort, needS = c.sShort, needStaff = c.min < h.minStaff, needPos = needW || needS;
          if (!needPos && !needStaff) break;
          const pick = group.filter(e => state[e.id][dk] === 'off' && !ptoOn(pto, e.id, dates[i]) && !locked(e, dk) && availWindow(e, dk).available && shiftFor(e, dk) &&
            (!needW || e.canWarehouse) && (!needS || e.canShowroom) &&
            days(e) < (needPos ? (e.maxDays || e.targetDays || 5) : (e.targetDays || 5)) &&   // staffing top-ups never exceed target days
            (needPos || hoursOK(e, dk, shiftFor(e, dk))))                                      // ...or the weekly hour maximum
            .sort((a, b) => (hoursOK(b, dk, shiftFor(b, dk)) - hoursOK(a, dk, shiftFor(a, dk))) || (days(a) >= 5) - (days(b) >= 5) || days(a) - days(b));
          if (pick.length) { const e = pick[0]; state[e.id][dk] = 'work'; sh[e.id][dk] = shiftFor(e, dk); continue; }
          // otherwise stretch an existing qualified person's shift to reach the uncovered time
          let widened = false;
          if (needPos) for (const strict of [true, false]) {
            for (const e of group) {
              const s = state[e.id][dk] === 'work' ? sh[e.id][dk] : null; if (!s) continue;
              if ((needW && !e.canWarehouse) && (needS && !e.canShowroom)) continue;
              if (needW && !needS && !e.canWarehouse) continue; if (needS && !needW && !e.canShowroom) continue;
              const aw = availWindow(e, dk), t = c.posAt;
              if (t < s.start && (aw.earliest == null || aw.earliest <= t) && !(strict && !hoursOK(e, dk, { start: t, end: s.end }))) { s.start = t; widened = true; break; }
              if (t + STEP > s.end && (aw.latest == null || aw.latest >= t + STEP) && !(strict && !hoursOK(e, dk, { start: s.start, end: t + STEP }))) { s.end = t + STEP; widened = true; break; }
            }
            if (widened) break;
          }
          if (!widened) { notes.push(`${loc} ${DAY_NAMES[i]}: could not fully cover ${needPos ? (needW && needS ? 'Warehouse and Showroom' : needW ? 'Warehouse' : 'Showroom') : 'minimum staffing'}`); break; }
        }
      });
      fitHours(true);
      // 3) write cells
      for (const e of group) for (const dk of DAYS) {
        if (state[e.id][dk] === 'work') { const s = sh[e.id][dk]; set(e, dk, `${fmtTime(s.start)}-${fmtTime(s.end)}`); }
        else if (state[e.id][dk] === 'off') set(e, dk, 'OFF');
      }
    }
    return { cells, notes };
  }

  // ---------- Google Calendar -> PTO ----------
  function matchEmployee(summary, employees) {
    const s = (summary || '').toLowerCase();
    let hit = null;
    for (const e of employees) {
      if (!e.active) continue;
      const full = e.name.toLowerCase().trim(); const first = full.split(/\s+/)[0];
      const re = n => new RegExp(`(^|[^a-z])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`);
      if (re(full).test(s)) return e;                     // full name wins
      if (!hit && re(first).test(s)) hit = e;
    }
    return hit;
  }
  /** events: Google Calendar API items. Returns {pto[], unmatched[], ignoredTimed}. */
  function eventsToPto(events, employees, settings) {
    const kw = (settings.google.keywords || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const pto = [], unmatched = []; let ignoredTimed = 0;
    for (const ev of events) {
      if (ev.status === 'cancelled') continue;
      const summary = ev.summary || '(no title)';
      if (!(ev.start && ev.start.date)) { ignoredTimed++; continue; }   // only all-day events block a whole day
      if (settings.google.requireKeyword && !kw.some(k => summary.toLowerCase().includes(k))) { unmatched.push({ summary, start: ev.start.date, reason: 'no PTO keyword' }); continue; }
      const e = matchEmployee(summary, employees);
      if (!e) { unmatched.push({ summary, start: ev.start.date, reason: 'no matching employee' }); continue; }
      // "Brendan Works" = an extra work day, not time off. Anything saying "off" stays time off.
      const type = /\b(works?|working)\b/i.test(summary) && !/\boff\b/i.test(summary) ? 'work' : 'off';
      pto.push({ id: 'g:' + ev.id + ':' + e.id, source: 'google', type, empId: e.id, start: ev.start.date, end: addDays(ev.end.date, -1) < ev.start.date ? ev.start.date : addDays(ev.end.date, -1), note: summary });
    }
    return { pto, unmatched, ignoredTimed };
  }

  let seq = 0;
  const newId = p => `${p}${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

  return { DAYS, DAY_NAMES, STEP, iso, parseISO, addDays, mondayOf, weekDates, dayLabel, fmtTime, parseClock, parseCell, resolveShift, paidHours, ptoOn, workOn, availFor, availWindow, hoursFor, weekGrid, coverageOf, validate, autoSchedule, matchEmployee, eventsToPto, newId };
});
