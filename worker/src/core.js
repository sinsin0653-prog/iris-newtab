// 宿題忘れゼロ — 共有ロジック（ES module）。ブラウザ側の shukudai/ds/bundle.js と同じ判定をする。
// 変えるときは両方を変え、worker/test/parity.test.js で一致を確かめる。

export const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const DAY_MS = 86400000;

export function parseDate(v) {
  if (v instanceof Date) return new Date(v.getFullYear(), v.getMonth(), v.getDate());
  if (typeof v === 'string') {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    const d = new Date(v);
    if (!isNaN(d)) return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}
export function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
export function toISO(d) {
  const mm = String(d.getMonth() + 1), dd = String(d.getDate());
  return `${d.getFullYear()}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}
export function formatDate(v) {
  const d = parseDate(v);
  return `${d.getMonth() + 1}/${d.getDate()}（${WEEKDAYS[d.getDay()]}）`;
}
function formatDateSpoken(v) {
  const d = parseDate(v);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}曜日`;
}
export function dayKey(v) { return toISO(parseDate(v || new Date())); }

/** その日に「かばんに入れた」か。packedOn（その日の日付キー）で見る。古い記録（packedOn なし）は当日扱い。 */
export function isPackedToday(item, today) {
  if (!item || !item.packed) return false;
  if (!item.packedOn) return true;
  return item.packedOn === dayKey(today);
}
/** 出した／先生に言った／消した、はもう追わない。 */
export function isActive(item) { return !!item && !item.deleted && !item.submitted && !item.dropped; }
/** 紙を持っていく宿題ではなく、ネットで出すもの。朝のかばん確認から外す。 */
export function isOnline(item) {
  if (!item) return false;
  if (item.location === 'online') return true;
  return /classroom|クラスルーム|タブレット|オンライン|google|ロイロ|teams|forms|提出フォーム|ネット/i.test(item.where || '');
}

/** 期限の状態。色・言葉・アイコンの 3 点セットの元。flags: { packed, submitted, dropped } */
export function dueInfo(due, today, done, flags = {}) {
  const t = parseDate(today || new Date());
  const d = parseDate(due);
  const days = Math.round((d - t) / DAY_MS);
  if (flags.submitted) return { state: 'submitted', label: '出した', days, icon: 'check', date: formatDate(d), spoken: '出した' };
  if (flags.dropped) return { state: 'dropped', label: '先生に言った', days, icon: 'check', date: formatDate(d), spoken: '先生に言った' };
  if (days < 0 && (flags.packed || done)) return { state: 'handin', label: '出した？', days, icon: 'bag', date: formatDate(d), spoken: `期限 ${formatDateSpoken(d)}、出した？` };
  if (done) return { state: 'done', label: 'できた', days, icon: 'check', date: formatDate(d), spoken: 'できた' };
  let label, state;
  if (days < 0) { state = 'overdue'; label = `${-days}日すぎた`; }
  else if (days === 0) { state = 'today'; label = 'きょう'; }
  else if (days === 1) { state = 'soon'; label = 'あした'; }
  else if (days === 2) { state = 'soon'; label = 'あさって'; }
  else { state = 'later'; label = `あと${days}日`; }
  return { state, label, days, icon: 'clock', date: formatDate(d), spoken: `期限 ${formatDateSpoken(d)}、${label}` };
}

// ---- 次の学校の日 / 次の授業 ----
export function nextSchoolDay(today, schoolDays) {
  const t = parseDate(today || new Date());
  const days = Array.isArray(schoolDays) && schoolDays.length ? schoolDays : [1, 2, 3, 4, 5];
  for (let k = 1; k <= 14; k++) { const d = addDays(t, k); if (days.indexOf(d.getDay()) >= 0) return d; }
  return addDays(t, 1);
}
export function nextLesson(subject, today, timetable, schoolDays) {
  const t = parseDate(today || new Date());
  const tt = timetable || {};
  for (let k = 1; k <= 14; k++) {
    const d = addDays(t, k);
    const list = tt[String(d.getDay())];
    if (Array.isArray(list) && list.indexOf(subject) >= 0) return { date: d, lesson: true };
  }
  return { date: nextSchoolDay(t, schoolDays), lesson: false };
}

// ---- 焦らせる：出発時刻までの残り時間と段階 ----
export function parseTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  return m ? { h: +m[1], m: +m[2] } : { h: 7, m: 50 };
}
export function hhmmToMinutes(hhmm) { const t = parseTime(hhmm); return t.h * 60 + t.m; }
function toNow(v) { return v instanceof Date ? v : (v ? new Date(v) : new Date()); }
export function minutesUntilLeave(leaveAt, now) {
  now = toNow(now);
  const t = parseTime(leaveAt);
  const leave = new Date(now.getFullYear(), now.getMonth(), now.getDate(), t.h, t.m);
  return Math.round((leave - now) / 60000);
}
export function spanLabel(mins) {
  const a = Math.abs(mins), h = Math.floor(a / 60), m = a % 60;
  const body = a >= 60 ? `${h}時間${m ? m + '分' : ''}` : `${a}分`;
  return mins >= 0 ? `あと${body}` : `${body}すぎた`;
}
/** stage: clear / calm（60 分より前）/ soon（60〜16 分前）/ urgent（15 分以内）/ late（出発時刻を過ぎた） */
export function nudgeStage(opts = {}) {
  const now = toNow(opts.now);
  const today = parseDate(opts.today || now);
  const pending = (opts.items || []).filter((i) => {
    if (!isActive(i) || isOnline(i) || isPackedToday(i, today)) return false;
    const st = dueInfo(i.due, today, false).state;
    return st === 'today' || st === 'overdue';
  });
  const mins = minutesUntilLeave(opts.leaveAt || '07:50', now);
  const leaveAt = opts.leaveAt || '07:50';
  if (!pending.length) return { stage: 'clear', minutes: mins, label: 'ぜんぶ入れた', items: [], leaveAt };
  pending.sort((a, b) => parseDate(a.due) - parseDate(b.due));
  const stage = mins > 60 ? 'calm' : mins > 15 ? 'soon' : mins >= 0 ? 'urgent' : 'late';
  return { stage, minutes: mins, label: spanLabel(mins), items: pending, leaveAt };
}

