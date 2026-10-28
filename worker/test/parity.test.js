// ブラウザの bundle.js とサーバーの core.js が同じ答えを出すことを確かめる。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '../src/core.js';
import { items } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', '..', 'shukudai', 'ds', 'bundle.js'), 'utf8');
const stub = () => new Proxy({}, { get: (t, k) => (k === 'classList' ? { add() {}, remove() {}, toggle() {}, contains() { return false; } } : k === 'style' ? {} : () => stub()) });
const win = {};
const doc = { createElement: stub, createElementNS: stub, createTextNode: stub };
new Function('window', 'document', src)(win, doc);
const S = win.Shukudai;

test('dueInfo agrees', () => {
  for (const due of ['2026-10-07', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-20']) {
    for (const done of [false, true]) assert.deepEqual(core.dueInfo(due, '2026-10-09', done), S.dueInfo(due, '2026-10-09', done));
  }
});

test('nudgeStage agrees', () => {
  for (const now of ['2026-10-09T06:20', '2026-10-09T07:15', '2026-10-09T07:42', '2026-10-09T08:05']) {
    const a = core.nudgeStage({ items: items(), now, leaveAt: '07:50' });
    const b = S.nudgeStage({ items: items(), now, leaveAt: '07:50' });
    assert.deepEqual({ ...a, items: a.items.map((i) => i.id) }, { ...b, items: b.items.map((i) => i.id) });
  }
});

test('captureAnswered / captureSubjects agree', () => {
  assert.equal(core.captureAnswered({ items: items(), today: '2026-10-08' }), S.captureAnswered({ items: items(), today: '2026-10-08' }));
  assert.equal(core.captureAnswered({ items: items(), today: '2026-10-09', capture: { '2026-10-09': 'none' } }), 'none');
  assert.deepEqual(core.captureSubjects({ today: '2026-10-09', timetable: { 5: ['数学'] } }), S.captureSubjects({ today: '2026-10-09', timetable: { 5: ['数学'] } }));
});

test('discordPayload agrees', () => {
  const cases = [
    { kind: 'evening', items: items(), now: '2026-10-08T20:00', today: '2026-10-08', userId: '123' },
    { kind: 'morning', items: items(), now: '2026-10-09T07:42', leaveAt: '07:50', userId: '123', appUrl: 'https://x.invalid' },
    { kind: 'morning', items: items(), now: '2026-10-09T08:05', leaveAt: '07:50', userId: '123' },
    { kind: 'overdue', items: items(), now: '2026-10-09T19:00', userId: '123' },
    { kind: 'capture', items: items(), now: '2026-10-09T15:45', today: '2026-10-09', userId: '123', appUrl: 'https://x.invalid', askNo: 3 },
    { kind: 'capture', items: items(), now: '2026-10-09T15:45', today: '2026-10-09', timetable: { 5: ['数学', '英語'] } },
    { kind: 'evening', items: items(), now: '2026-10-09T20:00', today: '2026-10-09', captureMissing: true }
  ];
  for (const c of cases) assert.deepEqual(core.discordPayload(c), S.discordPayload(c));
});

test('captureStatus / nextLesson / isPackedToday agree', () => {
  const opts = { items: items().map((i, k) => (k === 0 ? { ...i, createdOn: '2026-10-09' } : i)), capture: { '2026-10-09': { '理科': 'none' } }, today: '2026-10-09', timetable: { 5: ['数学', '英語', '理科'] } };
  assert.deepEqual(core.captureStatus(opts), S.captureStatus(opts));
  assert.deepEqual(core.captureStatus({ today: '2026-10-09', capture: { '2026-10-09': { '*': 'none', '数学': 'added' } } }), S.captureStatus({ today: '2026-10-09', capture: { '2026-10-09': { '*': 'none', '数学': 'added' } } }));
  assert.equal(core.nextLesson('数学', '2026-10-09', { 2: ['数学'] }).date.getTime(), S.nextLesson('数学', '2026-10-09', { 2: ['数学'] }).date.getTime());
  assert.equal(core.nextSchoolDay('2026-10-09', [1, 3]).getDay(), 1);
  assert.equal(core.isPackedToday({ packed: true, packedOn: '2026-10-08' }, '2026-10-09'), S.isPackedToday({ packed: true, packedOn: '2026-10-08' }, '2026-10-09'));
  for (const flags of [{ packed: true }, { submitted: true }, { dropped: true }, {}]) assert.deepEqual(core.dueInfo('2026-10-07', '2026-10-09', true, flags), S.dueInfo('2026-10-07', '2026-10-09', true, flags));
  assert.equal(core.captureWording(2, '2026-10-09', ['数学']), S.captureWording(2, '2026-10-09', ['数学']));
});

test('course schedule helpers agree', async () => {
  const { uniCourses } = await import('./helpers.js');
  const s = { courses: uniCourses(), commuteMinutes: 45 };
  for (const dow of [0, 1, 2, 3, 4, 5, 6]) assert.deepEqual(core.dayPlan(dow, s), S.dayPlan(dow, s), 'dayPlan ' + dow);
  assert.deepEqual(core.effectiveTimetable(s), S.effectiveTimetable(s));
  assert.deepEqual(core.effectiveSchoolDays(s), S.effectiveSchoolDays(s));
  assert.deepEqual(core.allSubjects(s), S.allSubjects(s));
  for (const d of ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-16']) {
    assert.deepEqual(core.daySubjects(d, s), S.daySubjects(d, s), 'daySubjects ' + d);
    for (const m of [600, 640, 760, 1100]) assert.deepEqual(core.askableSubjects(d, m, s), S.askableSubjects(d, m, s), `askable ${d} ${m}`);
  }
  assert.equal(core.submitPlace('英語演習', '2026-10-15', s), S.submitPlace('英語演習', '2026-10-15', s));
  assert.deepEqual(core.nextClass(new Date(2026, 9, 12, 9, 30), s), S.nextClass(new Date(2026, 9, 12, 9, 30), s));
  const p = { kind: 'capture', items: [], now: '2026-10-12T10:36', today: '2026-10-12', subjects: ['統計学'], askNo: 0 };
  assert.deepEqual(core.discordPayload(p), S.discordPayload(p));
  // 履修科目がないときは今までどおり
  assert.deepEqual(core.dayPlan(1, {}), S.dayPlan(1, {}));
  assert.deepEqual(core.daySubjects('2026-10-12', {}), S.daySubjects('2026-10-12', {}));
});

test('日付つきの授業：dayPlan と nextLesson が bundle とサーバーで同じ', () => {
  const s = { courses: [
    { name: '統計学 I', short: '統計学', day: 1, period: 1, room: 'A-101', dates: ['2026-10-19', '2026-11-02'] },
    { name: '英語演習', short: '英語演習', day: 2, period: 4, room: 'C-301', dates: ['2026-10-20', '2026-10-27'] },
    { name: 'ゼミ', short: 'ゼミ', day: 5, period: 5, room: 'D-401' }
  ] };
  for (const iso of ['2026-10-19', '2026-10-20', '2026-10-26', '2026-10-27', '2026-10-30', '2026-11-02', '2026-11-09']) {
    const d = new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
    assert.deepEqual(core.dayPlan(d, s), S.dayPlan(d, s), 'dayPlan ' + iso);
    assert.deepEqual(core.dayPlan(iso, s), S.dayPlan(iso, s), 'dayPlan(str) ' + iso);
  }
  assert.deepEqual(core.effectiveTimetable(s), S.effectiveTimetable(s));
  for (const sub of ['統計学', '英語演習', 'ゼミ']) for (const t of ['2026-10-19', '2026-10-27', '2026-11-02', '2026-11-20']) {
    const a = core.nextLesson(sub, t, core.effectiveTimetable(s), core.effectiveSchoolDays(s));
    const b = S.nextLesson(sub, t, S.effectiveTimetable(s), S.effectiveSchoolDays(s));
    assert.deepEqual({ d: core.toISO(a.date), l: a.lesson }, { d: S.toISO ? S.toISO(b.date) : core.toISO(b.date), l: b.lesson }, `${sub} ${t}`);
  }
});
