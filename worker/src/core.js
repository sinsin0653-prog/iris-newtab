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
  return /classroom|クラスルーム|タブレット|オンライン|google|ロイロ|teams|forms|提出フォーム|ネット|lms|moodle|manaba|webclass|メール/i.test(item.where || '');
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
  const dated = tt.__dates && tt.__dates[subject]; // 授業のある日の一覧（出欠表から）があれば、それが正しい
  if (dated && dated.length) {
    const t0 = toISO(t);
    const hit = dated.filter((x) => x > t0).sort()[0];
    if (hit) return { date: parseDate(hit), lesson: true };
    return { date: nextSchoolDay(t, schoolDays), lesson: false };
  }
  for (let k = 1; k <= 14; k++) {
    const d = addDays(t, k);
    const list = tt[String(d.getDay())];
    if (Array.isArray(list) && list.indexOf(subject) >= 0) return { date: d, lesson: true };
  }
  return { date: nextSchoolDay(t, schoolDays), lesson: false };
}

// ---- 履修科目（大学の時間割）から、曜日ごとの予定を作る ----
export const DEFAULT_PERIODS = { 1: ['09:00', '10:30'], 2: ['10:40', '12:10'], 3: ['13:00', '14:30'], 4: ['14:40', '16:10'], 5: ['16:20', '17:50'], 6: ['18:00', '19:30'] };
function hm(t) { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; }
export function hhmmOf(min) { min = ((Math.round(min) % 1440) + 1440) % 1440; const h = Math.floor(min / 60), m = min % 60; return `${h < 10 ? '0' : ''}${h}:${m < 10 ? '0' : ''}${m}`; }
function courseName(c) { return (c && (c.short || c.name)) || ''; }
function isSlotted(c) { return !!c && c.day !== null && c.day !== undefined && c.day !== '' && !!c.period; }
/** その日に授業があるか。dates（授業のある日の一覧）がある授業は、その日付だけ。ない授業は毎週。 */
function meetsOn(c, iso) { return !iso || !Array.isArray(c.dates) || c.dates.length === 0 || c.dates.indexOf(iso) >= 0; }
function coursesOf(s) { return s && Array.isArray(s.courses) ? s.courses.filter((c) => c && courseName(c)) : []; }
/** その曜日の予定。出る時間 = 最初の授業の開始 − 通学時間（既定 60 分）。放課後 = 最後の授業の終わり + 30 分。 */
export function dayPlan(dowOrDate, s = {}) {
  s = s || {};
  // 曜日の数字のほかに、日付（Date か 'YYYY-MM-DD'）も渡せる。日付を渡すと、日付つきの授業（dates）はその日付のときだけ授業になる
  const when = (dowOrDate instanceof Date || typeof dowOrDate === 'string') ? parseDate(dowOrDate) : null;
  const dow = when ? when.getDay() : dowOrDate;
  const iso = when ? toISO(when) : null;
  const courses = coursesOf(s);
  if (!courses.length) {
    const days = Array.isArray(s.schoolDays) && s.schoolDays.length ? s.schoolDays : [1, 2, 3, 4, 5];
    return { hasCourses: false, school: days.indexOf(dow) >= 0, lessons: [], leaveAt: s.leaveAt || '07:50', afterSchoolAt: (s.afterSchoolByDay || {})[dow] || s.afterSchoolAt || '15:45', leaveSchoolAt: s.leaveSchoolAt || '16:30' };
  }
  const periods = s.periods || DEFAULT_PERIODS;
  const lessons = courses.filter((c) => isSlotted(c) && +c.day === dow && meetsOn(c, iso) && periods[c.period] && hm(periods[c.period][0]) !== null).map((c) => (
    { subject: courseName(c), name: c.name || courseName(c), period: +c.period, room: c.room || '', teacher: c.teacher || '', start: periods[c.period][0], end: periods[c.period][1] }
  )).sort((a, b) => a.period - b.period);
  if (!lessons.length) return { hasCourses: true, school: false, lessons: [], leaveAt: null, afterSchoolAt: null, leaveSchoolAt: null };
  const first = lessons[0], last = lessons[lessons.length - 1];
  const commute = (s.commuteMinutes === 0 || +s.commuteMinutes > 0) ? +s.commuteMinutes : 60;
  const leave = (s.leaveByDay || {})[dow] || hhmmOf(hm(first.start) - commute);
  const after = (s.afterSchoolByDay || {})[dow] || hhmmOf(hm(last.end) + 30);
  return { hasCourses: true, school: true, lessons, leaveAt: leave, afterSchoolAt: after, leaveSchoolAt: hhmmOf(hm(last.end) + 10) };
}
export function effectiveTimetable(s = {}) {
  s = s || {};
  const courses = coursesOf(s);
  if (!courses.length) return s.timetable || {};
  const tt = {};
  courses.forEach((c) => {
    if (!isSlotted(c)) return;
    const k = String(+c.day), n = courseName(c);
    tt[k] = tt[k] || [];
    if (tt[k].indexOf(n) < 0) tt[k].push(n);
    if (Array.isArray(c.dates) && c.dates.length) { tt.__dates = tt.__dates || {}; tt.__dates[n] = (tt.__dates[n] || []).concat(c.dates); }
  });
  return tt;
}
export function effectiveSchoolDays(s = {}) {
  s = s || {};
  const courses = coursesOf(s);
  if (!courses.length) return Array.isArray(s.schoolDays) && s.schoolDays.length ? s.schoolDays.slice() : [1, 2, 3, 4, 5];
  const out = [];
  courses.forEach((c) => { if (isSlotted(c) && out.indexOf(+c.day) < 0) out.push(+c.day); });
  return out.sort((a, b) => a - b);
}
/** 科目が決まっているか（履修科目か、曜日ごとの時間割）。決まっていなければ「課題出た？」は聞かない（でたらめな科目で聞かない）。 */
export function hasSubjects(s) {
  if (coursesOf(s).length) return true;
  const tt = (s && s.timetable) || {};
  return Object.keys(tt).some((k) => Array.isArray(tt[k]) && tt[k].length > 0);
}
export function allSubjects(s) {
  const courses = coursesOf(s);
  if (!courses.length) return SUBJECTS.slice();
  const out = [];
  courses.forEach((c) => { const n = courseName(c); if (out.indexOf(n) < 0) out.push(n); });
  return out;
}
/** その日に聞く科目：その日の授業（時限順）。週の最後の授業日には、曜日のない授業も。 */
export function daySubjects(today, s = {}) {
  s = s || {};
  const d = parseDate(today || new Date());
  const courses = coursesOf(s);
  if (!courses.length) return captureSubjects({ today: d, timetable: s.timetable });
  const plan = dayPlan(d, s);
  const out = [];
  plan.lessons.forEach((l) => { if (out.indexOf(l.subject) < 0) out.push(l.subject); });
  const days = effectiveSchoolDays(s);
  if (plan.school && d.getDay() === days[days.length - 1]) courses.forEach((c) => { if (!isSlotted(c)) { const n = courseName(c); if (out.indexOf(n) < 0) out.push(n); } });
  return out;
}
/** いま聞いていい科目：授業が終わって 5 分たったもの。放課後を過ぎたらその日の全部。 */
export function askableSubjects(today, minutes, s = {}) {
  s = s || {};
  const d = parseDate(today || new Date());
  if (!coursesOf(s).length) return daySubjects(d, s);
  const plan = dayPlan(d, s);
  if (!plan.school) return [];
  if (minutes >= hm(plan.afterSchoolAt)) return daySubjects(d, s);
  const out = [];
  plan.lessons.forEach((l) => { if (hm(l.end) + 5 <= minutes && out.indexOf(l.subject) < 0) out.push(l.subject); });
  return out;
}
export function lessonOn(subject, date, s) {
  const d = parseDate(date);
  const plan = dayPlan(d, s);
  return plan.lessons.find((l) => l.subject === subject) || null;
}
export function submitPlace(subject, due, s) {
  const l = lessonOn(subject, due, s);
  return l ? `${formatDate(due)} ${l.period}限${l.room ? ' ' + l.room : ''}` : '';
}
export function nextClass(now, s) {
  const n = toNow(now);
  const plan = dayPlan(n, s);
  const m = n.getHours() * 60 + n.getMinutes();
  for (const l of plan.lessons) if (hm(l.end) > m) return { lesson: l, during: hm(l.start) <= m };
  return null;
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
  if (Array.isArray(opts.subjects)) return opts.subjects.slice(0, 7);
  const today = parseDate(opts.today || new Date());
  const list = (opts.timetable || {})[String(today.getDay())];
  if (Array.isArray(list) && list.length) return list.slice(0, 7);
  return SUBJECTS.slice();
}
/** 聞き方は回を追うごとに変える（同じ文は慣れる）。 */
export function captureWording(askNo, today, subs) {
  const d = parseDate(today || new Date());
  if (askNo === 0) return (subs.length ? subs.join('・') + '、おわった。' : '') + '課題出た？';
  if (askNo <= 1) return 'きょう、宿題出た？';
  if (askNo === 2) return `${WEEKDAYS[d.getDay()]}曜。${subs.join('・')}。どれか出た？`;
  if (askNo === 3) return 'まだ答えてない。授業のページやメモを開いて確かめて。';
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
    est = (props.capture !== undefined || props.timetable || props.subjects) ? captureStatus({ items: live, capture: props.capture, today, timetable: props.timetable, subjects: props.subjects }) : null;
    if (est && !est.all) title = `まだ答えてない科目：${est.unanswered.join('・')}。出た？ ` + (items.length ? title : '');
    else if (est && est.allNone && props.askAgainOnNone) title = 'きょうは全部「なし」。ほんとに？ 授業のページは見た？ ' + (items.length ? title : '');
    else if (props.captureMissing) title = 'きょう登録ゼロ。ほんとに宿題なし？ ' + (items.length ? title : '');
    stageKey = 'evening';
  } else if (kind === 'capture') {
    const cst = captureStatus({ items: live, capture: props.capture, today, timetable: props.timetable, subjects: props.subjects });
    const subs = cst.unanswered;
    const askNo = props.askNo === 0 ? 0 : (props.askNo || 1);
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
    compRows.push({ type: 1, components: row1.slice(0, 5) });
    // 宿題ごとの「やった」。1 つずつ押せる（かばんに入れる前に、できたことを知らせる）
    const undone = kind === 'overdue' ? [] : items.filter((i) => !i.done).slice(0, 5);
    if (undone.length) compRows.push({ type: 1, components: undone.map((i) => ({ type: 2, style: 2, label: `やった：${i.subject}`, custom_id: 'done:' + i.id })) });
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
