// Discord とのやりとり：署名の確認、REST、ボタンとスラッシュコマンドの応答。
import { discordPayload, parseDate, addDays, toISO, nudgeStage, captureAnswered, captureSubjects } from './core.js';
import { withDefaults } from './state.js';
import { localParts } from './scheduler.js';

export const API = 'https://discord.com/api/v10';

export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 || /[^0-9a-f]/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Discord からの Interaction の署名（Ed25519）を確かめる。本文は 1 回しか読めないので文字列で返す。 */
export async function verifyDiscordRequest(request, publicKeyHex) {
  const sig = hexToBytes(request.headers.get('X-Signature-Ed25519') || '');
  const ts = request.headers.get('X-Signature-Timestamp') || '';
  const body = await request.text();
  const key = hexToBytes(publicKeyHex || '');
  if (!sig || !key || !ts) return { valid: false, body };
  try {
    const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'Ed25519' }, false, ['verify']);
    const valid = await crypto.subtle.verify('Ed25519', cryptoKey, sig, new TextEncoder().encode(ts + body));
    return { valid, body };
  } catch {
    return { valid: false, body };
  }
}

/** Bot として送る。 */
export class DiscordRest {
  constructor(token, fetchImpl = globalThis.fetch) { this.token = token; this.fetch = fetchImpl; }
  async call(method, path, body) {
    const res = await this.fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bot ${this.token}`, 'Content-Type': 'application/json', 'User-Agent': 'shukudai-worker (https://github.com/sinsin0653-prog/iris-newtab, 1.0)' },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) throw new Error(`Discord ${method} ${path} → ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  }
  async dmChannel(userId) { const ch = await this.call('POST', '/users/@me/channels', { recipient_id: userId }); return ch.id; }
  async send(channelId, payload) { return this.call('POST', `/channels/${channelId}/messages`, payload); }
  async dm(userId, payload) { return this.send(await this.dmChannel(userId), payload); }
}

export const SUBJECT_CHOICES = ['国語', '数学', '英語', '理科', '社会', 'その他'].map((s) => ({ name: s, value: s }));
export const COMMANDS = [
  {
    name: 'shukudai', description: '宿題を登録する（科目・範囲・どこにある・いつまで）',
    options: [
      { type: 3, name: 'kamoku', description: '科目', required: true, choices: SUBJECT_CHOICES },
      { type: 3, name: 'hani', description: '範囲（p.24〜27、プリント1枚 など）', required: true },
      { type: 3, name: 'doko', description: 'どこにある？（教科書、プリント、Classroom…）', required: false },
      { type: 3, name: 'itsu', description: 'いつまで？', required: false, choices: [{ name: 'あした', value: '+1' }, { name: 'あさって', value: '+2' }, { name: '来週の同じ曜日', value: '+7' }, { name: 'きょう', value: '+0' }] },
      { type: 3, name: 'hizuke', description: '日付で決める（YYYY-MM-DD）。itsu より優先', required: false }
    ]
  },
  { name: 'kyou', description: 'きょう持っていくものを見る' }
];

const now2 = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const reply = (data) => ({ type: 4, data });
const ephemeral = (content) => ({ type: 4, data: { content, flags: 64 } });
const update = (data) => ({ type: 7, data });

/** 「あした」「あさって」「来週」「きょう」「10-14」「10/14」「2026-10-14」を日付に。わからなければ あした。 */
export function parseDueWords(text, todayKey) {
  const t = String(text || '').trim();
  const today = parseDate(todayKey);
  if (!t || /^あした|明日|^tomorrow$/i.test(t)) return toISO(addDays(today, 1));
  if (/^あさって|明後日/.test(t)) return toISO(addDays(today, 2));
  if (/^来週|らいしゅう/.test(t)) return toISO(addDays(today, 7));
  if (/^きょう|今日|^today$/i.test(t)) return toISO(today);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return toISO(new Date(+m[1], +m[2] - 1, +m[3]));
  m = /^(\d{1,2})[\/-](\d{1,2})$/.exec(t);
  if (m) {
    let d = new Date(today.getFullYear(), +m[1] - 1, +m[2]);
    if (d < today) d = new Date(today.getFullYear() + 1, +m[1] - 1, +m[2]);
    return toISO(d);
  }
  m = /^\+(\d+)$/.exec(t);
  if (m) return toISO(addDays(today, +m[1]));
  return toISO(addDays(today, 1));
}
function captureRows(subjects, more) {
  const rows = [];
  for (let r = 0; r < subjects.length; r += 5) rows.push({ type: 1, components: subjects.slice(r, r + 5).map((sub) => ({ type: 2, style: 2, label: sub, custom_id: 'cap:' + sub })) });
  rows.push({ type: 1, components: [{ type: 2, style: 3, label: more ? 'これで全部' : 'きょうは なし', custom_id: more ? 'capdone' : 'capnone' }] });
  return rows;
}
function modalValues(interaction) {
  const out = {};
  for (const row of (interaction.data && interaction.data.components) || []) for (const c of row.components || []) out[c.custom_id] = c.value;
  return out;
}

