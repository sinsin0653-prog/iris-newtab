// はしごを上る係。5 分おきに呼ばれ、「いま送るべき催促」を決める。送るのは index.js。
import { discordPayload, nudgeStage, dueInfo, parseDate, addDays, hhmmToMinutes, captureAnswered } from './core.js';
import { withDefaults } from './state.js';

/** UTC の Date を、設定のタイムゾーンの「壁時計」に直す。local は getHours() などがその壁時計を返す Date。 */
export function localParts(now, tz = 'Asia/Tokyo') {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = {};
  for (const part of fmt.formatToParts(now)) if (part.type !== 'literal') p[part.type] = +part.value;
  const local = new Date(p.year, p.month - 1, p.day, p.hour, p.minute);
  const dateKey = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  return { y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute, minutes: p.hour * 60 + p.minute, dateKey, local };
}

export function inQuietHours(minutes, settings) {
  const from = hhmmToMinutes(settings.quietFrom || '22:00');
  const to = hhmmToMinutes(settings.quietTo || '06:30');
  return from > to ? (minutes >= from || minutes < to) : (minutes >= from && minutes < to);
}

const LADDER = [
  { name: 'wake', at: (s) => hhmmToMinutes(s.wakeAt), snoozable: true, fresh: 20 },
  { name: 'soon', at: (s) => hhmmToMinutes(s.leaveAt) - 30, snoozable: true, fresh: 20 },
  { name: 'urgent', at: (s) => hhmmToMinutes(s.leaveAt) - 15, snoozable: false, fresh: 20 },
  ...[0, 1, 2, 3, 4, 5].map((k) => ({ name: `late${k}`, at: (s) => hhmmToMinutes(s.leaveAt) + 10 * k, snoozable: false, fresh: 60 }))
];

function liveItems(state) { return state.items.filter((i) => !i.deleted); }

/**
 * planNudges({ state, now }) → { actions: [{ slot, kind, payload }], state }
 * state.nudge.sent に送った段を記録し、同じ段を二度送らない。止まっていた時間の分をまとめて送ることはしない（最後の 1 段だけ）。
 */
export function planNudges({ state, now = new Date() }) {
  const st = withDefaults(state);
  const s = st.settings;
  const nowIso = now.toISOString();
  const lp = localParts(now, s.tz);
  const D = lp.dateKey, M = lp.minutes;
  const sent = { ...st.nudge.sent };
  const actions = [];
  const mark = (slot) => { sent[slot] = nowIso; };
  const key = (name) => `${D}:${name}`;

  // 古い記録は 3 日で捨てる
  const cutoff = addDays(parseDate(D), -3);
  for (const k of Object.keys(sent)) if (parseDate(k.slice(0, 10)) < cutoff) delete sent[k];

  const out = (extra) => ({ actions, state: { ...st, nudge: { ...st.nudge, sent, ...(extra || {}) } } });
  if (s.escalation !== 'full') return out();
  if (inQuietHours(M, s)) return out();

  const items = liveItems(st);
  const common = { items, today: D, now: lp.local, leaveAt: s.leaveAt, userId: s.discord.userId || undefined, appUrl: s.appUrl || undefined };
  const snoozed = st.nudge.snoozeUntil && new Date(st.nudge.snoozeUntil) > now;

  // 朝のはしご：期限がきょう／過ぎていて、まだ入れていないものがあるときだけ
  const pending = nudgeStage({ items, today: D, now: lp.local, leaveAt: s.leaveAt }).stage !== 'clear';
  const due = LADDER.filter((r) => r.at(s) <= M && !sent[key(r.name)]);
  if (due.length) {
    const last = due[due.length - 1];
    for (const r of due) mark(key(r.name));
    const fresh = M - last.at(s) <= last.fresh;
    if (pending && fresh && !(last.snoozable && snoozed)) {
      actions.push({ slot: key(last.name), kind: 'morning', payload: discordPayload({ ...common, kind: 'morning' }) });
    } else if (pending && !fresh && last.snoozable && snoozed) {
      // 「あとで」中に過ぎた段は、あとで鳴らさない
    }
  }

  // 捕まえる：学校のある日の放課後、きょうの分を答えるまで 30 分おきに最大 3 回
  const answered = captureAnswered({ items, capture: st.capture, today: D });
  const isSchoolDay = (s.schoolDays || []).includes(lp.local.getDay());
  if (isSchoolDay && !answered) {
    const base = hhmmToMinutes(s.afterSchoolAt), step = Math.max(10, +s.captureRepeatMinutes || 30), max = Math.max(1, +s.captureMax || 3);
    const dueRungs = [];
    for (let k = 0; k < max; k++) { const name = `capture${k}`; if (base + step * k <= M && !sent[key(name)]) dueRungs.push({ name, k, at: base + step * k }); }
    if (dueRungs.length) {
      const last = dueRungs[dueRungs.length - 1];
      for (const r of dueRungs) mark(key(r.name));
      if (M - last.at <= 20) actions.push({ slot: key(last.name), kind: 'capture', payload: discordPayload({ ...common, kind: 'capture', timetable: s.timetable, askNo: last.k + 1 }) });
    }
  }

  // 前日の夜：あしたまでにやるものが残っていれば 20:00、まだなら 21:30。きょう何も登録していなければ、その質問も混ぜる
  const eveningRungs = [['evening', s.eveningAt], ['evening2', s.evening2At]];
  for (const [name, at] of eveningRungs) {
    const t = hhmmToMinutes(at);
    if (M >= t && M < t + 20 && !sent[key(name)]) {
      mark(key(name));
      const captureMissing = isSchoolDay && !answered;
      const payload = discordPayload({ ...common, kind: 'evening', captureMissing });
      if (captureMissing) {
        // 聞く相手が答えられるように、科目ボタンも付ける
        const ask = discordPayload({ ...common, kind: 'capture', timetable: s.timetable, askNo: 2 });
        payload.components = ask.components.concat(payload.components).slice(0, 5);
      }
      const tomorrow = addDays(parseDate(D), 1);
      const left = items.filter((i) => !i.done && parseDate(i.due) <= tomorrow);
      if ((left.length || captureMissing) && !(name === 'evening' && snoozed)) actions.push({ slot: key(name), kind: 'evening', payload });
    }
  }

  // 期限を過ぎたもの：16:00 / 19:00 / 21:00
  for (const at of s.overdueAt || []) {
    const t = hhmmToMinutes(at);
    const slot = key(`overdue:${at}`);
    if (M >= t && M < t + 20 && !sent[slot]) {
      mark(slot);
      const overdue = items.filter((i) => !i.done && dueInfo(i.due, D).state === 'overdue');
      if (overdue.length) actions.push({ slot, kind: 'overdue', payload: discordPayload({ ...common, kind: 'overdue' }) });
    }
  }

  return out();
}
