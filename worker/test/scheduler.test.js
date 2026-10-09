import test from 'node:test';
import assert from 'node:assert/strict';
import { localParts, inQuietHours, planNudges } from '../src/scheduler.js';
import { jst, stateWith } from './helpers.js';

test('localParts converts UTC to the configured zone', () => {
  const p = localParts(jst('2026-10-09', '07:20'), 'Asia/Tokyo');
  assert.equal(p.dateKey, '2026-10-09');
  assert.equal(p.minutes, 7 * 60 + 20);
  assert.equal(p.local.getHours(), 7);
  assert.equal(p.local.getMinutes(), 20);
  assert.equal(p.local.getDate(), 9);
});

test('quiet hours wrap midnight', () => {
  const s = { quietFrom: '22:00', quietTo: '06:30' };
  assert.equal(inQuietHours(23 * 60, s), true);
  assert.equal(inQuietHours(3 * 60, s), true);
  assert.equal(inQuietHours(6 * 60 + 29, s), true);
  assert.equal(inQuietHours(6 * 60 + 30, s), false);
  assert.equal(inQuietHours(12 * 60, s), false);
  assert.equal(inQuietHours(13 * 60, { quietFrom: '12:00', quietTo: '14:00' }), true);
});

test('soon slot fires 30 minutes before leaving, once', () => {
  const r1 = planNudges({ state: stateWith(), now: jst('2026-10-09', '07:20') });
  assert.equal(r1.actions.length, 1);
  assert.equal(r1.actions[0].slot, '2026-10-09:soon');
  assert.equal(r1.actions[0].kind, 'morning');
  assert.match(r1.actions[0].payload.embeds[0].title, /出るまで あと30分/);
  assert.equal(r1.actions[0].payload.content.includes('<@123>'), false);
  const r2 = planNudges({ state: r1.state, now: jst('2026-10-09', '07:24') });
  assert.equal(r2.actions.length, 0);
});

test('urgent slot mentions the user', () => {
  const st = stateWith({ nudge: { sent: { '2026-10-09:soon': 'x', '2026-10-09:wake': 'x' } } });
  const r = planNudges({ state: st, now: jst('2026-10-09', '07:36') });
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].slot, '2026-10-09:urgent');
  assert.match(r.actions[0].payload.content, /^<@123> /);
});

test('late slots fire every 10 minutes up to six times', () => {
  let state = stateWith({ nudge: { sent: { '2026-10-09:wake': 'x', '2026-10-09:soon': 'x', '2026-10-09:urgent': 'x' } } });
  const fired = [];
  for (const t of ['07:50', '07:55', '08:00', '08:05', '08:10', '08:20', '08:30', '08:40', '08:50', '09:00']) {
    const r = planNudges({ state, now: jst('2026-10-09', t) });
    state = r.state;
    for (const a of r.actions) fired.push(`${t}=${a.slot.split(':')[1]}`);
  }
  assert.deepEqual(fired, ['07:50=late0', '08:00=late1', '08:10=late2', '08:20=late3', '08:30=late4', '08:40=late5']);
});

test('a worker that was down fires only the latest missed rung', () => {
  const r = planNudges({ state: stateWith(), now: jst('2026-10-09', '08:25') });
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].slot, '2026-10-09:late3');
  for (const s of ['wake', 'soon', 'urgent', 'late0', 'late1', 'late2', 'late3']) assert.ok(r.state.nudge.sent[`2026-10-09:${s}`], s + ' marked');
});

test('nothing fires when everything is packed', () => {
  const st = stateWith();
  st.items = st.items.map((i) => ({ ...i, packed: true }));
  const r = planNudges({ state: st, now: jst('2026-10-09', '07:36') });
  assert.equal(r.actions.length, 0);
});

test('nothing fires in quiet hours or when escalation is calm', () => {
  assert.equal(planNudges({ state: stateWith(), now: jst('2026-10-09', '23:10') }).actions.length, 0);
  assert.equal(planNudges({ state: stateWith({ settings: { escalation: 'calm' } }), now: jst('2026-10-09', '07:36') }).actions.length, 0);
});

test('snooze holds back soon but not urgent', () => {
  const st = stateWith({ nudge: { sent: { '2026-10-09:wake': 'x' }, snoozeUntil: jst('2026-10-09', '07:28').toISOString() } });
  assert.equal(planNudges({ state: st, now: jst('2026-10-09', '07:20') }).actions.length, 0);
  const st2 = stateWith({ nudge: { sent: { '2026-10-09:wake': 'x', '2026-10-09:soon': 'x' }, snoozeUntil: jst('2026-10-09', '07:45').toISOString() } });
  const r = planNudges({ state: st2, now: jst('2026-10-09', '07:36') });
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].slot, '2026-10-09:urgent');
});