// ---- 捕まえる：そもそも登録し忘れないために、こっちから聞く ----
export const SUBJECTS = ['国語', '数学', '英語', '理科', '社会', 'その他'];
function createdOn(item) {
  if (!item) return null;
  if (item.createdOn) return item.createdOn;
  return item.createdAt ? toISO(new Date(item.createdAt)) : null;
}
export function captureSubjects(opts = {}) {
  if (Array.isArray(opts.subjects) && opts.subjects.length) return opts.subjects.slice(0, 7);
  const today = parseDate(opts.today || new Date());
  const list = (opts.timetable || {})[String(today.getDay())];
  if (Array.isArray(list) && list.length) return list.slice(0, 7);
  return SUBJECTS.slice();
}
/** 聞き方は回を追うごとに変える（同じ文は慣れる）。 */
export function captureWording(askNo, today, subs) {
  const d = parseDate(today || new Date());
  if (askNo <= 1) return 'きょう、宿題出た？';
  if (askNo === 2) return `${WEEKDAYS[d.getDay()]}曜。${subs.join('・')}。どれか出た？`;
  if (askNo === 3) return 'まだ答えてない。Classroom と連絡帳を開いて確かめて。';
  return `まだ ${subs.join('・')} が答えてない。見て押すだけ。`;
}
/**
 * きょうの分を科目ごとに見る。capture[日付] は { 科目: 'added'|'none' }（'*' は全部、古い形の文字列も全部）。
 * きょう作った宿題は、その科目を 'added' にする。
 */
export function captureStatus(opts = {}) {
  const today = parseDate(opts.today || new Date());
  const key = toISO(today);
  const subjects = captureSubjects({ today, timetable: opts.timetable, subjects: opts.subjects });
  const raw = (opts.capture || {})[key];
  const answered = {};
  if (raw === 'none' || raw === 'added') subjects.forEach((sub) => { answered[sub] = raw; });
  else if (raw && typeof raw === 'object') {
    Object.keys(raw).forEach((k) => { if (k !== '*') answered[k] = raw[k]; });
    if (raw['*']) subjects.forEach((sub) => { if (!answered[sub]) answered[sub] = raw['*']; });
  }
  (opts.items || []).forEach((i) => { if (!i.deleted && createdOn(i) === key) answered[i.subject] = 'added'; });
  const unanswered = subjects.filter((sub) => answered[sub] !== 'added' && answered[sub] !== 'none');
  const anyAdded = Object.keys(answered).some((k) => answered[k] === 'added');
  return { key, subjects, answered, unanswered, all: unanswered.length === 0, allNone: unanswered.length === 0 && !anyAdded, anyAdded };
}
export function captureAnswered(opts = {}) {
  const st = captureStatus(opts);
  if (!st.all) return null;
  return st.anyAdded ? 'added' : 'none';
}

