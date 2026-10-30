const assert = require('assert');
const L = require('../src/logic');
const { initialData } = require('../src/defaults');

let n = 0; const t = (name, fn) => { try { fn(); n++; console.log('ok  ', name); } catch (e) { console.error('FAIL', name, '\n    ', e.message); process.exitCode = 1; } };

t('parseCell basics', () => {
  assert.deepStrictEqual(L.parseCell('8-5'), { kind: 'shift', start: 480, end: 1020, openEnded: false });
  assert.strictEqual(L.parseCell('7:30-4:30').end, 16 * 60 + 30);
  assert.strictEqual(L.parseCell('10-3').end, 15 * 60);
  assert.strictEqual(L.parseCell('7:30').openEnded, true);
  assert.strictEqual(L.parseCell('in late').kind, 'late');
  assert.strictEqual(L.parseCell('off').kind, 'off');
  assert.strictEqual(L.parseCell('').kind, 'blank');
  assert.strictEqual(L.parseCell('banana').kind, 'invalid');
  assert.strictEqual(L.parseCell('5-8').kind, 'shift'); // 5pm-8pm
});

t('dates', () => {
  assert.strictEqual(L.mondayOf('2026-10-31'), '2026-10-26');
  assert.strictEqual(L.mondayOf('2026-10-26'), '2026-10-26');
  assert.strictEqual(L.dayLabel('2026-10-26'), '26 October');
  assert.strictEqual(L.addDays('2026-10-30', 3), '2026-11-02');
});

const d = initialData(); const wk = d.schedules['2026-10-26'];
const byName = n => d.employees.find(e => e.name === n);

t('the photographed week validates with no errors', () => {
  const errs = L.validate(wk, d.employees, [], d.settings).filter(i => i.severity === 'error');
  assert.deepStrictEqual(errs.map(e => e.msg), []);
});

t('PTO on a worked day is an error', () => {
  const pto = [{ id: 'x', empId: byName('Brendan').id, start: '2026-10-28', end: '2026-10-28', note: 'PTO' }];
  const errs = L.validate(wk, d.employees, pto, d.settings).filter(i => i.severity === 'error');
  assert.ok(errs.some(e => /Brendan Wednesday.*PTO/.test(e.msg)), JSON.stringify(errs));
});

t('missing Warehouse / Showroom coverage detected', () => {
  const emps = JSON.parse(JSON.stringify(d.employees));
  emps.filter(e => e.location === 'Santa Rosa').forEach(e => { e.canShowroom = e.name === 'Brinley'; }); // only Brinley (7:30-2) can do Showroom
  const msgs = L.validate(wk, emps, [], d.settings).map(i => i.msg);
  assert.ok(msgs.some(m => /Santa Rosa Tuesday: not enough Showroom coverage/.test(m)), msgs.join(' | '));
  assert.ok(!msgs.some(m => /not enough Warehouse/.test(m)));
  // one person qualified for both cannot fill both positions at once
  const two = JSON.parse(JSON.stringify(d.employees));
  two.forEach(e => { if (e.location === 'Ukiah') { e.canWarehouse = e.name === 'Cameron'; e.canShowroom = e.name === 'Cameron'; } });
  assert.ok(L.validate(wk, two, [], d.settings).some(i => /Ukiah Monday: not enough/.test(i.msg)));
});

t('keyholder required at opening and closing', () => {
  // nobody marked keyholder -> rule is not enforced yet
  assert.ok(!L.validate(wk, d.employees, [], d.settings).some(i => /keyholder/.test(i.msg)));
  const emps = JSON.parse(JSON.stringify(d.employees));
  const sr = emps.filter(e => e.location === 'Santa Rosa');
  const [a, b] = [sr.find(e => e.name === 'Brinley'), sr.find(e => e.name === 'Denis')];
  a.keyholder = true; // Brinley works 7:30-2 on Tuesday: opens, but nobody keyed closes
  const msgs = L.validate(wk, emps, [], d.settings).map(i => i.msg);
  assert.ok(msgs.some(m => /Santa Rosa Tuesday: no keyholder at closing/.test(m)), msgs.join(' | '));
  assert.ok(!msgs.some(m => /Santa Rosa Tuesday: no keyholder at opening/.test(m)), msgs.join(' | '));
  assert.ok(msgs.some(m => /Santa Rosa .*: no keyholder/.test(m)));
  // everyone at the location a keyholder -> the photographed week is fine again
  sr.forEach(e => { e.keyholder = true; });
  assert.ok(!L.validate(wk, emps, [], d.settings).some(i => /keyholder/.test(i.msg)));
});

