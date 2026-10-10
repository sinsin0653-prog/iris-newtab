// 宿題忘れゼロ — Cloudflare Worker。アプリとの同期 API、Discord の Interactions、5 分おきの催促。
import { planNudges } from './scheduler.js';
import { verifyDiscordRequest, handleInteraction, DiscordRest } from './discord.js';
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

    if (url.pathname === '/') return new Response('shukudai worker ok', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    return json(env, { error: 'not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    const state = await loadState(env);
    const { actions, state: next } = planNudges({ state, now: new Date(event.scheduledTime || Date.now()) });
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