test('evening at 20:00 and again at 21:30 while something is still pending', () => {
  const r1 = planNudges({ state: stateWith(), now: jst('2026-10-08', '20:00') });
  assert.equal(r1.actions.length, 1);
  assert.equal(r1.actions[0].kind, 'evening');
  assert.match(r1.actions[0].payload.embeds[0].title, /あしたまで 2 つ/);
  const r2 = planNudges({ state: r1.state, now: jst('2026-10-08', '20:10') });
  assert.equal(r2.actions.length, 0);
  const r3 = planNudges({ state: r2.state, now: jst('2026-10-08', '21:30') });
  assert.equal(r3.actions.length, 1);
  assert.equal(r3.actions[0].slot, '2026-10-08:evening2');
  // all done → quiet evening
  const done = stateWith();
  done.items = done.items.map((i) => ({ ...i, done: true }));
  assert.equal(planNudges({ state: done, now: jst('2026-10-08', '20:00') }).actions.length, 0);
});

test('overdue reminders fire at 16:00 / 19:00 / 21:00 only when something is overdue', () => {
  const r = planNudges({ state: stateWith(), now: jst('2026-10-09', '19:03') });
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].kind, 'overdue');
  assert.equal(r.actions[0].slot, '2026-10-09:overdue:19:00');
  const clean = stateWith();
  clean.items = clean.items.filter((i) => i.id !== 'c');
  assert.equal(planNudges({ state: clean, now: jst('2026-10-09', '19:03') }).actions.length, 0);
});

test('wake slot sends the first morning message', () => {
  const r = planNudges({ state: stateWith(), now: jst('2026-10-09', '06:32') });
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].slot, '2026-10-09:wake');
  assert.match(r.actions[0].payload.embeds[0].title, /きょう持っていくもの 3 つ/); // 期限切れ 1 + きょう 2（できてても持っていく）
});

test('old sent markers are pruned', () => {
  const st = stateWith({ nudge: { sent: { '2026-10-01:soon': 'x', '2026-10-09:wake': 'x' } } });
  const r = planNudges({ state: st, now: jst('2026-10-09', '12:00') });
  assert.equal('2026-10-01:soon' in r.state.nudge.sent, false);
  assert.equal('2026-10-09:wake' in r.state.nudge.sent, true);
});

test('capture: asks after school every 30 minutes, three times, until answered', () => {
  let state = stateWith({ nudge: { sent: { '2026-10-09:wake': 'x', '2026-10-09:soon': 'x', '2026-10-09:urgent': 'x', '2026-10-09:late0': 'x', '2026-10-09:late1': 'x', '2026-10-09:late2': 'x', '2026-10-09:late3': 'x', '2026-10-09:late4': 'x', '2026-10-09:late5': 'x' } } });
  const fired = [];
  for (const t of ['15:40', '15:45', '15:50', '16:15', '16:20', '16:45', '17:15', '17:45']) {
    const r = planNudges({ state, now: jst('2026-10-09', t) });
    state = r.state;
    for (const a of r.actions) if (a.kind === 'capture') fired.push(`${t}=${a.slot.split(':')[1]}:${a.kind}`);
    if (t === '16:45') assert.match(r.actions.find((a) => a.kind === 'capture').payload.content, /^<@123> まだ答えてない/);
  }
  assert.deepEqual(fired, ['15:45=capture0:capture', '16:15=capture1:capture', '16:45=capture2:capture']);
  // 科目ボタンと「なし」
  const r = planNudges({ state: stateWith({ nudge: { sent: {} } }), now: jst('2026-10-09', '15:46') });
  const cap = r.actions.find((a) => a.kind === 'capture');
  assert.ok(cap);
  const labels = cap.payload.components.flatMap((row) => row.components.map((b) => b.label));
  assert.deepEqual(labels, ['国語', '数学', '英語', '理科', '社会', 'その他', 'きょうは なし', 'アプリで登録']);
});

test('capture: not on a non-school day, not once answered, timetable narrows the subjects', () => {
  assert.equal(planNudges({ state: stateWith(), now: jst('2026-10-10', '15:46') }).actions.filter((a) => a.kind === 'capture').length, 0, 'Saturday');
  const answered = stateWith(); answered.capture = { '2026-10-09': 'none' };
  assert.equal(planNudges({ state: answered, now: jst('2026-10-09', '15:46') }).actions.filter((a) => a.kind === 'capture').length, 0, 'answered none');
  const added = stateWith(); added.items[0].createdAt = jst('2026-10-09', '12:00').toISOString();
  assert.equal(planNudges({ state: added, now: jst('2026-10-09', '15:46') }).actions.filter((a) => a.kind === 'capture').length, 0, 'added today');
  const tt = stateWith({ settings: { timetable: { 5: ['数学', '英語'] } } });
  const r = planNudges({ state: tt, now: jst('2026-10-09', '15:46') });
  const cap = r.actions.find((a) => a.kind === 'capture');
  assert.deepEqual(cap.payload.components[0].components.map((b) => b.label), ['数学', '英語']);
});

test('evening asks about today when nothing was captured', () => {
  const st = stateWith();
  st.items = st.items.filter((i) => i.id === 'd'); // あしたまでの宿題はない
  const r = planNudges({ state: st, now: jst('2026-10-09', '20:00') });
  const ev = r.actions.find((a) => a.kind === 'evening');
  assert.ok(ev, 'evening still goes out');
  assert.match(ev.payload.embeds[0].title, /^きょう登録ゼロ。ほんとに宿題なし？/);
  assert.ok(ev.payload.components.some((row) => row.components.some((b) => b.custom_id === 'capnone')));
});