t('autoSchedule puts a keyholder at open and close (12 weeks)', () => {
  const emps = JSON.parse(JSON.stringify(d.employees));
  for (const loc of ['Santa Rosa', 'Ukiah']) emps.filter(e => e.location === loc).slice(0, 2).forEach(e => { e.keyholder = true; });
  let start = '2026-11-02';
  for (let i = 0; i < 12; i++, start = L.addDays(start, 7)) {
    const week = { start, cells: {} }; const r = L.autoSchedule(week, emps, [], d.settings); week.cells = r.cells;
    const bad = L.validate(week, emps, [], d.settings).filter(x => x.severity === 'error').map(x => x.msg);
    assert.deepStrictEqual(bad, [], start + ' ' + r.notes.join('; '));
  }
});

t('unavailable / earliest / latest enforced', () => {
  const e2 = JSON.parse(JSON.stringify(d.employees)); const s = e2.find(e => e.name === 'Sandee');
  const w = JSON.parse(JSON.stringify(wk)); w.cells[s.id].sat = '8-3';
  const msgs = L.validate(w, e2, [], d.settings).map(i => i.msg);
  assert.ok(msgs.some(m => /Sandee Saturday.*not available/.test(m)));
});

t('blank cells are errors', () => {
  const w = JSON.parse(JSON.stringify(wk)); w.cells[byName('Denis').id].mon = '';
  assert.ok(L.validate(w, d.employees, [], d.settings).some(i => i.severity === 'error' && /nothing entered/.test(i.msg)));
});

t('autoSchedule from blank week: valid, respects PTO and availability', () => {
  const pto = [{ id: 'p', empId: byName('Freya').id, start: '2026-11-03', end: '2026-11-04', note: 'PTO' }];
  const week = { start: '2026-11-02', status: 'draft', cells: {} };
  const r = L.autoSchedule(week, d.employees, pto, d.settings);
  week.cells = r.cells;
  assert.strictEqual(r.cells[byName('Freya').id].tue, 'PTO');
  assert.strictEqual(r.cells[byName('Freya').id].wed, 'PTO');
  assert.strictEqual(r.cells[byName('Sandee').id].sat, 'OFF');
  const errs = L.validate(week, d.employees, pto, d.settings).filter(i => i.severity === 'error');
  assert.deepStrictEqual(errs.map(e => e.msg), []);
  assert.ok(r.notes.every(x => /minimum staffing/.test(x)), r.notes.join('; ')); // honest report when PTO leaves the floor thin
  console.log('      sample:', JSON.stringify(Object.fromEntries(d.employees.filter(e => e.location !== 'Support').map(e => [e.name, L.DAYS.map(k => r.cells[e.id][k]).join(' | ')]))));
});

t('autoSchedule onlyEmpty keeps typed cells', () => {
  const week = { start: '2026-11-09', status: 'draft', cells: { [byName('Denis').id]: { mon: '9-5' } } };
  const r = L.autoSchedule(week, d.employees, [], d.settings, { onlyEmpty: true });
  assert.strictEqual(r.cells[byName('Denis').id].mon, '9-5');
  assert.ok(r.cells[byName('Denis').id].tue);
});

t('autoSchedule is stable over 12 weeks (no errors)', () => {
  let start = '2026-11-02';
  for (let i = 0; i < 12; i++, start = L.addDays(start, 7)) {
    const week = { start, cells: {} }; week.cells = L.autoSchedule(week, d.employees, [], d.settings).cells;
    const errs = L.validate(week, d.employees, [], d.settings).filter(x => x.severity === 'error');
    assert.deepStrictEqual(errs.map(e => e.msg), [], start);
  }
});

