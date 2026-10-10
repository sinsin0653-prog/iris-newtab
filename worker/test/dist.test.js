// dist/worker.js（ブラウザで貼る 1 ファイル版）が src/ と同じで、ちゃんと動くか。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'worker.js');

test('dist/worker.js is up to date with src/', () => {
  const before = fs.readFileSync(dist, 'utf8');
  execFileSync(process.execPath, [path.join(here, '..', 'scripts', 'build-single.mjs')]);
  assert.equal(fs.readFileSync(dist, 'utf8'), before, 'src/ を変えたら node scripts/build-single.mjs で作り直す');
});

function kv() { const m = new Map(); return { m, get: async (k) => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, v); } }; }
const ctx = { waitUntil() {} };

test('setup page, health, setup API and a cron run work from the single file', async () => {
  const worker = (await import(dist + '?t=' + Date.now())).default;
  const env = { SHUKUDAI: kv(), SYNC_TOKEN: 'secret-token', DISCORD_TOKEN: 'bot', DISCORD_PUBLIC_KEY: 'aa', DISCORD_APP_ID: '111' };

  const page = await worker.fetch(new Request('https://w.example/setup'), env, ctx);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /サーバーの準備/);
  assert.match(page.headers.get('Content-Security-Policy'), /connect-src 'self'/);

  const health = await (await worker.fetch(new Request('https://w.example/api/health'), env, ctx)).json();
  assert.deepEqual(health.checks, { DISCORD_TOKEN: true, DISCORD_PUBLIC_KEY: true, DISCORD_APP_ID: true, SYNC_TOKEN: true, KV: true });
  assert.equal(health.interactionsUrl, 'https://w.example/interactions');
  assert.equal(health.userIdSaved, false);
  const bare = await (await worker.fetch(new Request('https://w.example/api/health'), {}, ctx)).json();
  assert.deepEqual(bare.checks, { DISCORD_TOKEN: false, DISCORD_PUBLIC_KEY: false, DISCORD_APP_ID: false, SYNC_TOKEN: false, KV: false }, '何も入っていなくても落ちない');

  const wrong = await worker.fetch(new Request('https://w.example/api/setup', { method: 'POST', headers: { Authorization: 'Bearer nope' }, body: '{}' }), env, ctx);
  assert.equal(wrong.status, 401);

  // Discord の代わり
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(`${init.method} ${String(url).replace('https://discord.com/api/v10', '')}`);
    if (String(url).endsWith('/commands')) return new Response(JSON.stringify(JSON.parse(init.body).map((c) => ({ name: c.name }))), { status: 200 });
    if (String(url).endsWith('/users/@me/channels')) return new Response(JSON.stringify({ id: 'dm1' }), { status: 200 });
    if (String(url).endsWith('/channels/dm1/messages')) return new Response(JSON.stringify({ id: 'm1' }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  try {
    const res = await (await worker.fetch(new Request('https://w.example/api/setup', { method: 'POST', headers: { Authorization: 'Bearer secret-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: '123456789012345678' }) }), env, ctx)).json();
    assert.deepEqual(res, { saved: true, registered: ['/shukudai', '/kyou'], dm: true, errors: [] });
    assert.deepEqual(calls, ['PUT /applications/111/commands', 'POST /users/@me/channels', 'POST /channels/dm1/messages']);
    const bad = await (await worker.fetch(new Request('https://w.example/api/setup', { method: 'POST', headers: { Authorization: 'Bearer secret-token' }, body: JSON.stringify({ userId: 'abc', register: false, test: false }) }), env, ctx)).json();
    assert.match(bad.errors[0], /数字だけ/);
    // DM が届かない（50007）を言葉にする
    globalThis.fetch = async (url) => (String(url).endsWith('/messages') ? new Response('{"message":"Cannot send messages to this user","code":50007}', { status: 403 }) : new Response(JSON.stringify({ id: 'dm1' }), { status: 200 }));
    const no = await (await worker.fetch(new Request('https://w.example/api/setup', { method: 'POST', headers: { Authorization: 'Bearer secret-token' }, body: JSON.stringify({ register: false }) }), env, ctx)).json();
    assert.match(no.errors[0], /同じサーバーにいるか/);
  } finally {
    globalThis.fetch = realFetch;
  }

  // アプリから空の userId が来ても、/setup で入れた userId は消えない
  const put = await worker.fetch(new Request('https://w.example/api/state', { method: 'PUT', headers: { Authorization: 'Bearer secret-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [], settings: { leaveAt: '08:00', discord: { userId: '' }, updatedAt: new Date(Date.now() + 1000).toISOString() } }) }), env, ctx);
  const merged = await put.json();
  assert.equal(merged.settings.leaveAt, '08:00');
  assert.equal(merged.settings.discord.userId, '123456789012345678');

  // 見回り（cron）が動いたことが /setup に出る
  await worker.scheduled({ scheduledTime: Date.now() }, env, ctx);
  const after = await (await worker.fetch(new Request('https://w.example/api/health'), env, ctx)).json();
  assert.ok(after.lastRunAt, '見回った時刻が残る');
  assert.equal(after.userIdSaved, true);
});
