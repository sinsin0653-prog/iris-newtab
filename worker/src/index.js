// 宿題忘れゼロ — Cloudflare Worker。アプリとの同期 API、Discord の Interactions、5 分おきの催促。
import { planNudges } from './scheduler.js';
import { verifyDiscordRequest, handleInteraction, DiscordRest, COMMANDS } from './discord.js';
import { SETUP_HTML } from './setup-page.js';
import { APP_ASSETS } from './app-assets.js';
import { withDefaults, mergeState, emptyState, materializeRepeats } from './state.js';
import { nudgeStage, dayPlan } from './core.js';
import { localParts } from './scheduler.js';

const KEY = 'state';
// 外から起こす見回り（/api/tick）は、前の見回りから 4 分たっていなければ何もしない。連打されても KV を書きすぎない
const TICK_MIN_GAP_MS = 4 * 60 * 1000;

async function loadState(env) {
  const raw = await env.SHUKUDAI.get(KEY);
  return raw ? withDefaults(JSON.parse(raw)) : emptyState();
}
async function saveState(env, state) { await env.SHUKUDAI.put(KEY, JSON.stringify(state)); }

function cors(env, extra = {}) {
  return { 'Access-Control-Allow-Origin': env.APP_ORIGIN || '*', 'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Authorization,Content-Type', 'Access-Control-Max-Age': '86400', ...extra };
}
const json = (env, data, status = 200) => new Response(JSON.stringify(data), { status, headers: cors(env, { 'Content-Type': 'application/json; charset=utf-8' }) });

