import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyDiscordRequest, handleInteraction, DiscordRest, COMMANDS } from '../src/discord.js';
import { jst, stateWith } from './helpers.js';

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function signed(body, keys, ts = '1700000000') {
  const sig = await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(ts + body));
  return new Request('https://w.invalid/interactions', { method: 'POST', headers: { 'X-Signature-Ed25519': toHex(sig), 'X-Signature-Timestamp': ts, 'Content-Type': 'application/json' }, body });
}

test('verifies a genuine Discord signature and rejects a tampered one', async () => {
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const pub = toHex(await crypto.subtle.exportKey('raw', keys.publicKey));
  const body = JSON.stringify({ type: 1 });
  const ok = await verifyDiscordRequest(await signed(body, keys), pub);
  assert.equal(ok.valid, true);
  assert.equal(ok.body, body);
  const req = await signed(body, keys);
  const bad = new Request(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify({ type: 1, x: 1 }) });
  assert.equal((await verifyDiscordRequest(bad, pub)).valid, false);
  assert.equal((await verifyDiscordRequest(await signed(body, keys), 'zz')).valid, false);
});

function ctx(state) {
  const saved = [];
  const events = [];
  return { state, now: jst('2026-10-09', '07:42'), save: async (s) => { saved.push(JSON.parse(JSON.stringify(s))); }, saved, events };
}

test('PING is answered with PONG', async () => {
  assert.deepEqual(await handleInteraction({ type: 1 }, ctx(stateWith())), { type: 1 });
});

test('pack button marks the items packed and edits the message', async () => {
  const c = ctx(stateWith());
  const res = await handleInteraction({ type: 3, data: { custom_id: 'pack:c,a,b' }, message: { content: '<@123> 出るまで あと8分。', embeds: [{ title: 'x' }], components: [{ type: 1, components: [{ custom_id: 'pack:c,a,b' }] }] } }, c);
  // b はできているがまだ入れていない → 3 つとも入れたら clear
  assert.equal(res.type, 7);
  assert.match(res.data.content, /入れた（07:42）。いってらっしゃい！/);
  assert.deepEqual(res.data.components, []);
  const items = c.saved[0].items;
  assert.equal(items.find((i) => i.id === 'a').packed, true);
  assert.equal(items.find((i) => i.id === 'c').packed, true);
  assert.equal(items.find((i) => i.id === 'd').packed, false);
  // 一部だけ入れたときは残りの数を言う
  const c2 = ctx(stateWith());
  const part = await handleInteraction({ type: 3, data: { custom_id: 'pack:c' }, message: { content: 'x' } }, c2);
  assert.match(part.data.content, /入れた（07:42）。あと 2 つ。/);
});

test('done button keeps the pack button', async () => {
  const c = ctx(stateWith());
  const res = await handleInteraction({ type: 3, data: { custom_id: 'done:a' }, message: { content: 'x', components: [{ type: 1, components: [{ custom_id: 'pack:c,a', label: 'かばんに入れた' }, { custom_id: 'done:a', label: 'やった' }, { custom_id: 'snooze:a', label: '10分あとで' }] }] } }, c);
  assert.equal(res.type, 7);
  assert.equal(c.saved[0].items.find((i) => i.id === 'a').done, true);
  assert.deepEqual(res.data.components[0].components.map((b) => b.custom_id), ['pack:c,a']);
});

test('snooze is limited to snoozeMax per day', async () => {
  const c = ctx(stateWith({ nudge: { snoozeCount: { '2026-10-09': 2 } } }));
  const ok = await handleInteraction({ type: 3, data: { custom_id: 'snooze:a' }, message: { content: 'x' } }, c);
  assert.equal(ok.type, 7);
  assert.match(ok.data.content, /あと 0 回/);
  assert.equal(c.saved[0].nudge.snoozeUntil, jst('2026-10-09', '07:52').toISOString());
  const c2 = ctx(stateWith({ nudge: { snoozeCount: { '2026-10-09': 3 } } }));
  const no = await handleInteraction({ type: 3, data: { custom_id: 'snooze:a' }, message: { content: 'x' } }, c2);
  assert.equal(no.type, 4);
  assert.equal(no.data.flags, 64);
  assert.equal(c2.saved.length, 0);
});

test('/shukudai registers homework with a relative due date', async () => {
  const c = ctx(stateWith());
  const res = await handleInteraction({ type: 2, data: { name: 'shukudai', options: [{ name: 'kamoku', value: '数学' }, { name: 'hani', value: 'p.30' }, { name: 'itsu', value: '+2' }] } }, c);
  assert.equal(res.type, 4);
  const added = c.saved[0].items.at(-1);
  assert.equal(added.subject, '数学');
  assert.equal(added.range, 'p.30');
  assert.equal(added.due, '2026-10-11');
  assert.equal(added.where, '');
  assert.match(res.data.embeds[0].footer.text, /どこにあるか/);
  const empty = await handleInteraction({ type: 2, data: { name: 'shukudai', options: [{ name: 'kamoku', value: '数学' }, { name: 'hani', value: '  ' }] } }, ctx(stateWith()));
  assert.equal(empty.data.flags, 64);
});

