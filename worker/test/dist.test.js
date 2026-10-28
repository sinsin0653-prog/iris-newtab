// dist/worker.js（ブラウザで貼る 1 ファイル版）が src/ と同じで、ちゃんと動くか。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist', 'worker.js');

test('dist/worker.js is up to date with src/ and the app', () => {
  const assets = path.join(here, '..', 'src', 'app-assets.js');
  const beforeAssets = fs.readFileSync(assets, 'utf8');
  const before = fs.readFileSync(dist, 'utf8');
  execFileSync(process.execPath, [path.join(here, '..', 'scripts', 'build-assets.mjs')]);
  execFileSync(process.execPath, [path.join(here, '..', 'scripts', 'build-single.mjs')]);
  assert.equal(fs.readFileSync(assets, 'utf8'), beforeAssets, 'アプリ（shukudai/）を変えたら npm run build で作り直す');
  assert.equal(fs.readFileSync(dist, 'utf8'), before, 'src/ を変えたら npm run build で作り直す');
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
    if (String(url).endsWith('/applications/@me')) return new Response(JSON.stringify({ interactions_endpoint_url: null }), { status: 200 });
    if (String(url).endsWith('/commands')) return new Response(JSON.stringify(JSON.parse(init.body).map((c) => ({ name: c.name }))), { status: 200 });
    if (String(url).endsWith('/users/@me/channels')) return new Response(JSON.stringify({ id: 'dm1' }), { status: 200 });
    if (String(url).endsWith('/channels/dm1/messages')) return new Response(JSON.stringify({ id: 'm1' }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  try {
    const res = await (await worker.fetch(new Request('https://w.example/api/setup', { method: 'POST', headers: { Authorization: 'Bearer secret-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: '123456789012345678' }) }), env, ctx)).json();
    assert.deepEqual(res, { saved: true, registered: ['/shukudai', '/kyou'], dm: true, endpoint: { set: null, want: 'https://w.example/interactions', ok: false }, errors: [res.errors[0]] });
    assert.match(res.errors[0], /Interactions Endpoint URL がまだ空.*https:\/\/w\.example\/interactions/);
    assert.deepEqual(calls, ['PUT /applications/111/commands', 'GET /applications/@me', 'POST /users/@me/channels', 'POST /channels/dm1/messages']);
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

test('アプリ本体も同じサーバーから配る（/app/）', async () => {
  const worker = (await import(dist + '?t=' + Date.now())).default;
  const env = { SHUKUDAI: kv(), SYNC_TOKEN: 'secret-token' };

  const top = await worker.fetch(new Request('https://w.example/'), env, ctx);
  assert.equal(top.status, 302);
  assert.equal(top.headers.get('Location'), 'https://w.example/app/');
  assert.equal((await worker.fetch(new Request('https://w.example/app'), env, ctx)).headers.get('Location'), 'https://w.example/app/');

  const page = await worker.fetch(new Request('https://w.example/app/'), env, ctx);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('Content-Type'), /^text\/html/);
  const html = await page.text();
  assert.match(html, /<meta name="shukudai-server" content="same-origin">/, 'アプリが「サーバーは自分と同じ場所」とわかる印');
  assert.match(html, /app\.js/);

  const js = await worker.fetch(new Request('https://w.example/app/ds/bundle.js'), env, ctx);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('Content-Type'), /javascript/);
  assert.match(await js.text(), /Shukudai/);

  const png = await worker.fetch(new Request('https://w.example/app/icons/icon-192.png'), env, ctx);
  assert.equal(png.headers.get('Content-Type'), 'image/png');
  assert.deepEqual([...new Uint8Array(await png.arrayBuffer()).slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

  const etag = page.headers.get('ETag');
  assert.ok(etag);
  const again = await worker.fetch(new Request('https://w.example/app/', { headers: { 'If-None-Match': etag } }), env, ctx);
  assert.equal(again.status, 304);

  assert.equal((await worker.fetch(new Request('https://w.example/app/nope.js'), env, ctx)).status, 404);
});

test('外から起こす見回り（/api/tick）：Cron がなくても動き、4 分以内の連打は無視する', async () => {
  const worker = (await import(dist + '?t=' + Date.now())).default;
  const env = { SHUKUDAI: kv(), SYNC_TOKEN: 'secret-token', DISCORD_TOKEN: 'bot' };

  const first = await (await worker.fetch(new Request('https://w.example/api/tick', { method: 'POST' }), env, ctx)).json();
  assert.equal(first.ran, true);
  const second = await (await worker.fetch(new Request('https://w.example/api/tick'), env, ctx)).json();
  assert.equal(second.ran, false, '連打されても KV を書きすぎない');

  const health = await (await worker.fetch(new Request('https://w.example/api/health'), env, ctx)).json();
  assert.ok(health.lastRunAt);
  assert.equal(health.lastRunVia, 'tick');

  // Cron は間隔に関係なく動く
  await worker.scheduled({ scheduledTime: Date.now() }, env, ctx);
  const h2 = await (await worker.fetch(new Request('https://w.example/api/health'), env, ctx)).json();
  assert.equal(h2.lastRunVia, 'cron');

  assert.equal((await worker.fetch(new Request('https://w.example/api/tick'), {}, ctx)).status, 400, 'KV がなければ言葉で返す');
});
