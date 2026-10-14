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
  const answered = () => { const st = stateWith(); st.capture = { '2026-10-08': { '*': 'added' } }; return st; };
  const r1 = planNudges({ state: answered(), now: jst('2026-10-08', '20:00') });
  assert.equal(r1.actions.length, 1);
  assert.equal(r1.actions[0].kind, 'evening');
  assert.match(r1.actions[0].payload.embeds[0].title, /あしたまで 2 つ/);
  const r2 = planNudges({ state: r1.state, now: jst('2026-10-08', '20:10') });
  assert.equal(r2.actions.length, 0);
  const r3 = planNudges({ state: r2.state, now: jst('2026-10-08', '21:30') });
  assert.equal(r3.actions.length, 1);
  assert.equal(r3.actions[0].slot, '2026-10-08:evening2');
  // all done and the day answered → quiet evening
  const done = answered();
  done.items = done.items.map((i) => ({ ...i, done: true }));
  assert.equal(planNudges({ state: done, now: jst('2026-10-08', '20:00') }).actions.length, 0);
});

test('overdue reminders fire at 16:00 / 19:00 / 21:00 only when something is overdue', () => {
  const r = planNudges({ state: stateWith(), now: jst('2026-10-09', '19:03') });
  const od = r.actions.filter((a) => a.kind === 'overdue');
  assert.equal(od.length, 1);
  assert.equal(od[0].slot, '2026-10-09:overdue:19:00');
  assert.equal(od[0].payload.content.startsWith('<@123>'), false, '2 日目からは @メンションなし');
  assert.ok(od[0].payload.components[0].components.some((b) => b.custom_id === 'submit:c'), '出した の出口');
  assert.ok(od[0].payload.components[0].components.some((b) => b.custom_id === 'drop:c'), '先生に言った の出口');
  const clean = stateWith();
  clean.items = clean.items.filter((i) => i.id !== 'c');
  assert.equal(planNudges({ state: clean, now: jst('2026-10-09', '19:03') }).actions.filter((a) => a.kind === 'overdue').length, 0);
  // 初日は @メンション、4 日目からは 19:00 だけ
  const fresh = stateWith(); fresh.items[2].due = '2026-10-08';
  assert.ok(planNudges({ state: fresh, now: jst('2026-10-09', '16:03') }).actions.find((a) => a.kind === 'overdue').payload.content.startsWith('<@123>'));
  const old = stateWith(); old.items[2].due = '2026-10-03';
  assert.equal(planNudges({ state: old, now: jst('2026-10-09', '16:03') }).actions.filter((a) => a.kind === 'overdue').length, 0);
  assert.equal(planNudges({ state: old, now: jst('2026-10-09', '19:03') }).actions.filter((a) => a.kind === 'overdue').length, 1);
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

test('capture: 放課後は 1 回だけ。追いかけ回さない（@メンションもしない）', () => {
  const lateSent = { '2026-10-09:wake': 'x', '2026-10-09:soon': 'x', '2026-10-09:urgent': 'x', '2026-10-09:late0': 'x', '2026-10-09:late1': 'x', '2026-10-09:late2': 'x', '2026-10-09:late3': 'x', '2026-10-09:late4': 'x', '2026-10-09:late5': 'x' };
  let state = stateWith({ nudge: { sent: { ...lateSent } } });
  const fired = [];
  for (const t of ['15:40', '15:45', '15:50', '16:15', '16:45', '17:45', '18:45', '21:45']) {
    const r = planNudges({ state, now: jst('2026-10-09', t) });
    state = r.state;
    for (const a of r.actions) if (a.kind === 'capture') { fired.push(`${t}=${a.slot.split(':')[1]}`); assert.doesNotMatch(a.payload.content, /<@/); }
  }
  assert.deepEqual(fired, ['15:45=capture0']);

  // しつこくしたい人だけ：captureNag
  state = stateWith({ settings: { captureNag: true }, nudge: { sent: { ...lateSent } } });
  const nagged = [];
  for (const t of ['15:45', '16:15', '16:45', '17:45', '21:45']) {
    const r = planNudges({ state, now: jst('2026-10-09', t) });
    state = r.state;
    for (const a of r.actions) if (a.kind === 'capture') nagged.push(`${t}=${a.slot.split(':')[1]}`);
  }
  assert.deepEqual(nagged, ['15:45=capture0', '16:15=capture1', '16:45=capture2', '17:45=capture3', '21:45=capture7']);
});

test('capture: 時間割がサーバーにないあいだは、でたらめな科目で聞かない', () => {
  const st = stateWith({ settings: { timetable: {} }, items: [] });
  for (const t of ['15:46', '20:01']) {
    const r = planNudges({ state: st, now: jst('2026-10-09', t) });
    assert.equal(r.actions.filter((a) => a.kind === 'capture').length, 0, t);
    for (const a of r.actions) assert.doesNotMatch(JSON.stringify(a.payload), /国語/, t);
  }
});

test('capture: 科目ごとのボタン', () => {
  // 科目ごとの「出た／なし」
  const r = planNudges({ state: stateWith({ nudge: { sent: {} } }), now: jst('2026-10-09', '15:46') });
  const cap = r.actions.find((a) => a.kind === 'capture');
  assert.ok(cap);
  const labels = cap.payload.components.flatMap((row) => row.components.map((b) => b.label));
  assert.deepEqual(labels.slice(0, 4), ['国語：出た', '国語：なし', '数学：出た', '数学：なし']);
  assert.ok(labels.includes('のこりは ぜんぶ なし') && labels.includes('アプリで登録'));
  assert.ok(cap.payload.components.length <= 5);
});

test('capture: not on a non-school day, not once answered, timetable narrows the subjects', () => {
  assert.equal(planNudges({ state: stateWith(), now: jst('2026-10-10', '15:46') }).actions.filter((a) => a.kind === 'capture').length, 0, 'Saturday');
  const answered = stateWith(); answered.capture = { '2026-10-09': 'none' };
  assert.equal(planNudges({ state: answered, now: jst('2026-10-09', '15:46') }).actions.filter((a) => a.kind === 'capture').length, 0, 'answered none');
  const added = stateWith(); added.items[0].createdAt = jst('2026-10-09', '12:00').toISOString(); added.items[0].createdOn = '2026-10-09';
  const r0 = planNudges({ state: added, now: jst('2026-10-09', '15:46') }).actions.filter((a) => a.kind === 'capture');
  assert.equal(r0.length, 1, '1 件登録しても、ほかの科目は聞く');
  assert.equal(r0[0].payload.components.flatMap((r) => r.components.map((b) => b.label)).includes('英語：出た'), false, '登録した英語は聞かない');
  const tt = stateWith({ settings: { timetable: { 5: ['数学', '英語'] } } });
  const r = planNudges({ state: tt, now: jst('2026-10-09', '15:46') });
  const cap = r.actions.find((a) => a.kind === 'capture');
  assert.deepEqual(cap.payload.components[0].components.map((b) => b.label), ['数学：出た', '数学：なし', '英語：出た', '英語：なし']);
  // 1 件登録しても、ほかの科目は聞き続ける
  const partly = stateWith({ settings: { timetable: { 5: ['数学', '英語'] } } });
  partly.items[0].createdOn = '2026-10-09'; // 英語を登録した
  const r2 = planNudges({ state: partly, now: jst('2026-10-09', '15:46') });
  const cap2 = r2.actions.find((a) => a.kind === 'capture');
  assert.deepEqual(cap2.payload.components[0].components.map((b) => b.label), ['数学：出た', '数学：なし']);
  // 曜日ごとの放課後（金曜は部活で 18:30）
  const late = stateWith({ settings: { afterSchoolByDay: { 5: '18:30' } } });
  assert.equal(planNudges({ state: late, now: jst('2026-10-09', '15:46') }).actions.filter((a) => a.kind === 'capture').length, 0);
  assert.equal(planNudges({ state: late, now: jst('2026-10-09', '18:31') }).actions.filter((a) => a.kind === 'capture').length, 1);
});

test('evening asks about today when nothing was captured', () => {
  const st = stateWith();
  st.items = st.items.filter((i) => i.id === 'd'); // あしたまでの宿題はない
  const r = planNudges({ state: st, now: jst('2026-10-09', '20:00') });
  const ev = r.actions.find((a) => a.kind === 'evening');
  assert.ok(ev, 'evening still goes out');
  assert.match(ev.payload.embeds[0].title, /^まだ答えてない科目：/);
  assert.ok(ev.payload.components.some((row) => row.components.some((b) => /^capno:/.test(b.custom_id))));
  // 全部「なし」と答えた夜は「ほんとに？」を 1 回
  const allNone = stateWith({ settings: { classroomUrl: 'https://classroom.invalid/' } });
  allNone.items = allNone.items.filter((i) => i.id === 'd');
  allNone.capture = { '2026-10-09': { '*': 'none' } };
  const r2 = planNudges({ state: allNone, now: jst('2026-10-09', '20:00') });
  const ev2 = r2.actions.find((a) => a.kind === 'evening');
  assert.match(ev2.payload.embeds[0].title, /^きょうは全部「なし」。ほんとに？/);
  assert.ok(ev2.payload.components.some((row) => row.components.some((b) => b.custom_id === 'capreopen')));
  assert.ok(ev2.payload.components.some((row) => row.components.some((b) => b.url === 'https://classroom.invalid/')));
});


test('no morning ladder on a day without school; snooze really comes back 10 minutes later', () => {
  const sat = stateWith();
  assert.equal(planNudges({ state: sat, now: jst('2026-10-10', '07:36') }).actions.filter((a) => a.kind === 'morning').length, 0, 'Saturday');
  // 06:30 の wake を「あとで」→ 06:40 に同じ段がもう一度
  let state = stateWith({ nudge: { snoozeUntil: jst('2026-10-09', '06:40').toISOString() } });
  let r = planNudges({ state, now: jst('2026-10-09', '06:31') });
  assert.equal(r.actions.filter((a) => a.kind === 'morning').length, 0);
  assert.equal(r.state.nudge.resendAfterSnooze, '2026-10-09:wake');
  r = planNudges({ state: r.state, now: jst('2026-10-09', '06:36') });
  assert.equal(r.actions.filter((a) => a.kind === 'morning').length, 0, 'まだスヌーズ中');
  r = planNudges({ state: r.state, now: jst('2026-10-09', '06:41') });
  const again = r.actions.filter((a) => a.kind === 'morning');
  assert.equal(again.length, 1);
  assert.equal(again[0].slot, '2026-10-09:wake:again');
  assert.equal(r.state.nudge.resendAfterSnooze, null);
  r = planNudges({ state: r.state, now: jst('2026-10-09', '06:46') });
  assert.equal(r.actions.filter((a) => a.kind === 'morning').length, 0, '二度は鳴らさない');
});

test('packed yesterday but not handed in is asked again today; online homework is left out of the morning', () => {
  const st = stateWith();
  st.items[2].packed = true; st.items[2].packedOn = '2026-10-08'; // きのう入れた社会、出してない
  const r = planNudges({ state: st, now: jst('2026-10-09', '07:36') });
  const m = r.actions.find((a) => a.kind === 'morning');
  assert.ok(m && /社会/.test(m.payload.embeds[0].description), 'けさもう一度');
  assert.match(m.payload.embeds[0].description, /持っていった → 出した？/);
  const online = stateWith();
  online.items = online.items.map((i) => ({ ...i, where: 'Classroom' }));
  assert.equal(planNudges({ state: online, now: jst('2026-10-09', '07:36') }).actions.filter((a) => a.kind === 'morning').length, 0);
});

test('leaving school: things left in the locker get one message, per-item buttons', () => {
  const st = stateWith();
  st.items[0].location = 'school';
  const r = planNudges({ state: st, now: jst('2026-10-09', '16:31') });
  const ls = r.actions.find((a) => a.kind === 'leaveschool');
  assert.ok(ls);
  assert.match(ls.payload.content, /学校にあるもの 1 つ/);
  assert.equal(ls.payload.components[0].components[0].custom_id, 'pack:a');
  assert.equal(planNudges({ state: r.state, now: jst('2026-10-09', '16:36') }).actions.filter((a) => a.kind === 'leaveschool').length, 0);
});

test('a silent 3 days asks about mute in the watch channel, once', () => {
  let state = stateWith({ settings: { discord: { userId: '123', watchChannelId: 'w' } }, nudge: { sentDays: ['2026-10-07', '2026-10-08'] } });
  const r = planNudges({ state, now: jst('2026-10-09', '07:36') });
  const ask = r.actions.find((a) => a.kind === 'muteask');
  assert.ok(ask && ask.toChannel);
  assert.match(ask.payload.content, /ミュート/);
  const r2 = planNudges({ state: r.state, now: jst('2026-10-09', '07:51') });
  assert.equal(r2.actions.filter((a) => a.kind === 'muteask').length, 0);
  const active = stateWith({ settings: { discord: { userId: '123', watchChannelId: 'w' } }, nudge: { sentDays: ['2026-10-07', '2026-10-08'], lastInteractionAt: jst('2026-10-08', '20:00').toISOString() } });
  assert.equal(planNudges({ state: active, now: jst('2026-10-09', '07:36') }).actions.filter((a) => a.kind === 'muteask').length, 0);
});