test('/kyou lists what to bring today', async () => {
  const res = await handleInteraction({ type: 2, data: { name: 'kyou' } }, ctx(stateWith()));
  assert.equal(res.type, 4);
  assert.match(res.data.embeds[0].title, /出るまで あと8分/);
  // 社会（期限切れ）・英語（まだ）・数学（できてるけど入れてない）の 3 つ
  assert.deepEqual(res.data.components[0].components.map((b) => b.label), ['入れた：社会', '入れた：英語', '入れた：数学', 'やった']);
});

test('command definitions are well-formed', () => {
  for (const c of COMMANDS) {
    assert.match(c.name, /^[a-z]+$/);
    assert.ok(c.description.length <= 100);
    for (const o of c.options || []) assert.ok(o.description.length <= 100, o.name);
  }
});

test('capture buttons open a modal, the modal registers and asks for more', async () => {
  const c = ctx(stateWith());
  const modal = await handleInteraction({ type: 3, data: { custom_id: 'cap:数学' }, message: { content: 'きょう、宿題出た？' } }, c);
  assert.equal(modal.type, 9);
  assert.equal(modal.data.custom_id, 'capmodal:数学');
  assert.equal(modal.data.components.length, 3);
  const res = await handleInteraction({ type: 5, data: { custom_id: 'capmodal:数学', components: [{ type: 1, components: [{ custom_id: 'hani', value: 'p.40〜41' }] }, { type: 1, components: [{ custom_id: 'doko', value: 'ワーク' }] }, { type: 1, components: [{ custom_id: 'itsu', value: '来週' }] }] } }, c);
  assert.equal(res.type, 4);
  assert.match(res.data.content, /登録した：数学　p.40〜41　｜　どこ：ワーク　｜　10\/16 まで。 ほかは？ のこり：国語・英語・理科・社会・その他/);
  const saved = c.saved.at(-1);
  assert.equal(saved.capture['2026-10-09']['数学'], 'added');
  assert.equal(saved.items.at(-1).due, '2026-10-16');
  assert.equal(saved.items.at(-1).createdOn, '2026-10-09');
  const labels = res.data.components.flatMap((r) => r.components.map((b) => b.label));
  assert.ok(labels.includes('国語：出た') && labels.includes('国語：なし') && labels.includes('のこりは ぜんぶ なし'));
  const done = await handleInteraction({ type: 3, data: { custom_id: 'capnone' }, message: { content: 'x' } }, { ...c, state: saved });
  assert.equal(done.type, 7);
  assert.match(done.data.content, /これで全部。OK/);
  // 範囲が空でも登録できる（夜に聞く）
  const c2 = ctx(stateWith());
  const empty = await handleInteraction({ type: 5, data: { custom_id: 'capmodal:理科', components: [{ type: 1, components: [{ custom_id: 'hani', value: '' }] }] } }, c2);
  assert.match(empty.data.content, /範囲はあとで。夜に聞く/);
  assert.equal(c2.saved.at(-1).items.at(-1).rangeMissing, true);
  assert.equal(c2.saved.at(-1).items.at(-1).due, '2026-10-12', '既定は次の学校の日（金曜 → 月曜）');
});

test('"なし" is per subject; the rest can be closed at once; "やっぱりあった" reopens', async () => {
  const c = ctx(stateWith());
  const one = await handleInteraction({ type: 3, data: { custom_id: 'capno:数学' }, message: { content: 'きょう、宿題出た？' } }, c);
  assert.equal(one.type, 7);
  assert.match(one.data.content, /数学 はなし。のこり：国語・英語・理科・社会・その他/);
  assert.equal(c.saved.at(-1).capture['2026-10-09']['数学'], 'none');
  const res = await handleInteraction({ type: 3, data: { custom_id: 'capnone' }, message: { content: 'きょう、宿題出た？' } }, { ...c, state: c.saved.at(-1) });
  assert.equal(res.type, 7);
  assert.match(res.data.content, /きょうは宿題なし。OK（07:42）/);
  const cap = c.saved.at(-1).capture['2026-10-09'];
  for (const sub of ['国語', '数学', '英語', '理科', '社会', 'その他']) assert.equal(cap[sub], 'none', sub);
  const re = await handleInteraction({ type: 3, data: { custom_id: 'capreopen' }, message: { content: 'x' } }, { ...c, state: c.saved.at(-1) });
  assert.match(re.data.content, /やっぱりあった/);
  assert.equal(Object.values(c.saved.at(-1).capture['2026-10-09']).filter((v) => v === 'none').length, 0);
});

