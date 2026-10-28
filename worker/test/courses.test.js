import test from 'node:test';
import assert from 'node:assert/strict';
import { toISO, dayPlan, daySubjects, askableSubjects, effectiveTimetable, effectiveSchoolDays, nextLesson, submitPlace, nextClass, captureWording } from '../src/core.js';
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

// ---- 授業の日付（出欠表から取り出した、実際に授業がある日）----
const DATED = {
  courses: [
    { name: '統計学 I', short: '統計学', day: 1, period: 1, room: 'A-101', dates: ['2026-10-19', '2026-11-02', '2026-11-09'] }, // 10/26 は授業なし
    { name: '英語演習 II', short: '英語演習', day: 2, period: 4, room: 'C-301', dates: ['2026-10-20', '2026-10-27'] },
    { name: '英語演習 II', short: '英語演習', day: 4, period: 2, room: 'C-302', dates: ['2026-10-22', '2026-10-29'] },
    { name: 'ゼミ', short: 'ゼミ', day: 5, period: 5, room: 'D-401' } // 日付なし＝毎週
  ],
  commuteMinutes: 60
};

test('日付つきの授業：その日付だけ授業がある（曜日が同じでも、日付になければ休み）', () => {
  assert.equal(dayPlan(new Date(2026, 9, 19), DATED).school, true, '10/19（月）はある');
  assert.equal(dayPlan(new Date(2026, 9, 26), DATED).school, false, '10/26（月）は授業なし');
  assert.equal(dayPlan(new Date(2026, 9, 26), DATED).lessons.length, 0);
  assert.equal(dayPlan('2026-11-02', DATED).school, true, '文字列の日付でもいい');
  assert.equal(dayPlan(1, DATED).school, true, '曜日の数字だけなら、いままで通り（日付は見ない）');
  assert.equal(dayPlan(new Date(2026, 9, 30), DATED).school, true, '日付のないゼミは毎週');
});

test('日付つきの授業：「次のその授業」は、実際の次の授業の日', () => {
  const tt = effectiveTimetable(DATED);
  assert.equal(toISO(nextLesson('統計学', '2026-10-19', tt, effectiveSchoolDays(DATED)).date), '2026-11-02', '10/26 を飛ばす');
  assert.equal(toISO(nextLesson('英語演習', '2026-10-22', tt, effectiveSchoolDays(DATED)).date), '2026-10-27', '火と木のどちらか近い方');
  assert.equal(toISO(nextLesson('ゼミ', '2026-10-23', tt, effectiveSchoolDays(DATED)).date), '2026-10-30', '日付なしは毎週');
  const after = nextLesson('統計学', '2026-11-09', tt, effectiveSchoolDays(DATED));
  assert.equal(after.lesson, false, '日付がもうない授業は、「次の学校の日」にする');
});

test('日付つきの授業：授業のない日は、朝の催促も課題の質問もしない', () => {
  const st = { v: 1, items: [], settings: { leaveAt: '07:50', wakeAt: '06:30', quietFrom: '22:00', quietTo: '06:30', tz: 'Asia/Tokyo', escalation: 'full', snoozeMax: 3, discord: { userId: '123' }, ...DATED }, nudge: { sent: {} }, capture: {} };
  for (const t of ['07:10', '15:30', '17:50']) {
    const r = planNudges({ state: st, now: jst('2026-10-26', t) });
    assert.equal(r.actions.filter((a) => a.kind === 'capture' || a.kind === 'morning').length, 0, `10/26 ${t}`);
  }
  const ok = planNudges({ state: st, now: jst('2026-10-19', '10:36') });
  assert.ok(ok.actions.some((a) => a.kind === 'capture'), '授業のある日 10/19 は、授業のあとに聞く');
});
