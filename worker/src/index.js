// 宿題忘れゼロ — Cloudflare Worker。アプリとの同期 API、Discord の Interactions、5 分おきの催促。
import { planNudges } from './scheduler.js';
import { verifyDiscordRequest, handleInteraction, DiscordRest, COMMANDS } from './discord.js';
import { SETUP_HTML } from './setup-page.js';
import { withDefaults, mergeState, emptyState } from './state.js';
import { nudgeStage, dayPlan } from './core.js';
import { localParts } from './scheduler.js';

const KEY = 'state';

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
        await saveState(env, merged);
        // アプリ側で全部「かばんに入れた」になったら、良い知らせを見守りチャンネルへ
        const lp = localParts(new Date(), merged.settings.tz);
        const leaveOf = (st) => dayPlan(lp.local.getDay(), st.settings).leaveAt || st.settings.leaveAt;
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
      let kv = false, lastRunAt = null, userIdSaved = false;
      try {
        if (env.SHUKUDAI) { const st = await loadState(env); kv = true; lastRunAt = st.nudge.lastRunAt || null; userIdSaved = !!st.settings.discord.userId; }
      } catch { kv = false; }
      return json(env, { ok: true, checks: { DISCORD_TOKEN: !!env.DISCORD_TOKEN, DISCORD_PUBLIC_KEY: !!env.DISCORD_PUBLIC_KEY, DISCORD_APP_ID: !!env.DISCORD_APP_ID, SYNC_TOKEN: !!env.SYNC_TOKEN, KV: kv }, userIdSaved, lastRunAt, interactionsUrl: url.origin + '/interactions' });
    }
    if (url.pathname === '/api/setup' && request.method === 'POST') {
      if (!env.SYNC_TOKEN) return json(env, { error: 'SYNC_TOKEN（合言葉）がまだ Worker に入っていない' }, 400);
      if (!authorized(request, env)) return json(env, { error: '合言葉がちがう（SYNC_TOKEN に入れたものと同じにする）' }, 401);
      if (!env.SHUKUDAI) return json(env, { error: 'KV（SHUKUDAI）がまだつながっていない' }, 400);
      let body = {};
      try { body = await request.json(); } catch { body = {}; }
      const out = { saved: false, registered: null, dm: false, errors: [] };
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
      if (body.test !== false) {
        const uid = state.settings.discord.userId;
        if (!uid) out.errors.push('ユーザー ID がまだない（上の欄に入れる）');
        else {
          try { await rest.dm(uid, { content: 'つながった！ここに催促が来る。', embeds: [{ title: '宿題忘れゼロ', description: 'テスト送信。放課後の「課題出た？」も、朝の「出るまであと〇分」も、ここに来る。', color: 0xff8fc5 }] }); out.dm = true; }
          catch (e) { out.errors.push('テスト DM：' + explainDiscord(e)); }
        }
      }
      return json(env, out);
    }

    if (url.pathname === '/') return new Response('shukudai worker ok\n準備は /setup を開く', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    return json(env, { error: 'not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    const state = await loadState(env);
    const { actions, state: next } = planNudges({ state, now: new Date(event.scheduledTime || Date.now()) });
    next.nudge.lastRunAt = new Date().toISOString(); // /setup で「見回っているか」を見せる
    await saveState(env, next);
    if (!actions.length) return;
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
  }
};

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