test('hand-in: 出した / 先生に言った close an item; 範囲を書く fixes a blank range', async () => {
  const c = ctx(stateWith());
  const sub = await handleInteraction({ type: 3, data: { custom_id: 'submit:c' }, message: { content: 'x', components: [{ type: 1, components: [{ custom_id: 'submit:c', label: '出した：社会' }, { custom_id: 'drop:c', label: '先生に言った：社会' }] }] } }, c);
  assert.equal(sub.type, 7);
  assert.match(sub.data.content, /出した（07:42）。えらい。/);
  assert.equal(c.saved.at(-1).items.find((i) => i.id === 'c').submitted, true);
  assert.deepEqual(sub.data.components, []);
  assert.deepEqual(c.events.map((e) => e.type), ['submitted']);
  const drop = await handleInteraction({ type: 3, data: { custom_id: 'drop:a' }, message: { content: 'x' } }, ctx(stateWith()));
  assert.match(drop.data.content, /先生に言った/);
  const st = stateWith(); st.items[0].range = '';
  const c3 = ctx(st);
  const modal = await handleInteraction({ type: 3, data: { custom_id: 'fix:a' }, message: { content: 'x' } }, c3);
  assert.equal(modal.type, 9);
  const fixed = await handleInteraction({ type: 5, data: { custom_id: 'fixmodal:a', components: [{ type: 1, components: [{ custom_id: 'hani', value: 'p.12〜13' }] }] } }, c3);
  assert.match(fixed.data.content, /書いた：英語　p.12〜13/);
  assert.equal(c3.saved.at(-1).items[0].rangeMissing, false);
});

test('packing per item keeps the other buttons and reports a clear day', async () => {
  const c = ctx(stateWith());
  const res = await handleInteraction({ type: 3, data: { custom_id: 'pack:c' }, message: { content: 'x', components: [{ type: 1, components: [{ custom_id: 'pack:c', label: '入れた：社会' }, { custom_id: 'pack:a', label: '入れた：英語' }, { custom_id: 'done:c', label: 'やった' }] }] } }, c);
  assert.deepEqual(res.data.components[0].components.map((b) => b.custom_id), ['pack:a']);
  assert.equal(c.saved.at(-1).items.find((i) => i.id === 'c').packedOn, '2026-10-09');
  const all = await handleInteraction({ type: 3, data: { custom_id: 'pack:a,b' }, message: { content: 'x' } }, { ...c, state: c.saved.at(-1) });
  assert.match(all.data.content, /いってらっしゃい/);
  assert.ok(c.events.some((e) => e.type === 'packed_all'));
});

test('due words are understood', async () => {
  const { parseDueWords } = await import('../src/discord.js');
  assert.equal(parseDueWords('あした', '2026-10-09'), '2026-10-10');
  assert.equal(parseDueWords('あさって', '2026-10-09'), '2026-10-11');
  assert.equal(parseDueWords('来週', '2026-10-09'), '2026-10-16');
  assert.equal(parseDueWords('10-14', '2026-10-09'), '2026-10-14');
  assert.equal(parseDueWords('1/8', '2026-10-09'), '2027-01-08');
  assert.equal(parseDueWords('2026-12-01', '2026-10-09'), '2026-12-01');
  assert.equal(parseDueWords('', '2026-10-09'), '2026-10-12', '空なら次の学校の日（金 → 月）');
  assert.equal(parseDueWords('なんか', '2026-10-09'), '2026-10-12');
  assert.equal(parseDueWords('次', '2026-10-09', { subject: '数学', timetable: { 2: ['数学'] } }), '2026-10-13', '次の数学は火曜');
  assert.equal(parseDueWords('', '2026-10-09', { schoolDays: [1, 2, 3, 4, 5, 6] }), '2026-10-10', '土曜も学校なら土曜');
});

// Cloudflare の fetch は「this が別のオブジェクト」で呼ばれると Illegal invocation で落ちる。
test('DiscordRest: fetch を this つきで呼ばない（Cloudflare の Illegal invocation 対策）', async () => {
  const calls = [];
  function strictFetch(url, init) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation: function called with incorrect `this` reference.');
    calls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify({ id: '42' }), { status: 200 }));
  }
  const rest = new DiscordRest('tok', strictFetch);
  await rest.dm('123456789012345678', { content: 'hi' });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/users\/@me\/channels$/);
  assert.match(calls[1].url, /\/channels\/42\/messages$/);
});