function optionMap(interaction) {
  const m = {};
  for (const o of (interaction.data && interaction.data.options) || []) m[o.name] = o.value;
  return m;
}

/**
 * Interaction に答える。ctx = { state, now, save(state) }。返り値は Discord に返す JSON。
 */
export async function handleInteraction(interaction, ctx) {
  if (!interaction || interaction.type === 1) return { type: 1 };
  const state = withDefaults(ctx.state);
  const s = state.settings;
  const lp = localParts(ctx.now || new Date(), s.tz);
  const D = lp.dateKey;
  const stamp = now2(lp.local);
  const live = state.items.filter((i) => !i.deleted);
  const touch = (i) => { i.updatedAt = (ctx.now || new Date()).toISOString(); return i; };

  if (interaction.type === 2) {
    const name = interaction.data && interaction.data.name;
    if (name === 'shukudai') {
      const o = optionMap(interaction);
      const range = String(o.hani || '').trim();
      if (!range) return ephemeral('範囲だけは書いて！（例：p.24〜27）');
      let due = null;
      if (o.hizuke && /^\d{4}-\d{2}-\d{2}$/.test(o.hizuke)) due = o.hizuke;
      else if (o.itsu && /^\+\d+$/.test(o.itsu)) due = toISO(addDays(parseDate(D), +o.itsu.slice(1)));
      else due = toISO(addDays(parseDate(D), 1));
      const nowIso = (ctx.now || new Date()).toISOString();
      const item = { id: 'hw_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), subject: o.kamoku || 'その他', range, where: String(o.doko || '').trim(), submitTo: '', due, done: false, packed: false, createdAt: nowIso, updatedAt: nowIso };
      state.items.push(item);
      state.capture[D] = 'added';
      await ctx.save(state);
      const d = parseDate(due);
      return reply({
        embeds: [{ title: '登録した', description: `・${item.subject}　${item.range}　｜　${item.where ? 'どこ：' + item.where : 'どこ：まだ書いてない'}　｜　${d.getMonth() + 1}/${d.getDate()} まで`, color: 0xff8fc5, footer: { text: item.where ? '宿題忘れゼロ' : '宿題忘れゼロ ・ どこにあるかは、あとでアプリで足せる' } }]
      });
    }
    if (name === 'kyou') {
      const payload = discordPayload({ kind: 'morning', items: live, today: D, now: lp.local, leaveAt: s.leaveAt, appUrl: s.appUrl || undefined });
      return reply({ embeds: payload.embeds, components: payload.components });
    }
    return ephemeral('そのコマンドは知らない。');
  }

  if (interaction.type === 3) {
    const id = String((interaction.data && interaction.data.custom_id) || '');
    const msg = interaction.message || {};
    const [action, arg] = id.split(':');
    const ids = (arg || '').split(',').filter(Boolean);
    if (action === 'cap') {
      const subject = arg || 'その他';
      return {
        type: 9,
        data: {
          custom_id: 'capmodal:' + subject,
          title: `${subject} の宿題`,
          components: [
            { type: 1, components: [{ type: 4, custom_id: 'hani', label: '範囲（p.24〜27、プリント1枚 など）', style: 1, required: true, max_length: 100 }] },
            { type: 1, components: [{ type: 4, custom_id: 'doko', label: 'どこにある？（教科書、プリント、Classroom…）', style: 1, required: false, max_length: 100 }] },
            { type: 1, components: [{ type: 4, custom_id: 'itsu', label: 'いつまで？（あした／あさって／来週／10-14）', style: 1, required: false, value: 'あした', max_length: 20 }] }
          ]
        }
      };
    }
    if (action === 'capnone' || action === 'capdone') {
      const already = captureAnswered({ items: live, capture: state.capture, today: D });
      state.capture[D] = already === 'added' ? 'added' : 'none';
      await ctx.save(state);
      const tail = state.capture[D] === 'added' ? `これで全部。OK（${stamp}）。` : `きょうは宿題なし。OK（${stamp}）。`;
      return update({ content: `${msg.content || ''}\n${tail}`.trim(), embeds: msg.embeds || [], components: [] });
    }
    if (action === 'pack') {
      let n = 0;
      for (const i of live) if (ids.includes(i.id) && !i.packed) { i.packed = true; i.packedAt = (ctx.now || new Date()).toISOString(); touch(i); n++; }
      await ctx.save(state);
      const left = nudgeStage({ items: state.items.filter((i) => !i.deleted), today: D, now: lp.local, leaveAt: s.leaveAt });
      const tail = left.stage === 'clear' ? `入れた（${stamp}）。いってらっしゃい！` : `入れた（${stamp}）。あと ${left.items.length} つ。`;
      return update({ content: `${msg.content || ''}\n${tail}`.trim(), embeds: msg.embeds || [], components: [] });
    }
    if (action === 'done') {
      for (const i of live) if (ids.includes(i.id)) { i.done = true; touch(i); }
      await ctx.save(state);
      const keep = ((msg.components && msg.components[0] && msg.components[0].components) || []).filter((b) => !/^done:/.test(b.custom_id || '') && !/^snooze:/.test(b.custom_id || ''));
      return update({ content: `${msg.content || ''}\nやった！（${stamp}）。あとは入れるだけ。`.trim(), embeds: msg.embeds || [], components: keep.length ? [{ type: 1, components: keep }] : [] });
    }
    if (action === 'snooze') {
      const used = (state.nudge.snoozeCount && state.nudge.snoozeCount[D]) || 0;
      if (used >= s.snoozeMax) return ephemeral('「あとで」はきょうはもう使えない。入れよう。');
      const until = new Date((ctx.now || new Date()).getTime() + 10 * 60000);
      state.nudge.snoozeUntil = until.toISOString();
      state.nudge.snoozeCount = { [D]: used + 1 };
      await ctx.save(state);
      const left = s.snoozeMax - used - 1;
      return update({ content: `${msg.content || ''}\n10分あとで（${stamp}）。あと ${left} 回。`.trim(), embeds: msg.embeds || [], components: msg.components || [] });
    }
    return ephemeral('そのボタンは知らない。');
  }
  if (interaction.type === 5) {
    const cid = String((interaction.data && interaction.data.custom_id) || '');
    if (cid.startsWith('capmodal:')) {
      const subject = cid.slice('capmodal:'.length) || 'その他';
      const v = modalValues(interaction);
      const range = String(v.hani || '').trim();
      if (!range) return ephemeral('範囲だけは書いて！（例：p.24〜27）');
      const due = parseDueWords(v.itsu, D);
      const nowIso = (ctx.now || new Date()).toISOString();
      const item = { id: 'hw_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), subject, range, where: String(v.doko || '').trim(), submitTo: '', due, done: false, packed: false, createdAt: nowIso, updatedAt: nowIso };
      state.items.push(item);
      state.capture[D] = 'added';
      await ctx.save(state);
      const d = parseDate(due);
      return reply({
        content: `登録した：${subject}　${range}　｜　${item.where ? 'どこ：' + item.where : 'どこ：まだ書いてない'}　｜　${d.getMonth() + 1}/${d.getDate()} まで。ほかの科目は？`,
        components: captureRows(captureSubjects({ today: D, timetable: s.timetable }), true)
      });
    }
    return ephemeral('そのフォームは知らない。');
  }
  return ephemeral('それには答えられない。');
}