t('"Name Works" calendar events are extra work days, not PTO', () => {
  const evs = [{ id: 'w1', summary: 'Brendan Works', start: { date: '2026-10-31' }, end: { date: '2026-11-01' } },
               { id: 'o1', summary: 'Haley off', start: { date: '2026-10-26' }, end: { date: '2026-10-27' } }];
  const r = L.eventsToPto(evs, d.employees, d.settings);
  assert.deepStrictEqual(r.pto.map(p => [p.type, p.start]).sort(), [['off', '2026-10-26'], ['work', '2026-10-31']]);
  // Works entry must not block scheduling, even on a day the person is normally unavailable
  const emps = JSON.parse(JSON.stringify(d.employees)); const b = emps.find(e => e.name === 'Brendan');
  b.availability = { sat: { available: false } };
  const w = JSON.parse(JSON.stringify(wk));
  const errs = L.validate(w, emps, r.pto, d.settings).filter(i => i.severity === 'error');
  assert.deepStrictEqual(errs.map(e => e.msg), []);
  // ...while the same day with no Works entry IS a problem
  assert.ok(L.validate(w, emps, [], d.settings).some(i => /Brendan Saturday: not available/.test(i.msg)));
  // OFF on a Works day warns
  w.cells[b.id].sat = 'OFF';
  assert.ok(L.validate(w, emps, r.pto, d.settings).some(i => i.severity === 'warn' && /calendar says they work/.test(i.msg)));
  // Auto-fill schedules them
  const week = { start: '2026-10-26', cells: {} };
  assert.notStrictEqual(L.autoSchedule(week, emps, r.pto, d.settings).cells[b.id].sat, 'OFF');
});

t('the photographed week only warns about 7:30-5 days (8.5 paid hours); headcount ramp-up ignored', () => {
  const w = L.validate(wk, d.employees, [], d.settings).filter(i => i.severity === 'warn');
  assert.ok(w.length && w.every(x => /hours scheduled in one day \(over 8\)/.test(x.msg)), w.map(x => x.msg).join(' | '));
});

t('unpaid lunch: none under 6 h, 30 min from 6 h, 1 h from 9 h (8-5 = 8 paid)', () => {
  const ph = (a, b) => L.paidHours({ start: a * 60, end: b * 60 }, d.settings);
  assert.strictEqual(ph(8, 13), 5);        // 5 h shift: no lunch
  assert.strictEqual(ph(8, 14), 5.5);      // exactly 6 h: 30 min
  assert.strictEqual(ph(8, 16), 7.5);      // 8-4: 30 min
  assert.strictEqual(ph(8, 17), 8);        // 8-5: 1 h
  assert.strictEqual(ph(7.5, 17), 8.5);    // 7:30-5
});

t('alerts: over 8 hours in a day, 6 days in a row', () => {
  const w = JSON.parse(JSON.stringify(wk)); const e = byName('Denis');
  w.cells[e.id] = { mon: '7-5', tue: '8-5', wed: '8-5', thu: '8-5', fri: '8-5', sat: '8-3' };
  const msgs = L.validate(w, d.employees, [], d.settings).filter(i => i.empId === e.id).map(i => i.msg);
  assert.ok(msgs.some(m => /Denis Monday: 9 hours scheduled in one day \(over 8\)/.test(m)), msgs.join(' | '));
  assert.ok(!msgs.some(m => /Denis Tuesday.*one day/.test(m)));
  assert.ok(msgs.some(m => /Denis: scheduled 6 days in a row/.test(m)), msgs.join(' | '));
  w.cells[e.id].wed = 'OFF';
  assert.ok(!L.validate(w, d.employees, [], d.settings).some(i => /days in a row/.test(i.msg) && i.empId === e.id));
});

t('"Store closed" calendar days: CLOSED cells, Auto-fill, no coverage, scheduling is an error', () => {
  const evs = [{ id: 'c1', summary: 'Store closed', start: { date: '2026-11-04' }, end: { date: '2026-11-05' } },
               { id: 'c2', summary: 'Ukiah closed', start: { date: '2026-11-05' }, end: { date: '2026-11-06' } },
               { id: 'c3', summary: 'Sandee closed the store early', start: { date: '2026-11-06' }, end: { date: '2026-11-07' } }];
  const r = L.eventsToPto(evs, d.employees, d.settings);
  assert.deepStrictEqual(r.pto.map(p => [p.type, p.loc, p.start]), [['closed', null, '2026-11-04'], ['closed', 'Ukiah', '2026-11-05'], ['closed', null, '2026-11-06']]);
  const week = { start: '2026-11-02', cells: {} };
  const a = L.autoSchedule(week, d.employees, r.pto, d.settings); week.cells = a.cells;
  const sr = d.employees.find(e => e.location === 'Santa Rosa'), uk = d.employees.find(e => e.location === 'Ukiah');
  assert.strictEqual(a.cells[sr.id].wed, 'CLOSED'); assert.strictEqual(a.cells[uk.id].wed, 'CLOSED');
  assert.strictEqual(a.cells[uk.id].thu, 'CLOSED'); assert.notStrictEqual(a.cells[sr.id].thu, 'CLOSED');   // only Ukiah named on the 5th
  assert.strictEqual(a.cells[sr.id].fri, 'CLOSED');
  const msgs = L.validate(week, d.employees, r.pto, d.settings);
  assert.deepStrictEqual(msgs.filter(i => i.severity === 'error').map(i => i.msg), []);
  assert.ok(!msgs.some(i => /Wednesday/.test(i.msg) && /coverage|only \d/.test(i.msg)));
  week.cells[sr.id].wed = '8-5';
  assert.ok(L.validate(week, d.employees, r.pto, d.settings).some(i => /Wednesday: scheduled while Santa Rosa is closed/.test(i.msg)));
  week.cells[sr.id].wed = 'CLOSED';
  const w2 = JSON.parse(JSON.stringify(week)); w2.cells[sr.id].mon = 'CLOSED';   // CLOSED on a day the store is open
  assert.ok(L.validate(w2, d.employees, r.pto, d.settings).some(i => i.severity === 'warn' && /marked CLOSED but the store is open/.test(i.msg)));
});