function authorized(request, env) {
  const h = request.headers.get('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const want = env.SYNC_TOKEN || '';
  if (!want || token.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= token.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });

    // アプリ本体（../shukudai/ をまとめたもの）
    if (url.pathname === '/' || url.pathname === '/app') return Response.redirect(url.origin + '/app/', 302);
    if (url.pathname.startsWith('/app/') && request.method === 'GET') return serveAsset(request, url.pathname);

    // 外から起こす見回り。Cloudflare の Cron が設定できないときに、GitHub Actions などが 5 分おきに叩く
    if (url.pathname === '/api/tick' && (request.method === 'GET' || request.method === 'POST')) {
      if (!env.SHUKUDAI) return json(env, { error: 'KV（SHUKUDAI）がまだつながっていない' }, 400);
      const state = await loadState(env);
      const last = Date.parse(state.nudge.lastRunAt || '') || 0;
      if (Date.now() - last < TICK_MIN_GAP_MS) return json(env, { ran: false, lastRunAt: state.nudge.lastRunAt });
      const sent = await runPatrol(env, new Date(), state, 'tick');
      return json(env, { ran: true, sent });
    }

    if (url.pathname === '/interactions' && request.method === 'POST') {
      const { valid, body } = await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY);
      if (!valid) return new Response('bad signature', { status: 401 });
      const interaction = JSON.parse(body);
      const state = await loadState(env);
      const events = [];
      const res = await handleInteraction(interaction, { state, now: new Date(), save: (s) => saveState(env, s), events });
      if (events.length) ctx.waitUntil(postGoodNews(env, state, events));
      return new Response(JSON.stringify(res), { headers: { 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/api/state') {
      if (!authorized(request, env)) return json(env, { error: 'unauthorized' }, 401);
      if (request.method === 'GET') return json(env, await loadState(env));
      if (request.method === 'PUT') {
        let incoming;
        try { incoming = await request.json(); } catch { return json(env, { error: 'bad json' }, 400); }
        const before = await loadState(env);
        const merged = mergeState(before, incoming);
        merged.items = materializeRepeats(merged.items, localParts(new Date(), merged.settings.tz).dateKey, new Date().toISOString());
        await saveState(env, merged);
        // アプリ側で全部「かばんに入れた」になったら、良い知らせを見守りチャンネルへ
        const lp = localParts(new Date(), merged.settings.tz);
        const leaveOf = (st) => dayPlan(lp.local, st.settings).leaveAt || st.settings.leaveAt;
        const was = nudgeStage({ items: before.items, today: lp.dateKey, now: lp.local, leaveAt: leaveOf(before) });
        const is = nudgeStage({ items: merged.items, today: lp.dateKey, now: lp.local, leaveAt: leaveOf(merged) });
        if (was.stage !== 'clear' && is.stage === 'clear' && was.items.length) ctx.waitUntil(postGoodNews(env, merged, [{ type: 'packed_all', text: `ぜんぶ入れた（${String(lp.h).padStart(2, '0')}:${String(lp.mi).padStart(2, '0')}）。いってらっしゃい！` }]));
        return json(env, merged);
      }
    }

    if (url.pathname === '/api/test-dm' && request.method === 'POST') {
      if (!authorized(request, env)) return json(env, { error: 'unauthorized' }, 401);
      const state = await loadState(env);
      const userId = state.settings.discord.userId;
      if (!userId) return json(env, { error: 'settings.discord.userId がまだない' }, 400);
      try {
        await new DiscordRest(env.DISCORD_TOKEN).dm(userId, { content: 'つながった！ここに催促が来る。', embeds: [{ title: '宿題忘れゼロ', description: 'テスト送信。', color: 0xff8fc5 }] });
        return json(env, { ok: true });
      } catch (e) {
        return json(env, { error: String(e.message || e) }, 502);
      }
    }

    // ブラウザだけで準備するためのページと、その裏の API
    if (url.pathname === '/setup' && request.method === 'GET') {
      return new Response(SETUP_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer' } });
    }
    if (url.pathname === '/api/health' && request.method === 'GET') {
      // 何が入っているか（あるか・ないかだけ。中身は返さない）
      let kv = false, lastRunAt = null, lastRunVia = null, buttonOkAt = null, userIdSaved = false;
      try {
        if (env.SHUKUDAI) { const st = await loadState(env); kv = true; lastRunAt = st.nudge.lastRunAt || null; lastRunVia = st.nudge.lastRunVia || null; buttonOkAt = st.nudge.buttonOkAt || null; userIdSaved = !!st.settings.discord.userId; }
      } catch { kv = false; }
      return json(env, { ok: true, checks: { DISCORD_TOKEN: !!env.DISCORD_TOKEN, DISCORD_PUBLIC_KEY: !!env.DISCORD_PUBLIC_KEY, DISCORD_APP_ID: !!env.DISCORD_APP_ID, SYNC_TOKEN: !!env.SYNC_TOKEN, KV: kv }, userIdSaved, lastRunAt, lastRunVia, buttonOkAt, interactionsUrl: url.origin + '/interactions' });
    }
    if (url.pathname === '/api/setup' && request.method === 'POST') {
      if (!env.SYNC_TOKEN) return json(env, { error: 'SYNC_TOKEN（合言葉）がまだ Worker に入っていない' }, 400);
      if (!authorized(request, env)) return json(env, { error: '合言葉がちがう（SYNC_TOKEN に入れたものと同じにする）' }, 401);
      if (!env.SHUKUDAI) return json(env, { error: 'KV（SHUKUDAI）がまだつながっていない' }, 400);
      let body = {};
      try { body = await request.json(); } catch { body = {}; }
      const out = { saved: false, registered: null, dm: false, endpoint: null, errors: [] };
      const state = await loadState(env);
      const userId = String(body.userId || '').trim();
      if (userId) {
        if (!/^\d{15,22}$/.test(userId)) out.errors.push('ユーザー ID は 17〜20 桁くらいの数字だけ');
        else { state.settings.discord = { ...state.settings.discord, userId }; await saveState(env, state); out.saved = true; }
      }
      if (!env.DISCORD_TOKEN) { out.errors.push('DISCORD_TOKEN（Bot のトークン）がまだ入っていない'); return json(env, out); }
      const rest = new DiscordRest(env.DISCORD_TOKEN);
      if (body.register !== false) {
        if (!env.DISCORD_APP_ID) out.errors.push('DISCORD_APP_ID（Application ID）がまだ入っていない');
        else {
          try { const r = await rest.call('PUT', `/applications/${env.DISCORD_APP_ID}/commands`, COMMANDS); out.registered = Array.isArray(r) ? r.map((c) => '/' + c.name) : []; }
          catch (e) { out.errors.push('コマンド登録：' + explainDiscord(e)); }
        }
      }
      // ボタンの返事を Discord がこの Worker に送る設定（Interactions Endpoint URL）が入っているか、Discord 本人に聞く
      if (body.register !== false) try {
        const app = await rest.call('GET', '/applications/@me');
        const want = url.origin + '/interactions';
        out.endpoint = { set: app.interactions_endpoint_url || null, want, ok: app.interactions_endpoint_url === want };
        if (!out.endpoint.ok) out.errors.push(app.interactions_endpoint_url ? `Interactions Endpoint URL がちがう（いまは ${app.interactions_endpoint_url}）。${want} にする` : `Interactions Endpoint URL がまだ空。Developer Portal の General Information に ${want} を貼って Save Changes（これがないと、DM のボタンを押しても何も起きない）`);
      } catch (e) { out.errors.push('Discord に聞けなかった：' + explainDiscord(e)); }
      if (body.test !== false) {
        const uid = state.settings.discord.userId;
        if (!uid) out.errors.push('ユーザー ID がまだない（上の欄に入れる）');
        else {
          try { await rest.dm(uid, { content: 'つながった！ここに催促が来る。', embeds: [{ title: '宿題忘れゼロ', description: 'テスト送信。放課後の「課題出た？」も、朝の「出るまであと〇分」も、ここに来る。下のボタンを押して、動くか確かめて。', color: 0xff8fc5 }], components: [{ type: 1, components: [{ type: 2, style: 3, label: '押して確かめる', custom_id: 'ping' }] }] }); out.dm = true; }
          catch (e) { out.errors.push('テスト DM：' + explainDiscord(e)); }
        }
      }
      return json(env, out);
    }

    return json(env, { error: 'not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    await runPatrol(env, new Date(event.scheduledTime || Date.now()), await loadState(env), 'cron');
  }
};

/** 見回り 1 回分：送るべき催促を決めて、記録して、送る。Cron からも /api/tick からも呼ぶ。送った数を返す。 */
async function runPatrol(env, now, state, via) {
  const { actions, state: next } = planNudges({ state, now });
  next.nudge.lastRunAt = new Date().toISOString(); // /setup で「見回っているか」を見せる
  next.nudge.lastRunVia = via;
  await saveState(env, next);
  if (!actions.length) return 0;
  const userId = next.settings.discord.userId;
  const watch = next.settings.discord.watchChannelId;
  const w = next.settings.watch || {};
  const rest = new DiscordRest(env.DISCORD_TOKEN);
  for (const a of actions) {
    try {
      if (a.toChannel) { if (watch) await rest.send(watch, a.payload); continue; }
      if (userId) await rest.dm(userId, a.payload);
      // 見守りチャンネル：本人が選んだものだけ。既定は良い知らせだけなので、ここに来るのは夜のまとめと出発後の催促を選んだとき
      if (watch && a.kind === 'evening' && w.evening) await rest.send(watch, { ...a.payload, components: [], content: a.payload.embeds[0].title });
      if (watch && w.late && /:late[3-5]$/.test(a.slot)) await rest.send(watch, { ...a.payload, components: [] });
    } catch (e) {
      console.error('send failed', a.slot, String(e.message || e));
    }
  }
  return actions.length;
}

/** /app/ の中身を返す。変わっていなければ 304。 */
function serveAsset(request, pathname) {
  const a = APP_ASSETS[pathname];
  if (!a) return new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  const headers = { 'Content-Type': a.type, ETag: a.etag, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  if (request.headers.get('If-None-Match') === a.etag) return new Response(null, { status: 304, headers });
  const body = a.b64 ? Uint8Array.from(atob(a.b64), (c) => c.charCodeAt(0)) : a.body;
  return new Response(body, { headers });
}

/** 良い知らせ（ぜんぶ入れた、出した）を見守りチャンネルへ。本人が watch.good を切っていれば送らない。 */
async function postGoodNews(env, state, events) {
  const watch = state.settings.discord.watchChannelId;
  if (!watch || !(state.settings.watch || {}).good) return;
  const rest = new DiscordRest(env.DISCORD_TOKEN);
  for (const ev of events) {
    try { await rest.send(watch, { content: ev.text, allowed_mentions: { users: [] } }); } catch (e) { console.error('good news failed', String(e.message || e)); }
  }
}

/** Discord のエラーを、何を直せばいいかの言葉にする。 */
function explainDiscord(e) {
  const msg = String((e && e.message) || e);
  if (/→ 401/.test(msg)) return 'Bot のトークンがちがう。Developer Portal の Bot タブで Reset Token して、DISCORD_TOKEN に入れ直す';
  if (/"code":\s*50007/.test(msg)) return 'DM を送れない。Bot と同じサーバーにいるか、そのサーバーの「プライバシー設定」で「ダイレクトメッセージ」を許可しているか見る';
  if (/"code":\s*10013/.test(msg)) return 'そのユーザー ID の人が見つからない。ID をコピーし直す';
  if (/"code":\s*10002/.test(msg) || /→ 404/.test(msg)) return 'Application ID がちがう（DISCORD_APP_ID）';
  if (/→ 403/.test(msg)) return 'Bot に権限がない。招待し直す';
  return msg.slice(0, 200);
}
