import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyDiscordRequest, handleInteraction, COMMANDS } from '../src/discord.js';
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
  return { state, now: jst('2026-10-09', '07:42'), save: async (s) => { saved.push(JSON.parse(JSON.stringify(s))); }, saved };
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
  assert.equal(res.data.components[0].components[0].label, 'かばんに入れた');
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
  assert.match(res.data.content, /登録した：数学　p.40〜41　｜　どこ：ワーク　｜　10\/16 まで。ほかの科目は？/);
  const saved = c.saved.at(-1);
  assert.equal(saved.capture['2026-10-09'], 'added');
  assert.equal(saved.items.at(-1).due, '2026-10-16');
  assert.ok(res.data.components.at(-1).components.some((b) => b.custom_id === 'capdone'));
  const done = await handleInteraction({ type: 3, data: { custom_id: 'capdone' }, message: { content: 'x' } }, { ...c, state: saved });
  assert.equal(done.type, 7);
  assert.match(done.data.content, /これで全部。OK/);
});

test('"なし" marks the day answered and stops asking', async () => {
  const c = ctx(stateWith());
  const res = await handleInteraction({ type: 3, data: { custom_id: 'capnone' }, message: { content: 'きょう、宿題出た？' } }, c);
  assert.equal(res.type, 7);
  assert.match(res.data.content, /きょうは宿題なし。OK（07:42）/);
  assert.equal(c.saved[0].capture['2026-10-09'], 'none');
});

test('due words are understood', async () => {
  const { parseDueWords } = await import('../src/discord.js');
  assert.equal(parseDueWords('あした', '2026-10-09'), '2026-10-10');
  assert.equal(parseDueWords('あさって', '2026-10-09'), '2026-10-11');
  assert.equal(parseDueWords('来週', '2026-10-09'), '2026-10-16');
  assert.equal(parseDueWords('10-14', '2026-10-09'), '2026-10-14');
  assert.equal(parseDueWords('1/8', '2026-10-09'), '2027-01-08');
  assert.equal(parseDueWords('2026-12-01', '2026-10-09'), '2026-12-01');
  assert.equal(parseDueWords('', '2026-10-09'), '2026-10-10');
  assert.equal(parseDueWords('なんか', '2026-10-09'), '2026-10-10');
});
