import test from 'node:test';
import assert from 'node:assert/strict';
import { dayPlan, daySubjects, askableSubjects, effectiveTimetable, effectiveSchoolDays, nextLesson, submitPlace, nextClass, captureWording } from '../src/core.js';
import { planNudges } from '../src/scheduler.js';
import { handleInteraction } from '../src/discord.js';
import { jst, uniCourses, uniState } from './helpers.js';

const S = { courses: uniCourses(), commuteMinutes: 60 };

test('dayPlan derives leave time, after-school and lessons from the courses', () => {
  const mon = dayPlan(1, S);
  assert.equal(mon.school, true);
  assert.deepEqual(mon.lessons.map((l) => `${l.period}:${l.subject}:${l.room}`), ['1:統計学:A-101', '2:フランス語(a):B-201']);
  assert.equal(mon.leaveAt, '08:00', '1限 9:00 − 通学 60 分');
  assert.equal(mon.afterSchoolAt, '12:40', '2限の終わり 12:10 + 30 分');
  const fri = dayPlan(5, S);
  assert.equal(fri.leaveAt, '15:20', '金曜は 5限だけ → 15:20 に出る');
  assert.equal(dayPlan(3, S).school, false, '水曜は授業なし');
  assert.equal(dayPlan(6, S).school, false);
  assert.equal(dayPlan(1, { ...S, commuteMinutes: 90 }).leaveAt, '07:30');
  assert.equal(dayPlan(1, { ...S, leaveByDay: { 1: '07:45' } }).leaveAt, '07:45', '曜日ごとの上書き');
  assert.equal(dayPlan(1, { ...S, periods: { 1: ['08:50', '10:20'], 2: ['10:30', '12:00'] } }).leaveAt, '07:50', '時限の時刻を変えられる');
  // 履修科目がなければ前の設定のまま
  assert.deepEqual(dayPlan(1, { leaveAt: '07:50' }).leaveAt, '07:50');
});

test('timetable, school days and subjects come from the courses', () => {
  assert.deepEqual(effectiveTimetable(S), { 1: ['統計学', 'フランス語(a)'], 2: ['英語演習'], 4: ['英語演習'], 5: ['ゼミ'] });
  assert.deepEqual(effectiveSchoolDays(S), [1, 2, 4, 5]);
  assert.deepEqual(daySubjects('2026-10-12', S), ['統計学', 'フランス語(a)']);
  assert.deepEqual(daySubjects('2026-10-16', S), ['ゼミ', '集中講義'], '週の最後の授業日には曜日のない授業も聞く');
  assert.deepEqual(daySubjects('2026-10-14', S), [], '授業のない日は聞かない');
  assert.deepEqual(askableSubjects('2026-10-12', 10 * 60 + 34, S), [], '1限が終わって 5 分たつまで');
  assert.deepEqual(askableSubjects('2026-10-12', 10 * 60 + 35, S), ['統計学']);
  assert.deepEqual(askableSubjects('2026-10-12', 12 * 60 + 40, S), ['統計学', 'フランス語(a)']);
});

test('the next lesson is the default due date, and the hand-in place comes from it', () => {
  const n = nextLesson('英語演習', '2026-10-13', effectiveTimetable(S), effectiveSchoolDays(S));
  assert.equal(n.lesson, true);
  assert.equal(n.date.getDate(), 15, '火曜の英語演習 → 木曜');
  assert.equal(submitPlace('英語演習', '2026-10-15', S), '10/15（木） 2限 C-302');
  assert.equal(submitPlace('英語演習', '2026-10-14', S), '', 'その日に授業がなければ空');
  const now = new Date(2026, 9, 12, 9, 30);
  assert.equal(nextClass(now, S).lesson.subject, '統計学');
  assert.equal(nextClass(now, S).during, true);
  assert.equal(nextClass(new Date(2026, 9, 12, 13, 0), S), null);
  assert.equal(captureWording(0, '2026-10-12', ['統計学']), '統計学、おわった。課題出た？');
});

test('Friday with only a 5th-period class: no morning nagging at 7:50, the ladder follows 15:20', () => {
  const items = [{ id: 'z', subject: 'ゼミ', range: 'レジュメ', where: 'プリント', due: '2026-10-09', done: false, packed: false, createdAt: '2026-10-02T10:00:00Z', createdOn: '2026-10-02' }];
  const st = uniState({ items });
  for (const t of ['06:30', '07:36', '07:51', '12:00']) assert.equal(planNudges({ state: st, now: jst('2026-10-09', t) }).actions.filter((a) => a.kind === 'morning').length, 0, t);
  const wake = planNudges({ state: st, now: jst('2026-10-09', '14:21') }).actions.filter((a) => a.kind === 'morning');
  assert.equal(wake.length, 1);
  assert.equal(wake[0].slot, '2026-10-09:wake');
  assert.match(wake[0].payload.embeds[0].title, /出るまで あと59分/);
  const urgent = planNudges({ state: st, now: jst('2026-10-09', '15:06') }).actions.find((a) => a.kind === 'morning');
  assert.equal(urgent.slot, '2026-10-09:urgent');
  assert.match(urgent.payload.content, /^<@123>/);
});

