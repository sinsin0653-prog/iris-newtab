// Discord とのやりとり：署名の確認、REST、ボタンとスラッシュコマンドの応答。
import { discordPayload, parseDate, addDays, toISO, nudgeStage, captureStatus, nextLesson, isActive, dayPlan, effectiveTimetable, effectiveSchoolDays, askableSubjects, submitPlace } from './core.js';
import { withDefaults, materializeRepeats } from './state.js';
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
  constructor(token, fetchImpl = globalThis.fetch) {
    this.token = token;
    // this.fetch(...) と呼ぶと Cloudflare では Illegal invocation になるので、素の関数として呼ぶ。
    this.fetch = (url, init) => fetchImpl(url, init);
  }
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
export function parseDueWords(text, todayKey, ctx = {}) {
  const t = String(text || '').trim();
  const today = parseDate(todayKey);
  if (!t || /^次|つぎ|next/i.test(t)) return toISO(nextLesson(ctx.subject || '', today, ctx.timetable, ctx.schoolDays).date);
  if (/^あした|明日|^tomorrow$/i.test(t)) return toISO(addDays(today, 1));
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
  return toISO(nextLesson(ctx.subject || '', today, ctx.timetable, ctx.schoolDays).date);
}
/** capture[日付] を科目ごとの形にして書き込む。 */
function setCapture(state, D, subject, value) {
  const cur = state.capture[D];
  const obj = (cur === 'none' || cur === 'added') ? { '*': cur } : (cur && typeof cur === 'object' ? { ...cur } : {});
  if (subject === '*') obj['*'] = value; else if (value) obj[subject] = value; else delete obj[subject];
  state.capture[D] = obj;
}
function captureRows(unanswered) {
  const rows = [];
  const caps = [];
  unanswered.forEach((sub) => { caps.push({ type: 2, style: 2, label: `${sub}：出た`, custom_id: 'cap:' + sub }); caps.push({ type: 2, style: 2, label: `${sub}：なし`, custom_id: 'capno:' + sub }); });
  for (let r = 0; r < caps.length && rows.length < 4; r += 5) rows.push({ type: 1, components: caps.slice(r, r + 5) });
  if (unanswered.length) rows.push({ type: 1, components: [{ type: 2, style: 2, label: unanswered.length > 1 ? 'のこりは ぜんぶ なし' : 'これで全部', custom_id: 'capnone' }] });
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
  state.nudge.lastInteractionAt = (ctx.now || new Date()).toISOString();
  // 毎週くりかえす宿題：終わったら、来週の分をその場で作る
  const spawn = () => { state.items = materializeRepeats(state.items, D, (ctx.now || new Date()).toISOString()); };
  // 押したボタンだけ消す（ほかのボタンは残す）。空になった行は捨てる
  const dropButtons = (match) => ((msg_ && msg_.components) || []).map((row) => ({ type: 1, components: (row.components || []).filter((b) => !match(b.custom_id || '')) })).filter((row) => row.components.length);
  const msg_ = interaction.message;
  // 登録したあとに付けるボタン：やった／毎週にする
  const afterAdd = (item) => [{ type: 1, components: [{ type: 2, style: 3, label: 'もう やった', custom_id: 'done:' + item.id }, { type: 2, style: 2, label: '毎週にする', custom_id: 'repeat:' + item.id }] }];
  const emit = (ev) => { if (Array.isArray(ctx.events)) ctx.events.push(ev); };
  const newItem = (subject, range, where, due) => {
    const nowIso = (ctx.now || new Date()).toISOString();
    return { id: 'hw_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), subject, range, rangeMissing: !range, where, location: /classroom|タブレット|lms|moodle|メール/i.test(where) ? 'online' : (where ? 'bag' : null), submitTo: submitPlace(subject, due, s), due, done: false, packed: false, createdAt: nowIso, createdOn: D, updatedAt: nowIso };
  };
  const plan = dayPlan(lp.local.getDay(), s);
  const leaveAt = plan.leaveAt || s.leaveAt;
  const dueCtx = (subject) => ({ subject, timetable: effectiveTimetable(s), schoolDays: effectiveSchoolDays(s) });
  // いま聞いていい科目（授業が終わったもの。放課後を過ぎたらその日の全部）の答えぐあい
  const askable = () => captureStatus({ items: state.items.filter((i) => !i.deleted), capture: state.capture, today: D, subjects: askableSubjects(D, lp.minutes, s) });

  if (interaction.type === 2) {
    const name = interaction.data && interaction.data.name;
    if (name === 'shukudai') {
      const o = optionMap(interaction);
      const range = String(o.hani || '').trim();
      if (!range) return ephemeral('範囲だけは書いて！（例：p.24〜27）');
      const subject = o.kamoku || 'その他';
      const due = parseDueWords(o.hizuke || o.itsu || '', D, dueCtx(subject));
      const item = newItem(subject, range, String(o.doko || '').trim(), due);
      state.items.push(item);
      setCapture(state, D, subject, 'added');
      await ctx.save(state);
      const d = parseDate(due);
      return reply({
        embeds: [{ title: '登録した', description: `・${item.subject}　${item.range}　｜　${item.where ? 'どこ：' + item.where : 'どこ：まだ書いてない'}　｜　${d.getMonth() + 1}/${d.getDate()} まで`, color: 0xff8fc5, footer: { text: item.where ? '宿題忘れゼロ' : '宿題忘れゼロ ・ どこにあるかは、あとでアプリで足せる' } }],
        components: afterAdd(item)
      });
    }
    if (name === 'kyou') {
      const payload = discordPayload({ kind: 'morning', items: live, today: D, now: lp.local, leaveAt, appUrl: s.appUrl || undefined });
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
      const n = nextLesson(subject, D, effectiveTimetable(s), effectiveSchoolDays(s));
      const defLabel = n.lesson ? `次の${subject}（${n.date.getMonth() + 1}/${n.date.getDate()}）` : `次の学校の日（${n.date.getMonth() + 1}/${n.date.getDate()}）`;
      return {
        type: 9,
        data: {
          custom_id: 'capmodal:' + subject,
          title: `${subject} の宿題`,
          components: [
            { type: 1, components: [{ type: 4, custom_id: 'hani', label: '範囲（空でもいい。夜に聞く）', style: 1, required: false, max_length: 100, placeholder: 'p.24〜27、プリント1枚 など' }] },
            { type: 1, components: [{ type: 4, custom_id: 'doko', label: 'どこにある？（教科書、プリント、Classroom…）', style: 1, required: false, max_length: 100 }] },
            { type: 1, components: [{ type: 4, custom_id: 'itsu', label: 'いつまで？（次／あした／来週／10-14）', style: 1, required: false, value: '次', placeholder: defLabel, max_length: 20 }] }
          ]
        }
      };
    }
    if (action === 'capno') {
      const subject = arg || 'その他';
      setCapture(state, D, subject, 'none');
      await ctx.save(state);
      const cst = askable();
      const tail = cst.all ? (cst.anyAdded ? `${subject} はなし。これで全部。OK（${stamp}）。` : `${subject} はなし。きょうは宿題なし。OK（${stamp}）。`) : `${subject} はなし。のこり：${cst.unanswered.join('・')}`;
      return update({ content: `${msg.content || ''}\n${tail}`.trim(), embeds: msg.embeds || [], components: cst.all ? [] : captureRows(cst.unanswered) });
    }
    if (action === 'capnone' || action === 'capdone') {
      const before = askable();
      for (const sub of before.unanswered) setCapture(state, D, sub, 'none');
      await ctx.save(state);
      const tail = before.anyAdded ? `これで全部。OK（${stamp}）。` : `きょうは宿題なし。OK（${stamp}）。`;
      return update({ content: `${msg.content || ''}\n${tail}`.trim(), embeds: msg.embeds || [], components: [] });
    }
    if (action === 'capreopen') {
      const cur = state.capture[D];
      if (cur && typeof cur === 'object') { for (const k of Object.keys(cur)) if (cur[k] === 'none') delete cur[k]; } else if (cur === 'none') delete state.capture[D];
      await ctx.save(state);
      const cst = askable();
      return update({ content: `${msg.content || ''}\nやっぱりあった。どの科目？`.trim(), embeds: msg.embeds || [], components: captureRows(cst.unanswered) });
    }
    if (action === 'submit' || action === 'drop') {
      const hit = live.filter((i) => ids.includes(i.id) && isActive(i));
      for (const i of hit) { if (action === 'submit') { i.submitted = true; i.submittedAt = (ctx.now || new Date()).toISOString(); } else { i.dropped = true; i.droppedAt = (ctx.now || new Date()).toISOString(); } touch(i); }
      spawn();
      await ctx.save(state);
      if (action === 'submit') for (const i of hit) emit({ type: 'submitted', text: `出した：${i.subject} ${i.range || ''}（${stamp}）` });
      const left = ((msg.components && msg.components[0] && msg.components[0].components) || []).filter((b) => !ids.some((id) => (b.custom_id || '').endsWith(':' + id)));
      const tail = action === 'submit' ? `出した（${stamp}）。えらい。` : `先生に言った（${stamp}）。これで終わり。`;
      return update({ content: `${msg.content || ''}\n${tail}`.trim(), embeds: msg.embeds || [], components: left.length ? [{ type: 1, components: left }] : [] });
    }
    if (action === 'fix') {
      const item = live.find((i) => i.id === arg);
      if (!item) return ephemeral('その宿題はもうない。');
      return { type: 9, data: { custom_id: 'fixmodal:' + item.id, title: `${item.subject} の範囲`, components: [
        { type: 1, components: [{ type: 4, custom_id: 'hani', label: '範囲（p.24〜27、プリント1枚 など）', style: 1, required: true, max_length: 100, value: item.range || '' }] },
        { type: 1, components: [{ type: 4, custom_id: 'doko', label: 'どこにある？', style: 1, required: false, max_length: 100, value: item.where || '' }] }
      ] } };
    }
    if (action === 'pack') {
      let n = 0;
      for (const i of live) if (ids.includes(i.id) && !(i.packed && i.packedOn === D)) { i.packed = true; i.packedAt = (ctx.now || new Date()).toISOString(); i.packedOn = D; touch(i); n++; }
      await ctx.save(state);
      const left = nudgeStage({ items: state.items.filter((i) => !i.deleted), today: D, now: lp.local, leaveAt });
      const tail = left.stage === 'clear' ? `入れた（${stamp}）。いってらっしゃい！` : `入れた（${stamp}）。あと ${left.items.length} つ。`;
      if (left.stage === 'clear') emit({ type: 'packed_all', text: `ぜんぶ入れた（${stamp}）。いってらっしゃい！` });
      const rest = ((msg.components && msg.components[0] && msg.components[0].components) || []).filter((b) => /^pack:/.test(b.custom_id || '') && !ids.some((id) => b.custom_id === 'pack:' + id));
      return update({ content: `${msg.content || ''}\n${tail}`.trim(), embeds: msg.embeds || [], components: left.stage === 'clear' || !rest.length ? [] : [{ type: 1, components: rest }] });
    }
    if (action === 'done') {
      const hit = live.filter((i) => ids.includes(i.id));
      for (const i of hit) { i.done = true; touch(i); }
      spawn();
      await ctx.save(state);
      for (const i of hit) emit({ type: 'done', text: `やった：${i.subject} ${i.range || ''}（${stamp}）` });
      const again = hit.filter((i) => i.repeat === 'weekly').length ? ' 来週の分も出しておいた。' : '';
      const rest = dropButtons((c) => ids.some((id) => c === 'done:' + id));
      return update({ content: `${msg.content || ''}\nやった！（${stamp}）。あとは入れるだけ。${again}`.trim(), embeds: msg.embeds || [], components: rest });
    }
    if (action === 'repeat') {
      const item = live.find((i) => i.id === arg);
      if (!item) return ephemeral('その宿題はもうない。');
      const on = item.repeat !== 'weekly';
      item.repeat = on ? 'weekly' : null;
      touch(item);
      await ctx.save(state);
      const rest = dropButtons((c) => c === 'repeat:' + item.id);
      rest.push({ type: 1, components: [{ type: 2, style: on ? 4 : 2, label: on ? '毎週をやめる' : '毎週にする', custom_id: 'repeat:' + item.id }] });
      return update({ content: `${msg.content || ''}\n${on ? '毎週の宿題にした。終わったら、来週の分が出る。' : '毎週をやめた。'}（${stamp}）`.trim(), embeds: msg.embeds || [], components: rest.slice(0, 5) });
    }
    if (action === 'ping') {
      state.nudge.buttonOkAt = (ctx.now || new Date()).toISOString();
      await ctx.save(state);
      return update({ content: `${msg.content || ''}\nボタンも動いた！（${stamp}）。これで Discord とつながった。`.trim(), embeds: msg.embeds || [], components: [] });
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
      const due = parseDueWords(v.itsu, D, dueCtx(subject));
      const item = newItem(subject, range, String(v.doko || '').trim(), due);
      state.items.push(item);
      setCapture(state, D, subject, 'added');
      await ctx.save(state);
      const d = parseDate(due);
      const cst = askable();
      return reply({
        content: `登録した：${subject}　${range || '（範囲はあとで。夜に聞く）'}　｜　${item.where ? 'どこ：' + item.where : 'どこ：まだ書いてない'}　｜　${d.getMonth() + 1}/${d.getDate()} まで。` + (cst.all ? ' これで全部。' : ` ほかは？ のこり：${cst.unanswered.join('・')}`),
        components: afterAdd(item).concat(cst.all ? [] : captureRows(cst.unanswered)).slice(0, 5)
      });
    }
    if (cid.startsWith('fixmodal:')) {
      const item = live.find((i) => i.id === cid.slice('fixmodal:'.length));
      if (!item) return ephemeral('その宿題はもうない。');
      const v = modalValues(interaction);
      const range = String(v.hani || '').trim();
      if (!range) return ephemeral('範囲だけは書いて！（例：p.24〜27）');
      item.range = range; item.rangeMissing = false;
      if (String(v.doko || '').trim()) item.where = String(v.doko).trim();
      touch(item);
      await ctx.save(state);
      return reply({ content: `書いた：${item.subject}　${item.range}　｜　${item.where ? 'どこ：' + item.where : 'どこ：まだ書いてない'}（${stamp}）` });
    }
    return ephemeral('そのフォームは知らない。');
  }
  return ephemeral('それには答えられない。');
}
