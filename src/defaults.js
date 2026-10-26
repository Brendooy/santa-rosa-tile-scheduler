/* First-run data, seeded from the photographed schedule (week of 26 Oct 2026).
   Warehouse/Showroom qualifications (everyone starts with both) and store hours are INFERRED from that photo; the manager should confirm them in the Staff and Rules tabs. */
const L = require('./logic');

const wk = (o, c, sat) => ({ mon: { open: o, close: c }, tue: { open: o, close: c }, wed: { open: o, close: c }, thu: { open: o, close: c }, fri: { open: o, close: c }, sat });

function defaultSettings() {
  return {
    locations: {
      'Santa Rosa': {
        minStaff: 3, minWarehouse: 1, minShowroom: 1,
        hours: wk('7:30', '5', { open: '8', close: '3:30' }),
        defaultShift: { mon: '8-5', tue: '8-5', wed: '8-5', thu: '8-5', fri: '8-5', sat: '8-3:30' },
      },
      'Ukiah': {
        minStaff: 2, minWarehouse: 1, minShowroom: 1,
        hours: wk('8', '5', { open: '8', close: '3' }),
        defaultShift: { mon: '8-5', tue: '8-5', wed: '8-5', thu: '8-5', fri: '8-5', sat: '8-3' },
      },
    },
    lunchMinutes: 30,        // unpaid lunch for shifts of lunchAfterHours or more (hours totals only)
    lunchAfterHours: 6,
    longLunchMinutes: 60,    // ...and a full hour for shifts of longLunchAfterHours or more (e.g. 8-5)
    longLunchAfterHours: 9,
    warnLongDay: true,       // warn when someone is scheduled for more than maxDayHours paid hours in a day
    warnSixDays: true,       // warn when someone is scheduled six days in a row
    maxDayHours: 8,          // warn when one person is scheduled for more paid hours than this in a day (0 = off)
    lateStartMinutes: 90,    // "IN LATE" counts as starting this many minutes after opening
    rampMinutes: 60,         // minimum-headcount check ignores this long after opening and before closing
    backupKeep: 30,
    google: { calendarIds: [], keywords: 'pto,vacation,off,sick,holiday', requireKeyword: false, daysBack: 7, daysAhead: 180 },
    printTitle: 'SANTA ROSA TILE SUPPLY SCHEDULE',
    printNote: '-SCHEDULE MAY BE SUBJECT TO CHANGE-',
  };
}

const emp = (name, location, canWarehouse, canShowroom, extra = {}) => ({
  id: L.newId('e'), name, location, active: true, canWarehouse, canShowroom, keyholder: false, targetDays: 5, maxDays: 6, maxHours: 0, availability: {}, ...extra,
});
const only = (shift, days = ['mon', 'tue', 'wed', 'thu', 'fri']) => Object.fromEntries(days.map(d => [d, { available: true, shift }]));

function seedEmployees() {
  return [
    emp('Buddy', 'Santa Rosa', true, true, { maxDays: 5 }),
    emp('Brendan', 'Santa Rosa', true, true),
    emp('Andrew', 'Santa Rosa', true, true, { targetDays: 2, maxDays: 3 }),
    emp('Freya', 'Santa Rosa', true, true, { availability: { ...only('8:30-5'), sat: { available: true, shift: '8-3:30' } } }),
    emp('Sandee', 'Santa Rosa', true, true, { targetDays: 5, availability: { ...only('10-3'), sat: { available: false } } }),
    emp('Denis', 'Santa Rosa', true, true, { availability: { ...only('8:30-5'), sat: { available: true, shift: '8-3:30' } } }),
    emp('Brinley', 'Santa Rosa', true, true, { availability: { ...only('7:30-2'), sat: { available: true, shift: '8-3:30' } } }),
    emp('Saysha', 'Ukiah', true, true),
    emp('Haley', 'Ukiah', true, true),
    emp('Cameron', 'Ukiah', true, true, { availability: only('8-4') }),
    emp('Mark', 'Support', false, false),
  ];
}

function seedWeek(employees) {
  const id = n => employees.find(e => e.name === n).id;
  const D = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const rows = {
    Buddy: ['7:30', 'IN LATE', '7:30', 'IN LATE', '7:30', 'OFF'],
    Brendan: ['OFF', '8-5', '8-5', '8-5', '8-5', '8-3'],
    Andrew: ['7:30-5', '7:30-4:30', 'OFF', 'OFF', 'OFF', 'OFF'],
    Freya: ['OFF', '8:30-5', '8:30-5', '8:30-5', '8:30-5', '8-3:30'],
    Sandee: ['10-3', '10-5', '10-3', '10-3', '10-3', 'OFF'],
    Denis: ['8:30-5', 'OFF', '8:30-5', '8:30-5', '8:30-5', '8-3:30'],
    Brinley: ['7:30-2', '7:30-2', 'OFF', '7:30-2', 'OFF', '8-3:30'],
    Saysha: ['8-5', '8-5', 'OFF', '8-5', '8-5', '8-3'],
    Haley: ['OFF', '9-5', '8-5', '8-5', '9-5', '8-3'],
    Cameron: ['8-4', '8-4', '8-4', '8-4', '8-5', 'OFF'],
  };
  const cells = {};
  for (const [n, v] of Object.entries(rows)) { cells[id(n)] = {}; D.forEach((d, i) => { cells[id(n)][d] = v[i]; }); }
  return { start: '2026-10-26', status: 'draft', cells, support: { tue: 'Mark', wed: 'Mark' }, publishedAt: null, updatedAt: new Date().toISOString() };
}

function initialData() {
  const employees = seedEmployees();
  const w = seedWeek(employees);
  return {
    version: 1,
    employees,
    settings: defaultSettings(),
    schedules: { [w.start]: w },
    pto: [],
    ptoMeta: { lastRefreshed: null, lastError: null, lastAttempt: null, lastSummary: null, unmatched: [] },
    meta: { createdAt: new Date().toISOString(), seeded: true },
  };
}

module.exports = { initialData, defaultSettings };
