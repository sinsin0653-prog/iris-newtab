// はしごを上る係。5 分おきに呼ばれ、「いま送るべき催促」を決める。送るのは index.js。
import { discordPayload, nudgeStage, dueInfo, parseDate, addDays, hhmmToMinutes, captureStatus, isActive, isPackedToday } from './core.js';
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

  const nudgeExtra = {};
  const out = () => ({ actions, state: { ...st, nudge: { ...st.nudge, sent, ...nudgeExtra } } });
  if (s.escalation !== 'full') return out();
  if (inQuietHours(M, s)) return out();

  const items = liveItems(st);
  const dow = lp.local.getDay();
  const isSchoolDay = (s.schoolDays || []).includes(dow);
  const common = { items, today: D, now: lp.local, leaveAt: s.leaveAt, userId: s.discord.userId || undefined, appUrl: s.appUrl || undefined, capture: st.capture, timetable: s.timetable };
  const snoozed = st.nudge.snoozeUntil && new Date(st.nudge.snoozeUntil) > now;

  // 朝のはしご：学校のある日だけ。期限がきょう／過ぎていて、まだ入れていないものがあるときだけ
  const pending = nudgeStage({ items, today: D, now: lp.local, leaveAt: s.leaveAt }).stage !== 'clear';
  if (isSchoolDay) {
    const due = LADDER.filter((r) => r.at(s) <= M && !sent[key(r.name)]);
    if (due.length) {
      const last = due[due.length - 1];
      for (const r of due) mark(key(r.name));
      const fresh = M - last.at(s) <= last.fresh;
      if (pending && fresh) {
        if (last.snoozable && snoozed) nudgeExtra.resendAfterSnooze = key(last.name); // 「あとで」が明けたら、この段をもう一度
        else actions.push({ slot: key(last.name), kind: 'morning', payload: discordPayload({ ...common, kind: 'morning' }) });
      }
    }
    // 「10分あとで」が明けた：止めた段を本当に鳴らし直す
    if (st.nudge.resendAfterSnooze && !snoozed && pending) {
      const again = `${st.nudge.resendAfterSnooze}:again`;
      if (!sent[again]) { mark(again); actions.push({ slot: again, kind: 'morning', payload: discordPayload({ ...common, kind: 'morning' }) }); }
      nudgeExtra.resendAfterSnooze = null;
    } else if (st.nudge.resendAfterSnooze && !snoozed) {
      nudgeExtra.resendAfterSnooze = null;
    }
  }

  // 捕まえる：学校のある日の放課後、科目ごとに答え終わるまで。30 分おきに 3 回、そのあとは 1 時間おきに静かな時間まで
  const cst = captureStatus({ items, capture: st.capture, today: D, timetable: s.timetable });
  if (isSchoolDay && !cst.all) {
    const base = hhmmToMinutes((s.afterSchoolByDay || {})[dow] || s.afterSchoolAt);
    const step = Math.max(10, +s.captureRepeatMinutes || 30), max = Math.max(1, +s.captureMax || 3);
    const quietFrom = hhmmToMinutes(s.quietFrom || '22:00');
    const rungs = [];
    for (let k = 0; k < max; k++) rungs.push({ name: `capture${k}`, k, at: base + step * k });
    if (s.captureHourlyUntilQuiet !== false) {
      let t = base + step * (max - 1) + 60, j = max;
      while (t < quietFrom && j < max + 8) { rungs.push({ name: `capture${j}`, k: j, at: t }); t += 60; j++; }
    }
    const dueRungs = rungs.filter((r) => r.at <= M && !sent[key(r.name)]);
    if (dueRungs.length) {
      const last = dueRungs[dueRungs.length - 1];
      for (const r of dueRungs) mark(key(r.name));
      if (M - last.at <= 20) actions.push({ slot: key(last.name), kind: 'capture', payload: discordPayload({ ...common, kind: 'capture', askNo: last.k + 1 }) });
    }
  }

  // 学校を出る前：学校（机・ロッカー）にあるものを、かばんへ
  if (isSchoolDay && s.leaveSchoolAt) {
    const t = hhmmToMinutes(s.leaveSchoolAt);
    const slot = key('leaveschool');
    if (M >= t && M < t + 20 && !sent[slot]) {
      mark(slot);
      const tomorrow = addDays(parseDate(D), 1);
      const atSchool = items.filter((i) => isActive(i) && i.location === 'school' && !isPackedToday(i, D) && parseDate(i.due) <= tomorrow);
      if (atSchool.length) {
        actions.push({ slot, kind: 'leaveschool', payload: {
          content: `学校にあるもの ${atSchool.length} つ。帰る前にかばんへ。`,
          embeds: [{ title: '帰る前に、ロッカーと机の中', description: atSchool.map((i) => `・${i.subject}　${i.range || ''}　｜　${i.where || ''}`).join('\n'), color: 0xffe1ef, footer: { text: '宿題忘れゼロ ・ 家に帰ってからでは取りに戻れない' }, timestamp: now.toISOString() }],
          components: [{ type: 1, components: atSchool.slice(0, 4).map((i) => ({ type: 2, style: 3, label: `入れた：${i.subject}`, custom_id: 'pack:' + i.id })) }],
          allowed_mentions: { users: [] }
        } });
      }
    }
  }

  // 前日の夜：あしたまでにやるものが残っていれば 20:00、まだなら 21:30。答えていない科目があれば、その質問も混ぜる
  const eveningRungs = [['evening', s.eveningAt], ['evening2', s.evening2At]];
  for (const [name, at] of eveningRungs) {
    const t = hhmmToMinutes(at);
    if (M >= t && M < t + 20 && !sent[key(name)]) {
      mark(key(name));
      const askAgainOnNone = isSchoolDay && name === 'evening';
      const payload = discordPayload({ ...common, kind: 'evening', askAgainOnNone, classroomUrl: s.classroomUrl || undefined, captureMissing: isSchoolDay && !cst.all });
      const tomorrow = addDays(parseDate(D), 1);
      const left = items.filter((i) => isActive(i) && !i.done && parseDate(i.due) <= tomorrow);
      const missingRange = items.some((i) => isActive(i) && !i.range);
      const askCapture = isSchoolDay && (!cst.all || (cst.allNone && askAgainOnNone));
      if ((left.length || askCapture || missingRange) && !(name === 'evening' && snoozed)) actions.push({ slot: key(name), kind: 'evening', payload });
    }
  }

  // 期限を過ぎたもの：16:00 / 19:00 / 21:00。@メンションは初日だけ、4 日目からは 19:00 の 1 回だけ
  const overdueItems = items.filter((i) => isActive(i) && parseDate(i.due) < parseDate(D));
  if (overdueItems.length) {
    const oldest = Math.max(...overdueItems.map((i) => Math.round((parseDate(D) - parseDate(i.due)) / 86400000)));
    const newest = Math.min(...overdueItems.map((i) => Math.round((parseDate(D) - parseDate(i.due)) / 86400000)));
    const slots = (s.overdueAt || []).slice();
    const onlyMiddle = oldest >= 4 && slots.length > 1 ? [slots[Math.floor(slots.length / 2)]] : slots;
    for (const at of onlyMiddle) {
      const t = hhmmToMinutes(at);
      const slot = key(`overdue:${at}`);
      if (M >= t && M < t + 20 && !sent[slot]) {
        mark(slot);
        actions.push({ slot, kind: 'overdue', payload: discordPayload({ ...common, kind: 'overdue', quietMention: newest > 1 }) });
      }
    }
  }

  // ミュート疑い：3 日以上ボタンが押されていない日が続いたら、見守りチャンネルに 1 回だけ
  if (actions.length) {
    const days = new Set(st.nudge.sentDays || []); days.add(D);
    nudgeExtra.sentDays = [...days].sort().slice(-14);
    const since = st.nudge.lastInteractionAt ? String(st.nudge.lastInteractionAt).slice(0, 10) : null;
    const silentDays = [...days].filter((d) => !since || d > since);
    const lastMute = st.nudge.muteAskedOn || null;
    if (s.discord.watchChannelId && silentDays.length >= 3 && (!lastMute || parseDate(D) - parseDate(lastMute) >= 3 * 86400000)) {
      nudgeExtra.muteAskedOn = D;
      actions.push({ slot: key('muteask'), kind: 'muteask', toChannel: true, payload: { content: `${s.discord.userId ? `<@${s.discord.userId}> ` : ''}3 日、どのボタンも押されてない。DM をミュートしてない？ 1 回だけ聞く。`, allowed_mentions: { users: s.discord.userId ? [s.discord.userId] : [] } } });
    }
  }

  return out();
}