// ---- Discord へ送るメッセージ ----
// Discord はほぼダークテーマ：黒の帯は見えないので、late と overdue は白（ink のダーク値）
const EMBED_COLORS = { calm: 0xffe1ef, soon: 0xffe1ef, urgent: 0xff8fc5, late: 0xf5f5f5, evening: 0xffe1ef, overdue: 0xf5f5f5, clear: 0xf2f2f2 };
const FOOTER = {
  calm: '宿題忘れゼロ',
  soon: '宿題忘れゼロ ・ 15 分前にもう一度言う',
  urgent: '宿題忘れゼロ ・ 押すまで 10 分ごとに言う',
  late: '宿題忘れゼロ ・ 押すまで 10 分ごとに言う',
  evening: '宿題忘れゼロ ・ まだなら 21:30 にもう一度',
  overdue: '宿題忘れゼロ ・ 出すか、先生に言うまで',
  clear: '宿題忘れゼロ'
};
function itemLine(i, today) {
  const d = dueInfo(i.due, today, i.done, { packed: i.packed });
  const status = d.state === 'handin' ? '持っていった → 出した？' : (i.done ? 'できてる' : 'まだ') + (d.state === 'overdue' ? `（${d.label}）` : '');
  return `・${i.subject || ''}　${i.range || '範囲？'}　｜　${i.where ? 'どこ：' + i.where : 'どこ：まだ書いてない'}${i.location === 'school' ? '（学校）' : ''}　｜　${status}`;
}
/**
 * kind: capture（放課後）/ evening（前日 20:00）/ morning（出発前、段階で変わる）/ overdue（期限を過ぎた夕方）
 * props: { kind, items, today?, now?, leaveAt?, userId?, appUrl?, capture?, timetable?, subjects?, askNo?, askAgainOnNone?, classroomUrl?, quietMention?, captureMissing? }
 */