test('right after each class, one question about that class only', () => {
  let state = uniState();
  const at = (t) => { const r = planNudges({ state, now: jst('2026-10-12', t) }); state = r.state; return r.actions.filter((a) => a.kind === 'capture'); };
  assert.equal(at('10:30').length, 0);
  const first = at('10:36');
  assert.equal(first.length, 1);
  assert.equal(first[0].slot, '2026-10-12:class1');
  assert.equal(first[0].payload.content, '統計学、おわった。課題出た？');
  assert.deepEqual(first[0].payload.components[0].components.map((b) => b.label), ['統計学：出た', '統計学：なし']);
  assert.equal(at('10:41').length, 0, '同じ授業は二度聞かない');
  const second = at('12:16');
  assert.equal(second[0].slot, '2026-10-12:class2');
  assert.match(second[0].payload.content, /^フランス語\(a\)、おわった。/);
  // 放課後（12:40）からは、まだ答えていない科目をまとめて聞く
  const roll = at('12:41');
  assert.equal(roll[0].slot, '2026-10-12:capture0');
  assert.deepEqual(roll[0].payload.components[0].components.map((b) => b.label), ['統計学：出た', '統計学：なし', 'フランス語(a)：出た', 'フランス語(a)：なし']);
});

test('a class already answered is not asked about after it ends', () => {
  const st = uniState({ capture: { '2026-10-12': { '統計学': 'none' } } });
  assert.equal(planNudges({ state: st, now: jst('2026-10-12', '10:36') }).actions.filter((a) => a.kind === 'capture').length, 0);
});

test('Discord: "なし" right after a class only looks at the classes that have ended', async () => {
  const saved = [];
  const ctx = { state: uniState(), now: jst('2026-10-12', '10:37'), save: async (s) => { saved.push(JSON.parse(JSON.stringify(s))); }, events: [] };
  const res = await handleInteraction({ type: 3, data: { custom_id: 'capno:統計学' }, message: { content: '統計学、おわった。課題出た？' } }, ctx);
  assert.equal(res.type, 7);
  assert.match(res.data.content, /統計学 はなし。きょうは宿題なし。OK（10:37）/);
  assert.deepEqual(res.data.components, [], 'まだ終わっていないフランス語は聞かない');
});

test('Discord: registering after class sets the next lesson and where to hand it in', async () => {
  const saved = [];
  const ctx = { state: uniState(), now: jst('2026-10-13', '16:20'), save: async (s) => { saved.push(JSON.parse(JSON.stringify(s))); }, events: [] };
  const modal = await handleInteraction({ type: 3, data: { custom_id: 'cap:英語演習' }, message: { content: 'x' } }, ctx);
  assert.match(modal.data.components[2].components[0].placeholder, /次の英語演習（10\/15）/);
  const res = await handleInteraction({ type: 5, data: { custom_id: 'capmodal:英語演習', components: [{ type: 1, components: [{ custom_id: 'hani', value: 'Unit 4 の音読' }] }, { type: 1, components: [{ custom_id: 'doko', value: 'LMS' }] }, { type: 1, components: [{ custom_id: 'itsu', value: '次' }] }] } }, ctx);
  assert.match(res.data.content, /10\/15 まで/);
  const item = saved.at(-1).items.at(-1);
  assert.equal(item.due, '2026-10-15');
  assert.equal(item.submitTo, '10/15（木） 2限 C-302');
  assert.equal(item.location, 'online', 'LMS はネット提出 → 朝のかばん確認から外れる');
});

test('after the first class starts, no more "you are late leaving" messages', () => {
  const items = [{ id: 'm', subject: '統計学', range: 'p.10', where: 'プリント', due: '2026-10-12', done: false, packed: false, createdAt: '2026-10-05T10:00:00Z', createdOn: '2026-10-05' }];
  let state = uniState({ items, settings: { commuteMinutes: 20 } }); // 8:40 に出る、9:00 に授業
  const fired = [];
  for (const t of ['08:40', '08:50', '09:00', '09:10', '09:20']) {
    const r = planNudges({ state, now: jst('2026-10-12', t) });
    state = r.state;
    for (const a of r.actions) if (a.kind === 'morning') fired.push(`${t}=${a.slot.split(':')[1]}`);
  }
  assert.deepEqual(fired, ['08:40=late0', '08:50=late1'], '9:00 の授業が始まったら止まる');
});