t('"off at" / "in at" calendar titles limit the hours of that day (warning), and Auto-fill respects them', () => {
  const evs = [{ id: 'o1', summary: 'Buddy off at 10', start: { date: '2026-11-13' }, end: { date: '2026-11-15' } },
               { id: 'i1', summary: 'Brendan in at 10:30', start: { date: '2026-11-12' }, end: { date: '2026-11-13' } }];
  const r = L.eventsToPto(evs, d.employees, d.settings);
  assert.deepStrictEqual(r.pto.map(p => [p.type, p.time, p.start, p.end]), [['offat', 600, '2026-11-13', '2026-11-14'], ['inat', 630, '2026-11-12', '2026-11-12']]);
  const buddy = byName('Buddy'), brendan = byName('Brendan');
  // it is NOT time off: scheduling Buddy is not a "has PTO" problem
  const week = { start: '2026-11-09', cells: { [buddy.id]: { mon: 'OFF', tue: 'OFF', wed: 'OFF', thu: 'OFF', fri: '8-5', sat: '8-3:30' } } };
  const v = L.validate(week, d.employees, r.pto, d.settings).filter(i => i.empId === buddy.id);
  assert.ok(!v.some(i => /PTO/.test(i.msg)), JSON.stringify(v));
  assert.ok(v.some(i => i.severity === 'warn' && /Buddy Friday: .*off at 10 AM.*until 5 PM/.test(i.msg)), v.map(i => i.msg).join(' | '));
  week.cells[buddy.id].fri = '7:30-10';
  assert.ok(!L.validate(week, d.employees, r.pto, d.settings).some(i => /Buddy Friday/.test(i.msg) && /off at/.test(i.msg)));
  // "in at": a shift before that time warns
  week.cells[brendan.id] = { thu: '8-5' };
  assert.ok(L.validate(week, d.employees, r.pto, d.settings).some(i => /Brendan Thursday: .*in at 10:30 AM.*starts at 8 AM/.test(i.msg)));
  // Auto-fill: nobody starts before "in at", nobody works past "off at"
  const a = L.autoSchedule({ start: '2026-11-09', cells: {} }, d.employees, r.pto, d.settings);
  const sh = (e, dk) => L.resolveShift(L.parseCell(a.cells[e.id][dk]), L.hoursFor(d.settings, e.location, dk), d.settings);
  for (const dk of ['fri', 'sat']) { const s = sh(buddy, dk); assert.ok(!s || s.end <= 600, `Buddy ${dk} ${a.cells[buddy.id][dk]}`); }
  { const s = sh(brendan, 'thu'); assert.ok(!s || s.start >= 630, `Brendan thu ${a.cells[brendan.id].thu}`); }
  // old saved entries that were stored as plain time off get upgraded from their title
  const store = require('../src/store'); const data = JSON.parse(JSON.stringify(d));
  data.pto = [{ id: 'z', source: 'google', type: 'off', empId: buddy.id, start: '2026-11-13', end: '2026-11-14', note: 'Buddy off at 10' }];
  assert.deepStrictEqual([store.normalize(data).pto[0].type, data.pto[0].time], ['offat', 600]);
});

t('warnings can be switched off', () => {
  const w = JSON.parse(JSON.stringify(wk)); const e = byName('Denis');
  w.cells[e.id] = { mon: '7-5', tue: '8-5', wed: '8-5', thu: '8-5', fri: '8-5', sat: '8-3' };
  const off = { ...d.settings, warnLongDay: false, warnSixDays: false };
  assert.ok(!L.validate(w, d.employees, [], off).some(i => i.empId === e.id && /one day|in a row/.test(i.msg)));
  assert.ok(L.validate(w, d.employees, [], { ...off, warnSixDays: true }).some(i => /in a row/.test(i.msg)));
});