export function discordPayload(props = {}) {
  const now = toNow(props.now);
  const today = parseDate(props.today || now);
  const kind = props.kind || 'morning';
  const live = (props.items || []).filter((i) => !i.deleted);
  let items, title, stageKey, mention = '', est = null;
  if (kind === 'evening') {
    const tomorrow = addDays(today, 1);
    items = live.filter((i) => isActive(i) && !i.done && parseDate(i.due) <= tomorrow);
    title = `あしたまで ${items.length} つ。いまのうちに。`;
    est = (props.capture !== undefined || props.timetable) ? captureStatus({ items: live, capture: props.capture, today, timetable: props.timetable }) : null;
    if (est && !est.all) title = `まだ答えてない科目：${est.unanswered.join('・')}。出た？ ` + (items.length ? title : '');
    else if (est && est.allNone && props.askAgainOnNone) title = 'きょうは全部「なし」。ほんとに？ Classroom は見た？ ' + (items.length ? title : '');
    else if (props.captureMissing) title = 'きょう登録ゼロ。ほんとに宿題なし？ ' + (items.length ? title : '');
    stageKey = 'evening';
  } else if (kind === 'capture') {
    const cst = captureStatus({ items: live, capture: props.capture, today, timetable: props.timetable, subjects: props.subjects });
    const subs = cst.unanswered;
    const askNo = props.askNo || 1;
    title = captureWording(askNo, today, subs);
    const rows = [];
    const caps = [];
    subs.forEach((sub) => { caps.push({ type: 2, style: 2, label: `${sub}：出た`, custom_id: 'cap:' + sub }); caps.push({ type: 2, style: 2, label: `${sub}：なし`, custom_id: 'capno:' + sub }); });
    for (let r = 0; r < caps.length && rows.length < 3; r += 5) rows.push({ type: 1, components: caps.slice(r, r + 5) });
    const handin = live.filter((i) => isActive(i) && i.packed && parseDate(i.due) <= today).slice(0, 2);
    if (handin.length) rows.push({ type: 1, components: handin.map((i) => ({ type: 2, style: 3, label: `出した：${i.subject}`, custom_id: 'submit:' + i.id })) });
    const tail = [];
    if (subs.length > 1) tail.push({ type: 2, style: 2, label: 'のこりは ぜんぶ なし', custom_id: 'capnone' });
    if (props.appUrl) tail.push({ type: 2, style: 5, label: 'アプリで登録', url: props.appUrl });
    if (tail.length && rows.length < 5) rows.push({ type: 1, components: tail });
    let desc = '科目ごとに「出た」か「なし」。「出た」→ 範囲とどこにあるかを書く（範囲は空でもいい）。';
    if (Object.keys(cst.answered).length) desc += '\n答えた：' + cst.subjects.filter((x) => cst.answered[x]).map((x) => x + (cst.answered[x] === 'added' ? '（入れた）' : '（なし）')).join('、');
    if (handin.length) desc += '\n持っていったぶん：' + handin.map((i) => `${i.subject} ${i.range || ''}`).join('、') + ' → 出した？';
    return {
      content: ((askNo >= 3 && props.userId) ? `<@${props.userId}> ` : '') + title,
      embeds: [{ title, description: desc, color: askNo >= 3 ? 0xff8fc5 : 0xffe1ef, footer: { text: '宿題忘れゼロ ・ 放課後のチェック' }, timestamp: now.toISOString() }],
      components: rows,
      allowed_mentions: { users: props.userId ? [props.userId] : [] }
    };
  } else if (kind === 'overdue') {
    items = live.filter((i) => isActive(i) && parseDate(i.due) < today);
    const notDone = items.filter((i) => !i.done && !i.packed).length;
    title = notDone ? `出してないのが ${items.length} つ。あしたの朝いちで出そう。` : `持っていったぶん ${items.length} つ、出した？`;
    stageKey = 'overdue';
    mention = (props.userId && !props.quietMention) ? `<@${props.userId}> ` : '';
  } else {
    const n = nudgeStage({ items: live, today, now, leaveAt: props.leaveAt });
    items = n.items;
    stageKey = n.stage;
    if (n.stage === 'clear') title = 'ぜんぶ入れた。いってらっしゃい！';
    else if (n.stage === 'late') { title = `出る時間 ${n.leaveAt} を ${n.label}。かばんに入れた？`; mention = props.userId ? `<@${props.userId}> ` : ''; }
    else { title = `出るまで ${n.label}。${n.stage === 'urgent' ? 'いますぐ入れる。' : `きょう持っていくもの ${items.length} つ。`}`; mention = (n.stage === 'urgent' && props.userId) ? `<@${props.userId}> ` : ''; }
  }
  const lines = items.map((i) => itemLine(i, today));
  const missing = kind === 'evening' ? live.filter((i) => isActive(i) && !i.range).slice(0, 3) : [];
  if (missing.length) lines.push('範囲が空：' + missing.map((i) => i.subject).join('・') + ' → 下の「範囲を書く」');
  const compRows = [];
  const row1 = [];
  if (items.length) {
    if (kind === 'overdue') {
      items.slice(0, 2).forEach((i) => { row1.push({ type: 2, style: 3, label: `出した：${i.subject}`, custom_id: 'submit:' + i.id }); row1.push({ type: 2, style: 2, label: `先生に言った：${i.subject}`, custom_id: 'drop:' + i.id }); });
    } else if (items.length > 1 && items.length <= 4) {
      items.forEach((i) => { row1.push({ type: 2, style: 3, label: `入れた：${i.subject}`, custom_id: 'pack:' + i.id }); });
    } else {
      row1.push({ type: 2, style: 3, label: 'かばんに入れた', custom_id: 'pack:' + items.map((i) => i.id).join(',') });
    }
    if (kind !== 'overdue') row1.push({ type: 2, style: 2, label: 'やった', custom_id: 'done:' + items[0].id });
    compRows.push({ type: 1, components: row1.slice(0, 5) });
    const row2 = [];
    if (stageKey === 'calm' || stageKey === 'soon' || stageKey === 'evening') row2.push({ type: 2, style: 2, label: '10分あとで', custom_id: 'snooze:' + items[0].id });
    if (props.appUrl) row2.push({ type: 2, style: 5, label: 'アプリで見る', url: props.appUrl });
    if (row2.length) compRows.push({ type: 1, components: row2 });
  }
  if (kind === 'evening') {
    if (missing.length) compRows.push({ type: 1, components: missing.map((i) => ({ type: 2, style: 2, label: `範囲を書く：${i.subject}`, custom_id: 'fix:' + i.id })) });
    if (est && !est.all) {
      const capBtns = [];
      est.unanswered.slice(0, 2).forEach((sub) => { capBtns.push({ type: 2, style: 2, label: `${sub}：出た`, custom_id: 'cap:' + sub }); capBtns.push({ type: 2, style: 2, label: `${sub}：なし`, custom_id: 'capno:' + sub }); });
      compRows.push({ type: 1, components: capBtns.slice(0, 5) });
    } else if (est && est.allNone && props.askAgainOnNone) {
      compRows.push({ type: 1, components: [{ type: 2, style: 2, label: 'やっぱりあった', custom_id: 'capreopen' }].concat(props.classroomUrl ? [{ type: 2, style: 5, label: 'Classroom を見る', url: props.classroomUrl }] : []) });
    }
  }
  return {
    content: mention + title,
    embeds: [{
      title,
      description: lines.length ? lines.join('\n') : (kind === 'evening' ? 'あしたまでの宿題はない。' : 'きょう持っていく宿題はない。'),
      color: EMBED_COLORS[stageKey] || EMBED_COLORS.calm,
      footer: { text: FOOTER[stageKey] || FOOTER.calm },
      timestamp: now.toISOString()
    }],
    components: compRows.slice(0, 5),
    allowed_mentions: { users: props.userId ? [props.userId] : [] }
  };
}