t('old saved calendar entries without a type are repaired from their title', () => {
  const store = require('../src/store');
  const data = JSON.parse(JSON.stringify(d));
  data.pto = [{ id: 'a', source: 'google', empId: byName('Brendan').id, start: '2026-10-31', end: '2026-10-31', note: 'brendan works' },
              { id: 'b', source: 'google', empId: byName('Sandee').id, start: '2026-10-31', end: '2026-10-31', note: 'Sandee Off' },
              { id: 'c', source: 'manual', empId: byName('Denis').id, start: '2026-10-27', end: '2026-10-27', note: 'PTO' }];
  const n = store.normalize(data);
  assert.deepStrictEqual(n.pto.map(p => p.type), ['work', 'off', 'off']);
  // Brendan scheduled OFF on a calendar "works" day is a warning, not a problem
  const sched = JSON.parse(JSON.stringify(n.schedules['2026-10-26'])); sched.cells[byName('Brendan').id].sat = 'OFF';
  const iss = L.validate(sched, n.employees, n.pto, n.settings).filter(i => i.empId === byName('Brendan').id && i.day === 5);
  assert.ok(iss.every(i => i.severity === 'warn') && iss.some(i => /calendar says they work/.test(i.msg)), JSON.stringify(iss));
});

t('autoSchedule keeps people within their maximum weekly hours (and 8 h days) when it can', () => {
  const emps = JSON.parse(JSON.stringify(d.employees));
  const sr = emps.filter(e => e.location === 'Santa Rosa'); sr.forEach(e => { e.maxHours = 30; });
  let start = '2026-11-02';
  for (let i = 0; i < 6; i++, start = L.addDays(start, 7)) {
    const week = { start, cells: {} }; const r = L.autoSchedule(week, emps, [], d.settings); week.cells = r.cells;
    const warn = L.validate(week, emps, [], d.settings);
    assert.deepStrictEqual(warn.filter(x => x.severity === 'error').map(x => x.msg), [], start);
    assert.ok(!warn.some(x => /hours scheduled in one day|days in a row/.test(x.msg)), warn.map(x => x.msg).join(' | '));
    for (const e of sr) {
      const hrs = L.weekGrid(week, emps, [], d.settings).rows.find(x => x.emp.id === e.id).cells.reduce((t, c) => t + L.paidHours(c.shift, d.settings), 0);
      assert.ok(hrs <= 30 + 1e-9 || r.notes.some(n => n.startsWith(e.name)), `${e.name} ${hrs} h in ${start}: ${r.notes.join('; ')}`);
    }
  }
});

t('autoSchedule never exceeds anyone\'s target days (12 weeks, no PTO)', () => {
  let start = '2026-11-02';
  for (let i = 0; i < 12; i++, start = L.addDays(start, 7)) {
    const week = { start, cells: {} }; const r = L.autoSchedule(week, d.employees, [], d.settings);
    for (const e of d.employees.filter(x => x.location !== 'Support')) {
      const worked = L.DAYS.filter(k => r.cells[e.id][k] !== 'OFF').length;
      assert.ok(worked <= (e.targetDays || 5), `${e.name} works ${worked} days in week ${start}`);
    }
  }
});

t('google events -> pto', () => {
  const evs = [
    { id: '1', summary: 'Brendan - PTO', start: { date: '2026-11-02' }, end: { date: '2026-11-05' } },
    { id: '2', summary: 'Company holiday', start: { date: '2026-11-26' }, end: { date: '2026-11-27' } },
    { id: '3', summary: 'Haley dentist', start: { dateTime: '2026-11-03T09:00:00-08:00' }, end: { dateTime: '2026-11-03T10:00:00-08:00' } },
    { id: '4', summary: 'Brendan Smith off', status: 'cancelled', start: { date: '2026-12-01' }, end: { date: '2026-12-02' } },
  ];
  const r = L.eventsToPto(evs, d.employees, d.settings);
  assert.strictEqual(r.pto.length, 1);
  assert.deepStrictEqual([r.pto[0].start, r.pto[0].end], ['2026-11-02', '2026-11-04']);
  assert.strictEqual(r.unmatched.length, 1);
  assert.strictEqual(r.ignoredTimed, 1);
});

console.log(`\n${n} passed`);
