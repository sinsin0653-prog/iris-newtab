// 宿題忘れゼロ — Cloudflare Worker（1 ファイル版）
// このファイルは worker/scripts/build-single.mjs が src/ から作る。直すときは src/ を直して作り直す。
//
// 使い方（ブラウザだけ）：Cloudflare → Workers & Pages → 自分の Worker →「コードを編集」→
// 中身を全部消して、このファイルの中身を全部貼る →「デプロイ」。
// 要るもの：KV のバインディング SHUKUDAI、シークレット DISCORD_TOKEN / DISCORD_PUBLIC_KEY / DISCORD_APP_ID / SYNC_TOKEN、
// Cron トリガー */5 * * * *（なければ GitHub Actions が /api/tick を 5 分おきに叩く）。
// 準備ができたか、つながったかは https://<Worker の URL>/setup で見る。アプリは https://<Worker の URL>/app/

// ===== core.js =====
// 宿題忘れゼロ — 共有ロジック（ES module）。ブラウザ側の shukudai/ds/bundle.js と同じ判定をする。
// 変えるときは両方を変え、worker/test/parity.test.js で一致を確かめる。

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const DAY_MS = 86400000;

function parseDate(v) {
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
function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function toISO(d) {
  const mm = String(d.getMonth() + 1), dd = String(d.getDate());
  return `${d.getFullYear()}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}
function formatDate(v) {
  const d = parseDate(v);
  return `${d.getMonth() + 1}/${d.getDate()}（${WEEKDAYS[d.getDay()]}）`;
}
function formatDateSpoken(v) {
  const d = parseDate(v);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}曜日`;
}
function dayKey(v) { return toISO(parseDate(v || new Date())); }

/** その日に「かばんに入れた」か。packedOn（その日の日付キー）で見る。古い記録（packedOn なし）は当日扱い。 */
function isPackedToday(item, today) {
  if (!item || !item.packed) return false;
  if (!item.packedOn) return true;
  return item.packedOn === dayKey(today);
}
/** 出した／先生に言った／消した、はもう追わない。 */
function isActive(item) { return !!item && !item.deleted && !item.submitted && !item.dropped; }
/** 紙を持っていく宿題ではなく、ネットで出すもの。朝のかばん確認から外す。 */
function isOnline(item) {
  if (!item) return false;
  if (item.location === 'online') return true;
  return /classroom|クラスルーム|タブレット|オンライン|google|ロイロ|teams|forms|提出フォーム|ネット|lms|moodle|manaba|webclass|メール/i.test(item.where || '');
}

/** 期限の状態。色・言葉・アイコンの 3 点セットの元。flags: { packed, submitted, dropped } */
function dueInfo(due, today, done, flags = {}) {
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
function nextSchoolDay(today, schoolDays) {
  const t = parseDate(today || new Date());
  const days = Array.isArray(schoolDays) && schoolDays.length ? schoolDays : [1, 2, 3, 4, 5];
  for (let k = 1; k <= 14; k++) { const d = addDays(t, k); if (days.indexOf(d.getDay()) >= 0) return d; }
  return addDays(t, 1);
}
function nextLesson(subject, today, timetable, schoolDays) {
  const t = parseDate(today || new Date());
  const tt = timetable || {};
  for (let k = 1; k <= 14; k++) {
    const d = addDays(t, k);
    const list = tt[String(d.getDay())];
    if (Array.isArray(list) && list.indexOf(subject) >= 0) return { date: d, lesson: true };
  }
  return { date: nextSchoolDay(t, schoolDays), lesson: false };
}

// ---- 履修科目（大学の時間割）から、曜日ごとの予定を作る ----
const DEFAULT_PERIODS = { 1: ['09:00', '10:30'], 2: ['10:40', '12:10'], 3: ['13:00', '14:30'], 4: ['14:40', '16:10'], 5: ['16:20', '17:50'], 6: ['18:00', '19:30'] };
function hm(t) { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; }
function hhmmOf(min) { min = ((Math.round(min) % 1440) + 1440) % 1440; const h = Math.floor(min / 60), m = min % 60; return `${h < 10 ? '0' : ''}${h}:${m < 10 ? '0' : ''}${m}`; }
function courseName(c) { return (c && (c.short || c.name)) || ''; }
function isSlotted(c) { return !!c && c.day !== null && c.day !== undefined && c.day !== '' && !!c.period; }
function coursesOf(s) { return s && Array.isArray(s.courses) ? s.courses.filter((c) => c && courseName(c)) : []; }
/** その曜日の予定。出る時間 = 最初の授業の開始 − 通学時間（既定 60 分）。放課後 = 最後の授業の終わり + 30 分。 */
function dayPlan(dow, s = {}) {
  s = s || {};
  const courses = coursesOf(s);
  if (!courses.length) {
    const days = Array.isArray(s.schoolDays) && s.schoolDays.length ? s.schoolDays : [1, 2, 3, 4, 5];
    return { hasCourses: false, school: days.indexOf(dow) >= 0, lessons: [], leaveAt: s.leaveAt || '07:50', afterSchoolAt: (s.afterSchoolByDay || {})[dow] || s.afterSchoolAt || '15:45', leaveSchoolAt: s.leaveSchoolAt || '16:30' };
  }
  const periods = s.periods || DEFAULT_PERIODS;
  const lessons = courses.filter((c) => isSlotted(c) && +c.day === dow && periods[c.period] && hm(periods[c.period][0]) !== null).map((c) => (
    { subject: courseName(c), name: c.name || courseName(c), period: +c.period, room: c.room || '', teacher: c.teacher || '', start: periods[c.period][0], end: periods[c.period][1] }
  )).sort((a, b) => a.period - b.period);
  if (!lessons.length) return { hasCourses: true, school: false, lessons: [], leaveAt: null, afterSchoolAt: null, leaveSchoolAt: null };
  const first = lessons[0], last = lessons[lessons.length - 1];
  const commute = (s.commuteMinutes === 0 || +s.commuteMinutes > 0) ? +s.commuteMinutes : 60;
  const leave = (s.leaveByDay || {})[dow] || hhmmOf(hm(first.start) - commute);
  const after = (s.afterSchoolByDay || {})[dow] || hhmmOf(hm(last.end) + 30);
  return { hasCourses: true, school: true, lessons, leaveAt: leave, afterSchoolAt: after, leaveSchoolAt: hhmmOf(hm(last.end) + 10) };
}
function effectiveTimetable(s = {}) {
  s = s || {};
  const courses = coursesOf(s);
  if (!courses.length) return s.timetable || {};
  const tt = {};
  courses.forEach((c) => {
    if (!isSlotted(c)) return;
    const k = String(+c.day), n = courseName(c);
    tt[k] = tt[k] || [];
    if (tt[k].indexOf(n) < 0) tt[k].push(n);
  });
  return tt;
}
function effectiveSchoolDays(s = {}) {
  s = s || {};
  const courses = coursesOf(s);
  if (!courses.length) return Array.isArray(s.schoolDays) && s.schoolDays.length ? s.schoolDays.slice() : [1, 2, 3, 4, 5];
  const out = [];
  courses.forEach((c) => { if (isSlotted(c) && out.indexOf(+c.day) < 0) out.push(+c.day); });
  return out.sort((a, b) => a - b);
}
/** 科目が決まっているか（履修科目か、曜日ごとの時間割）。決まっていなければ「課題出た？」は聞かない（でたらめな科目で聞かない）。 */
function hasSubjects(s) {
  if (coursesOf(s).length) return true;
  const tt = (s && s.timetable) || {};
  return Object.keys(tt).some((k) => Array.isArray(tt[k]) && tt[k].length > 0);
}
function allSubjects(s) {
  const courses = coursesOf(s);
  if (!courses.length) return SUBJECTS.slice();
  const out = [];
  courses.forEach((c) => { const n = courseName(c); if (out.indexOf(n) < 0) out.push(n); });
  return out;
}
/** その日に聞く科目：その日の授業（時限順）。週の最後の授業日には、曜日のない授業も。 */
function daySubjects(today, s = {}) {
  s = s || {};
  const d = parseDate(today || new Date());
  const courses = coursesOf(s);
  if (!courses.length) return captureSubjects({ today: d, timetable: s.timetable });
  const plan = dayPlan(d.getDay(), s);
  const out = [];
  plan.lessons.forEach((l) => { if (out.indexOf(l.subject) < 0) out.push(l.subject); });
  const days = effectiveSchoolDays(s);
  if (plan.school && d.getDay() === days[days.length - 1]) courses.forEach((c) => { if (!isSlotted(c)) { const n = courseName(c); if (out.indexOf(n) < 0) out.push(n); } });
  return out;
}
/** いま聞いていい科目：授業が終わって 5 分たったもの。放課後を過ぎたらその日の全部。 */
function askableSubjects(today, minutes, s = {}) {
  s = s || {};
  const d = parseDate(today || new Date());
  if (!coursesOf(s).length) return daySubjects(d, s);
  const plan = dayPlan(d.getDay(), s);
  if (!plan.school) return [];
  if (minutes >= hm(plan.afterSchoolAt)) return daySubjects(d, s);
  const out = [];
  plan.lessons.forEach((l) => { if (hm(l.end) + 5 <= minutes && out.indexOf(l.subject) < 0) out.push(l.subject); });
  return out;
}
function lessonOn(subject, date, s) {
  const d = parseDate(date);
  const plan = dayPlan(d.getDay(), s);
  return plan.lessons.find((l) => l.subject === subject) || null;
}
function submitPlace(subject, due, s) {
  const l = lessonOn(subject, due, s);
  return l ? `${formatDate(due)} ${l.period}限${l.room ? ' ' + l.room : ''}` : '';
}
function nextClass(now, s) {
  const n = toNow(now);
  const plan = dayPlan(n.getDay(), s);
  const m = n.getHours() * 60 + n.getMinutes();
  for (const l of plan.lessons) if (hm(l.end) > m) return { lesson: l, during: hm(l.start) <= m };
  return null;
}

// ---- 焦らせる：出発時刻までの残り時間と段階 ----
function parseTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  return m ? { h: +m[1], m: +m[2] } : { h: 7, m: 50 };
}
function hhmmToMinutes(hhmm) { const t = parseTime(hhmm); return t.h * 60 + t.m; }
function toNow(v) { return v instanceof Date ? v : (v ? new Date(v) : new Date()); }
function minutesUntilLeave(leaveAt, now) {
  now = toNow(now);
  const t = parseTime(leaveAt);
  const leave = new Date(now.getFullYear(), now.getMonth(), now.getDate(), t.h, t.m);
  return Math.round((leave - now) / 60000);
}
function spanLabel(mins) {
  const a = Math.abs(mins), h = Math.floor(a / 60), m = a % 60;
  const body = a >= 60 ? `${h}時間${m ? m + '分' : ''}` : `${a}分`;
  return mins >= 0 ? `あと${body}` : `${body}すぎた`;
}
/** stage: clear / calm（60 分より前）/ soon（60〜16 分前）/ urgent（15 分以内）/ late（出発時刻を過ぎた） */
function nudgeStage(opts = {}) {
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
const SUBJECTS = ['国語', '数学', '英語', '理科', '社会', 'その他'];
function createdOn(item) {
  if (!item) return null;
  if (item.createdOn) return item.createdOn;
  return item.createdAt ? toISO(new Date(item.createdAt)) : null;
}
function captureSubjects(opts = {}) {
  if (Array.isArray(opts.subjects)) return opts.subjects.slice(0, 7);
  const today = parseDate(opts.today || new Date());
  const list = (opts.timetable || {})[String(today.getDay())];
  if (Array.isArray(list) && list.length) return list.slice(0, 7);
  return SUBJECTS.slice();
}
/** 聞き方は回を追うごとに変える（同じ文は慣れる）。 */
function captureWording(askNo, today, subs) {
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
function captureStatus(opts = {}) {
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
function captureAnswered(opts = {}) {
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
function discordPayload(props = {}) {
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

// ===== state.js =====
// 保存する形と、端末と Discord の両方から来る変更の合わせ方。
const DEFAULT_SETTINGS = Object.freeze({
  leaveAt: '07:50',
  wakeAt: '06:30',
  quietFrom: '22:00',
  quietTo: '06:30',
  eveningAt: '20:00',
  evening2At: '21:30',
  overdueAt: ['16:00', '19:00', '21:00'],
  tz: 'Asia/Tokyo',
  escalation: 'full',
  snoozeMax: 3,
  appUrl: '',
  afterSchoolAt: '15:45',
  afterSchoolByDay: {},
  captureRepeatMinutes: 30,
  captureMax: 3,
  captureHourlyUntilQuiet: true,
  leaveSchoolAt: '16:30',
  schoolDays: [1, 2, 3, 4, 5],
  timetable: {},
  classroomUrl: '',
  paperSpot: '',
  watch: { good: true, evening: false, late: false },
  courses: [],
  periods: null,
  commuteMinutes: 60,
  leaveByDay: {},
  discord: { userId: null, watchChannelId: null }
});

function emptyState() {
  return { v: 1, items: [], settings: { ...DEFAULT_SETTINGS, discord: { ...DEFAULT_SETTINGS.discord } }, nudge: { sent: {}, snoozeUntil: null, snoozeCount: {} }, capture: {}, updatedAt: null };
}

function withDefaults(state) {
  const s = state && typeof state === 'object' ? state : {};
  const settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
  settings.discord = { ...DEFAULT_SETTINGS.discord, ...((s.settings && s.settings.discord) || {}) };
  settings.watch = { ...DEFAULT_SETTINGS.watch, ...((s.settings && s.settings.watch) || {}) };
  if (!settings.afterSchoolByDay || typeof settings.afterSchoolByDay !== 'object') settings.afterSchoolByDay = {};
  if (!settings.timetable || typeof settings.timetable !== 'object') settings.timetable = {};
  if (!Array.isArray(settings.courses)) settings.courses = [];
  if (!settings.leaveByDay || typeof settings.leaveByDay !== 'object') settings.leaveByDay = {};
  if (!Array.isArray(settings.overdueAt)) settings.overdueAt = [...DEFAULT_SETTINGS.overdueAt];
  return {
    v: 1,
    items: Array.isArray(s.items) ? s.items.filter((i) => i && typeof i.id === 'string') : [],
    settings,
    nudge: { sent: {}, snoozeUntil: null, snoozeCount: {}, resendAfterSnooze: null, lastInteractionAt: null, sentDays: [], ...(s.nudge || {}) },
    capture: s.capture && typeof s.capture === 'object' ? { ...s.capture } : {},
    updatedAt: s.updatedAt || null
  };
}

/** 宿題 1 件ずつ、updatedAt の新しい方が勝つ。消したものは deleted:true の墓標で残す（同期で蘇らないように）。 */
function mergeItems(a = [], b = []) {
  const byId = new Map();
  for (const list of [a, b]) {
    for (const it of list) {
      if (!it || typeof it.id !== 'string') continue;
      const prev = byId.get(it.id);
      if (!prev || String(it.updatedAt || '') >= String(prev.updatedAt || '')) byId.set(it.id, it);
    }
  }
  return [...byId.values()].sort((x, y) => String(x.createdAt || '').localeCompare(String(y.createdAt || '')));
}

/** 端末から来た state を保存済みの state に合わせる。設定は新しい方、nudge はサーバーのものを守る。 */
function mergeState(server, incoming) {
  const s = withDefaults(server), c = withDefaults(incoming);
  const settingsNewer = String(c.settings.updatedAt || '') >= String(s.settings.updatedAt || '');
  return {
    v: 1,
    items: mergeItems(s.items, c.items),
    settings: settingsNewer ? { ...c.settings, discord: { ...c.settings.discord, userId: c.settings.discord.userId || s.settings.discord.userId || null, watchChannelId: c.settings.discord.watchChannelId || s.settings.discord.watchChannelId || null }, watch: { ...c.settings.watch } } : s.settings,
    nudge: mergeNudge(s.nudge, c.nudge),
    capture: mergeCapture(s.capture, c.capture),
    updatedAt: new Date().toISOString()
  };
}

/** 「答えた」は負けない：科目ごとに、どちらかが none / added なら残す。added は none より強い。古い形（文字列）は '*'（全部）に直す。 */
function normCapture(v) {
  if (v === 'none' || v === 'added') return { '*': v };
  return v && typeof v === 'object' ? { ...v } : {};
}
function mergeCapture(a = {}, b = {}) {
  const out = {};
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    const x = normCapture((a || {})[k]), y = normCapture((b || {})[k]);
    const merged = { ...x };
    for (const [sub, v] of Object.entries(y)) if (v === 'added' || (v === 'none' && merged[sub] !== 'added')) merged[sub] = v;
    if (Object.keys(merged).length) out[k] = merged;
  }
  return out;
}

/** 端末から来たスヌーズを合わせる。サーバーの送信記録は守る。 */
function mergeNudge(server = {}, client = {}) {
  const out = { ...server };
  if (client && client.snoozeUntil && (!server.snoozeUntil || String(client.snoozeUntil) > String(server.snoozeUntil))) out.snoozeUntil = client.snoozeUntil;
  if (client && client.snoozeCount && typeof client.snoozeCount === 'object') {
    out.snoozeCount = { ...(server.snoozeCount || {}) };
    for (const [d, n] of Object.entries(client.snoozeCount)) out.snoozeCount[d] = Math.max(out.snoozeCount[d] || 0, +n || 0);
  }
  return out;
}

// ===== setup-page.js =====
// /setup で出すページ。ブラウザだけで「つながっているか」を確かめ、コマンド登録とテスト DM を押すだけでできるようにする。
const SETUP_HTML = String.raw`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>宿題忘れゼロ サーバーの準備</title>
<style>
  :root { --ink: #111111; --ground: #ffffff; --soft: #f2f2f2; --pink: #ff8fc5; --pink-ink: #c81e6a; --muted: #5f5f5f; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --ink: #f5f5f5; --ground: #0f0f0f; --soft: #2a2a2a; --pink-ink: #ff8fc5; --muted: #b0b0b0; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--ground); color: var(--ink); font-family: "Hiragino Kaku Gothic ProN", "BIZ UDPGothic", system-ui, sans-serif; font-size: 16px; line-height: 1.6; }
  main { max-width: 560px; margin: 0 auto; padding: 24px 16px 64px; display: flex; flex-direction: column; gap: 20px; }
  h1 { margin: 0; font-size: 24px; line-height: 1.3; }
  h2 { margin: 0 0 8px; font-size: 18px; }
  section { border: 2px solid var(--ink); border-radius: 24px; padding: 16px 20px; }
  ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
  li { display: flex; gap: 8px; align-items: baseline; }
  .tag { flex: none; min-width: 3.5em; text-align: center; font-family: ui-monospace, monospace; font-size: 13px; font-weight: 700; border-radius: 999px; padding: 0 8px; }
  .ok { background: var(--soft); }
  .ng { background: var(--pink); color: #111111; }
  .mono { font-family: ui-monospace, monospace; font-size: 14px; overflow-wrap: anywhere; background: var(--soft); border-radius: 12px; padding: 8px 12px; }
  .note { margin: 4px 0 0; color: var(--muted); font-size: 14px; }
  label { display: block; font-weight: 700; margin-top: 12px; }
  input { width: 100%; min-height: 48px; margin-top: 4px; padding: 8px 14px; font-size: 16px; border: 2px solid var(--muted); border-radius: 12px; background: var(--soft); color: var(--ink); }
  button { min-height: 48px; padding: 0 20px; border: 2px solid var(--ink); border-radius: 999px; background: var(--ground); color: var(--ink); font-size: 16px; font-weight: 700; cursor: pointer; }
  button.primary { width: 100%; min-height: 60px; margin-top: 16px; background: var(--pink); color: #111111; }
  button:focus-visible, input:focus-visible { outline: 3px solid var(--pink-ink); outline-offset: 3px; }
  #result { margin-top: 12px; }
  #result li { align-items: flex-start; }
</style>
</head>
<body>
<main>
  <h1>宿題忘れゼロ<br>サーバーの準備</h1>

  <section aria-labelledby="h-checks">
    <h2 id="h-checks">1. 入れたものの確認</h2>
    <ul id="checks"><li>確認中…</li></ul>
    <p class="note">「まだ」があれば、Cloudflare の Worker の「Settings」→「Variables and Secrets」で入れる（KV は「Bindings」）。入れたらこのページを読み直す。</p>
  </section>

  <section aria-labelledby="h-url">
    <h2 id="h-url">2. Discord に貼る URL</h2>
    <p class="mono" id="iurl">…</p>
    <button type="button" id="copy">コピー</button>
    <p class="note">Discord Developer Portal → 自分のアプリ → General Information → 「Interactions Endpoint URL」に貼って「Save Changes」。</p>
  </section>

  <section aria-labelledby="h-go">
    <h2 id="h-go">3. コマンド登録とテスト DM</h2>
    <label for="token">合言葉（SYNC_TOKEN に入れたもの）</label>
    <input id="token" type="password" autocomplete="off">
    <label for="uid">自分の Discord ユーザー ID</label>
    <input id="uid" inputmode="numeric" autocomplete="off" placeholder="18 桁くらいの数字">
    <p class="note">Discord の設定 → 詳細設定 → 開発者モードを ON。自分のアイコンを右クリック（スマホは長押し）→「ユーザー ID をコピー」。</p>
    <button type="button" class="primary" id="go">コマンドを登録して、テスト DM を送る</button>
    <ul id="result" aria-live="polite"></ul>
  </section>

  <section aria-labelledby="h-cron">
    <h2 id="h-cron">4. 5 分おきの見回り</h2>
    <p id="cron">…</p>
    <p class="note">GitHub の見回り係が 5 分おきに起こしに来るので、何もしなくていい。Cloudflare の Worker の「Settings」→「Triggers」→「Cron Triggers」に */5 * * * * を入れると、もっと正確になる（入れなくても動く）。5 分たってこのページを読み直すと、時刻が出る。</p>
  </section>
</main>
<script>
(function () {
  function $(id) { return document.getElementById(id); }
  function row(ok, text) {
    var li = document.createElement('li');
    var t = document.createElement('span'); t.className = 'tag ' + (ok ? 'ok' : 'ng'); t.textContent = ok ? 'OK' : 'まだ';
    var s = document.createElement('span'); s.textContent = text;
    li.appendChild(t); li.appendChild(s); return li;
  }
  var labels = [['DISCORD_TOKEN', 'Bot のトークン（DISCORD_TOKEN）'], ['DISCORD_PUBLIC_KEY', 'Public Key（DISCORD_PUBLIC_KEY）'], ['DISCORD_APP_ID', 'Application ID（DISCORD_APP_ID）'], ['SYNC_TOKEN', '合言葉（SYNC_TOKEN）'], ['KV', '保存場所（KV の名前 SHUKUDAI）']];
  fetch('/api/health').then(function (r) { return r.json(); }).then(function (h) {
    var ul = $('checks'); ul.textContent = '';
    labels.forEach(function (l) { ul.appendChild(row(!!h.checks[l[0]], l[1])); });
    ul.appendChild(row(!!h.userIdSaved, '自分の Discord ユーザー ID（下の 3 で入る）'));
    $('iurl').textContent = h.interactionsUrl;
    $('cron').textContent = h.lastRunAt ? '最後に見回った：' + new Date(h.lastRunAt).toLocaleString('ja-JP') + (h.lastRunVia === 'tick' ? '（GitHub の見回り係）' : h.lastRunVia === 'cron' ? '（Cloudflare の Cron）' : '') : 'まだ一度も見回っていない。';
  }).catch(function () { $('checks').textContent = '確認できなかった。Worker のコードが貼れているか見て。'; });
  $('copy').addEventListener('click', function () {
    var text = $('iurl').textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { $('copy').textContent = 'コピーした'; });
  });
  $('go').addEventListener('click', function () {
    var res = $('result'); res.textContent = '';
    res.appendChild(row(true, '送っている…'));
    fetch('/api/setup', { method: 'POST', headers: { 'Authorization': 'Bearer ' + $('token').value.trim(), 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: $('uid').value.trim() }) })
      .then(function (r) { return r.json(); })
      .then(function (o) {
        res.textContent = '';
        if (o.error) { res.appendChild(row(false, o.error)); return; }
        if (o.saved) res.appendChild(row(true, 'ユーザー ID を覚えた'));
        if (o.registered) res.appendChild(row(true, 'コマンドを登録した：' + o.registered.join(' ')));
        if (o.dm) res.appendChild(row(true, 'テスト DM を送った。Discord を見て！'));
        (o.errors || []).forEach(function (e) { res.appendChild(row(false, e)); });
      })
      .catch(function () { res.textContent = ''; res.appendChild(row(false, '送れなかった。ネットか URL を見て。')); });
  });
})();
</script>
</body>
</html>`;

// ===== app-assets.js =====
// このファイルは scripts/build-assets.mjs が ../shukudai/ から作る。手で直さない。
const APP_ASSETS = {"/app/index.html":{"type":"text/html; charset=utf-8","etag":"\"0b11d0c62039ba28\"","body":"<!doctype html>\n<html lang=\"ja\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"shukudai-server\" content=\"same-origin\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https:; manifest-src 'self'; base-uri 'none'; form-action 'none'\">\n<meta name=\"referrer\" content=\"no-referrer\">\n<meta name=\"color-scheme\" content=\"light dark\">\n<meta name=\"theme-color\" content=\"#ffffff\" media=\"(prefers-color-scheme: light)\">\n<meta name=\"theme-color\" content=\"#0f0f0f\" media=\"(prefers-color-scheme: dark)\">\n<meta name=\"apple-mobile-web-app-capable\" content=\"yes\">\n<meta name=\"apple-mobile-web-app-title\" content=\"宿題\">\n<title>宿題忘れゼロ</title>\n<link rel=\"manifest\" href=\"manifest.webmanifest\">\n<link rel=\"icon\" href=\"icons/icon.svg\" type=\"image/svg+xml\">\n<link rel=\"apple-touch-icon\" href=\"icons/icon-192.png\">\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n<link rel=\"stylesheet\" href=\"ds/tokens.css\">\n<link rel=\"stylesheet\" href=\"ds/bundle.css\">\n<link rel=\"stylesheet\" href=\"app.css\">\n<script src=\"ds/bundle.js\" defer></script>\n<script type=\"module\" src=\"app.js\"></script>\n</head>\n<body>\n<div id=\"app\" class=\"app\"></div>\n<noscript><p class=\"app\">このアプリは JavaScript が要る。</p></noscript>\n</body>\n</html>\n"},"/app/app.js":{"type":"text/javascript; charset=utf-8","etag":"\"39a0a1033c1d4328\"","body":"// 宿題忘れゼロ — アプリ本体。部品とロジックは window.Shukudai（ds/bundle.js）。\nimport { pullState, pushState, testDm, mergeItems, mergeCapture } from './sync.js';\n\nconst KEY = 'shukudai.state.v1';\nconst FONT_CSS = 'https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Dela+Gothic+One&family=Zen+Kaku+Gothic+New:wght@500;700;900&display=swap';\nconst DEFAULT_SETTINGS = {\n  leaveAt: '07:50', wakeAt: '06:30', quietFrom: '22:00', quietTo: '06:30', tz: 'Asia/Tokyo',\n  escalation: 'full', snoozeMax: 3, appUrl: '', theme: 'auto',\n  afterSchoolAt: '15:45', afterSchoolByDay: {}, leaveSchoolAt: '16:30', schoolDays: [1, 2, 3, 4, 5], timetable: {}, classroomUrl: '', paperSpot: '',\n  watch: { good: true, evening: false, late: false },\n  courses: [], periods: null, commuteMinutes: 60, leaveByDay: {},\n  discord: { userId: '', watchChannelId: '' },\n  sync: { url: '', token: '' },\n  updatedAt: null\n};\n\nlet S; // window.Shukudai\nlet state = load();\nlet ui = { sheet: null, toast: null, undo: null, syncStatus: '', deleteArmed: false, lastPull: null, doneToday: 0, board: false };\nconst root = document.getElementById('app');\n\n// ---------- 保存 ----------\nfunction load() {\n  let raw = null;\n  try { raw = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { raw = null; }\n  const st = raw && typeof raw === 'object' ? raw : {};\n  return {\n    v: 1,\n    items: Array.isArray(st.items) ? st.items : [],\n    settings: { ...DEFAULT_SETTINGS, ...(st.settings || {}), discord: { ...DEFAULT_SETTINGS.discord, ...((st.settings || {}).discord || {}) }, sync: { ...DEFAULT_SETTINGS.sync, ...((st.settings || {}).sync || {}) }, watch: { ...DEFAULT_SETTINGS.watch, ...((st.settings || {}).watch || {}) } },\n    draft: st.draft || null,\n    nudge: { snoozeUntil: null, snoozeCount: {}, ...(st.nudge || {}) },\n    capture: st.capture && typeof st.capture === 'object' ? st.capture : {}\n  };\n}\n// Worker の /app/ から開いたときは、サーバーはこのページと同じ場所。URL は自分で埋める（合言葉だけ入れればいい）\nif (!state.settings.sync.url && document.querySelector('meta[name=\"shukudai-server\"][content=\"same-origin\"]')) state.settings.sync.url = location.origin;\nlet pushTimer = null;\nfunction save({ push = true } = {}) {\n  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { setStatus('端末に保存できなかった。もう一回押して'); }\n  if (push && state.settings.sync.url && state.settings.sync.token) {\n    clearTimeout(pushTimer);\n    pushTimer = setTimeout(doPush, 900);\n  }\n}\nasync function doPush() {\n  try {\n    const merged = await pushState(state.settings.sync, state);\n    if (merged && Array.isArray(merged.items)) { state.items = mergeItems(state.items, merged.items); state.capture = mergeCapture(state.capture, merged.capture); localStorage.setItem(KEY, JSON.stringify(state)); }\n    setStatus('同期した ' + clock());\n    render();\n  } catch (e) { setStatus('同期できなかった（' + (e.message || e) + '）。端末には保存してある'); }\n}\nasync function doPull() {\n  if (!state.settings.sync.url || !state.settings.sync.token) return;\n  try {\n    const remote = await pullState(state.settings.sync);\n    if (remote && Array.isArray(remote.items)) {\n      state.items = mergeItems(state.items, remote.items);\n      state.capture = mergeCapture(state.capture, remote.capture);\n      // サーバーの準備ページ（/setup）で入れた Discord ユーザー ID を、アプリの設定にも映す\n      const rid = remote.settings && remote.settings.discord && remote.settings.discord.userId;\n      if (rid && !state.settings.discord.userId) state.settings.discord = { ...state.settings.discord, userId: rid };\n      save({ push: false });\n      ui.lastPull = Date.now();\n      setStatus('同期した ' + clock());\n      render();\n    }\n  } catch (e) { setStatus('同期できなかった（' + (e.message || e) + '）'); }\n}\nfunction setStatus(msg) { ui.syncStatus = msg; const el = document.querySelector('[data-sync-status]'); if (el) el.textContent = msg; }\n\n// ---------- 小道具 ----------\nconst nowIso = () => new Date().toISOString();\nconst todayISO = () => S.formatDate ? isoOf(new Date()) : '';\nfunction isoOf(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }\nfunction clock(d = new Date()) { return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }\nfunction h(tag, attrs, ...children) {\n  const n = document.createElement(tag);\n  for (const [k, v] of Object.entries(attrs || {})) {\n    if (v === null || v === undefined || v === false) continue;\n    if (k === 'className') n.className = v;\n    else if (k === 'text') n.textContent = v;\n    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);\n    else n.setAttribute(k, v === true ? '' : String(v));\n  }\n  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c);\n  return n;\n}\nconst live = () => state.items.filter((i) => !i.deleted);\nconst active = () => live().filter((i) => S.isActive(i));\nfunction touch(item) { item.updatedAt = nowIso(); }\nfunction sorted() {\n  const items = live();\n  const t = todayISO();\n  // まだ：できてない、または できたけど出していない（期限が来ている）\n  const pending = items.filter((i) => S.isActive(i) && (!i.done || S.dueInfo(i.due, t, i.done, { packed: i.packed }).state === 'handin')).sort((a, b) => (a.due || '').localeCompare(b.due || '') || (a.createdAt || '').localeCompare(b.createdAt || ''));\n  const weekAgo = Date.now() - 7 * 86400000;\n  const done = items.filter((i) => !pending.includes(i) && (i.done || i.submitted || i.dropped) && Date.parse(i.updatedAt || i.createdAt || 0) > weekAgo).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));\n  return { pending, done };\n}\n/** 持っていくもの。18:00 以降は「あしたの準備」（あした分＋期限切れ）。ネット提出は入れない。 */\nfunction bringMode() { return minutesNow() >= 18 * 60 ? 'tomorrow' : 'today'; }\nfunction bringItems() {\n  const t = todayISO();\n  const tomorrow = isoOf(new Date(Date.now() + 86400000));\n  return active().filter((i) => !S.isOnline(i)).filter((i) => {\n    const st = S.dueInfo(i.due, t, false).state;\n    return st === 'today' || st === 'overdue' || (bringMode() === 'tomorrow' && i.due === tomorrow);\n  }).sort((a, b) => (a.due || '').localeCompare(b.due || ''));\n}\nfunction handinItems() {\n  const t = todayISO();\n  return active().filter((i) => i.packed && (i.due || '') <= t);\n}\nfunction minutesNow(d = new Date()) { return d.getHours() * 60 + d.getMinutes(); }\nfunction hhmm(t) { const m = /^(\\d{1,2}):(\\d{2})$/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : 0; }\nconst hasCourses = (s = state.settings) => Array.isArray(s.courses) && s.courses.length > 0;\n/** その日の予定（履修科目があれば、曜日ごとの出る時間・放課後・授業） */\nfunction planFor(d = new Date()) { return S.dayPlan(d.getDay(), state.settings); }\nfunction leaveToday() { return planFor().leaveAt || state.settings.leaveAt; }\n/**\n * 「課題出た？」を出すか。\n * 履修科目があれば、授業が終わって 5 分たったら、終わった授業だけを聞く（asked 0）。放課後を過ぎたら、その日の全部を回数つきで。\n * 履修科目がなければ、放課後から。\n */\nfunction captureView() {\n  const today = todayISO();\n  const now = new Date();\n  const s = state.settings;\n  const plan = planFor(now);\n  if (!plan.school) return null;\n  const m = minutesNow(now);\n  if (m >= hhmm(s.quietFrom || '22:00')) return null;\n  const after = hhmm(plan.afterSchoolAt);\n  if (m < after && !plan.hasCourses) return null;\n  const subjects = S.askableSubjects(today, m, s);\n  if (!subjects.length) return null;\n  const st = S.captureStatus({ items: state.items, capture: state.capture, today, subjects });\n  const handin = handinItems();\n  if (m < after) return st.all && !handin.length ? null : { asked: 0, handin, subjects };\n  if (st.all && m - after > 120 && !handin.length) return null;\n  const elapsed = m - after;\n  const asked = elapsed < 90 ? Math.floor(elapsed / 30) + 1 : 3 + Math.floor((elapsed - 60) / 60);\n  return { asked, handin, subjects };\n}\nfunction setCapture(subject, value) {\n  const D = todayISO();\n  const cur = state.capture[D];\n  const obj = (cur === 'none' || cur === 'added') ? { '*': cur } : (cur && typeof cur === 'object' ? { ...cur } : {});\n  if (value) obj[subject] = value; else delete obj[subject];\n  state.capture[D] = obj;\n}\nfunction applyTheme() {\n  const pref = state.settings.theme || 'auto';\n  const dark = pref === 'dark' || (pref === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);\n  document.documentElement.dataset.theme = dark ? 'dark' : 'light';\n  const meta = document.querySelector('meta[name=\"theme-color\"]:not([media])');\n  if (meta) meta.content = dark ? '#0f0f0f' : '#ffffff';\n}\n\n// ---------- 画面 ----------\n/** 「いま 2限 フランス語(a) B-201（〜12:10）」／「つぎ 4限 …（14:40〜）」 */\nfunction nextClassLine() {\n  if (!hasCourses()) return null;\n  const nc = S.nextClass(new Date(), state.settings);\n  if (!nc) return null;\n  const l = nc.lesson;\n  return h('p', { className: 'brand__next', text: (nc.during ? 'いま ' : 'つぎ ') + l.period + '限 ' + l.subject + (l.room ? ' ' + l.room : '') + (nc.during ? '（〜' + l.end + '）' : '（' + l.start + '〜）') });\n}\nfunction render() {\n  if (!S) return;\n  applyTheme();\n  const today = todayISO();\n  const { pending, done } = sorted();\n  const hero = pending[0] || null;\n  const rest = pending.slice(1);\n  const plan = planFor();\n  const leaveAt = plan.leaveAt || state.settings.leaveAt;\n  const n = S.nudgeStage({ items: live(), leaveAt, now: new Date(), today });\n  const snoozed = state.nudge.snoozeUntil && new Date(state.nudge.snoozeUntil) > new Date();\n  const schoolToday = plan.school;\n  // 学校のある日の、出発 60 分前から、学校に着くころまで（履修科目があれば最初の授業が始まるまで、なければ出発後 60 分）。\n  // 全部入れたあとも「いってらっしゃい」として残す（消えない）。「あとで」中は 1 行にたたむ。学校に着いたあとの「出した？」は放課後のチェックが聞く\n  const untilArrive = plan.hasCourses && plan.lessons.length ? hhmm(plan.lessons[0].start) - hhmm(leaveAt) : 60;\n  const showNudge = schoolToday && bringMode() === 'today' && bringItems().length > 0 && n.minutes <= 60 && n.minutes >= -untilArrive;\n  const snoozeLeft = Math.max(0, (state.settings.snoozeMax || 3) - ((state.nudge.snoozeCount || {})[today] || 0));\n\n  const mark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');\n  mark.setAttribute('viewBox', '0 0 36 36'); mark.setAttribute('class', 'brand__mark'); mark.setAttribute('aria-hidden', 'true');\n  [[4, '#ffffff'], [14, '#ffffff'], [24, '#ff8fc5']].forEach(([x, f]) => { const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect'); r.setAttribute('x', x); r.setAttribute('y', 4); r.setAttribute('width', 8); r.setAttribute('height', 28); r.setAttribute('rx', 4); r.setAttribute('fill', f); mark.prepend(r); });\n  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect'); bg.setAttribute('width', 36); bg.setAttribute('height', 36); bg.setAttribute('rx', 10); bg.setAttribute('fill', '#111111'); mark.prepend(bg);\n\n  const top = h('header', { className: 'top' },\n    h('div', { className: 'brand' }, mark, h('div', null,\n      h('h1', { className: 'brand__name', text: '宿題忘れゼロ' }),\n      h('p', { className: 'brand__date', text: S.formatDate(new Date()) + (plan.hasCourses ? (plan.school ? '　出る ' + plan.leaveAt : '　きょうは授業なし') : '　出る時間 ' + leaveAt) }),\n      nextClassLine()\n    )),\n    h('div', { className: 'top__actions' },\n      h('button', { className: 'sk-iconbtn', type: 'button', 'aria-label': bringMode() === 'tomorrow' ? 'あしたの準備' : 'あさのチェック', title: bringMode() === 'tomorrow' ? 'あしたの準備' : 'あさのチェック', onClick: () => openSheet('bring') }, S.icon('bag', 24)),\n      h('button', { className: 'sk-pill', type: 'button', onClick: () => openSheet('week') }, 'こんしゅう'),\n      h('button', { className: 'sk-pill', type: 'button', onClick: () => openSheet('settings') }, '設定')\n    )\n  );\n\n  const parts = [top];\n  const nudging = showNudge && !snoozed && (n.stage === 'soon' || n.stage === 'urgent' || n.stage === 'late');\n  root.classList.toggle('is-nudging', !!nudging);\n  if (showNudge) parts.push(S.NudgeBar({ items: live(), leaveAt, now: new Date(), today, snoozeLeft, snoozedUntil: snoozed ? state.nudge.snoozeUntil : null, onPack: packItem, onSnooze: snooze, onWake: () => { state.nudge.snoozeUntil = null; save(); render(); } }));\n  if (state.draft && !ui.sheet) parts.push(h('button', { className: 'draft', type: 'button', onClick: () => openSheet('add', state.draft) }, S.icon('book', 20), h('span', { text: '書きかけ 1 つ：' + (state.draft.subject || '科目なし') + ' ' + (state.draft.range || '') }), h('span', { className: 'draft__go', text: 'つづきを書く' })));\n  const cap = captureView();\n  if (cap) parts.push(S.CaptureAsk({\n    items: state.items, capture: state.capture, subjects: cap.subjects, today, asked: cap.asked, handin: cap.handin,\n    onPick: (subject) => openSheet('add', { subject, fromCapture: true }),\n    onNone: (subject) => { setCapture(subject, 'none'); save(); render(); },\n    onNoneAll: () => { for (const sub of S.captureStatus({ items: state.items, capture: state.capture, today, subjects: cap.subjects }).unanswered) setCapture(sub, 'none'); save(); render(); },\n    onReopen: () => { const cur = state.capture[today]; if (cur && typeof cur === 'object') { for (const k of Object.keys(cur)) if (cur[k] === 'none') delete cur[k]; } else if (cur === 'none') delete state.capture[today]; save(); render(); },\n    onSubmit: submitItem, onDrop: dropItem\n  }));\n  const heroEl = S.TodayHero({ item: hero, today, remaining: rest.length, onDone: (item) => completeItem(item, true, { heroEl }), onAdd: () => openSheet('add') });\n  parts.push(heroEl);\n  if (rest.length) {\n    parts.push(h('p', { className: 'section-label', text: 'そのあと ' + rest.length }));\n    parts.push(h('div', { className: 'list' }, rest.map((item) => S.HomeworkCard({ item, today, onDone: (it, next) => completeItem(it, next, { fromCard: true }), onOpen: (it) => openSheet('edit', it), onSubmit: submitItem, onDrop: dropItem }))));\n  }\n  if (done.length) {\n    parts.push(h('p', { className: 'section-label', text: 'できた ' + done.length }));\n    parts.push(h('div', { className: 'list' }, done.map((item) => S.HomeworkCard({ item, today, onDone: (it, next) => completeItem(it, next, { fromCard: true }), onOpen: (it) => openSheet('edit', it) }))));\n  }\n  if (!navigator.onLine) parts.push(h('p', { className: 'offline', text: 'オフライン。端末には保存してある。' }));\n\n  // 朝、バーがピンクになっているあいだは「追加」を脇役に（ピンクは 1 画面に 1 つ）\n  const fab = h('div', { className: 'fab' }, S.BigButton({ label: '宿題を追加', kind: nudging ? 'secondary' : 'primary', icon: 'plus', full: true, onClick: () => openSheet('add') }));\n  if (ui.board) { renderBoard(); return; }\n  root.replaceChildren(...parts, fab);\n  if (ui.toast) root.append(ui.toast);\n  if (ui.sheet) root.append(ui.sheet);\n}\n\n// ---------- 操作 ----------\nconst DONE_LINES = ['できた。', '1 つ消えた。', 'はい、つぎ。', 'いい調子。'];\nfunction completeItem(item, next, { fromCard = false, heroEl = null } = {}) {\n  item.done = next; touch(item); save();\n  if (!next) { render(); return; }\n  ui.doneToday++;\n  // 手応えを残す：主役なら打ち消し線に変えてから、カードなら 220ms の膨らみを見せてから、次へ\n  if (heroEl) { heroEl.classList.add('is-done'); const chip = heroEl.querySelector('.sk-chip'); if (chip) chip.replaceWith(S.DueChip({ due: item.due, today: todayISO(), done: true, size: 'lg' })); }\n  showUndo(item);\n  setTimeout(render, fromCard || heroEl ? 600 : 0);\n}\nfunction submitItem(item) {\n  item.submitted = true; item.submittedAt = nowIso(); touch(item); save();\n  toast('出した。えらい。', null); render();\n}\nfunction dropItem(item) {\n  item.dropped = true; item.droppedAt = nowIso(); touch(item); save();\n  toast('先生に言った。これで終わり。', null); render();\n}\nfunction toast(text, action) {\n  clearTimeout(ui.undo);\n  ui.toast = h('div', { className: 'toast', role: 'status' }, text, action);\n  ui.undo = setTimeout(hideToast, 5000);\n}\nfunction packItem(item) {\n  const t = todayISO();\n  for (const i of bringItems()) if (i.id === item.id) { i.packed = true; i.packedAt = nowIso(); i.packedOn = t; touch(i); }\n  save(); render();\n}\nfunction snooze() {\n  const t = todayISO();\n  const used = (state.nudge.snoozeCount || {})[t] || 0;\n  if (used >= (state.settings.snoozeMax || 3)) return;\n  state.nudge.snoozeCount = { [t]: used + 1 };\n  state.nudge.snoozeUntil = new Date(Date.now() + 10 * 60000).toISOString();\n  save({ push: false }); render();\n}\nfunction showUndo(item) {\n  const leftover = sorted().pending.filter((i) => i.id !== item.id && !i.done).length;\n  const line = leftover === 0 ? 'ぜんぶ終わった！' : DONE_LINES[(ui.doneToday - 1) % DONE_LINES.length];\n  toast(line, S.BigButton({ label: 'もどす', kind: 'ghost', icon: 'undo', onClick: () => { item.done = false; touch(item); save(); hideToast(); render(); } }));\n  const old = root.querySelector('.toast'); if (old) old.remove();\n  root.append(ui.toast);\n}\nfunction hideToast() { clearTimeout(ui.undo); ui.toast = null; const t = root.querySelector('.toast'); if (t) t.remove(); }\nfunction addItem(item) {\n  if (!item.submitTo) item.submitTo = S.submitPlace(item.subject, item.due, state.settings);\n  state.items.push(item); setCapture(item.subject, 'added'); state.draft = null; save(); closeSheet(); render();\n}\n\n// ---------- シート ----------\nfunction openSheet(kind, item) {\n  ui.deleteArmed = false;\n  let content;\n  if (kind === 'add') content = S.QuickAdd({ today: todayISO(), initial: item || null, ...subjectChoices(), timetable: S.effectiveTimetable(state.settings), schoolDays: S.effectiveSchoolDays(state.settings), paperSpot: state.settings.paperSpot, allowEmptyRange: !!(item && item.fromCapture), onSubmit: addItem, onCancel: (draft) => { state.draft = (draft && (draft.range || draft.subject)) ? draft : null; save({ push: false }); closeSheet(); } });\n  else if (kind === 'week') content = weekSheet();\n  else if (kind === 'import') content = importSheet(item);\n  else if (kind === 'bring') content = bringSheet();\n  else if (kind === 'edit') content = editSheet(item);\n  else content = settingsSheet();\n  const sheet = h('div', { className: 'sheet', role: 'dialog', 'aria-modal': 'true' }, content);\n  ui.sheet = h('div', { className: 'sheet-backdrop', onClick: (e) => { if (e.target === ui.sheet) closeSheet(); } }, sheet);\n  render();\n  const first = sheet.querySelector('input, button'); if (first) first.focus();\n}\nfunction closeSheet() { ui.sheet = null; render(); }\nconst UNI_WHERE = ['教科書', 'プリント', 'レジュメ', 'ノート', 'LMS', 'Classroom', 'メール'];\n/** 登録シートの科目：きょうの授業を先頭に、ほかの授業は「ほかの授業」に畳む。 */\nfunction subjectChoices() {\n  const all = S.allSubjects(state.settings);\n  if (!hasCourses()) return { subjects: all };\n  const todays = S.daySubjects(todayISO(), state.settings);\n  return { subjects: todays.length ? todays : all, moreSubjects: all, wherePresets: UNI_WHERE };\n}\n\nfunction bringSheet() {\n  const items = bringItems();\n  const tomorrow = new Date(Date.now() + 86400000);\n  const evening = bringMode() === 'tomorrow';\n  return h('div', { className: 'panel' },\n    S.BringCheck({ items, today: todayISO(), paperSpot: state.settings.paperSpot, title: evening ? 'あしたの準備' : 'あさのチェック', dateText: evening ? S.formatDate(tomorrow) + ' に持っていくもの。前の晩に詰める。' : undefined, onToggle: (it) => { if (it.packed) it.packedOn = evening ? isoOf(tomorrow) : todayISO(); touch(it); save(); }, onClose: closeSheet }),\n    h('div', { className: 'panel__actions' }, S.BigButton({ label: 'とじる', kind: 'secondary', full: true, onClick: closeSheet }))\n  );\n}\n\nfunction weekDays() {\n  const out = [];\n  const base = new Date();\n  for (let k = 0; k < 7; k++) {\n    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + k);\n    const key = isoOf(d);\n    out.push({ d, key, items: active().filter((i) => i.due === key || (k === 0 && (i.due || '') < key)) });\n  }\n  return out;\n}\nfunction weekGrid(big) {\n  const today = todayISO();\n  return h('div', { className: 'week' + (big ? ' week--big' : '') }, weekDays().map(({ d, key, items }, k) =>\n    h('section', { className: 'week__day' + (k === 0 ? ' is-today' : '') + (!S.dayPlan(d.getDay(), state.settings).school ? ' is-off' : '') },\n      h('p', { className: 'week__date', text: (k === 0 ? 'きょう ' : k === 1 ? 'あした ' : '') + S.formatDate(d) }),\n      (() => { const ls = S.dayPlan(d.getDay(), state.settings).lessons; return ls.length ? h('p', { className: 'week__classes', text: ls.map((l) => l.period + '限 ' + l.subject + (l.room ? ' ' + l.room : '')).join('　') }) : null; })(),\n      items.length ? h('div', { className: 'week__items' }, items.map((i) => h('div', { className: 'week__item' + (i.done ? ' is-done' : '') }, S.SubjectTag({ subject: i.subject }), h('span', { className: 'week__range', text: i.range || '範囲？' }), S.DueChip({ due: i.due, today, done: i.done, flags: { packed: i.packed } })))) : h('p', { className: 'week__empty', text: 'なし' })\n    )));\n}\nfunction weekSheet() {\n  return h('div', { className: 'panel' },\n    h('div', { className: 'panel__head' }, h('h2', { className: 'panel__title', text: 'こんしゅう' }), h('button', { className: 'sk-iconbtn', type: 'button', 'aria-label': 'とじる', onClick: closeSheet }, S.icon('close', 24))),\n    weekGrid(false),\n    h('p', { className: 'panel__note', text: 'リビングのタブレットなどに出すときは、このページの URL の最後に ?board=1 を付ける（操作なしの大きい表示）。' }),\n    h('div', { className: 'panel__actions' }, S.BigButton({ label: 'とじる', kind: 'secondary', full: true, onClick: closeSheet }))\n  );\n}\n/** ?board=1：家族が見る大きい表示。操作ボタンなし、1 分ごとに更新。 */\nfunction renderBoard() {\n  document.body.classList.add('is-board');\n  const today = todayISO();\n  const n = S.nudgeStage({ items: live(), leaveAt: leaveToday(), now: new Date(), today });\n  const line = n.stage === 'clear' ? 'きょうのぶんは、ぜんぶ かばんの中。' : `まだ かばんに入れていないもの：${n.items.map((i) => i.subject).join('・')}`;\n  root.replaceChildren(\n    h('header', { className: 'top' }, h('div', { className: 'brand' }, h('div', null, h('h1', { className: 'brand__name', text: '宿題忘れゼロ' }), h('p', { className: 'brand__date', text: S.formatDate(new Date()) + '　' + clock() })))),\n    h('p', { className: 'board__line', text: line }),\n    weekGrid(true)\n  );\n}\nfunction editSheet(item) {\n  const draft = { ...item };\n  const input = (name, placeholder, type = 'text') => h('input', { className: 'sk-input', type, name, value: draft[name] || '', placeholder, autocomplete: 'off', onInput: (e) => { draft[name] = e.target.value; } });\n  const names = S.allSubjects(state.settings);\n  if (draft.subject && !names.includes(draft.subject)) names.push(draft.subject);\n  const subjectChoices = h('div', { className: 'sk-choices', role: 'radiogroup', 'aria-label': '科目' }, names.map((label) => {\n    const b = h('button', { className: 'sk-choice' + (draft.subject === label ? ' is-on' : ''), type: 'button', role: 'radio', 'aria-checked': draft.subject === label ? 'true' : 'false', text: label });\n    b.addEventListener('click', () => { draft.subject = label; for (const c of subjectChoices.children) { c.classList.toggle('is-on', c === b); c.setAttribute('aria-checked', c === b ? 'true' : 'false'); } });\n    return b;\n  }));\n  const del = S.BigButton({ label: '消す', kind: 'ghost', full: true, onClick: () => {\n    if (!ui.deleteArmed) { ui.deleteArmed = true; del.querySelector('.sk-btn__label').textContent = 'ほんとに消す？ もう一回押す'; return; }\n    item.deleted = true; touch(item); save(); closeSheet();\n  } });\n  return h('form', { className: 'panel', onSubmit: (e) => { e.preventDefault(); const autoBefore = S.submitPlace(item.subject, item.due, state.settings); const subject = draft.subject || 'その他'; const due = draft.due || item.due; let submitTo = (draft.submitTo || '').trim(); if (!submitTo || submitTo === autoBefore) submitTo = S.submitPlace(subject, due, state.settings); const range = (draft.range || '').trim() || item.range; Object.assign(item, { subject, range, rangeMissing: !range, where: (draft.where || '').trim(), submitTo, due }); touch(item); save(); closeSheet(); } },\n    h('div', { className: 'panel__head' }, h('h2', { className: 'panel__title', text: '直す' }), h('button', { className: 'sk-iconbtn', type: 'button', 'aria-label': 'とじる', onClick: closeSheet }, S.icon('close', 24))),\n    h('div', { className: 'sk-field' }, h('p', { className: 'sk-field__label', text: '01 科目' }), subjectChoices),\n    h('div', { className: 'sk-field' }, h('label', { className: 'sk-field__label', text: '02 範囲' }), input('range', 'p.24〜27')),\n    h('div', { className: 'sk-field' }, h('label', { className: 'sk-field__label', text: '03 どこにある？' }), input('where', '教科書、プリント、Classroom…')),\n    h('div', { className: 'sk-field' }, h('label', { className: 'sk-field__label', text: '04 いつまで？' }), input('due', '', 'date')),\n    h('div', { className: 'sk-field' }, h('label', { className: 'sk-field__label', text: '05 出すところ（任意）' }), input('submitTo', '先生に直接、提出箱…')),\n    h('div', { className: 'panel__actions' },\n      S.BigButton({ label: 'これで保存', kind: 'primary', icon: 'check', full: true, type: 'submit' }),\n      item.packed ? S.BigButton({ label: 'かばんから出した（入れたを取り消す）', kind: 'secondary', full: true, onClick: () => { item.packed = false; touch(item); save(); closeSheet(); } }) : null,\n      del\n    )\n  );\n}\n\n// ---------- 履修科目（大学の時間割） ----------\nconst DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];\n/** 貼り付けた JSON を読む。{ courses: [...], periods?, commuteMinutes? } でも、配列だけでもいい。day は 1〜6 か「月」〜「土」。 */\nfunction parseCoursesText(text) {\n  let data;\n  try { data = JSON.parse(text); } catch { throw new Error('読めなかった。JSON の形になっているか見て'); }\n  const list = Array.isArray(data) ? data : (data && Array.isArray(data.courses) ? data.courses : null);\n  if (!list || !list.length) throw new Error('courses が見つからない');\n  const courses = list.map((c, i) => {\n    if (!c || typeof c.name !== 'string' || !c.name.trim()) throw new Error((i + 1) + ' 個目に name（授業名）がない');\n    let day = c.day;\n    if (typeof day === 'string') day = DAY_NAMES.indexOf(day.trim().slice(0, 1));\n    day = day === null || day === undefined || day === -1 || day === '' ? null : +day;\n    if (day !== null && !(day >= 0 && day <= 6)) throw new Error(c.name + ' の day（曜日）がおかしい');\n    const period = c.period === null || c.period === undefined || c.period === '' ? null : +c.period;\n    if (period !== null && !(period >= 1 && period <= 8)) throw new Error(c.name + ' の period（時限）がおかしい');\n    const str = (v, n) => (typeof v === 'string' || typeof v === 'number') ? String(v).trim().slice(0, n) : '';\n    return { name: str(c.name, 80), short: str(c.short, 30) || str(c.name, 30), day, period: day === null ? null : period, room: str(c.room, 30), teacher: str(c.teacher, 40), code: str(c.code, 20), credits: +c.credits || null, required: !!c.required };\n  });\n  const out = { courses };\n  if (data && data.periods && typeof data.periods === 'object') {\n    const periods = {};\n    for (const [k, v] of Object.entries(data.periods)) if (Array.isArray(v) && /^\\d{1,2}:\\d{2}$/.test(v[0]) && /^\\d{1,2}:\\d{2}$/.test(v[1])) periods[k] = [v[0], v[1]];\n    if (Object.keys(periods).length) out.periods = periods;\n  }\n  if (data && (data.commuteMinutes === 0 || +data.commuteMinutes > 0)) out.commuteMinutes = +data.commuteMinutes;\n  return out;\n}\nfunction b64urlEncode(str) { const bytes = new TextEncoder().encode(str); let bin = ''; bytes.forEach((b) => { bin += String.fromCharCode(b); }); return btoa(bin).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, ''); }\nfunction b64urlDecode(s) { const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)); return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))); }\nfunction coursesSummary(courses, periods) {\n  const byDay = [1, 2, 3, 4, 5, 6, 0].map((d) => {\n    const ls = courses.filter((c) => c.day === d && c.period).sort((a, b) => a.period - b.period);\n    return ls.length ? h('p', { className: 'courses__day' }, h('span', { className: 'courses__dow', text: DAY_NAMES[d] }), ls.map((c) => c.period + '限 ' + (c.short || c.name) + (c.room ? ' ' + c.room : '')).join('　')) : null;\n  });\n  const floating = courses.filter((c) => c.day === null || c.day === undefined);\n  return h('div', { className: 'courses' }, byDay, floating.length ? h('p', { className: 'courses__day' }, h('span', { className: 'courses__dow', text: '他' }), floating.map((c) => c.short || c.name).join('・') + '（曜日なし。週の最後の授業日に聞く）') : null);\n}\n/** #import=… で開いたとき：中身を見せてから入れる */\nfunction importSheet(data) {\n  return h('div', { className: 'panel' },\n    h('div', { className: 'panel__head' }, h('h2', { className: 'panel__title', text: '時間割を入れる？' }), h('button', { className: 'sk-iconbtn', type: 'button', 'aria-label': 'とじる', onClick: closeSheet }, S.icon('close', 24))),\n    h('p', { className: 'panel__note', text: data.courses.length + ' コマ。いまの履修科目は、これに入れかわる。' }),\n    coursesSummary(data.courses, data.periods),\n    h('div', { className: 'panel__actions' },\n      S.BigButton({ label: 'この時間割を入れる', kind: 'primary', icon: 'check', full: true, onClick: () => { applyCourses(data); closeSheet(); toast('時間割を入れた。' + data.courses.length + ' コマ。', null); render(); } }),\n      S.BigButton({ label: 'やめる', kind: 'ghost', full: true, onClick: closeSheet })\n    )\n  );\n}\nfunction applyCourses(data) {\n  state.settings = { ...state.settings, courses: data.courses, ...(data.periods ? { periods: data.periods } : {}), ...(data.commuteMinutes !== undefined ? { commuteMinutes: data.commuteMinutes } : {}), updatedAt: nowIso() };\n  save();\n}\n/** 設定の「授業（履修科目）」 */\nfunction coursesSection(s, field) {\n  const status = h('p', { className: 'panel__status' });\n  const area = h('textarea', { className: 'sk-input courses__text', rows: '6', placeholder: '{ \"courses\": [ { \"name\": \"統計学 I\", \"short\": \"統計学\", \"day\": \"月\", \"period\": 1, \"room\": \"A-101\" } ] }', spellcheck: 'false', 'aria-label': '履修科目の JSON' });\n  const load = S.BigButton({ label: '貼り付けたものを読み込む', kind: 'secondary', full: true, onClick: () => {\n    try { const data = parseCoursesText(area.value); s.courses = data.courses; if (data.periods) s.periods = data.periods; if (data.commuteMinutes !== undefined) s.commuteMinutes = data.commuteMinutes; status.textContent = data.courses.length + ' コマ読んだ。「これで保存」で入る。'; }\n    catch (e) { status.textContent = e.message; }\n  } });\n  const importBox = h('details', { className: 'details' }, h('summary', { className: 'section-label' }, hasCourses(s) ? '履修科目を貼り付けて入れかえる' : '履修科目（大学の時間割）を入れる'),\n    h('p', { className: 'panel__note', text: '入れると、曜日ごとに「出る時間」が決まり、授業が終わるたびに「課題出た？」と聞き、期限は「次のその授業」、出すところは「その授業の教室」になる。' }),\n    area, load, status);\n  if (!hasCourses(s)) return importBox;\n  const periods = s.periods || S.DEFAULT_PERIODS;\n  const leaveLine = h('p', { className: 'panel__note courses__leave' });\n  const refresh = () => { leaveLine.textContent = '出る時間：' + [1, 2, 3, 4, 5, 6].map((d) => { const p = S.dayPlan(d, s); return p.school ? DAY_NAMES[d] + ' ' + p.leaveAt : null; }).filter(Boolean).join('　'); };\n  refresh();\n  const commute = h('input', { className: 'sk-input sk-input--sub', type: 'number', min: '0', max: '240', step: '5', value: String(s.commuteMinutes === 0 || +s.commuteMinutes > 0 ? s.commuteMinutes : 60), onInput: (e) => { const v = +e.target.value; if (v >= 0) { s.commuteMinutes = v; refresh(); } } });\n  const periodRows = h('div', { className: 'panel__actions' }, [1, 2, 3, 4, 5, 6].map((k) => {\n    const cur = (periods[k] || ['', '']);\n    const set = (i, v) => { s.periods = JSON.parse(JSON.stringify(s.periods || S.DEFAULT_PERIODS)); s.periods[k] = s.periods[k] || ['', '']; s.periods[k][i] = v; refresh(); };\n    return h('div', { className: 'row row--tt' }, h('span', { className: 'row__day', text: k }),\n      h('input', { className: 'sk-input sk-input--sub row__time', type: 'time', value: cur[0], 'aria-label': k + '限のはじまり', onInput: (e) => set(0, e.target.value) }),\n      h('span', { text: '〜' }),\n      h('input', { className: 'sk-input sk-input--sub row__time', type: 'time', value: cur[1], 'aria-label': k + '限のおわり', onInput: (e) => set(1, e.target.value) }));\n  }));\n  const copyStatus = h('p', { className: 'panel__status' });\n  const exported = () => JSON.stringify({ courses: s.courses, periods: s.periods || undefined, commuteMinutes: s.commuteMinutes }, null, 1);\n  let clearArmed = false;\n  const clearBtn = S.BigButton({ label: '履修科目を消す', kind: 'ghost', full: true, onClick: () => {\n    if (!clearArmed) { clearArmed = true; clearBtn.querySelector('.sk-btn__label').textContent = 'ほんとに消す？ もう一回押す'; return; }\n    s.courses = []; copyStatus.textContent = '消した。「これで保存」で反映。';\n  } });\n  return h('div', { className: 'courses-block' },\n    h('p', { className: 'section-label', text: '授業（履修科目）' }),\n    coursesSummary(s.courses, periods),\n    h('div', { className: 'grid-2' }, field('通学時間（分）', commute, '家から教室まで。出る時間 = 最初の授業 − これ'), h('div', null)),\n    leaveLine,\n    h('details', { className: 'details' }, h('summary', { className: 'section-label' }, '時限の時刻（学校に合わせて直す）'), periodRows),\n    importBox,\n    h('div', { className: 'panel__actions' },\n      S.BigButton({ label: 'ほかの端末に入れるリンクをコピー', kind: 'secondary', full: true, onClick: async () => {\n        const url = location.origin + location.pathname + '#import=' + b64urlEncode(exported());\n        try { await navigator.clipboard.writeText(url); copyStatus.textContent = 'コピーした。ほかの端末で開くと入る。'; } catch { copyStatus.textContent = url; }\n      } }),\n      clearBtn, copyStatus)\n  );\n}\nfunction settingsSheet() {\n  const s = JSON.parse(JSON.stringify(state.settings));\n  const field = (label, node, note) => h('div', { className: 'sk-field' }, h('label', { className: 'sk-field__label', text: label }), node, note ? h('p', { className: 'panel__note', text: note }) : null);\n  const time = (key) => h('input', { className: 'sk-input sk-input--sub', type: 'time', value: s[key], onInput: (e) => { s[key] = e.target.value || s[key]; } });\n  const text = (get, set, placeholder, type = 'text') => h('input', { className: 'sk-input sk-input--sub', type, value: get() || '', placeholder, autocomplete: 'off', spellcheck: 'false', onInput: (e) => set(e.target.value.trim()) });\n  const chips = (options, get, set) => {\n    const g = h('div', { className: 'sk-choices', role: 'radiogroup' }, options.map(([v, label]) => {\n      const b = h('button', { className: 'sk-choice' + (get() === v ? ' is-on' : ''), type: 'button', role: 'radio', 'aria-checked': get() === v ? 'true' : 'false', text: label });\n      b.addEventListener('click', () => { set(v); for (const c of g.children) { c.classList.toggle('is-on', c === b); c.setAttribute('aria-checked', c === b ? 'true' : 'false'); } });\n      return b;\n    }));\n    return g;\n  };\n  const chipsMulti = (options, get, set) => h('div', { className: 'sk-choices', role: 'group' }, options.map(([k, label]) => {\n    const b = h('button', { className: 'sk-choice' + (get(k) ? ' is-on' : ''), type: 'button', 'aria-pressed': get(k) ? 'true' : 'false', text: label });\n    b.addEventListener('click', () => { set(k, !get(k)); b.classList.toggle('is-on', get(k)); b.setAttribute('aria-pressed', get(k) ? 'true' : 'false'); });\n    return b;\n  }));\n  const status = h('p', { className: 'panel__status', 'data-sync-status': '', text: ui.syncStatus });\n  return h('form', { className: 'panel', onSubmit: (e) => { e.preventDefault(); s.updatedAt = nowIso(); state.settings = s; save(); closeSheet(); doPull(); } },\n    h('div', { className: 'panel__head' }, h('h2', { className: 'panel__title', text: '設定' }), h('button', { className: 'sk-iconbtn', type: 'button', 'aria-label': 'とじる', onClick: closeSheet }, S.icon('close', 24))),\n    coursesSection(s, field),\n    h('p', { className: 'section-label', text: '自分で決める' }),\n    hasCourses(s) ? null : h('div', { className: 'grid-2' },\n      field('出る時間', time('leaveAt'), 'ここが軸。60 分前からバーが出る'),\n      field('起きる時間', time('wakeAt'), 'この時刻に Discord の 1 通目')\n    ),\n    h('div', { className: 'grid-2' }, field('静かにする（から）', time('quietFrom')), field('静かにする（まで）', time('quietTo'))),\n    h('div', { className: 'grid-2' },\n      hasCourses(s) ? null : field('学校を出る時刻', time('leaveSchoolAt'), '学校（ロッカー・机）にあるものを、帰る前に「かばんへ」と言う'),\n      field('プリントの置き場所（家）', text(() => s.paperSpot, (v) => { s.paperSpot = v; }, '冷蔵庫横の赤いファイル'), 'プリントを登録したとき、ここへ、と出す')\n    ),\n    field('強さ', chips([['full', 'しっかり（Discord も）'], ['calm', 'アプリの中だけ']], () => s.escalation, (v) => { s.escalation = v; })),\n    field('見た目', chips([['auto', '自動'], ['light', '白'], ['dark', '黒']], () => s.theme, (v) => { s.theme = v; })),\n    hasCourses(s) ? null : h('p', { className: 'section-label', text: '捕まえる（登録し忘れを防ぐ）' }),\n    hasCourses(s) ? null : field('放課後（聞きに行く時刻）', time('afterSchoolAt'), 'この時刻から「きょう、宿題出た？」。答えるまで 30 分おきに 3 回'),\n    hasCourses(s) ? null : field('学校がある日', (() => {\n      const names = ['日', '月', '火', '水', '木', '金', '土'];\n      const g = h('div', { className: 'sk-choices', role: 'group' }, [1, 2, 3, 4, 5, 6, 0].map((d) => {\n        const on = () => (s.schoolDays || []).includes(d);\n        const b = h('button', { className: 'sk-choice' + (on() ? ' is-on' : ''), type: 'button', 'aria-pressed': on() ? 'true' : 'false', text: names[d] });\n        b.addEventListener('click', () => { s.schoolDays = on() ? s.schoolDays.filter((x) => x !== d) : [...(s.schoolDays || []), d]; b.classList.toggle('is-on', on()); b.setAttribute('aria-pressed', on() ? 'true' : 'false'); });\n        return b;\n      }));\n      return g;\n    })()),\n    hasCourses(s) ? null : field('時間割と、曜日ごとの放課後（任意）', h('div', { className: 'panel__actions' }, [1, 2, 3, 4, 5, 6].map((d) => {\n      const names = ['日', '月', '火', '水', '木', '金', '土'];\n      return h('div', { className: 'row row--tt' },\n        h('span', { className: 'row__day', text: names[d] }),\n        h('input', { className: 'sk-input sk-input--sub row__subjects', type: 'text', placeholder: '数学, 英語, 理科', value: ((s.timetable || {})[d] || []).join(', '), 'aria-label': names[d] + '曜の時間割', onInput: (e) => { s.timetable = { ...(s.timetable || {}), [d]: e.target.value.split(/[、,，\\s]+/).map((x) => x.trim()).filter(Boolean) }; } }),\n        h('input', { className: 'sk-input sk-input--sub row__time', type: 'time', value: (s.afterSchoolByDay || {})[d] || '', 'aria-label': names[d] + '曜の放課後', onInput: (e) => { s.afterSchoolByDay = { ...(s.afterSchoolByDay || {}) }; if (e.target.value) s.afterSchoolByDay[d] = e.target.value; else delete s.afterSchoolByDay[d]; } })\n      );\n    })), '科目を入れると、その日の科目だけを聞き、期限の既定が「次の○○」になる。右の時刻は部活がある日の放課後（空なら上の時刻）'),\n    h('details', { className: 'details', open: !!(s.discord.userId || s.sync.url) },\n      h('summary', { className: 'section-label' }, '大人と一緒に 1 回だけつなぐ（Discord・同期）'),\n      h('p', { className: 'panel__note', text: 'ここは誰かと一緒にやる。終わったら触らない。' }),\n    field('あなたの Discord ユーザー ID', text(() => s.discord.userId, (v) => { s.discord.userId = v; }, '18 桁くらいの数字'), 'Discord の設定 → 詳細設定 → 開発者モードを ON にして、自分の名前を右クリック →「ユーザー ID をコピー」'),\n    field('見守りチャンネル ID（任意）', text(() => s.discord.watchChannelId, (v) => { s.discord.watchChannelId = v; }, '空なら使わない'), '家族や友だちが見られる場所。本人が選んだものだけ届く'),\n    field('見守りチャンネルに届くもの', chipsMulti([['good', '良い知らせ（ぜんぶ入れた・出した）'], ['evening', '夜のまとめ'], ['late', '出発後の催促']], (k) => !!s.watch[k], (k, on) => { s.watch = { ...s.watch, [k]: on }; }), '既定は良い知らせだけ。失敗を流すかどうかは自分で決める'),\n    field('Classroom の URL（任意）', text(() => s.classroomUrl, (v) => { s.classroomUrl = v; }, 'https://classroom.google.com/', 'url'), '全部「なし」と答えた夜に「Classroom は見た？」とリンクを出す'),\n    h('p', { className: 'section-label', text: '同期（Discord に届かせるため）' }),\n    field('サーバーの URL', text(() => s.sync.url, (v) => { s.sync.url = v; }, 'https://shukudai-worker.xxx.workers.dev', 'url')),\n    field('合言葉（SYNC_TOKEN）', text(() => s.sync.token, (v) => { s.sync.token = v; }, 'wrangler secret put SYNC_TOKEN で決めたもの', 'password')),\n    field('アプリの URL（Discord の「アプリで見る」）', text(() => s.appUrl, (v) => { s.appUrl = v; }, location.href.split('#')[0], 'url')),\n    status\n    ),\n    h('div', { className: 'panel__actions' },\n      S.BigButton({ label: 'これで保存', kind: 'primary', icon: 'check', full: true, type: 'submit' }),\n      S.BigButton({ label: 'Discord にテスト送信', kind: 'secondary', icon: 'bag', full: true, onClick: async () => {\n        status.textContent = '送っている…';\n        try { state.settings = { ...s, updatedAt: nowIso() }; save({ push: false }); await pushState(s.sync, state); await testDm(s.sync); status.textContent = '届いた？ Discord の DM を見て'; }\n        catch (e) { status.textContent = '送れなかった：' + (e.message || e); }\n      } }),\n      S.BigButton({ label: 'とじる', kind: 'ghost', full: true, onClick: closeSheet })\n    )\n  );\n}\n\n// ---------- 起動 ----------\n/** URL の #import=… に時間割があれば、中身を見せてから入れる。 */\nfunction checkImportHash() {\n  const imp = /#import=([A-Za-z0-9_-]+)/.exec(location.hash);\n  if (!imp) return false;\n  history.replaceState(null, '', location.pathname + location.search);\n  try { openSheet('import', parseCoursesText(b64urlDecode(imp[1]))); } catch (e) { toast('時間割のリンクが読めなかった：' + e.message, null); render(); }\n  return true;\n}\nfunction loadFonts() { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = FONT_CSS; document.head.appendChild(l); }\nfunction boot() {\n  S = window.Shukudai;\n  if (!S) { setTimeout(boot, 30); return; }\n  loadFonts();\n  render();\n  ui.board = /[?&]board=1/.test(location.search);\n  if (ui.board) { renderBoard(); setInterval(renderBoard, 60000); }\n  if (!checkImportHash() && /[?&#]add\\b/.test(location.search + location.hash)) { history.replaceState(null, '', location.pathname); openSheet('add'); }\n  // アプリを開いたまま取り込みリンクを踏んだとき（# だけ変わってページは読み直されない）\n  window.addEventListener('hashchange', checkImportHash);\n  doPull();\n  setInterval(render, 30000);\n  setInterval(doPull, 5 * 60000);\n  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { render(); doPull(); } });\n  window.addEventListener('online', render); window.addEventListener('offline', render);\n  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);\n  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ui.sheet) closeSheet(); });\n  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {\n    navigator.serviceWorker.register('./sw.js').catch(() => {});\n  }\n}\nboot();\n"},"/app/app.css":{"type":"text/css; charset=utf-8","etag":"\"96da3b4aa5041bc4\"","body":"/* 宿題忘れゼロ — 画面の組み立て。部品の見た目は ds/bundle.css、色と文字は ds/tokens.css。 */\n* { box-sizing: border-box; }\nhtml, body { margin: 0; min-height: 100%; }\nbody {\n  background: var(--ground); color: var(--ink);\n  font-family: var(--font-sans); font-size: 16px; line-height: 24px; font-weight: 500;\n  -webkit-text-size-adjust: 100%;\n}\n:focus-visible { outline: 3px solid var(--focus); outline-offset: 4px; }\n\n.app {\n  max-width: var(--content-max); margin: 0 auto;\n  padding: var(--space-4) var(--space-4) calc(var(--space-8) + var(--space-7) + env(safe-area-inset-bottom));\n  display: flex; flex-direction: column; gap: var(--space-4);\n}\n\n/* ヘッダー：名前は display、日付は mono、右に 2 つの丸ボタン */\n.top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2) var(--space-3); padding-top: var(--space-2); }\n.brand { display: flex; align-items: center; gap: var(--space-3); min-width: 0; }\n.brand__mark { flex: none; width: 36px; height: 36px; border-radius: 10px; }\n.brand__name { margin: 0; font-family: var(--font-display); font-size: 22px; line-height: 30px; font-weight: 400; letter-spacing: -.01em; white-space: nowrap; }\n.brand__date { margin: 0; font-family: var(--font-mono); font-size: 13px; line-height: 18px; letter-spacing: .02em; color: var(--muted); white-space: nowrap; }\n.top__actions { display: flex; gap: var(--space-2); flex: none; align-items: center; margin-left: auto; }\n.sk-pill { display: inline-flex; align-items: center; min-height: var(--tap-min); padding: 0 var(--space-3); border: var(--border) solid var(--ink); border-radius: var(--radius-pill); background: var(--surface); color: var(--ink); font-family: var(--font-sans); font-size: 14px; line-height: 20px; font-weight: 700; cursor: pointer; }\n.draft { display: flex; align-items: center; gap: var(--space-2); width: 100%; min-height: var(--tap-min); padding: var(--space-2) var(--space-4); border: var(--border) dashed var(--line-strong); border-radius: var(--radius-pill); background: var(--accent-soft); color: var(--ink); font: inherit; font-weight: 700; text-align: left; cursor: pointer; }\n.draft__go { margin-left: auto; flex: none; white-space: nowrap; font-family: var(--font-mono); font-size: 12px; letter-spacing: .08em; color: var(--accent-ink); }\n/* 朝、バーがピンクのあいだは主役のボタンも脇役に（ピンクは 1 画面に 1 つ） */\n.app.is-nudging .sk-hero .sk-btn--primary { background: var(--surface); color: var(--ink); border-color: var(--ink); box-shadow: none; font-family: var(--font-sans); font-weight: 700; text-transform: none; }\n.fab::before { content: ''; position: absolute; inset: auto 0 0; height: 140%; background: linear-gradient(to top, var(--ground) 55%, transparent); pointer-events: none; z-index: -1; }\n.fab { position: fixed; }\n\n.section-label { margin: var(--space-2) 0 0; font-family: var(--font-mono); font-size: 12px; line-height: 16px; letter-spacing: .12em; text-transform: uppercase; color: var(--ink-soft); }\n.list { display: flex; flex-direction: column; gap: var(--space-3); }\n.empty { margin: 0; color: var(--muted); font-family: var(--font-mono); font-size: 13px; line-height: 18px; letter-spacing: .02em; }\n.offline { margin: 0; font-family: var(--font-mono); font-size: 12px; line-height: 16px; letter-spacing: .04em; color: var(--muted); }\n\n/* 下に固定の主ボタン */\n.fab { position: fixed; left: 0; right: 0; bottom: 0; z-index: 5; display: flex; justify-content: center; padding: var(--space-3) var(--space-4) calc(var(--space-4) + env(safe-area-inset-bottom)); pointer-events: none; }\n.fab > * { pointer-events: auto; width: 100%; max-width: var(--content-max); }\n\n/* ボトムシート */\n.sheet-backdrop { position: fixed; inset: 0; z-index: 10; background: #11111199; display: flex; align-items: flex-end; justify-content: center; }\n.sheet { width: 100%; max-width: var(--content-max); max-height: 94vh; overflow: auto; overscroll-behavior: contain; }\n.sheet > .sk-quick, .sheet > .panel { padding-bottom: calc(var(--space-6) + env(safe-area-inset-bottom)); }\n.panel {\n  display: flex; flex-direction: column; gap: var(--space-5);\n  padding: var(--space-5) var(--space-4) var(--space-6);\n  border: var(--border) solid var(--ink); border-bottom: 0;\n  border-radius: var(--radius-xl) var(--radius-xl) 0 0;\n  background: var(--surface); color: var(--ink); box-shadow: var(--shadow-float);\n}\n.panel__head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }\n.panel__title { margin: 0; font-family: var(--font-display); font-size: 24px; line-height: 32px; font-weight: 400; }\n.panel .sk-bring { border: 0; padding: 0; box-shadow: none; }\n.panel__actions { display: flex; flex-direction: column; gap: var(--space-2); }\n.panel__note { margin: 0; font-family: var(--font-mono); font-size: 13px; line-height: 18px; letter-spacing: .02em; color: var(--muted); }\n.panel__status { margin: 0; font-family: var(--font-mono); font-size: 13px; line-height: 18px; letter-spacing: .02em; color: var(--accent-ink); }\n.row { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; }\n.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }\n.row--tt { flex-wrap: nowrap; }\n.row__day { flex: none; width: 1.5em; font-family: var(--font-mono); font-weight: 700; }\n.row__subjects { flex: 1 1 auto; min-width: 0; }\n.row__time { flex: none; width: 7.5em; }\n.details { display: flex; flex-direction: column; gap: var(--space-5); }\n.details > summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: var(--space-2); }\n.details > summary::before { content: '+'; font-family: var(--font-mono); font-size: 16px; }\n.details[open] > summary::before { content: '−'; }\n\n/* こんしゅう */\n.week { display: flex; flex-direction: column; gap: var(--space-2); }\n.week__day { padding: var(--space-3) var(--space-4); border: var(--border) solid var(--line); border-radius: var(--radius-md); background: var(--surface); }\n.week__day.is-today { border-color: var(--accent); border-width: 3px; }\n.week__day.is-off { background: var(--surface-soft); }\n.week__date { margin: 0 0 var(--space-2); font-family: var(--font-mono); font-size: 13px; line-height: 18px; letter-spacing: .04em; color: var(--ink-soft); }\n.week__items { display: flex; flex-direction: column; gap: var(--space-2); }\n.week__item { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }\n.week__item.is-done .week__range { text-decoration: line-through; color: var(--muted); }\n.week__range { font-weight: 700; flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }\n.week__empty { margin: 0; font-family: var(--font-mono); font-size: 13px; color: var(--muted); }\n.week--big .week__date { font-size: 18px; line-height: 26px; }\n.week--big .week__range { font-size: 24px; line-height: 32px; font-family: var(--font-display); font-weight: 400; }\n.week--big .sk-tag, .week--big .sk-chip { font-size: 18px; min-height: 40px; }\nbody.is-board .app { max-width: 960px; padding-bottom: var(--space-6); }\nbody.is-board .brand__name { font-size: 40px; line-height: 48px; }\n.board__line { margin: 0; font-family: var(--font-display); font-size: 28px; line-height: 36px; }\n\n/* 5 秒の「もどす」 */\n.toast {\n  position: fixed; left: 50%; transform: translateX(-50%); z-index: 20;\n  bottom: calc(var(--tap-primary) + var(--space-7) + env(safe-area-inset-bottom));\n  display: flex; align-items: center; gap: var(--space-3);\n  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-4);\n  border-radius: var(--radius-pill); background: var(--ink); color: var(--ground);\n  font-weight: 700; white-space: nowrap; box-shadow: var(--shadow-float);\n}\n.toast .sk-btn--ghost { color: var(--accent); min-height: 40px; }\n[data-theme=\"dark\"] .toast { background: var(--surface-soft); color: var(--ink); border: var(--border) solid var(--ink); }\n[data-theme=\"dark\"] .toast .sk-btn--ghost { color: var(--accent-ink); }\n\n@media (prefers-reduced-motion: no-preference) {\n  .sheet { animation: rise .16s ease-out; }\n  @keyframes rise { from { transform: translateY(24px); opacity: .6; } to { transform: none; opacity: 1; } }\n}\n\n/* 履修科目 */\n.brand__next { margin: 2px 0 0; font-family: var(--font-mono); font-size: 12px; line-height: 16px; letter-spacing: .02em; color: var(--accent-ink); overflow-wrap: anywhere; }\n.week__classes { margin: -4px 0 var(--space-2); font-family: var(--font-mono); font-size: 12px; line-height: 18px; letter-spacing: .02em; color: var(--muted); overflow-wrap: anywhere; }\n.courses { display: flex; flex-direction: column; gap: var(--space-1); padding: var(--space-3) var(--space-4); border: var(--border) solid var(--line); border-radius: var(--radius-md); }\n.courses__day { margin: 0; font-size: 14px; line-height: 22px; overflow-wrap: anywhere; }\n.courses__dow { display: inline-block; width: 1.6em; font-family: var(--font-mono); font-weight: 700; }\n.courses__text { min-height: 120px; font-family: var(--font-mono); font-size: 13px; line-height: 18px; }\n.courses-block { display: flex; flex-direction: column; gap: var(--space-4); }\n.courses__leave { color: var(--ink-soft); font-weight: 700; }\n\n[hidden] { display: none !important; }\n"},"/app/sync.js":{"type":"text/javascript; charset=utf-8","etag":"\"106f409012e93c31\"","body":"// サーバー（worker/）との同期。端末が正、サーバーは Discord のための写し。失敗しても端末のデータは消さない。\nexport async function pullState(sync) {\n  if (!sync || !sync.url || !sync.token) return null;\n  const res = await fetch(`${sync.url.replace(/\\/$/, '')}/api/state`, { headers: { Authorization: `Bearer ${sync.token}` } });\n  if (!res.ok) throw new Error(`pull ${res.status}`);\n  return res.json();\n}\n\nexport async function pushState(sync, state) {\n  if (!sync || !sync.url || !sync.token) return null;\n  const { sync: _omit, ...settings } = state.settings;\n  const res = await fetch(`${sync.url.replace(/\\/$/, '')}/api/state`, {\n    method: 'PUT',\n    headers: { Authorization: `Bearer ${sync.token}`, 'Content-Type': 'application/json' },\n    body: JSON.stringify({ items: state.items, settings, capture: state.capture || {}, nudge: { snoozeUntil: (state.nudge || {}).snoozeUntil || null, snoozeCount: (state.nudge || {}).snoozeCount || {} } })\n  });\n  if (!res.ok) throw new Error(`push ${res.status}`);\n  return res.json();\n}\n\nexport async function testDm(sync) {\n  const res = await fetch(`${sync.url.replace(/\\/$/, '')}/api/test-dm`, { method: 'POST', headers: { Authorization: `Bearer ${sync.token}` } });\n  const body = await res.json().catch(() => ({}));\n  if (!res.ok) throw new Error(body.error || `test-dm ${res.status}`);\n  return body;\n}\n\n/** 宿題 1 件ずつ updatedAt の新しい方。消したものは deleted:true の墓標で残す。 */\nexport function mergeItems(a = [], b = []) {\n  const byId = new Map();\n  for (const list of [a, b]) for (const it of list) {\n    if (!it || typeof it.id !== 'string') continue;\n    const prev = byId.get(it.id);\n    if (!prev || String(it.updatedAt || '') >= String(prev.updatedAt || '')) byId.set(it.id, it);\n  }\n  return [...byId.values()].sort((x, y) => String(x.createdAt || '').localeCompare(String(y.createdAt || '')));\n}\n\n/** 「答えた」は負けない：どちらかが none / added なら残す。added は none より強い。 */\nfunction normCapture(v) {\n  if (v === 'none' || v === 'added') return { '*': v };\n  return v && typeof v === 'object' ? { ...v } : {};\n}\nexport function mergeCapture(a = {}, b = {}) {\n  const out = {};\n  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {\n    const merged = normCapture((a || {})[k]);\n    for (const [sub, v] of Object.entries(normCapture((b || {})[k]))) if (v === 'added' || (v === 'none' && merged[sub] !== 'added')) merged[sub] = v;\n    if (Object.keys(merged).length) out[k] = merged;\n  }\n  return out;\n}\n"},"/app/sw.js":{"type":"text/javascript; charset=utf-8","etag":"\"ccfb0b9b2dd7e603\"","body":"// オフラインでも開けるように、画面の材料だけキャッシュする。同期 API と外のフォントは触らない。\n// つながるときは毎回ネットから取る（直したものがすぐ届く）。つながらないときだけキャッシュ。\nconst VERSION = 'shukudai-v2';\nconst SHELL = ['./', './index.html', './app.js', './app.css', './sync.js', './ds/tokens.css', './ds/bundle.css', './ds/bundle.js', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png'];\n\nself.addEventListener('install', (e) => {\n  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));\n});\nself.addEventListener('activate', (e) => {\n  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));\n});\nself.addEventListener('fetch', (e) => {\n  const url = new URL(e.request.url);\n  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;\n  e.respondWith(\n    fetch(e.request).then((res) => {\n      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }\n      return res;\n    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || caches.match('./index.html')))\n  );\n});\n"},"/app/manifest.webmanifest":{"type":"application/manifest+json; charset=utf-8","etag":"\"73c69fcaa457ac63\"","body":"{\n  \"name\": \"宿題忘れゼロ\",\n  \"short_name\": \"宿題\",\n  \"description\": \"メモらなくても、忘れない。当日の朝でも、持っていける。\",\n  \"lang\": \"ja\",\n  \"start_url\": \"./\",\n  \"scope\": \"./\",\n  \"display\": \"standalone\",\n  \"orientation\": \"portrait\",\n  \"background_color\": \"#ffffff\",\n  \"theme_color\": \"#111111\",\n  \"shortcuts\": [\n    { \"name\": \"宿題を追加\", \"short_name\": \"追加\", \"url\": \"./?add=1\", \"icons\": [{ \"src\": \"icons/icon-192.png\", \"sizes\": \"192x192\" }] }\n  ],\n  \"icons\": [\n    { \"src\": \"icons/icon-192.png\", \"sizes\": \"192x192\", \"type\": \"image/png\", \"purpose\": \"any\" },\n    { \"src\": \"icons/icon-512.png\", \"sizes\": \"512x512\", \"type\": \"image/png\", \"purpose\": \"any\" },\n    { \"src\": \"icons/icon-512-maskable.png\", \"sizes\": \"512x512\", \"type\": \"image/png\", \"purpose\": \"maskable\" }\n  ]\n}\n"},"/app/ds/tokens.css":{"type":"text/css; charset=utf-8","etag":"\"f3536bb8b568fc3a\"","body":"/* 宿題忘れゼロ — generated from tokens.json */\n:root, [data-theme=\"light\"] {\n  --ground: #ffffff;\n  --surface: #ffffff;\n  --surface-soft: #f2f2f2;\n  --ink: #111111;\n  --ink-soft: #3d3d3d;\n  --muted: #5f5f5f;\n  --line: #dcdcdc;\n  --line-strong: #6e6e6e;\n  --accent: #ff8fc5;\n  --on-accent: #111111;\n  --accent-ink: #c81e6a;\n  --accent-soft: #ffe1ef;\n  --due-overdue: var(--ground);\n  --due-overdue-fill: var(--ink);\n  --due-today: var(--on-accent);\n  --due-today-fill: var(--accent);\n  --due-soon: var(--ink);\n  --due-soon-fill: var(--accent-soft);\n  --due-later: var(--muted);\n  --due-later-fill: var(--surface-soft);\n  --done: var(--muted);\n  --done-fill: var(--surface-soft);\n  --focus: var(--accent-ink);\n  --shadow-soft: 0 4px 12px #0000001f;\n  --shadow-lift: 0 10px 24px #00000024;\n  --shadow-float: 0 16px 40px #00000029;\n}\n[data-theme=\"dark\"] {\n  --ground: #0f0f0f;\n  --surface: #1b1b1b;\n  --surface-soft: #2a2a2a;\n  --ink: #f5f5f5;\n  --ink-soft: #d9d9d9;\n  --muted: #b0b0b0;\n  --line: #3b3b3b;\n  --line-strong: #8c8c8c;\n  --accent: #ff8fc5;\n  --on-accent: #111111;\n  --accent-ink: #ff8fc5;\n  --accent-soft: #4a2238;\n  --due-overdue: var(--ground);\n  --due-overdue-fill: var(--ink);\n  --due-today: var(--on-accent);\n  --due-today-fill: var(--accent);\n  --due-soon: var(--ink);\n  --due-soon-fill: var(--accent-soft);\n  --due-later: var(--muted);\n  --due-later-fill: var(--surface-soft);\n  --done: var(--muted);\n  --done-fill: var(--surface-soft);\n  --focus: var(--accent);\n  --shadow-soft: 0 4px 12px #00000066;\n  --shadow-lift: 0 10px 24px #00000080;\n  --shadow-float: 0 16px 40px #00000099;\n}\n:root {\n  --space-1: 4px;\n  --space-2: 8px;\n  --space-3: 12px;\n  --space-4: 16px;\n  --space-5: 24px;\n  --space-6: 32px;\n  --space-7: 48px;\n  --space-8: 64px;\n  --radius-sm: 12px;\n  --radius-md: 20px;\n  --radius-lg: 28px;\n  --radius-xl: 40px;\n  --radius-pill: 999px;\n  --tap-min: 48px;\n  --tap-primary: 64px;\n  --icon: 24px;\n  --icon-lg: 40px;\n  --border: 2px;\n  --content-max: 520px;\n  --font-display: \"Dela Gothic One\", \"Zen Kaku Gothic New\", \"Hiragino Kaku Gothic ProN\", sans-serif;\n  --font-sans: \"Zen Kaku Gothic New\", \"Hiragino Kaku Gothic ProN\", \"BIZ UDPGothic\", sans-serif;\n  --font-mono: \"DM Mono\", \"Zen Kaku Gothic New\", \"Hiragino Kaku Gothic ProN\", monospace;\n}\n.display { font-family: var(--font-display); font-size: 36px; line-height: 44px; font-weight: 400; letter-spacing: -0.01em; }\n.numeral { font-family: var(--font-display); font-size: 64px; line-height: 64px; font-weight: 400; letter-spacing: 0; }\n.title { font-family: var(--font-display); font-size: 24px; line-height: 32px; font-weight: 400; letter-spacing: 0; }\n.button { font-family: var(--font-display); font-size: 18px; line-height: 26px; font-weight: 400; letter-spacing: 0.02em; }\n.heading { font-family: var(--font-sans); font-size: 18px; line-height: 26px; font-weight: 700; }\n.body { font-family: var(--font-sans); font-size: 16px; line-height: 24px; font-weight: 500; }\n.body-strong { font-family: var(--font-sans); font-size: 16px; line-height: 24px; font-weight: 700; }\n.chip { font-family: var(--font-sans); font-size: 14px; line-height: 20px; font-weight: 700; letter-spacing: 0.02em; }\n.eyebrow { font-family: var(--font-mono); font-size: 12px; line-height: 16px; font-weight: 500; letter-spacing: 0.12em; }\n.caption { font-family: var(--font-mono); font-size: 13px; line-height: 18px; font-weight: 500; letter-spacing: 0.02em; }\n"},"/app/ds/bundle.css":{"type":"text/css; charset=utf-8","etag":"\"1808f490b847c36e\"","body":"/* 宿題忘れゼロ — 部品のスタイル。白地に黒の枠、差し色はピンク。見出しは display（極太）、数字と日付は mono。値はすべて tokens.css の変数から。 */\n.sk-icon { flex: none; display: inline-block; vertical-align: middle; }\n\n/* ---- DueChip ---- */\n.sk-chip {\n  display: inline-flex; align-items: center; gap: var(--space-1);\n  min-height: 32px; padding: var(--space-1) var(--space-3);\n  border-radius: var(--radius-pill);\n  font-family: var(--font-sans); font-size: 14px; line-height: 20px; font-weight: 700; letter-spacing: .02em;\n  white-space: nowrap;\n}\n.sk-chip--lg { min-height: var(--tap-min); padding: var(--space-2) var(--space-4); font-size: 18px; line-height: 26px; gap: var(--space-2); }\n.sk-chip__date { font-family: var(--font-mono); font-weight: 500; font-size: .9em; letter-spacing: .02em; opacity: .85; margin-left: var(--space-1); }\n.sk-chip--overdue { color: var(--due-overdue); background: var(--due-overdue-fill); }\n.sk-chip--today   { color: var(--due-today);   background: var(--due-today-fill); }\n.sk-chip--soon    { color: var(--due-soon);    background: var(--due-soon-fill); }\n.sk-chip--later   { color: var(--due-later);   background: var(--due-later-fill); }\n.sk-chip--done    { color: var(--done);        background: var(--done-fill); }\n.sk-chip--handin  { color: var(--due-today);   background: var(--due-today-fill); }\n.sk-chip--submitted, .sk-chip--dropped { color: var(--done); background: var(--done-fill); }\n\n/* ---- SubjectTag ---- */\n.sk-tag {\n  display: inline-flex; align-items: center;\n  min-height: 32px; padding: 2px var(--space-3);\n  border: var(--border) solid var(--ink); border-radius: var(--radius-pill);\n  color: var(--ink); background: var(--surface);\n  font-family: var(--font-sans); font-size: 14px; line-height: 20px; font-weight: 700; letter-spacing: .02em;\n  white-space: nowrap;\n}\n.sk-tag--lg { min-height: 40px; padding: var(--space-1) var(--space-4); font-size: 16px; line-height: 24px; }\n\n/* ---- BigButton ---- */\n.sk-btn {\n  display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2);\n  min-height: var(--tap-min); padding: 0 var(--space-5);\n  border: var(--border) solid transparent; border-radius: var(--radius-pill); cursor: pointer;\n  font-family: var(--font-sans); font-size: 16px; line-height: 24px; font-weight: 700;\n  transition: transform .16s ease-out, box-shadow .16s ease-out;\n}\n.sk-btn:active { transform: scale(.98); }\n.sk-btn:focus-visible { outline: 3px solid var(--focus); outline-offset: 4px; }\n.sk-btn--full { width: 100%; }\n.sk-btn--primary { min-height: var(--tap-primary); font-family: var(--font-display); font-weight: 400; font-size: 18px; line-height: 26px; letter-spacing: .02em; text-transform: uppercase; color: var(--on-accent); background: var(--accent); border-color: var(--ink); box-shadow: var(--shadow-float); }\n.sk-btn--primary:active { box-shadow: var(--shadow-lift); }\n.sk-btn--secondary { color: var(--ink); background: var(--surface); border-color: var(--ink); }\n.sk-btn--ghost { color: var(--ink-soft); background: transparent; }\n.sk-btn:disabled { opacity: .5; cursor: default; transform: none; }\n.sk-iconbtn {\n  display: inline-flex; align-items: center; justify-content: center;\n  width: var(--tap-min); height: var(--tap-min); border: var(--border) solid var(--ink); border-radius: var(--radius-pill);\n  color: var(--ink); background: var(--surface); cursor: pointer;\n}\n.sk-iconbtn:focus-visible { outline: 3px solid var(--focus); outline-offset: 4px; }\n\n/* ---- HomeworkCard ---- */\n.sk-card {\n  display: flex; gap: var(--space-4); align-items: flex-start;\n  padding: var(--space-4);\n  border: var(--border) solid var(--ink); border-radius: var(--radius-lg);\n  background: var(--surface); color: var(--ink);\n  font-family: var(--font-sans);\n  transition: box-shadow .16s ease-out;\n}\n.sk-card:focus-within { box-shadow: var(--shadow-soft); }\n.sk-card.is-done { background: var(--done-fill); border-color: transparent; }\n.sk-card__check {\n  flex: none; width: 56px; height: 56px; border-radius: var(--radius-pill);\n  border: var(--border) solid var(--ink); background: var(--surface); color: transparent; cursor: pointer;\n  display: inline-flex; align-items: center; justify-content: center;\n  transition: transform .22s ease-out, background .16s ease-out;\n}\n.sk-card__check:focus-visible { outline: 3px solid var(--focus); outline-offset: 4px; }\n.sk-card__check[aria-pressed=\"true\"] { background: var(--accent); border-color: var(--ink); color: var(--on-accent); }\n.sk-card__check.is-pop { animation: sk-pop .22s ease-out; }\n@keyframes sk-pop { 0% { transform: scale(1); } 50% { transform: scale(1.14); } 100% { transform: scale(1); } }\n.sk-card__body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: var(--space-2); text-align: left; }\nbutton.sk-card__body { border: 0; background: transparent; padding: 0; font: inherit; color: inherit; cursor: pointer; border-radius: var(--radius-sm); }\nbutton.sk-card__body:focus-visible { outline: 3px solid var(--focus); outline-offset: 4px; }\n.sk-card__meta { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; }\n.sk-card__range { margin: 0; font-size: 18px; line-height: 26px; font-weight: 700; overflow-wrap: anywhere; }\n.sk-card__where { margin: 0; display: flex; gap: var(--space-1); align-items: flex-start; font-size: 16px; line-height: 24px; font-weight: 500; color: var(--ink-soft); }\n.sk-card__where .sk-icon { margin-top: 2px; }\n.sk-card__where.is-missing { color: var(--muted); }\n.sk-card__submit { margin: 0; font-family: var(--font-mono); font-size: 13px; line-height: 18px; letter-spacing: .02em; color: var(--muted); }\n.sk-card.is-done .sk-card__range { text-decoration: line-through; color: var(--done); }\n.sk-card.is-done .sk-card__where { color: var(--muted); }\n.sk-card.is-done .sk-tag { border-color: var(--muted); color: var(--muted); background: transparent; }\n.sk-card__range.is-missing { color: var(--muted); font-weight: 500; }\n.sk-card__actions { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-1); }\n.sk-card.is-closed { opacity: .7; }\n\n/* ---- TodayHero ---- */\n.sk-hero {\n  display: flex; flex-direction: column; gap: var(--space-4); align-items: flex-start;\n  padding: var(--space-6) var(--space-5);\n  border: var(--border) solid var(--ink); border-radius: var(--radius-lg);\n  background: var(--surface); color: var(--ink);\n  font-family: var(--font-sans);\n}\n.sk-hero__eyebrow { margin: 0; font-family: var(--font-mono); font-size: 12px; line-height: 16px; font-weight: 500; letter-spacing: .12em; text-transform: uppercase; color: var(--accent-ink); }\n.sk-hero__range { margin: 0; font-family: var(--font-display); font-size: 36px; line-height: 44px; font-weight: 400; letter-spacing: -.01em; text-transform: uppercase; overflow-wrap: anywhere; }\n.sk-hero__range.is-missing { color: var(--muted); }\n.sk-hero.is-done .sk-hero__range { text-decoration: line-through; color: var(--done); }\n.sk-hero.is-done { background: var(--done-fill); border-color: transparent; }\n.sk-hero__meta { display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: center; }\n.sk-hero__where { display: inline-flex; gap: var(--space-1); align-items: center; font-size: 16px; line-height: 24px; font-weight: 500; color: var(--ink-soft); }\n.sk-hero__where.is-missing { color: var(--muted); }\n.sk-hero .sk-btn--full { margin-top: var(--space-2); }\n.sk-hero__rest { margin: 0; font-family: var(--font-mono); font-size: 13px; line-height: 18px; letter-spacing: .02em; color: var(--muted); }\n\n/* ---- QuickAdd ---- */\n.sk-quick {\n  display: flex; flex-direction: column; gap: var(--space-5);\n  padding: var(--space-5) var(--space-4) var(--space-6);\n  border: var(--border) solid var(--ink); border-bottom: 0;\n  border-radius: var(--radius-xl) var(--radius-xl) 0 0;\n  background: var(--surface); color: var(--ink); box-shadow: var(--shadow-float);\n  font-family: var(--font-sans);\n}\n.sk-quick__head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }\n.sk-quick__title { margin: 0; font-family: var(--font-display); font-size: 24px; line-height: 32px; font-weight: 400; }\n.sk-field { display: flex; flex-direction: column; gap: var(--space-2); }\n.sk-field__label { margin: 0; display: flex; gap: var(--space-1); align-items: center; font-family: var(--font-mono); font-size: 13px; line-height: 18px; font-weight: 500; letter-spacing: .12em; text-transform: uppercase; color: var(--ink-soft); }\n.sk-choices { display: flex; flex-wrap: wrap; gap: var(--space-2); }\n.sk-choice {\n  display: inline-flex; align-items: center; gap: var(--space-1);\n  min-height: var(--tap-min); padding: 0 var(--space-4);\n  border: var(--border) solid var(--ink); border-radius: var(--radius-pill);\n  background: var(--surface); color: var(--ink); cursor: pointer;\n  font-family: var(--font-sans); font-size: 16px; line-height: 24px; font-weight: 700;\n  transition: background .16s ease-out;\n}\n.sk-choice.is-on { background: var(--accent); color: var(--on-accent); }\n.sk-choice:focus-visible { outline: 3px solid var(--focus); outline-offset: 4px; }\n.sk-input {\n  width: 100%; box-sizing: border-box; min-height: 56px; padding: var(--space-3) var(--space-4);\n  border: var(--border) solid var(--line-strong); border-radius: var(--radius-sm);\n  background: var(--surface-soft); color: var(--ink);\n  font-family: var(--font-sans); font-size: 16px; line-height: 24px; font-weight: 500;\n}\n.sk-input::placeholder { color: var(--muted); }\n.sk-input:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; border-color: var(--ink); }\n.sk-input.is-error { border-color: var(--accent-ink); }\n.sk-input--sub { min-height: var(--tap-min); }\n.sk-hint { margin: 0; font-family: var(--font-mono); font-size: 13px; line-height: 18px; font-weight: 500; letter-spacing: .02em; color: var(--accent-ink); }\n.sk-hint:empty { display: none; }\n.sk-hint--calm { color: var(--ink-soft); font-weight: 500; }\n.sk-field__sub { margin: var(--space-1) 0 0; font-family: var(--font-mono); font-size: 12px; line-height: 16px; letter-spacing: .08em; color: var(--muted); }\n.sk-quick__actions { display: flex; flex-direction: column; gap: var(--space-2); }\n\n/* ---- BringCheck ---- */\n.sk-bring {\n  display: flex; flex-direction: column; gap: var(--space-4);\n  padding: var(--space-5) var(--space-4);\n  border: var(--border) solid var(--ink); border-radius: var(--radius-lg);\n  background: var(--surface); color: var(--ink);\n  font-family: var(--font-sans);\n}\n.sk-bring__head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); }\n.sk-bring__title { margin: 0; font-family: var(--font-display); font-size: 24px; line-height: 32px; font-weight: 400; }\n.sk-bring__date { margin: 0; font-family: var(--font-mono); font-size: 13px; line-height: 18px; letter-spacing: .02em; color: var(--muted); }\n.sk-bring__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-3); }\n.sk-bring__row { display: flex; gap: var(--space-3); align-items: flex-start; padding: var(--space-3); border-radius: var(--radius-md); background: var(--surface-soft); }\n.sk-bring__row.is-packed { background: var(--accent-soft); }\n.sk-bring__box {\n  flex: none; width: 56px; height: 56px; border-radius: var(--radius-sm);\n  border: var(--border) solid var(--ink); background: var(--surface); color: var(--ink); cursor: pointer;\n  display: inline-flex; align-items: center; justify-content: center;\n}\n.sk-bring__box:focus-visible { outline: 3px solid var(--focus); outline-offset: 4px; }\n.sk-bring__box[aria-pressed=\"true\"] { background: var(--ink); color: var(--ground); }\n.sk-bring__text { display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; }\n.sk-bring__meta { display: flex; flex-wrap: wrap; gap: var(--space-2); }\n.sk-bring__range { margin: 0; font-size: 18px; line-height: 26px; font-weight: 700; overflow-wrap: anywhere; }\n.sk-bring__status { margin: 0; font-family: var(--font-mono); font-size: 13px; line-height: 18px; font-weight: 500; letter-spacing: .02em; color: var(--ink-soft); }\n.sk-bring__status.is-pending { color: var(--accent-ink); }\n.sk-bring__count { margin: 0; font-family: var(--font-mono); font-size: 14px; line-height: 20px; font-weight: 500; letter-spacing: .04em; color: var(--ink-soft); }\n.sk-bring__empty { margin: 0; font-size: 16px; line-height: 24px; color: var(--muted); }\n\n/* ---- AllDone ---- */\n.sk-alldone {\n  display: flex; flex-direction: column; align-items: center; text-align: center; gap: var(--space-3);\n  padding: var(--space-7) var(--space-5);\n  border: var(--border) solid var(--ink); border-radius: var(--radius-lg);\n  background: var(--surface); color: var(--ink);\n  font-family: var(--font-sans);\n}\n.sk-alldone__blob--pale { fill: var(--accent-soft); }\n.sk-alldone__blob--grey { fill: var(--surface-soft); }\n.sk-alldone__blob--pink { fill: var(--accent); }\n.sk-alldone__check { stroke: var(--ink); }\n.sk-alldone__title { margin: 0; font-family: var(--font-display); font-size: 24px; line-height: 32px; font-weight: 400; }\n.sk-alldone__body { margin: 0 0 var(--space-2); font-size: 16px; line-height: 24px; color: var(--ink-soft); max-width: 32em; }\n\n/* ---- NudgeBar（焦らせるバー）---- 焦らせていい面はここと Discord だけ */\n.sk-nudge {\n  display: flex; flex-direction: column; gap: var(--space-2); align-items: flex-start;\n  padding: var(--space-4) var(--space-5) var(--space-5);\n  border: var(--border) solid var(--ink); border-radius: var(--radius-lg);\n  background: var(--surface); color: var(--ink);\n  font-family: var(--font-sans);\n}\n.sk-nudge__eyebrow { margin: 0; font-family: var(--font-mono); font-size: 12px; line-height: 16px; font-weight: 500; letter-spacing: .12em; text-transform: uppercase; color: var(--ink-soft); }\n.sk-nudge__count { margin: 0; font-family: var(--font-display); font-size: 64px; line-height: 64px; font-weight: 400; font-variant-numeric: tabular-nums; white-space: nowrap; }\n/* 長い数字（あと30分・15分すぎた）は小さく組んで、スマホ幅に収める */\n.sk-nudge__count--mid { font-size: 52px; line-height: 56px; }\n.sk-nudge__count--long { font-size: 44px; line-height: 48px; }\n.sk-nudge__item { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; margin-top: var(--space-2); }\n.sk-nudge__range { font-size: 18px; line-height: 26px; font-weight: 700; overflow-wrap: anywhere; }\n.sk-nudge__state { font-family: var(--font-mono); font-size: 13px; line-height: 18px; letter-spacing: .04em; padding: 2px var(--space-2); border: var(--border) solid currentColor; border-radius: var(--radius-pill); }\n.sk-nudge__line { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; }\n.sk-nudge__actions { width: 100%; display: flex; flex-direction: column; gap: var(--space-2); margin-top: var(--space-2); }\n.sk-nudge--soon { background: var(--accent-soft); }\n.sk-nudge--urgent { background: var(--accent); color: var(--on-accent); }\n.sk-nudge--urgent .sk-nudge__eyebrow { color: var(--on-accent); }\n.sk-nudge--urgent .sk-tag { background: var(--on-accent); color: var(--accent); border-color: var(--on-accent); }\n.sk-nudge--urgent .sk-btn--primary { background: var(--ink); color: var(--ground); border-color: var(--ink); box-shadow: none; }\n.sk-nudge--late { background: var(--ink); color: var(--ground); border-color: var(--ink); }\n.sk-nudge--late .sk-nudge__eyebrow { color: var(--ground); opacity: .8; }\n.sk-nudge--late .sk-tag { background: var(--ground); color: var(--ink); border-color: var(--ground); }\n.sk-nudge--late .sk-btn--primary { border-color: var(--ground); }\n.sk-nudge--clear { flex-direction: row; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); background: var(--accent-soft); border-color: transparent; }\n.sk-nudge__clear { margin: 0; font-size: 16px; line-height: 24px; font-weight: 700; }\n.sk-nudge--snoozed { flex-direction: row; align-items: center; flex-wrap: wrap; gap: var(--space-3); padding: var(--space-3) var(--space-4); background: var(--surface-soft); border-color: transparent; }\n.sk-nudge--snoozed .sk-btn--ghost { margin-left: auto; }\n\n/* ---- CaptureAsk（放課後の「きょう、宿題出た？」）---- 聞く側から行く。答えるまで居座る */\n.sk-capture {\n  display: flex; flex-direction: column; gap: var(--space-3); align-items: flex-start;\n  padding: var(--space-4) var(--space-5) var(--space-5);\n  border: var(--border) solid var(--ink); border-radius: var(--radius-lg);\n  background: var(--accent-soft); color: var(--ink);\n  font-family: var(--font-sans);\n}\n.sk-capture--again { background: var(--accent); }\n.sk-capture__eyebrow { margin: 0; font-family: var(--font-mono); font-size: 12px; line-height: 16px; font-weight: 500; letter-spacing: .12em; text-transform: uppercase; color: var(--ink-soft); }\n.sk-capture--again .sk-capture__eyebrow { color: var(--on-accent); }\n.sk-capture__title { margin: 0; font-family: var(--font-display); font-size: 24px; line-height: 32px; font-weight: 400; }\n.sk-capture__line { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; }\n.sk-capture .sk-choice { background: var(--surface); }\n.sk-capture .sk-btn--secondary { margin-top: var(--space-2); }\n.sk-capture--done { flex-direction: row; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); background: var(--surface-soft); border-color: transparent; }\n.sk-capture__done { margin: 0; font-size: 16px; line-height: 24px; font-weight: 700; }\n.sk-capture__doneRow { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-3); width: 100%; }\n.sk-capture__doneRow .sk-choice { margin-left: auto; min-height: 40px; }\n.sk-capture__rows { display: flex; flex-direction: column; gap: var(--space-2); width: 100%; }\n.sk-capture__row { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }\n.sk-capture__name { flex: 1 1 auto; min-width: 4em; font-size: 18px; line-height: 26px; font-weight: 700; }\n.sk-capture__row .sk-choice { min-height: var(--tap-min); padding: 0 var(--space-4); }\n.sk-capture .sk-choice--yes { background: var(--accent); border-color: var(--ink); color: var(--on-accent); }\n.sk-capture--again .sk-choice--yes { background: var(--ink); color: var(--ground); }\n.sk-capture__sub { margin: 0; font-family: var(--font-mono); font-size: 12px; line-height: 16px; letter-spacing: .06em; color: var(--ink-soft); }\n.sk-capture__handin { display: flex; flex-direction: column; gap: var(--space-2); width: 100%; padding-top: var(--space-2); border-top: var(--border) dashed var(--line-strong); }\n.sk-capture--done .sk-capture__handin { border-top-color: var(--line); }\n\n/* ---- DiscordPreview（Discord ではこう見える）---- Discord 側の見た目をまねた見本。トークンはこのシステムのもの */\n.sk-dc {\n  display: flex; gap: var(--space-3); align-items: flex-start;\n  padding: var(--space-3) var(--space-4);\n  border-radius: var(--radius-sm);\n  background: var(--ink); color: var(--ground);\n  font-family: var(--font-sans); font-size: 15px; line-height: 22px;\n}\n.sk-dc__avatar { flex: none; width: 40px; height: 40px; border-radius: var(--radius-pill); background: var(--accent); color: var(--on-accent); display: inline-flex; align-items: center; justify-content: center; font-family: var(--font-display); font-size: 18px; }\n.sk-dc__body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: var(--space-1); }\n.sk-dc__head { display: flex; align-items: center; gap: var(--space-2); }\n.sk-dc__name { font-weight: 700; }\n.sk-dc__bot { font-family: var(--font-mono); font-size: 10px; line-height: 14px; letter-spacing: .08em; padding: 0 5px; border-radius: 4px; background: var(--accent); color: var(--on-accent); }\n.sk-dc__time { font-family: var(--font-mono); font-size: 12px; line-height: 16px; opacity: .6; }\n.sk-dc__content { margin: 0; }\n.sk-dc__mention { background: var(--accent-soft); color: var(--ink); border-radius: 4px; padding: 0 3px; font-weight: 700; }\n.sk-dc__embed { border-left: 4px solid var(--accent); border-radius: 4px; padding: var(--space-2) var(--space-3); background: #ffffff14; display: flex; flex-direction: column; gap: var(--space-1); max-width: 520px; }\n:root[data-theme=\"dark\"] .sk-dc__embed, [data-theme=\"dark\"] .sk-dc__embed { background: #00000029; }\n.sk-dc__title { margin: 0; font-weight: 700; }\n.sk-dc__desc { margin: 0; font-size: 14px; line-height: 22px; opacity: .92; overflow-wrap: anywhere; }\n.sk-dc__footer { margin: var(--space-1) 0 0; font-family: var(--font-mono); font-size: 11px; line-height: 16px; letter-spacing: .02em; opacity: .6; }\n.sk-dc__buttons { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-1); }\n.sk-dc__btn { display: inline-flex; align-items: center; min-height: 32px; padding: 0 var(--space-3); border-radius: 4px; font-size: 14px; line-height: 20px; font-weight: 700; }\n.sk-dc__btn--success { background: #248046; color: #ffffff; }\n.sk-dc__btn--secondary { background: #ffffff1f; color: var(--ground); }\n.sk-dc__btn--primary { background: #5865f2; color: #ffffff; }\n.sk-dc__btn--link { background: #ffffff1f; color: var(--ground); text-decoration: underline; }\n:root[data-theme=\"dark\"] .sk-dc__btn--secondary, :root[data-theme=\"dark\"] .sk-dc__btn--link, [data-theme=\"dark\"] .sk-dc__btn--secondary, [data-theme=\"dark\"] .sk-dc__btn--link { background: #00000033; }\n\n@media (prefers-reduced-motion: reduce) {\n  .sk-btn, .sk-card, .sk-card__check, .sk-choice, .sk-nudge { transition: none; }\n  .sk-card__check.is-pop { animation: none; }\n  .sk-btn:active { transform: none; }\n}\n\n/* ---- QuickAdd：ほかの授業 ---- */\n.sk-more { align-self: flex-start; min-height: 40px; padding: 0 var(--space-3); border: var(--border) dashed var(--line-strong); border-radius: var(--radius-pill); background: transparent; color: var(--ink-soft); font-family: var(--font-sans); font-size: 14px; line-height: 20px; font-weight: 700; cursor: pointer; }\n.sk-more:focus-visible { outline: 3px solid var(--focus); outline-offset: 4px; }\n/* hidden 属性は、display を指定した部品にも必ず効かせる（「ほかの授業」を畳む、日付入力を隠す） */\n.sk-choice[hidden], .sk-input[hidden], .sk-btn[hidden] { display: none; }\n"},"/app/ds/bundle.js":{"type":"text/javascript; charset=utf-8","etag":"\"04d2c5fb11137264\"","body":"/* @ds-bundle: {\"format\":4,\"namespace\":\"Shukudai\",\"components\":[{\"name\":\"DueChip\"},{\"name\":\"SubjectTag\"},{\"name\":\"BigButton\"},{\"name\":\"HomeworkCard\"},{\"name\":\"TodayHero\"},{\"name\":\"QuickAdd\"},{\"name\":\"BringCheck\"},{\"name\":\"AllDone\"},{\"name\":\"NudgeBar\"},{\"name\":\"DiscordPreview\"},{\"name\":\"CaptureAsk\"}]} */\n/* 宿題忘れゼロ — 依存なしの素の JavaScript。各関数は HTMLElement を返す。\n   Shukudai.HomeworkCard({ item, today, onDone }) のように呼び、返った要素を appendChild する。 */\n(function () {\n  'use strict';\n\n  var SVG_NS = 'http://www.w3.org/2000/svg';\n  var DAY_MS = 86400000;\n  var WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];\n\n  // ---- 小さな DOM ヘルパー（innerHTML は使わない） ----\n  function el(tag, attrs) {\n    var node = document.createElement(tag);\n    attrs = attrs || {};\n    Object.keys(attrs).forEach(function (k) {\n      var v = attrs[k];\n      if (v === null || v === undefined || v === false) return;\n      if (k === 'className') node.className = v;\n      else if (k === 'text') node.textContent = v;\n      else if (k === 'onClick') node.addEventListener('click', v);\n      else if (k === 'onInput') node.addEventListener('input', v);\n      else if (k === 'onSubmit') node.addEventListener('submit', v);\n      else if (k === 'style') node.setAttribute('style', v);\n      else node.setAttribute(k, v === true ? '' : String(v));\n    });\n    for (var i = 2; i < arguments.length; i++) {\n      var c = arguments[i];\n      if (c === null || c === undefined || c === false) continue;\n      if (Array.isArray(c)) c.forEach(function (x) { if (x) node.appendChild(typeof x === 'string' ? document.createTextNode(x) : x); });\n      else node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);\n    }\n    return node;\n  }\n\n  // ---- インラインの線画アイコン（currentColor、丸い端） ----\n  var ICON_PATHS = {\n    check: 'M6 12.5 L10 16.5 L18 7.5',\n    plus: 'M12 5 V19 M5 12 H19',\n    clock: 'M12 7 V12 L15.5 14.5 M12 21 A9 9 0 1 0 12 3 A9 9 0 0 0 12 21 Z',\n    pin: 'M12 21 C12 21 5 14 5 9.5 A7 7 0 0 1 19 9.5 C19 14 12 21 12 21 Z M12 12 A2.5 2.5 0 1 0 12 7 A2.5 2.5 0 0 0 12 12 Z',\n    bag: 'M5 9 H19 A1.5 1.5 0 0 1 20.5 10.5 V19 A1.5 1.5 0 0 1 19 20.5 H5 A1.5 1.5 0 0 1 3.5 19 V10.5 A1.5 1.5 0 0 1 5 9 Z M8.5 9 V7 A3.5 3.5 0 0 1 15.5 7 V9 M3.5 13.5 H20.5',\n    book: 'M4 5 H10 A2 2 0 0 1 12 7 A2 2 0 0 1 14 5 H20 V18 H14 A2 2 0 0 0 12 20 A2 2 0 0 0 10 18 H4 Z M12 7 V20',\n    undo: 'M9 14 L4 9 L9 4 M4 9 H15 A5 5 0 0 1 15 19 H12',\n    close: 'M6 6 L18 18 M18 6 L6 18'\n  };\n  function icon(name, size) {\n    var svg = document.createElementNS(SVG_NS, 'svg');\n    svg.setAttribute('viewBox', '0 0 24 24');\n    svg.setAttribute('width', String(size || 24));\n    svg.setAttribute('height', String(size || 24));\n    svg.setAttribute('aria-hidden', 'true');\n    svg.setAttribute('focusable', 'false');\n    svg.setAttribute('class', 'sk-icon');\n    var p = document.createElementNS(SVG_NS, 'path');\n    p.setAttribute('d', ICON_PATHS[name] || ICON_PATHS.book);\n    p.setAttribute('fill', 'none');\n    p.setAttribute('stroke', 'currentColor');\n    p.setAttribute('stroke-width', '2.5');\n    p.setAttribute('stroke-linecap', 'round');\n    p.setAttribute('stroke-linejoin', 'round');\n    svg.appendChild(p);\n    return svg;\n  }\n\n  // ---- 科目 ----\n  var SUBJECTS = [\n    { key: 'kokugo', label: '国語' },\n    { key: 'sugaku', label: '数学' },\n    { key: 'eigo', label: '英語' },\n    { key: 'rika', label: '理科' },\n    { key: 'shakai', label: '社会' },\n    { key: 'other', label: 'その他' }\n  ];\n  function subjectKey(label) {\n    for (var i = 0; i < SUBJECTS.length; i++) if (SUBJECTS[i].label === label || SUBJECTS[i].key === label) return SUBJECTS[i].key;\n    if (/算数/.test(label)) return 'sugaku';\n    return 'other';\n  }\n\n  // ---- 日付 ----\n  function parseDate(v) {\n    if (v instanceof Date) return new Date(v.getFullYear(), v.getMonth(), v.getDate());\n    if (typeof v === 'string') {\n      var m = /^(\\d{4})-(\\d{1,2})-(\\d{1,2})/.exec(v);\n      if (m) return new Date(+m[1], +m[2] - 1, +m[3]);\n      var d = new Date(v);\n      if (!isNaN(d)) return new Date(d.getFullYear(), d.getMonth(), d.getDate());\n    }\n    var now = new Date();\n    return new Date(now.getFullYear(), now.getMonth(), now.getDate());\n  }\n  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }\n  function toISO(d) {\n    var mm = String(d.getMonth() + 1), dd = String(d.getDate());\n    return d.getFullYear() + '-' + (mm.length < 2 ? '0' + mm : mm) + '-' + (dd.length < 2 ? '0' + dd : dd);\n  }\n  function formatDate(v) {\n    var d = parseDate(v);\n    return (d.getMonth() + 1) + '/' + d.getDate() + '（' + WEEKDAYS[d.getDay()] + '）';\n  }\n  function formatDateSpoken(v) {\n    var d = parseDate(v);\n    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + WEEKDAYS[d.getDay()] + '曜日';\n  }\n\n  /** 日付キー（YYYY-MM-DD）。createdOn / packedOn の比較に使う。 */\n  function dayKey(v) { return toISO(parseDate(v || new Date())); }\n  /** その日に「かばんに入れた」か。packedOn（その日の日付キー）で見る。古い記録（packedOn なし）は当日扱い。 */\n  function isPackedToday(item, today) {\n    if (!item || !item.packed) return false;\n    if (!item.packedOn) return true;\n    return item.packedOn === dayKey(today);\n  }\n  /** 出した／先生に言った／消した、はもう追わない。 */\n  function isActive(item) { return !!item && !item.deleted && !item.submitted && !item.dropped; }\n  /** 紙を持っていく宿題ではなく、ネットで出すもの。朝のかばん確認から外す。 */\n  function isOnline(item) {\n    if (!item) return false;\n    if (item.location === 'online') return true;\n    return /classroom|クラスルーム|タブレット|オンライン|google|ロイロ|teams|forms|提出フォーム|ネット|lms|moodle|manaba|webclass|メール/i.test(item.where || '');\n  }\n\n  /** 期限の状態。色・言葉・アイコンの 3 点セットの元。flags: { packed, submitted, dropped } */\n  function dueInfo(due, today, done, flags) {\n    flags = flags || {};\n    var t = parseDate(today || new Date());\n    var d = parseDate(due);\n    var days = Math.round((d - t) / DAY_MS);\n    if (flags.submitted) return { state: 'submitted', label: '出した', days: days, icon: 'check', date: formatDate(d), spoken: '出した' };\n    if (flags.dropped) return { state: 'dropped', label: '先生に言った', days: days, icon: 'check', date: formatDate(d), spoken: '先生に言った' };\n    if (days < 0 && (flags.packed || done)) return { state: 'handin', label: '出した？', days: days, icon: 'bag', date: formatDate(d), spoken: '期限 ' + formatDateSpoken(d) + '、出した？' };\n    if (done) return { state: 'done', label: 'できた', days: days, icon: 'check', date: formatDate(d), spoken: 'できた' };\n    var label, state;\n    if (days < 0) { state = 'overdue'; label = (-days) + '日すぎた'; }\n    else if (days === 0) { state = 'today'; label = 'きょう'; }\n    else if (days === 1) { state = 'soon'; label = 'あした'; }\n    else if (days === 2) { state = 'soon'; label = 'あさって'; }\n    else { state = 'later'; label = 'あと' + days + '日'; }\n    return { state: state, label: label, days: days, icon: 'clock', date: formatDate(d), spoken: '期限 ' + formatDateSpoken(d) + '、' + label };\n  }\n\n  // ---- 部品 ----\n\n  /** 期限チップ。props: { due, today?, done?, size?: 'md'|'lg', showDate? } */\n  function DueChip(props) {\n    props = props || {};\n    var info = dueInfo(props.due, props.today, props.done, props.flags);\n    var chip = el('span', {\n      className: 'sk-chip sk-chip--' + info.state + (props.size === 'lg' ? ' sk-chip--lg' : ''),\n      role: 'img',\n      'aria-label': info.spoken\n    }, icon(info.icon, props.size === 'lg' ? 28 : 20), el('span', { className: 'sk-chip__text', text: info.label }));\n    if (props.showDate && info.state !== 'done') chip.appendChild(el('span', { className: 'sk-chip__date', text: info.date }));\n    return chip;\n  }\n\n  /** 科目タグ。props: { subject, size?: 'md'|'lg' } */\n  function SubjectTag(props) {\n    props = props || {};\n    var label = props.subject || 'その他';\n    return el('span', { className: 'sk-tag sk-tag--' + subjectKey(label) + (props.size === 'lg' ? ' sk-tag--lg' : ''), text: label });\n  }\n\n  /** 大きなボタン。props: { label, kind?: 'primary'|'secondary'|'ghost', icon?, full?, type?, disabled?, onClick } */\n  function BigButton(props) {\n    props = props || {};\n    var kind = props.kind || 'primary';\n    return el('button', {\n      className: 'sk-btn sk-btn--' + kind + (props.full ? ' sk-btn--full' : ''),\n      type: props.type || 'button',\n      disabled: !!props.disabled,\n      onClick: props.onClick\n    }, props.icon ? icon(props.icon, 24) : null, el('span', { className: 'sk-btn__label', text: props.label || '' }));\n  }\n\n  /** 宿題カード。props: { item, today?, onDone(item, done), onOpen?(item), onSubmit?(item), onDrop?(item) } */\n  function HomeworkCard(props) {\n    props = props || {};\n    var item = props.item || {};\n    var flags = { packed: item.packed, submitted: item.submitted, dropped: item.dropped };\n    var info = dueInfo(item.due, props.today, item.done, flags);\n    var card = el('article', { className: 'sk-card sk-card--' + info.state + (item.done ? ' is-done' : '') + (info.state === 'submitted' || info.state === 'dropped' ? ' is-closed' : '') });\n\n    var check = el('button', {\n      className: 'sk-card__check',\n      type: 'button',\n      'aria-pressed': item.done ? 'true' : 'false',\n      'aria-label': item.done ? 'もどす（まだにする）' : 'できた にする'\n    }, icon('check', 28));\n    check.addEventListener('click', function () {\n      var next = !item.done;\n      item.done = next;\n      card.className = 'sk-card sk-card--' + dueInfo(item.due, props.today, next, flags).state + (next ? ' is-done' : '');\n      check.setAttribute('aria-pressed', next ? 'true' : 'false');\n      check.setAttribute('aria-label', next ? 'もどす（まだにする）' : 'できた にする');\n      if (!window.matchMedia || !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {\n        check.classList.remove('is-pop'); void check.offsetWidth; check.classList.add('is-pop');\n      }\n      var old = card.querySelector('.sk-chip');\n      if (old) old.replaceWith(DueChip({ due: item.due, today: props.today, done: next, flags: flags }));\n      if (props.onDone) props.onDone(item, next);\n    });\n\n    var where = item.where\n      ? el('p', { className: 'sk-card__where' }, icon('pin', 20), el('span', { text: item.where }))\n      : el('p', { className: 'sk-card__where is-missing' }, icon('pin', 20), el('span', { text: 'どこにある？まだ書いてない' }));\n\n    var body = el(props.onOpen ? 'button' : 'div', {\n      className: 'sk-card__body',\n      type: props.onOpen ? 'button' : null,\n      onClick: props.onOpen ? function () { props.onOpen(item); } : null\n    },\n      el('div', { className: 'sk-card__meta' }, SubjectTag({ subject: item.subject }), DueChip({ due: item.due, today: props.today, done: item.done, flags: flags })),\n      el('h3', { className: 'sk-card__range' + (item.range ? '' : ' is-missing'), text: item.range || '範囲？まだ書いてない' }),\n      where,\n      item.location === 'school' && !isPackedToday(item, props.today) ? el('p', { className: 'sk-card__submit', text: '学校にある。帰る前にかばんへ。' }) : null,\n      item.submitTo ? el('p', { className: 'sk-card__submit', text: '出すところ：' + item.submitTo }) : null\n    );\n\n    card.appendChild(check);\n    card.appendChild(body);\n    // 期限が来たら「出した」を聞く。期限切れには出口（先生に言った）も\n    if ((info.state === 'handin' || info.state === 'overdue') && (props.onSubmit || props.onDrop)) {\n      var actions = el('div', { className: 'sk-card__actions' },\n        props.onSubmit ? BigButton({ label: '出した', kind: 'secondary', icon: 'check', onClick: function () { props.onSubmit(item); } }) : null,\n        props.onDrop ? BigButton({ label: '先生に言った', kind: 'ghost', onClick: function () { props.onDrop(item); } }) : null\n      );\n      body.appendChild(actions);\n    }\n    return card;\n  }\n\n  /** ホームの主役。props: { item, today?, remaining?, onDone(item), onAdd? } ― item がなければ AllDone を返す。 */\n  function TodayHero(props) {\n    props = props || {};\n    var item = props.item;\n    if (!item) return AllDone({ onAdd: props.onAdd });\n    var info = dueInfo(item.due, props.today, item.done, { packed: item.packed, submitted: item.submitted, dropped: item.dropped });\n    var remaining = props.remaining || 0;\n    var hero = el('section', { className: 'sk-hero sk-hero--' + info.state, 'aria-labelledby': 'sk-hero-range' },\n      el('p', { className: 'sk-hero__eyebrow', text: info.state === 'overdue' ? 'まずこれ。やりかけでも持っていこう' : 'いま、いちばん近いのはこれ' }),\n      DueChip({ due: item.due, today: props.today, done: item.done, size: 'lg', showDate: true, flags: { packed: item.packed, submitted: item.submitted, dropped: item.dropped } }),\n      el('h2', { className: 'sk-hero__range' + (item.range ? '' : ' is-missing'), id: 'sk-hero-range', text: item.range || '範囲？まだ書いてない' }),\n      el('div', { className: 'sk-hero__meta' },\n        SubjectTag({ subject: item.subject, size: 'lg' }),\n        el('span', { className: 'sk-hero__where' + (item.where ? '' : ' is-missing') }, icon('pin', 22), el('span', { text: item.where || 'どこにある？まだ書いてない' }))\n      ),\n      BigButton({ label: 'やった！', kind: 'primary', icon: 'check', full: true, onClick: function () { if (props.onDone) props.onDone(item); } }),\n      el('p', { className: 'sk-hero__rest', text: remaining > 0 ? 'ほかに ' + remaining + ' つ。これが終わってから。' : 'これが最後！' })\n    );\n    return hero;\n  }\n\n  var WHERE_PRESETS = ['教科書', 'ノート', 'プリント', 'ワーク', 'Classroom', 'タブレット'];\n  var LOCATION_PRESETS = [{ key: 'bag', label: 'かばん' }, { key: 'school', label: '学校（机・ロッカー）' }, { key: 'home', label: '家' }, { key: 'online', label: 'ネット' }];\n\n  /** 次に学校がある日（きょうは含まない）。schoolDays は曜日の配列（0=日）。 */\n  function nextSchoolDay(today, schoolDays) {\n    var t = parseDate(today || new Date());\n    var days = Array.isArray(schoolDays) && schoolDays.length ? schoolDays : [1, 2, 3, 4, 5];\n    for (var k = 1; k <= 14; k++) { var d = addDays(t, k); if (days.indexOf(d.getDay()) >= 0) return d; }\n    return addDays(t, 1);\n  }\n  /** 次にその科目の授業がある日。時間割になければ次の学校の日。 */\n  function nextLesson(subject, today, timetable, schoolDays) {\n    var t = parseDate(today || new Date());\n    var tt = timetable || {};\n    for (var k = 1; k <= 14; k++) {\n      var d = addDays(t, k);\n      var list = tt[String(d.getDay())];\n      if (Array.isArray(list) && list.indexOf(subject) >= 0) return { date: d, lesson: true };\n    }\n    return { date: nextSchoolDay(t, schoolDays), lesson: false };\n  }\n\n  // ---- 履修科目（大学の時間割）から、曜日ごとの予定を作る ----\n  var DEFAULT_PERIODS = { 1: ['09:00', '10:30'], 2: ['10:40', '12:10'], 3: ['13:00', '14:30'], 4: ['14:40', '16:10'], 5: ['16:20', '17:50'], 6: ['18:00', '19:30'] };\n  function hm(t) { var m = /^(\\d{1,2}):(\\d{2})$/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; }\n  function hhmmOf(min) { min = ((Math.round(min) % 1440) + 1440) % 1440; var h = Math.floor(min / 60), m = min % 60; return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m; }\n  function courseName(c) { return (c && (c.short || c.name)) || ''; }\n  function isSlotted(c) { return !!c && c.day !== null && c.day !== undefined && c.day !== '' && !!c.period; }\n  function coursesOf(s) { return s && Array.isArray(s.courses) ? s.courses.filter(function (c) { return c && courseName(c); }) : []; }\n  /**\n   * その曜日の予定。履修科目（settings.courses）があればそこから作り、なければ設定の値を使う。\n   * → { hasCourses, school, lessons: [{ subject, name, period, room, teacher, start, end }], leaveAt, afterSchoolAt, leaveSchoolAt }\n   * 出る時間 = 最初の授業の開始 − 通学時間（commuteMinutes、既定 60 分）。放課後 = 最後の授業の終わり + 30 分。\n   */\n  function dayPlan(dow, s) {\n    s = s || {};\n    var courses = coursesOf(s);\n    if (!courses.length) {\n      var days = Array.isArray(s.schoolDays) && s.schoolDays.length ? s.schoolDays : [1, 2, 3, 4, 5];\n      return { hasCourses: false, school: days.indexOf(dow) >= 0, lessons: [], leaveAt: s.leaveAt || '07:50', afterSchoolAt: (s.afterSchoolByDay || {})[dow] || s.afterSchoolAt || '15:45', leaveSchoolAt: s.leaveSchoolAt || '16:30' };\n    }\n    var periods = s.periods || DEFAULT_PERIODS;\n    var lessons = courses.filter(function (c) { return isSlotted(c) && +c.day === dow && periods[c.period] && hm(periods[c.period][0]) !== null; }).map(function (c) {\n      return { subject: courseName(c), name: c.name || courseName(c), period: +c.period, room: c.room || '', teacher: c.teacher || '', start: periods[c.period][0], end: periods[c.period][1] };\n    }).sort(function (a, b) { return a.period - b.period; });\n    if (!lessons.length) return { hasCourses: true, school: false, lessons: [], leaveAt: null, afterSchoolAt: null, leaveSchoolAt: null };\n    var first = lessons[0], last = lessons[lessons.length - 1];\n    var commute = (s.commuteMinutes === 0 || +s.commuteMinutes > 0) ? +s.commuteMinutes : 60;\n    var leave = (s.leaveByDay || {})[dow] || hhmmOf(hm(first.start) - commute);\n    var after = (s.afterSchoolByDay || {})[dow] || hhmmOf(hm(last.end) + 30);\n    return { hasCourses: true, school: true, lessons: lessons, leaveAt: leave, afterSchoolAt: after, leaveSchoolAt: hhmmOf(hm(last.end) + 10) };\n  }\n  /** 曜日 → 科目名（履修科目があればそこから。なければ設定の timetable）。次の授業を探すのに使う。 */\n  function effectiveTimetable(s) {\n    s = s || {};\n    var courses = coursesOf(s);\n    if (!courses.length) return s.timetable || {};\n    var tt = {};\n    courses.forEach(function (c) {\n      if (!isSlotted(c)) return;\n      var k = String(+c.day), n = courseName(c);\n      tt[k] = tt[k] || [];\n      if (tt[k].indexOf(n) < 0) tt[k].push(n);\n    });\n    return tt;\n  }\n  /** 学校（授業）のある曜日。 */\n  function effectiveSchoolDays(s) {\n    s = s || {};\n    var courses = coursesOf(s);\n    if (!courses.length) return Array.isArray(s.schoolDays) && s.schoolDays.length ? s.schoolDays.slice() : [1, 2, 3, 4, 5];\n    var out = [];\n    courses.forEach(function (c) { if (isSlotted(c) && out.indexOf(+c.day) < 0) out.push(+c.day); });\n    return out.sort(function (a, b) { return a - b; });\n  }\n  /** 科目名の一覧（履修科目があればそこから。曜日のない授業も入る）。 */\n  function allSubjects(s) {\n    var courses = coursesOf(s);\n    if (!courses.length) return SUBJECTS.map(function (x) { return x.label; });\n    var out = [];\n    courses.forEach(function (c) { var n = courseName(c); if (out.indexOf(n) < 0) out.push(n); });\n    return out;\n  }\n  /** その日に聞く科目：その日の授業（時限順）。週の最後の授業日には、曜日のない授業（集中講義など）も。 */\n  function daySubjects(today, s) {\n    s = s || {};\n    var d = parseDate(today || new Date());\n    var courses = coursesOf(s);\n    if (!courses.length) return captureSubjects({ today: d, timetable: s.timetable });\n    var plan = dayPlan(d.getDay(), s);\n    var out = [];\n    plan.lessons.forEach(function (l) { if (out.indexOf(l.subject) < 0) out.push(l.subject); });\n    var days = effectiveSchoolDays(s);\n    if (plan.school && d.getDay() === days[days.length - 1]) courses.forEach(function (c) { if (!isSlotted(c)) { var n = courseName(c); if (out.indexOf(n) < 0) out.push(n); } });\n    return out;\n  }\n  /** いま聞いていい科目：授業が終わって 5 分たったもの。放課後（afterSchoolAt）を過ぎたらその日の全部。 */\n  function askableSubjects(today, minutes, s) {\n    s = s || {};\n    var d = parseDate(today || new Date());\n    if (!coursesOf(s).length) return daySubjects(d, s);\n    var plan = dayPlan(d.getDay(), s);\n    if (!plan.school) return [];\n    if (minutes >= hm(plan.afterSchoolAt)) return daySubjects(d, s);\n    var out = [];\n    plan.lessons.forEach(function (l) { if (hm(l.end) + 5 <= minutes && out.indexOf(l.subject) < 0) out.push(l.subject); });\n    return out;\n  }\n  /** その日のその科目の授業。 */\n  function lessonOn(subject, date, s) {\n    var d = parseDate(date);\n    var plan = dayPlan(d.getDay(), s);\n    for (var i = 0; i < plan.lessons.length; i++) if (plan.lessons[i].subject === subject) return plan.lessons[i];\n    return null;\n  }\n  /** 出すところ（授業から作る）：「10/12（月） 2限 B-201」 */\n  function submitPlace(subject, due, s) {\n    var l = lessonOn(subject, due, s);\n    return l ? formatDate(due) + ' ' + l.period + '限' + (l.room ? ' ' + l.room : '') : '';\n  }\n  /** いま（授業中）か、つぎの授業。きょうもう無ければ null。 */\n  function nextClass(now, s) {\n    var n = toNow(now);\n    var plan = dayPlan(n.getDay(), s);\n    var m = n.getHours() * 60 + n.getMinutes();\n    for (var i = 0; i < plan.lessons.length; i++) {\n      var l = plan.lessons[i];\n      if (hm(l.end) > m) return { lesson: l, during: hm(l.start) <= m };\n    }\n    return null;\n  }\n\n  /** さっと登録。props: { today?, subjects?, moreSubjects?（「ほかの授業」に畳む）, wherePresets?, timetable?, schoolDays?, paperSpot?, allowEmptyRange?, initial?, onSubmit(item), onCancel?(draft) } */\n  function QuickAdd(props) {\n    props = props || {};\n    var today = parseDate(props.today || new Date());\n    var subjects = props.subjects || SUBJECTS.map(function (s) { return s.label; });\n    var init = props.initial || {};\n    var state = { subject: init.subject || null, where: Array.isArray(init.whereList) ? init.whereList.slice() : [], due: init.due || null, location: init.location || null, dueChoice: null };\n\n    function choiceGroup(legendText, options, multi, onPick) {\n      var group = el('div', { className: 'sk-choices', role: multi ? 'group' : 'radiogroup', 'aria-label': legendText });\n      options.forEach(function (opt) {\n        var b = el('button', { className: 'sk-choice', type: 'button', role: multi ? null : 'radio', 'aria-checked': 'false', 'aria-pressed': multi ? 'false' : null, text: opt.label }, opt.icon ? icon(opt.icon, 20) : null);\n        if (opt.icon) b.insertBefore(b.lastChild, b.firstChild);\n        b.addEventListener('click', function () {\n          if (!multi) {\n            Array.prototype.forEach.call(group.children, function (c) { c.setAttribute('aria-checked', 'false'); c.classList.remove('is-on'); });\n            b.setAttribute('aria-checked', 'true'); b.classList.add('is-on');\n          } else {\n            var on = b.classList.toggle('is-on');\n            b.setAttribute('aria-pressed', on ? 'true' : 'false');\n          }\n          onPick(opt, b.classList.contains('is-on'));\n        });\n        if (!multi && state.subject && opt.value === state.subject) { b.setAttribute('aria-checked', 'true'); b.classList.add('is-on'); }\n        group.appendChild(b);\n      });\n      return group;\n    }\n\n    var rangeInput = el('input', { className: 'sk-input', type: 'text', id: 'sk-range', name: 'range', autocomplete: 'off', enterkeyhint: 'done', placeholder: 'p.24〜27 ／ プリント1枚 ／ ワーク §3', value: init.range || '' });\n    var rangeHint = el('p', { className: 'sk-hint', id: 'sk-range-hint', 'aria-live': 'polite' });\n    rangeInput.setAttribute('aria-describedby', 'sk-range-hint');\n\n    var whereOther = el('input', { className: 'sk-input sk-input--sub', type: 'text', name: 'whereOther', placeholder: 'ほかの場所（ロッカー、先生の机…）', autocomplete: 'off', value: init.whereOther || '' });\n    var paperHint = el('p', { className: 'sk-hint sk-hint--calm', 'aria-live': 'polite' });\n    function updatePaperHint() {\n      paperHint.textContent = (props.paperSpot && state.where.indexOf('プリント') >= 0) ? '家に着いたら、プリントは「' + props.paperSpot + '」へ。' : '';\n    }\n    var dateInput = el('input', { className: 'sk-input sk-input--sub', type: 'date', name: 'dueDate', min: toISO(today), hidden: true, 'aria-label': '日付をえらぶ' });\n    dateInput.addEventListener('input', function () { state.due = dateInput.value || null; });\n\n    var nextWeek = addDays(today, 7);\n    // 既定は「次の○○の授業」。時間割がなければ「次の学校の日」。土曜に登録して日曜に鳴る、を防ぐ\n    function defaultDue() {\n      var n = state.subject ? nextLesson(state.subject, today, props.timetable, props.schoolDays) : { date: nextSchoolDay(today, props.schoolDays), lesson: false };\n      var d = n.date;\n      var label = (n.lesson ? '次の' + state.subject : '次の学校の日') + '（' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + WEEKDAYS[d.getDay()] + '）';\n      return { label: label, value: toISO(d) };\n    }\n    var dueGroup = null;\n    function buildDueOptions() {\n      var def = defaultDue();\n      var opts = [def];\n      var tomorrow = toISO(addDays(today, 1)), dayAfter = toISO(addDays(today, 2)), week = toISO(nextWeek);\n      if (tomorrow !== def.value) opts.push({ label: 'あした', value: tomorrow });\n      if (dayAfter !== def.value) opts.push({ label: 'あさって', value: dayAfter });\n      if (week !== def.value) opts.push({ label: '来週の' + WEEKDAYS[nextWeek.getDay()] + '曜', value: week });\n      opts.push({ label: '日付をえらぶ', value: 'pick' });\n      return opts;\n    }\n    function buildDueGroup() {\n      var g = choiceGroup('いつまで', buildDueOptions(), false, function (opt) {\n        state.dueChoice = opt.value;\n        if (opt.value === 'pick') { dateInput.hidden = false; dateInput.focus(); state.due = dateInput.value || null; }\n        else { dateInput.hidden = true; state.due = opt.value; }\n      });\n      return g;\n    }\n\n    var more = (props.moreSubjects || []).filter(function (x) { return subjects.indexOf(x) < 0; });\n    var subjectGroup = choiceGroup('科目', subjects.concat(more).map(function (s) { return { label: s, value: s }; }), false, function (opt) {\n      state.subject = opt.value;\n      if (dueGroup && !state.dueChoice) {\n        var fresh = buildDueGroup();\n        dueGroup.replaceWith(fresh); dueGroup = fresh;\n      }\n    });\n    var moreBtn = null;\n    if (more.length) {\n      var hiddenCount = 0;\n      Array.prototype.forEach.call(subjectGroup.children, function (c, i) {\n        if (i >= subjects.length && c.textContent !== state.subject) { c.hidden = true; hiddenCount++; }\n      });\n      if (hiddenCount) moreBtn = el('button', { className: 'sk-more', type: 'button', text: 'ほかの授業（' + hiddenCount + '）', onClick: function () {\n        Array.prototype.forEach.call(subjectGroup.children, function (c) { c.hidden = false; });\n        moreBtn.remove();\n      } });\n    }\n\n    var form = el('form', { className: 'sk-quick', novalidate: true },\n      el('div', { className: 'sk-quick__head' },\n        el('h2', { className: 'sk-quick__title', text: 'さっと登録' }),\n        props.onCancel ? el('button', { className: 'sk-iconbtn', type: 'button', 'aria-label': 'とじる', onClick: function () { props.onCancel(draft()); } }, icon('close', 24)) : null\n      ),\n      el('div', { className: 'sk-field' },\n        el('p', { className: 'sk-field__label', text: '01 科目' }),\n        subjectGroup,\n        moreBtn\n      ),\n      el('div', { className: 'sk-field' },\n        el('label', { className: 'sk-field__label', 'for': 'sk-range' }, icon('book', 20), el('span', { text: '02 範囲（ここだけ書く）' })),\n        rangeInput, rangeHint\n      ),\n      el('div', { className: 'sk-field' },\n        el('p', { className: 'sk-field__label' }, icon('pin', 20), el('span', { text: '03 どこにある？' })),\n        choiceGroup('どこにある', (props.wherePresets || WHERE_PRESETS).map(function (w) { return { label: w, value: w }; }), true, function (opt, on) {\n          var i = state.where.indexOf(opt.value);\n          if (on && i < 0) state.where.push(opt.value); else if (!on && i >= 0) state.where.splice(i, 1);\n          if (/classroom|タブレット|lms|moodle|メール/i.test(opt.value)) { if (on && !state.location) state.location = 'online'; }\n          updatePaperHint();\n        }),\n        whereOther,\n        paperHint,\n        el('p', { className: 'sk-field__sub', text: 'いま、どこ？' }),\n        choiceGroup('いまどこにある', LOCATION_PRESETS.map(function (l) { return { label: l.label, value: l.key }; }), false, function (opt) { state.location = opt.value; })\n      ),\n      el('div', { className: 'sk-field' },\n        el('p', { className: 'sk-field__label' }, icon('clock', 20), el('span', { text: '04 いつまで？' })),\n        (function () { dueGroup = buildDueGroup(); return dueGroup; })(),\n        dateInput\n      ),\n      el('div', { className: 'sk-quick__actions' },\n        BigButton({ label: 'これで登録', kind: 'primary', icon: 'plus', full: true, type: 'submit' }),\n        props.onCancel ? BigButton({ label: 'あとで（書きかけはとっておく）', kind: 'ghost', full: true, onClick: function () { props.onCancel(draft()); } }) : null\n      )\n    );\n\n    function draft() {\n      return { subject: state.subject, range: rangeInput.value, whereList: state.where.slice(), whereOther: whereOther.value, due: state.due, location: state.location };\n    }\n    function submit(allowEmpty) {\n      var range = rangeInput.value.trim();\n      if (!range && !allowEmpty) {\n        rangeHint.textContent = props.allowEmptyRange ? '範囲が空のまま登録する？ 下の「範囲はあとで」を押す。' : '範囲だけは書いて！（例：p.24〜27）';\n        rangeInput.classList.add('is-error');\n        rangeInput.focus();\n        return;\n      }\n      rangeHint.textContent = '';\n      rangeInput.classList.remove('is-error');\n      var where = state.where.slice();\n      if (whereOther.value.trim()) where.push(whereOther.value.trim());\n      var nowDate = new Date();\n      var item = {\n        id: 'hw_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),\n        subject: state.subject || 'その他',\n        range: range,\n        rangeMissing: !range,\n        where: where.join('・'),\n        location: state.location || (where.length ? 'bag' : null),\n        submitTo: '',\n        due: state.due || defaultDue().value,\n        done: false,\n        packed: false,\n        createdAt: nowDate.toISOString(),\n        createdOn: toISO(nowDate)\n      };\n      if (props.onSubmit) props.onSubmit(item);\n    }\n    form.getDraft = draft;\n    form.addEventListener('submit', function (e) { e.preventDefault(); submit(false); });\n    if (props.allowEmptyRange) {\n      var acts = form.querySelector('.sk-quick__actions');\n      var later = BigButton({ label: '範囲はあとで（夜に聞く）', kind: 'ghost', full: true, onClick: function () { submit(true); } });\n      acts.insertBefore(later, acts.children[1] || null);\n    }\n    return form;\n  }\n\n  /** あさのチェック。props: { items, today?, title?, dateText?, paperSpot?, onToggle(item, packed), onClose? } */\n  function BringCheck(props) {\n    props = props || {};\n    var items = props.items || [];\n    var count = el('p', { className: 'sk-bring__count', 'aria-live': 'polite' });\n    function updateCount() {\n      var packed = items.filter(function (i) { return i.packed; }).length;\n      count.textContent = packed === items.length && items.length > 0 ? 'ぜんぶ入れた。いってらっしゃい！' : 'かばんに入れた ' + packed + ' / ' + items.length;\n    }\n    var list = el('ul', { className: 'sk-bring__list' });\n    items.forEach(function (item) {\n      var box = el('button', { className: 'sk-bring__box', type: 'button', 'aria-pressed': item.packed ? 'true' : 'false', 'aria-label': (item.subject || '') + ' ' + (item.range || '') + ' をかばんに入れた' }, icon('bag', 26));\n      var row = el('li', { className: 'sk-bring__row' + (item.packed ? ' is-packed' : '') },\n        box,\n        el('div', { className: 'sk-bring__text' },\n          el('div', { className: 'sk-bring__meta' }, SubjectTag({ subject: item.subject }), DueChip({ due: item.due, today: props.today, done: item.done, flags: { packed: item.packed, submitted: item.submitted, dropped: item.dropped } })),\n          el('p', { className: 'sk-bring__range', text: item.range || '' }),\n          el('p', { className: 'sk-bring__status' + (item.done ? '' : ' is-pending'), text: (item.done ? 'できてる。あとは入れるだけ' : 'まだ。やりかけでも持っていこう') + (item.location === 'school' ? '（学校にある）' : '') + (props.paperSpot && /プリント/.test(item.where || '') ? '　プリントは「' + props.paperSpot + '」' : '') })\n        )\n      );\n      box.addEventListener('click', function () {\n        item.packed = !item.packed;\n        item.packedOn = item.packed ? toISO(parseDate(props.today || new Date())) : null;\n        box.setAttribute('aria-pressed', item.packed ? 'true' : 'false');\n        row.classList.toggle('is-packed', item.packed);\n        updateCount();\n        if (props.onToggle) props.onToggle(item, item.packed);\n      });\n      list.appendChild(row);\n    });\n    updateCount();\n    return el('section', { className: 'sk-bring', 'aria-labelledby': 'sk-bring-title' },\n      el('div', { className: 'sk-bring__head' },\n        el('div', null,\n          el('h2', { className: 'sk-bring__title', id: 'sk-bring-title', text: props.title || 'あさのチェック' }),\n          el('p', { className: 'sk-bring__date', text: props.dateText || (formatDate(props.today || new Date()) + ' に持っていくもの') })\n        ),\n        props.onClose ? el('button', { className: 'sk-iconbtn', type: 'button', 'aria-label': 'とじる', onClick: props.onClose }, icon('close', 24)) : null\n      ),\n      items.length ? list : el('p', { className: 'sk-bring__empty', text: 'きょう持っていく宿題はない。' }),\n      count\n    );\n  }\n\n  /** 全部終わった。props: { onAdd?, message? } */\n  function AllDone(props) {\n    props = props || {};\n    var svg = document.createElementNS(SVG_NS, 'svg');\n    svg.setAttribute('viewBox', '0 0 160 120');\n    svg.setAttribute('width', '160'); svg.setAttribute('height', '120');\n    svg.setAttribute('aria-hidden', 'true');\n    svg.setAttribute('class', 'sk-alldone__art');\n    [['ellipse', { cx: 50, cy: 70, rx: 46, ry: 40, 'class': 'sk-alldone__blob sk-alldone__blob--pale' }],\n     ['ellipse', { cx: 112, cy: 56, rx: 40, ry: 36, 'class': 'sk-alldone__blob sk-alldone__blob--grey' }],\n     ['ellipse', { cx: 88, cy: 92, rx: 30, ry: 24, 'class': 'sk-alldone__blob sk-alldone__blob--pink' }],\n     ['path', { d: 'M56 66 L74 84 L108 46', fill: 'none', 'stroke-width': '8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'class': 'sk-alldone__check' }]\n    ].forEach(function (s) {\n      var n = document.createElementNS(SVG_NS, s[0]);\n      Object.keys(s[1]).forEach(function (k) { n.setAttribute(k, String(s[1][k])); });\n      svg.appendChild(n);\n    });\n    return el('section', { className: 'sk-alldone' },\n      svg,\n      el('h2', { className: 'sk-alldone__title', text: 'ぜんぶ終わった！' }),\n      el('p', { className: 'sk-alldone__body', text: props.message || 'いまは宿題がない。思い出したら、すぐ入れておこう。' }),\n      BigButton({ label: '宿題を追加', kind: 'secondary', icon: 'plus', onClick: props.onAdd })\n    );\n  }\n\n  // ---- 焦らせる：出発時刻までの残り時間と段階 ----\n  function parseTime(hhmm) {\n    var m = /^(\\d{1,2}):(\\d{2})$/.exec(hhmm || '');\n    return m ? { h: +m[1], m: +m[2] } : { h: 7, m: 50 };\n  }\n  function toNow(v) { return v instanceof Date ? v : (v ? new Date(v) : new Date()); }\n  function minutesUntilLeave(leaveAt, now) {\n    now = toNow(now);\n    var t = parseTime(leaveAt);\n    var leave = new Date(now.getFullYear(), now.getMonth(), now.getDate(), t.h, t.m);\n    return Math.round((leave - now) / 60000);\n  }\n  function spanLabel(mins) {\n    var a = Math.abs(mins), h = Math.floor(a / 60), m = a % 60;\n    var body = a >= 60 ? (h + '時間' + (m ? m + '分' : '')) : (a + '分');\n    return mins >= 0 ? 'あと' + body : body + 'すぎた';\n  }\n  /**\n   * 焦らせる段階。items のうち、きょうが期限か期限を過ぎていて、まだ「かばんに入れた」が押されていないものを見る。\n   * stage: clear（全部入れた）/ calm（出発 60 分より前）/ soon（60〜16 分前）/ urgent（15 分以内）/ late（出発時刻を過ぎた）\n   */\n  function nudgeStage(opts) {\n    opts = opts || {};\n    var now = toNow(opts.now);\n    var today = parseDate(opts.today || now);\n    var pending = (opts.items || []).filter(function (i) {\n      if (!isActive(i) || isOnline(i) || isPackedToday(i, today)) return false;\n      var st = dueInfo(i.due, today, false).state;\n      return st === 'today' || st === 'overdue';\n    });\n    var mins = minutesUntilLeave(opts.leaveAt || '07:50', now);\n    if (!pending.length) return { stage: 'clear', minutes: mins, label: 'ぜんぶ入れた', items: [], leaveAt: opts.leaveAt || '07:50' };\n    pending.sort(function (a, b) { return parseDate(a.due) - parseDate(b.due); });\n    var stage = mins > 60 ? 'calm' : mins > 15 ? 'soon' : mins >= 0 ? 'urgent' : 'late';\n    return { stage: stage, minutes: mins, label: spanLabel(mins), items: pending, leaveAt: opts.leaveAt || '07:50' };\n  }\n\n  var NUDGE_LINES = {\n    calm: 'いまのうちに。かばんに入れたら押す。',\n    soon: 'そろそろ。やりかけでも入れよう。',\n    urgent: 'いますぐ。できてなくても、入れる。',\n    late: '出る時間すぎてる。入れて、押して、出よう。'\n  };\n\n  /** 焦らせるバー。props: { items, leaveAt?, now?, today?, snoozeLeft?, snoozedUntil?, onPack(item), onDone(item), onSnooze(), onWake() } */\n  function NudgeBar(props) {\n    props = props || {};\n    var n = nudgeStage(props);\n    if (props.snoozedUntil && (n.stage === 'calm' || n.stage === 'soon')) {\n      var until = new Date(props.snoozedUntil);\n      return el('section', { className: 'sk-nudge sk-nudge--snoozed', role: 'status' },\n        icon('clock', 24),\n        el('p', { className: 'sk-nudge__clear', text: formatClock(until) + ' にもう一度言う。' + (n.items.length ? 'まだ ' + n.items.length + ' つ。' : '') }),\n        BigButton({ label: 'いまやる', kind: 'ghost', onClick: props.onWake })\n      );\n    }\n    if (n.stage === 'clear') {\n      return el('section', { className: 'sk-nudge sk-nudge--clear', role: 'status' },\n        icon('check', 28),\n        el('p', { className: 'sk-nudge__clear', text: 'ぜんぶ入れた。いってらっしゃい！' }));\n    }\n    var first = n.items[0];\n    var rest = n.items.length - 1;\n    var canSnooze = (n.stage === 'calm' || n.stage === 'soon') && (props.snoozeLeft === undefined || props.snoozeLeft > 0);\n    var bar = el('section', { className: 'sk-nudge sk-nudge--' + n.stage, role: n.stage === 'urgent' || n.stage === 'late' ? 'alert' : 'status', 'aria-live': 'polite' },\n      el('p', { className: 'sk-nudge__eyebrow', text: '出る時間 ' + n.leaveAt + ' まで' }),\n      el('p', { className: 'sk-nudge__count' + (n.label.length >= 6 ? ' sk-nudge__count--long' : n.label.length === 5 ? ' sk-nudge__count--mid' : ''), text: n.label }),\n      el('div', { className: 'sk-nudge__item' },\n        SubjectTag({ subject: first.subject }),\n        el('span', { className: 'sk-nudge__range', text: first.range || '' }),\n        el('span', { className: 'sk-nudge__state', text: first.done ? 'できてる' : 'まだ' })\n      ),\n      el('p', { className: 'sk-nudge__line', text: NUDGE_LINES[n.stage] + (rest > 0 ? ' ほかに ' + rest + ' つ。' : '') }),\n      el('div', { className: 'sk-nudge__actions' },\n        BigButton({ label: n.items.length > 1 ? first.subject + '、入れた' : 'かばんに入れた', kind: 'primary', icon: 'bag', full: true, onClick: function () { if (props.onPack) props.onPack(first); } }),\n        canSnooze ? BigButton({ label: '10分あとで' + (props.snoozeLeft !== undefined ? '（あと ' + props.snoozeLeft + ' 回）' : ''), kind: 'ghost', full: true, onClick: props.onSnooze }) : null\n      )\n    );\n    return bar;\n  }\n\n  // ---- 捕まえる：そもそも登録し忘れないために、こっちから聞く ----\n  function createdOn(item) {\n    if (!item) return null;\n    if (item.createdOn) return item.createdOn;\n    return item.createdAt ? toISO(new Date(item.createdAt)) : null;\n  }\n  /**\n   * きょうの分を科目ごとに見る。capture[日付] は { 科目: 'added'|'none' }（古い形：'none'/'added' の文字列＝全部）。\n   * きょう作った宿題は、その科目を 'added' にする。\n   * → { subjects, answered: {科目: 'added'|'none'}, unanswered: [...], all: 全部答えた, allNone: 全部なし, anyAdded }\n   */\n  function captureStatus(opts) {\n    opts = opts || {};\n    var today = parseDate(opts.today || new Date());\n    var key = toISO(today);\n    var subjects = captureSubjects({ today: today, timetable: opts.timetable, subjects: opts.subjects });\n    var raw = (opts.capture || {})[key];\n    var answered = {};\n    if (raw === 'none' || raw === 'added') subjects.forEach(function (sub) { answered[sub] = raw; });\n    else if (raw && typeof raw === 'object') {\n      Object.keys(raw).forEach(function (k) { if (k !== '*') answered[k] = raw[k]; });\n      if (raw['*']) subjects.forEach(function (sub) { if (!answered[sub]) answered[sub] = raw['*']; });\n    }\n    (opts.items || []).forEach(function (i) {\n      if (!i.deleted && createdOn(i) === key) answered[i.subject] = 'added';\n    });\n    var unanswered = subjects.filter(function (sub) { return answered[sub] !== 'added' && answered[sub] !== 'none'; });\n    var anyAdded = Object.keys(answered).some(function (k) { return answered[k] === 'added'; });\n    return { key: key, subjects: subjects, answered: answered, unanswered: unanswered, all: unanswered.length === 0, allNone: unanswered.length === 0 && !anyAdded, anyAdded: anyAdded };\n  }\n  /** 全部答えたら 'added'（何か登録した）か 'none'（全部なし）。まだなら null。 */\n  function captureAnswered(opts) {\n    var st = captureStatus(opts);\n    if (!st.all) return null;\n    return st.anyAdded ? 'added' : 'none';\n  }\n  /** きょう聞く科目。時間割があればその日の科目、なければ 6 科目。 */\n  function captureSubjects(opts) {\n    opts = opts || {};\n    if (Array.isArray(opts.subjects)) return opts.subjects.slice(0, 7);\n    var today = parseDate(opts.today || new Date());\n    var tt = opts.timetable || {};\n    var list = tt[String(today.getDay())];\n    if (Array.isArray(list) && list.length) return list.slice(0, 7);\n    return SUBJECTS.map(function (s) { return s.label; });\n  }\n  /** 聞き方は回を追うごとに変える（同じ文は慣れる）。 */\n  function captureWording(askNo, today, subs) {\n    var d = parseDate(today || new Date());\n    if (askNo === 0) return (subs.length ? subs.join('・') + '、おわった。' : '') + '課題出た？';\n    if (askNo <= 1) return 'きょう、宿題出た？';\n    if (askNo === 2) return WEEKDAYS[d.getDay()] + '曜。' + subs.join('・') + '。どれか出た？';\n    if (askNo === 3) return 'まだ答えてない。授業のページやメモを開いて確かめて。';\n    return 'まだ ' + subs.join('・') + ' が答えてない。見て押すだけ。';\n  }\n\n  /**\n   * 放課後の「きょう、宿題出た？」。科目ごとに「出た／なし」。\n   * props: { items?, capture?, timetable?, subjects?, today?, asked?（0 は授業の直後）, handin?: items, onPick(subject), onNone(subject), onNoneAll(), onReopen(), onSubmit(item), onDrop(item) }\n   */\n  function CaptureAsk(props) {\n    props = props || {};\n    var st = captureStatus(props);\n    var asked = props.asked === 0 ? 0 : (props.asked || 1);\n    var handin = (props.handin || []);\n    var handinRows = handin.length ? el('div', { className: 'sk-capture__handin' },\n      el('p', { className: 'sk-capture__sub', text: '持っていったぶん、出した？' }),\n      handin.map(function (item) {\n        return el('div', { className: 'sk-capture__row' },\n          SubjectTag({ subject: item.subject }),\n          el('span', { className: 'sk-capture__name', text: item.range || '' }),\n          el('button', { className: 'sk-choice sk-choice--yes', type: 'button', text: '出した', onClick: function () { if (props.onSubmit) props.onSubmit(item); } }),\n          dueInfo(item.due, props.today, item.done, { packed: item.packed }).state === 'handin' && props.onDrop ? el('button', { className: 'sk-choice', type: 'button', text: '先生に言った', onClick: function () { props.onDrop(item); } }) : null\n        );\n      })) : null;\n    if (st.all) {\n      return el('section', { className: 'sk-capture sk-capture--done', role: 'status' },\n        el('div', { className: 'sk-capture__doneRow' },\n          icon('check', 28),\n          el('p', { className: 'sk-capture__done', text: st.anyAdded ? 'きょうの分、入れた。えらい。' : 'きょうは宿題なし。OK。' }),\n          props.onReopen ? el('button', { className: 'sk-choice', type: 'button', text: 'やっぱりあった', onClick: props.onReopen }) : null\n        ),\n        handinRows);\n    }\n    return el('section', { className: 'sk-capture' + (asked >= 3 ? ' sk-capture--again' : ''), role: asked >= 3 ? 'alert' : 'status' },\n      el('p', { className: 'sk-capture__eyebrow', text: asked === 0 ? '授業のあと' : asked > 1 ? '放課後のチェック ・ ' + asked + ' 回目' : '放課後のチェック' }),\n      el('h2', { className: 'sk-capture__title', text: captureWording(asked, props.today, st.unanswered) }),\n      el('p', { className: 'sk-capture__line', text: '科目ごとに「出た」か「なし」。出たら 10 秒で登録、範囲はあとでもいい。' }),\n      el('div', { className: 'sk-capture__rows', role: 'group', 'aria-label': '科目ごとの答え' }, st.unanswered.map(function (sub) {\n        return el('div', { className: 'sk-capture__row' },\n          el('span', { className: 'sk-capture__name', text: sub }),\n          el('button', { className: 'sk-choice sk-choice--yes', type: 'button', text: '出た', 'aria-label': sub + '：出た', onClick: function () { if (props.onPick) props.onPick(sub); } }),\n          el('button', { className: 'sk-choice', type: 'button', text: 'なし', 'aria-label': sub + '：なし', onClick: function () { if (props.onNone) props.onNone(sub); } })\n        );\n      })),\n      Object.keys(st.answered).length ? el('p', { className: 'sk-capture__sub', text: '答えた：' + st.subjects.filter(function (x) { return st.answered[x]; }).map(function (x) { return x + (st.answered[x] === 'added' ? '（入れた）' : '（なし）'); }).join('、') }) : null,\n      st.unanswered.length > 1 && props.onNoneAll ? BigButton({ label: 'のこりは ぜんぶ なし', kind: 'ghost', full: true, onClick: props.onNoneAll }) : null,\n      handinRows\n    );\n  }\n\n  // ---- Discord へ送るメッセージ ----\n  // Discord はほぼダークテーマ：黒の帯は見えないので、late と overdue は白（ink のダーク値）\n  var EMBED_COLORS = { calm: 0xffe1ef, soon: 0xffe1ef, urgent: 0xff8fc5, late: 0xf5f5f5, evening: 0xffe1ef, overdue: 0xf5f5f5, clear: 0xf2f2f2 };\n  var FOOTER = { calm: '宿題忘れゼロ', soon: '宿題忘れゼロ ・ 15 分前にもう一度言う', urgent: '宿題忘れゼロ ・ 押すまで 10 分ごとに言う', late: '宿題忘れゼロ ・ 押すまで 10 分ごとに言う', evening: '宿題忘れゼロ ・ まだなら 21:30 にもう一度', overdue: '宿題忘れゼロ ・ 出すか、先生に言うまで', clear: '宿題忘れゼロ' };\n\n  function itemLine(i, today) {\n    var d = dueInfo(i.due, today, i.done, { packed: i.packed });\n    var status = d.state === 'handin' ? '持っていった → 出した？' : (i.done ? 'できてる' : 'まだ') + (d.state === 'overdue' ? '（' + d.label + '）' : '');\n    return '・' + (i.subject || '') + '　' + (i.range || '範囲？') + '　｜　' + (i.where ? 'どこ：' + i.where : 'どこ：まだ書いてない') + (i.location === 'school' ? '（学校）' : '') + '　｜　' + status;\n  }\n\n  /**\n   * Discord の Webhook / Bot に渡す JSON。kind: 'evening'（前日 20:00）/ 'morning'（出発前、nudgeStage の段階で色と言葉が変わる）/ 'overdue'（期限を過ぎた夕方）。\n   * props: { kind, items, today?, now?, leaveAt?, userId?, appUrl? }\n   */\n  function discordPayload(props) {\n    props = props || {};\n    var now = toNow(props.now);\n    var today = parseDate(props.today || now);\n    var kind = props.kind || 'morning';\n    var live = (props.items || []).filter(function (i) { return !i.deleted; });\n    var items, title, stageKey, mention = '', est = null;\n    if (kind === 'evening') {\n      var tomorrow = addDays(today, 1);\n      items = live.filter(function (i) { return isActive(i) && !i.done && parseDate(i.due) <= tomorrow; });\n      title = 'あしたまで ' + items.length + ' つ。いまのうちに。';\n      est = (props.capture !== undefined || props.timetable || props.subjects) ? captureStatus({ items: live, capture: props.capture, today: today, timetable: props.timetable, subjects: props.subjects }) : null;\n      if (est && !est.all) title = 'まだ答えてない科目：' + est.unanswered.join('・') + '。出た？ ' + (items.length ? title : '');\n      else if (est && est.allNone && props.askAgainOnNone) title = 'きょうは全部「なし」。ほんとに？ 授業のページは見た？ ' + (items.length ? title : '');\n      else if (props.captureMissing) title = 'きょう登録ゼロ。ほんとに宿題なし？ ' + (items.length ? title : '');\n      stageKey = 'evening';\n    } else if (kind === 'capture') {\n      var cst = captureStatus({ items: live, capture: props.capture, today: today, timetable: props.timetable, subjects: props.subjects });\n      var subs = cst.unanswered;\n      var askNo = props.askNo === 0 ? 0 : (props.askNo || 1);\n      title = captureWording(askNo, today, subs);\n      var rows = [];\n      var caps = [];\n      subs.forEach(function (sub) { caps.push({ type: 2, style: 2, label: sub + '：出た', custom_id: 'cap:' + sub }); caps.push({ type: 2, style: 2, label: sub + '：なし', custom_id: 'capno:' + sub }); });\n      for (var r = 0; r < caps.length && rows.length < 3; r += 5) rows.push({ type: 1, components: caps.slice(r, r + 5) });\n      // 持っていったぶん、出した？\n      var handin = live.filter(function (i) { return isActive(i) && i.packed && parseDate(i.due) <= today; }).slice(0, 2);\n      if (handin.length) rows.push({ type: 1, components: handin.map(function (i) { return { type: 2, style: 3, label: '出した：' + i.subject, custom_id: 'submit:' + i.id }; }) });\n      var tail = [];\n      if (subs.length > 1) tail.push({ type: 2, style: 2, label: 'のこりは ぜんぶ なし', custom_id: 'capnone' });\n      if (props.appUrl) tail.push({ type: 2, style: 5, label: 'アプリで登録', url: props.appUrl });\n      if (tail.length && rows.length < 5) rows.push({ type: 1, components: tail });\n      var desc = '科目ごとに「出た」か「なし」。「出た」→ 範囲とどこにあるかを書く（範囲は空でもいい）。';\n      if (Object.keys(cst.answered).length) desc += '\\n答えた：' + cst.subjects.filter(function (x) { return cst.answered[x]; }).map(function (x) { return x + (cst.answered[x] === 'added' ? '（入れた）' : '（なし）'); }).join('、');\n      if (handin.length) desc += '\\n持っていったぶん：' + handin.map(function (i) { return i.subject + ' ' + (i.range || ''); }).join('、') + ' → 出した？';\n      return {\n        content: ((askNo >= 3 && props.userId) ? '<@' + props.userId + '> ' : '') + title,\n        embeds: [{ title: title, description: desc, color: askNo >= 3 ? 0xff8fc5 : 0xffe1ef, footer: { text: '宿題忘れゼロ ・ 放課後のチェック' }, timestamp: now.toISOString() }],\n        components: rows,\n        allowed_mentions: { users: props.userId ? [props.userId] : [] }\n      };\n    } else if (kind === 'overdue') {\n      items = live.filter(function (i) { return isActive(i) && parseDate(i.due) < today; });\n      var notDone = items.filter(function (i) { return !i.done && !i.packed; }).length;\n      title = notDone ? '出してないのが ' + items.length + ' つ。あしたの朝いちで出そう。' : '持っていったぶん ' + items.length + ' つ、出した？';\n      stageKey = 'overdue';\n      mention = (props.userId && !props.quietMention) ? '<@' + props.userId + '> ' : '';\n    } else {\n      var n = nudgeStage({ items: live, today: today, now: now, leaveAt: props.leaveAt });\n      items = n.items;\n      stageKey = n.stage;\n      if (n.stage === 'clear') { title = 'ぜんぶ入れた。いってらっしゃい！'; }\n      else if (n.stage === 'late') { title = '出る時間 ' + n.leaveAt + ' を ' + n.label + '。かばんに入れた？'; mention = props.userId ? '<@' + props.userId + '> ' : ''; }\n      else { title = '出るまで ' + n.label + '。' + (n.stage === 'urgent' ? 'いますぐ入れる。' : 'きょう持っていくもの ' + items.length + ' つ。'); mention = (n.stage === 'urgent' && props.userId) ? '<@' + props.userId + '> ' : ''; }\n    }\n    var lines = items.map(function (i) { return itemLine(i, today); });\n    var missing = kind === 'evening' ? live.filter(function (i) { return isActive(i) && !i.range; }).slice(0, 3) : [];\n    if (missing.length) lines.push('範囲が空：' + missing.map(function (i) { return i.subject; }).join('・') + ' → 下の「範囲を書く」');\n    var compRows = [];\n    var row1 = [];\n    if (items.length) {\n      if (kind === 'overdue') {\n        items.slice(0, 2).forEach(function (i) { row1.push({ type: 2, style: 3, label: '出した：' + i.subject, custom_id: 'submit:' + i.id }); row1.push({ type: 2, style: 2, label: '先生に言った：' + i.subject, custom_id: 'drop:' + i.id }); });\n      } else if (items.length > 1 && items.length <= 4) {\n        items.forEach(function (i) { row1.push({ type: 2, style: 3, label: '入れた：' + i.subject, custom_id: 'pack:' + i.id }); });\n      } else {\n        row1.push({ type: 2, style: 3, label: 'かばんに入れた', custom_id: 'pack:' + items.map(function (i) { return i.id; }).join(',') });\n      }\n      if (kind !== 'overdue') row1.push({ type: 2, style: 2, label: 'やった', custom_id: 'done:' + items[0].id });\n      compRows.push({ type: 1, components: row1.slice(0, 5) });\n      var row2 = [];\n      if (stageKey === 'calm' || stageKey === 'soon' || stageKey === 'evening') row2.push({ type: 2, style: 2, label: '10分あとで', custom_id: 'snooze:' + items[0].id });\n      if (props.appUrl) row2.push({ type: 2, style: 5, label: 'アプリで見る', url: props.appUrl });\n      if (row2.length) compRows.push({ type: 1, components: row2 });\n    }\n    if (kind === 'evening') {\n      if (missing.length) compRows.push({ type: 1, components: missing.map(function (i) { return { type: 2, style: 2, label: '範囲を書く：' + i.subject, custom_id: 'fix:' + i.id }; }) });\n      if (est && !est.all) {\n        var capBtns = [];\n        est.unanswered.slice(0, 2).forEach(function (sub) { capBtns.push({ type: 2, style: 2, label: sub + '：出た', custom_id: 'cap:' + sub }); capBtns.push({ type: 2, style: 2, label: sub + '：なし', custom_id: 'capno:' + sub }); });\n        compRows.push({ type: 1, components: capBtns.slice(0, 5) });\n      } else if (est && est.allNone && props.askAgainOnNone) {\n        compRows.push({ type: 1, components: [{ type: 2, style: 2, label: 'やっぱりあった', custom_id: 'capreopen' }].concat(props.classroomUrl ? [{ type: 2, style: 5, label: 'Classroom を見る', url: props.classroomUrl }] : []) });\n      }\n    }\n    return {\n      content: mention + title,\n      embeds: [{\n        title: title,\n        description: lines.length ? lines.join('\\n') : (kind === 'evening' ? 'あしたまでの宿題はない。' : 'きょう持っていく宿題はない。'),\n        color: EMBED_COLORS[stageKey] || EMBED_COLORS.calm,\n        footer: { text: FOOTER[stageKey] || FOOTER.calm },\n        timestamp: now.toISOString()\n      }],\n      components: compRows.slice(0, 5),\n      allowed_mentions: { users: props.userId ? [props.userId] : [] }\n    };\n  }\n\n  /** Discord ではこう見える、の見本。props: discordPayload と同じ、または { payload, botName?, time? } */\n  function DiscordPreview(props) {\n    props = props || {};\n    var payload = props.payload || discordPayload(props);\n    var embed = payload.embeds && payload.embeds[0];\n    var hex = embed ? '#' + ('000000' + embed.color.toString(16)).slice(-6) : '#ffe1ef';\n    var buttons = (payload.components && payload.components[0] ? payload.components[0].components : []);\n    var styleName = { 1: 'primary', 2: 'secondary', 3: 'success', 4: 'danger', 5: 'link' };\n    return el('div', { className: 'sk-dc', role: 'img', 'aria-label': 'Discord のメッセージ：' + (embed ? embed.title : '') },\n      el('div', { className: 'sk-dc__avatar', text: '宿', 'aria-hidden': 'true' }),\n      el('div', { className: 'sk-dc__body' },\n        el('div', { className: 'sk-dc__head' },\n          el('span', { className: 'sk-dc__name', text: props.botName || '宿題忘れゼロ' }),\n          el('span', { className: 'sk-dc__bot', text: 'BOT' }),\n          el('span', { className: 'sk-dc__time', text: props.time || 'きょう ' + formatClock(toNow(props.now)) })\n        ),\n        el('p', { className: 'sk-dc__content' }, (payload.content || '').split(/(<@\\w+>)/).map(function (part) {\n          return /^<@\\w+>$/.test(part) ? el('span', { className: 'sk-dc__mention', text: '@あなた' }) : part;\n        })),\n        embed ? el('div', { className: 'sk-dc__embed', style: 'border-left-color:' + hex },\n          el('p', { className: 'sk-dc__title', text: embed.title }),\n          el('p', { className: 'sk-dc__desc' }, embed.description.split('\\n').reduce(function (acc, l, i) { if (i) acc.push(el('br')); acc.push(l); return acc; }, [])),\n          el('p', { className: 'sk-dc__footer', text: embed.footer ? embed.footer.text : '' })\n        ) : null,\n        buttons.length ? el('div', { className: 'sk-dc__buttons' }, buttons.map(function (b) {\n          return el('span', { className: 'sk-dc__btn sk-dc__btn--' + (styleName[b.style] || 'secondary'), text: b.label });\n        })) : null\n      )\n    );\n  }\n  function formatClock(d) {\n    var h = String(d.getHours()), m = String(d.getMinutes());\n    return (h.length < 2 ? '0' + h : h) + ':' + (m.length < 2 ? '0' + m : m);\n  }\n\n  window.Shukudai = {\n    DueChip: DueChip,\n    SubjectTag: SubjectTag,\n    BigButton: BigButton,\n    HomeworkCard: HomeworkCard,\n    TodayHero: TodayHero,\n    QuickAdd: QuickAdd,\n    BringCheck: BringCheck,\n    AllDone: AllDone,\n    NudgeBar: NudgeBar,\n    DiscordPreview: DiscordPreview,\n    CaptureAsk: CaptureAsk,\n    captureAnswered: captureAnswered,\n    captureStatus: captureStatus,\n    captureSubjects: captureSubjects,\n    captureWording: captureWording,\n    isActive: isActive,\n    isOnline: isOnline,\n    isPackedToday: isPackedToday,\n    nextSchoolDay: nextSchoolDay,\n    nextLesson: nextLesson,\n    DEFAULT_PERIODS: DEFAULT_PERIODS,\n    dayPlan: dayPlan,\n    effectiveTimetable: effectiveTimetable,\n    effectiveSchoolDays: effectiveSchoolDays,\n    allSubjects: allSubjects,\n    daySubjects: daySubjects,\n    askableSubjects: askableSubjects,\n    lessonOn: lessonOn,\n    submitPlace: submitPlace,\n    nextClass: nextClass,\n    LOCATION_PRESETS: LOCATION_PRESETS,\n    nudgeStage: nudgeStage,\n    discordPayload: discordPayload,\n    minutesUntilLeave: minutesUntilLeave,\n    icon: icon,\n    dueInfo: dueInfo,\n    formatDate: formatDate,\n    SUBJECTS: SUBJECTS,\n    WHERE_PRESETS: WHERE_PRESETS\n  };\n})();\n"},"/app/icons/icon.svg":{"type":"image/svg+xml","etag":"\"518899d36d073db1\"","body":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\" width=\"512\" height=\"512\">\n  <rect width=\"512\" height=\"512\" rx=\"112\" fill=\"#111111\"/>\n  <rect x=\"96\" y=\"64\" width=\"64\" height=\"384\" rx=\"32\" fill=\"#ffffff\"/>\n  <rect x=\"224\" y=\"64\" width=\"64\" height=\"384\" rx=\"32\" fill=\"#ffffff\"/>\n  <rect x=\"352\" y=\"64\" width=\"64\" height=\"384\" rx=\"32\" fill=\"#ff8fc5\"/>\n  <path d=\"M152 300 L228 376 L392 212\" fill=\"none\" stroke=\"#111111\" stroke-width=\"56\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>\n  <path d=\"M152 300 L228 376 L392 212\" fill=\"none\" stroke=\"#ff8fc5\" stroke-width=\"32\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>\n</svg>\n"},"/app/icons/icon-192.png":{"type":"image/png","etag":"\"b76ed32d06f89694\"","b64":"iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAYAAABS3GwHAAAFH0lEQVR4nOzbz2scZRzH8e/MbrpoW2u0RSuSGKzgKZiLv5B2A5X2qiKIiCZr7NF/QKk16MFz97zbGlEPQsUfR3VRMUG8iFEjoiQlGE0tpGmTze5m5ukzk+52t01Lr8Pn/SK7zGRnc3re+8wzk83XajVngKh88lQsFgMDxCQf/vn2ztTU1C3PBI1G492JiYlJv9k0IMM6ATg//J86dNju3nfPTQ53Nv39N7Z4dv6NSqUyWCqVJvwvGwZkVFcAztYaztxqZFF8g4NzzhotZ8PDw9bff9dL1eqpgfHxsSP+pQ0DMihsbzgXW3PT2XrT2aWN2Hb4NB7an7eBvbl0P3nU/SOKts6UDhx40I4ePXKwWq3O+d3bDcigzgwQx878TzoT3HtnaPv7t14q9AU2MrTDZs82LBn6URTZ9PR0+kgEQTBYqVTXSqVxFtLInJ5ToMTgvj6747brx3LsT4s2Nzdt5LFROzh62PpygR/8fgFQX7cvP/vEgCzqmgHidCX8979NfyoUbXtw6Ef8xeRUyK8DQj/4c/4p9AuG9L1ABvXMAPGVRxRvf0U0yaIVXX0tnwutELjO7AFkTc8M4K6sAVx8awPahc4KO3fPHzv22pABGXRNAC4912+f0fgULHItW20t+ctFeduV32v5sNB5c7MZ1x6+Lz9qQEb1nAIln/tJCMmVnoutZftj9Sv78dxpC/u2FsV7cvfbSP/zNrTrSSuEu08VH9kzbkCGde4DpDPA1jrYlupzNnO+aj+tvN8Z/IkL0aJ993/ZphZePtEe/OVyefDkyTKLAGRS142wZAw7O9f40365cMb+Wqtt+wZ/u2zsg2e+fjvZ/n3JHXri6RfnWQQjq7pmAH8HuLlisyuf28L6zLYH+7mg+NGzM6eT7de/ePWVT+feq6VXjmICQDZ1rQFim/nvY1sMf/UL3+v/yTN0wQMfPvfDQrL9wpnH31pu/nai7pbt23+SPxEakEWdAOr1uoU/77QBe7TnAP8BP3/8+Judy5yTk+9Ug1kba++vBxtWKBQMyKIg+VIAX4iBop4vxACKCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADSCADS0gBqtZozQNBlAAAA//9BVbCBAAAABklEQVQDAAYxVwk6hsgiAAAAAElFTkSuQmCC"},"/app/icons/icon-512.png":{"type":"image/png","etag":"\"d54f56a46f7ddce5\"","b64":"iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAYAAAD0eNT6AAALgElEQVR4nOzdz4+cZQHA8We3WzYKiFWIYgyViIknIhd/xcCSYOCqxsQYo7RWjv4DGkSiB8/03AVr1IMJxh9HdaPGNsaLERVjNIUQUdCEn11225lxZkvXVqrhOvl+Ptl38r477+z1+c7zPDO7trW1NRsAQMra4mFjY2NlAAAJizf/axcvTp48+bpnAnZ2dr5+7NixB+enuwMAWDr7ATCbD/8fueOu8dYb3vZ/bp+NU7/82XjqyTNfOnHixOGjR48em/9yZwAAS+WSAJiNl3dmY/bCZEym/+PmA7Oxc242br311nHo0Fs+s7n58E1Hjtx79/ypVwYAsDRWL57MZtOxe342zu7OxkuvTMdV8zR4z41r46brD+xdL47t+TGZXFgpuOWWd4977rn79s3Nzcfnl28cAMDS2J8BmE5nY/6zNxPw9jevjhsPXXhq/eDKuO3mq8ZjT+6MxdA/mUzGqVOn9o6FlZWVwydObL589OgRGwkBYElctgSwcPiGg+NNb3jtWD6dLwucP39+3PaBO8ftd941Dh5YmQ/+Y+xsnx0//sH3BgCwPC6ZAZju7QT8699350sBkyvevDof8V9cLAWcm83Pxzgwf1idTC+8FgBYGpfNAExfPSbTK38icJEF5yb/eW7twOpYX5ntzx4AAMvhshmA2at7AGbT1zegz1ZnY/3qa8/cd98Xbh4AwNL4rwCY7a31X5zRn6fAmMzOjRfOPT1W57des3b9WFtd33/x7u50673vWLtzAABL5bIlgMX7/kUILHb6v3jumfGnF34yfv3sI2P14IVNgdcdeOe47dAnx83XfHisr1778Mb7rjsyAICls/89AHszABf2AY6ntx8fp/+1OX7z3Df3B/+F5ydPjV/88/g4+cRnH7g4+B8/fvzwQw8dtwkAAJbIJV8EtBjDZ+PZnT+P3z3/6PjLy1tXfMF07N77rY/99KuL8z8+PbvjQx/99BmbAAFguVwyAzAbL+0+Nx577ofjibOnr3jzfC5g4zsfP/3I4vyLP/r8577/+De29j45MBUAALBMLtkDMB2n//Hd8dTq78dk9tp/8rc6W3nXtz/xqycW55969INfeWb3Dw9sz54ZP//b4k+sDgBgeewHwPb29lj97dXjpvH+y26Yv8E/c//9X97/mN+DD35tc+Wxce/F67Mrr4z19fUBACyPla2trdnGxobv8QeAiMXYvzYAgBwBAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAAQJAAAIEgAAECQAACBIAABAkAAAgCABAABBAgAAggQAAATtBcDW1tZsAAAZ/wYAAP//WivsDwAAAAZJREFUAwDGO1wJoqh6OQAAAABJRU5ErkJggg=="},"/app/icons/icon-512-maskable.png":{"type":"image/png","etag":"\"d63367ea760a0944\"","b64":"iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAAJ90lEQVR4nOzdz4ucZwHA8dnNpsEfGDe1aEEitfFWgkFRKNVYUuNNieA/YW8ttSdzqKdaqJjmaBCFgAdloWJiA+LP0FhUFFtQq4VI1WprmrRpNrvZmdfZRIoGCZODMMv38+FleXifOSx7eL/7PM8Ms7S8vDwCoGdpBECSAABECQBAlAAARAkAQJQAAEQJAECUAABECQBAlAAARAkAQJQAAEQJAECUAABECQBAlAAARAkAQJQAAEQJAECUAABECQBAlAAARAkAQJQAAEQJAECUAABECQBAlAAARAkAQJQAAEQJAECUAABECQBAlAAARAkAQJQAAEQJAECUAABECQBAlAAARAkAQJQAAEQJAECUAABECQBAlAAARAkAQJQAAEQJAECUAABEzW8AVlZWRgBb36FDh0Zzaa5XAHP7VwOY0Tz/LzvvW0BHjhy58QtOnDhx8uTJhYWFEQA3Y94DMAyje/bfd+tt7/6fk0//7IcHDhzYtWvX8ePHNQDgpsx/AIY31obhtfF4cv3U0rZh7cqwd+/e/fs/sby86+jRJzQAYHaLo/k2DJP1jeHS+nDx8uSWpdEHbl/a/a5t0/H0Wr08GY+H6Wv27Lnz/vs/f/jw4WktRgDMZt5XAJPJMBk21wHveefi7cubv+2O7Qv77rjl2T+vTR/24/H46aum95eWlh5//CsPPvjACIAZbIEtoOnP9922/R1v+a/tnclktLGxse+j93783vu2b9vc+1lbvfS9J789AmA2878CmEwj8MJL6+sb4+umFhcWXp9uBF0ZFhdG2xYXFseTzRcDMJstsAKYXL3Gk+v396dBuDL+982lbYs7FgZnAACz2wIrgOHqGcAwudHDfVgczp1/9eGHvzACYDbz/i6gqwEYpls7167pOmB9vP7K5bPnLv9lfWPtzfu//Pnpzx780AiAmW2BLaDhagbG4/HrV/7x+9d+8MzL31jcvnkgvHPbe/ctf+6Ot999+tT3n3j0oREAN2MrrAA2j4FHf1v93Zl/fv0X57957ek/dWH84k9fOfrFr37y2tN/586djzzypREAs5n/D4JNFwDDy2vP//bCyp/e+NF1s78+dvb5J1+aDj744bu/89SvHAIDzG4LfBDs4vr5Z1e/e/bSmeumnnn07Kt/WJ0O3n/P7oMPfGzzzUITAQCY1fyfAUzO/P1bLy4+Nx7W//P+jx/64+VzG9PBnZ++dc9n3vrCxdM/+evS/C9oAObHvAdgdXV18Tdv2z36yJt3Lly4cOzY166NDx781F177ho9tzm+tHB5x44dIwBmM+8BeOyxL99g9tSpp6bXCICb5zuBAaIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIEoAAKIEACBKAACiBAAgSgAAogQAIGquA7CysjIC4P9jYXl5eQRAjy0ggCgBAIgSAIAoAQCIEgCAKAEAiBIAgCgBAIgSAIAoAQCIEgCAKAEAiBIAgCgBAIgSAIAoAQCIEgCAKAEAiBIAgCgBAIgSAIAoAQCIEgCAKAEAiBIAgCgBAIgSAIAoAQCIEgCAKAEAiBIAgCgBAIgSAIAoAQCIEgCAKAEAiBIAgCgBAIgSAIAoAQCIEgCAKAEAiBIAgCgBAIgSAIAoAQCIEgCAKAEAiBIAgCgBAIj6FwAAAP//GYRhngAAAAZJREFUAwDWrFcabacbxgAAAABJRU5ErkJggg=="},"/app/":{"type":"text/html; charset=utf-8","etag":"\"0b11d0c62039ba28\"","body":"<!doctype html>\n<html lang=\"ja\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"shukudai-server\" content=\"same-origin\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https:; manifest-src 'self'; base-uri 'none'; form-action 'none'\">\n<meta name=\"referrer\" content=\"no-referrer\">\n<meta name=\"color-scheme\" content=\"light dark\">\n<meta name=\"theme-color\" content=\"#ffffff\" media=\"(prefers-color-scheme: light)\">\n<meta name=\"theme-color\" content=\"#0f0f0f\" media=\"(prefers-color-scheme: dark)\">\n<meta name=\"apple-mobile-web-app-capable\" content=\"yes\">\n<meta name=\"apple-mobile-web-app-title\" content=\"宿題\">\n<title>宿題忘れゼロ</title>\n<link rel=\"manifest\" href=\"manifest.webmanifest\">\n<link rel=\"icon\" href=\"icons/icon.svg\" type=\"image/svg+xml\">\n<link rel=\"apple-touch-icon\" href=\"icons/icon-192.png\">\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n<link rel=\"stylesheet\" href=\"ds/tokens.css\">\n<link rel=\"stylesheet\" href=\"ds/bundle.css\">\n<link rel=\"stylesheet\" href=\"app.css\">\n<script src=\"ds/bundle.js\" defer></script>\n<script type=\"module\" src=\"app.js\"></script>\n</head>\n<body>\n<div id=\"app\" class=\"app\"></div>\n<noscript><p class=\"app\">このアプリは JavaScript が要る。</p></noscript>\n</body>\n</html>\n"}};

// ===== scheduler.js =====
// はしごを上る係。5 分おきに呼ばれ、「いま送るべき催促」を決める。送るのは index.js。

/** UTC の Date を、設定のタイムゾーンの「壁時計」に直す。local は getHours() などがその壁時計を返す Date。 */
function localParts(now, tz = 'Asia/Tokyo') {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = {};
  for (const part of fmt.formatToParts(now)) if (part.type !== 'literal') p[part.type] = +part.value;
  const local = new Date(p.year, p.month - 1, p.day, p.hour, p.minute);
  const dateKey = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  return { y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute, minutes: p.hour * 60 + p.minute, dateKey, local };
}

function inQuietHours(minutes, settings) {
  const from = hhmmToMinutes(settings.quietFrom || '22:00');
  const to = hhmmToMinutes(settings.quietTo || '06:30');
  return from > to ? (minutes >= from || minutes < to) : (minutes >= from && minutes < to);
}

// 朝のはしご。leave = その日の出る時間（分）、wake = 1 通目（履修科目があれば出る 60 分前、なければ設定の起きる時間）
const LADDER = [
  { name: 'wake', at: (leave, wake) => wake, snoozable: true, fresh: 20 },
  { name: 'soon', at: (leave) => leave - 30, snoozable: true, fresh: 20 },
  { name: 'urgent', at: (leave) => leave - 15, snoozable: false, fresh: 20 },
  ...[0, 1, 2, 3, 4, 5].map((k) => ({ name: `late${k}`, at: (leave) => leave + 10 * k, snoozable: false, fresh: 60 }))
];

function liveItems(state) { return state.items.filter((i) => !i.deleted); }

/**
 * planNudges({ state, now }) → { actions: [{ slot, kind, payload }], state }
 * state.nudge.sent に送った段を記録し、同じ段を二度送らない。止まっていた時間の分をまとめて送ることはしない（最後の 1 段だけ）。
 */
// 見回りが遅れても（外から起こす見回りは数分〜十数分ずれることがある）、この分数までなら送る。それより遅れたら古い催促は送らない
const LATE_OK_MIN = 30;

function planNudges({ state, now = new Date() }) {
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
  // その日の予定（履修科目があれば、曜日ごとの出る時間・放課後・授業の終わり）
  const plan = dayPlan(dow, s);
  const isSchoolDay = plan.school;
  const leaveAt = plan.leaveAt || s.leaveAt;
  const leaveMin = hhmmToMinutes(leaveAt);
  const wakeMin = plan.hasCourses ? leaveMin - 60 : hhmmToMinutes(s.wakeAt);
  // 科目が決まっていない（時間割がまだサーバーに届いていない）あいだは、「課題出た？」を聞かない
  const asking = hasSubjects(s);
  const subjects = asking ? daySubjects(D, s) : [];
  const common = { items, today: D, now: lp.local, leaveAt, userId: s.discord.userId || undefined, appUrl: s.appUrl || undefined, capture: st.capture, timetable: effectiveTimetable(s), subjects };
  const snoozed = st.nudge.snoozeUntil && new Date(st.nudge.snoozeUntil) > now;

  // 朝のはしご：学校（授業）のある日だけ。期限がきょう／過ぎていて、まだ入れていないものがあるときだけ
  const pending = nudgeStage({ items, today: D, now: lp.local, leaveAt }).stage !== 'clear';
  if (isSchoolDay) {
    // 授業が始まったら、もう「出る時間すぎた」は言わない（学校に着いている）
    const arriveMin = plan.hasCourses && plan.lessons.length ? hhmmToMinutes(plan.lessons[0].start) : Infinity;
    const due = LADDER.filter((r) => r.at(leaveMin, wakeMin) <= M && r.at(leaveMin, wakeMin) < arriveMin && !sent[key(r.name)]);
    if (due.length) {
      const last = due[due.length - 1];
      for (const r of due) mark(key(r.name));
      const fresh = M - last.at(leaveMin, wakeMin) <= last.fresh;
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

  // 捕まえる（1）：授業が終わって 5 分後、その授業だけ「課題出た？」。いちばん思い出しやすいのは、いま
  for (const l of asking ? plan.lessons : []) {
    const t = hhmmToMinutes(l.end) + 5;
    const slot = key(`class${l.period}`);
    if (M >= t && !sent[slot]) {
      mark(slot);
      const one = captureStatus({ items, capture: st.capture, today: D, subjects: [l.subject] });
      if (M - t <= LATE_OK_MIN && !one.all) actions.push({ slot, kind: 'capture', payload: discordPayload({ ...common, kind: 'capture', subjects: [l.subject], askNo: 0 }) });
    }
  }

  // 捕まえる（2）：放課後に 1 回だけ、まだ答えていない科目をまとめて。あとは夜 20:00 のまとめで聞く。
  // 毎回課題が出るわけではないので、追いかけ回さない。しつこくしたいときだけ captureNag: true（30 分おき ×3 → 1 時間おき）
  const cst = captureStatus({ items, capture: st.capture, today: D, subjects });
  if (isSchoolDay && asking && !cst.all) {
    const base = hhmmToMinutes(plan.afterSchoolAt);
    const nag = s.captureNag === true;
    const step = Math.max(10, +s.captureRepeatMinutes || 30), max = nag ? Math.max(1, +s.captureMax || 3) : 1;
    const quietFrom = hhmmToMinutes(s.quietFrom || '22:00');
    const rungs = [];
    for (let k = 0; k < max; k++) rungs.push({ name: `capture${k}`, k, at: base + step * k });
    if (nag && s.captureHourlyUntilQuiet !== false) {
      let t = base + step * (max - 1) + 60, j = max;
      while (t < quietFrom && j < max + 8) { rungs.push({ name: `capture${j}`, k: j, at: t }); t += 60; j++; }
    }
    const dueRungs = rungs.filter((r) => r.at <= M && !sent[key(r.name)]);
    if (dueRungs.length) {
      const last = dueRungs[dueRungs.length - 1];
      for (const r of dueRungs) mark(key(r.name));
      if (M - last.at <= LATE_OK_MIN) actions.push({ slot: key(last.name), kind: 'capture', payload: discordPayload({ ...common, kind: 'capture', askNo: last.k + 1 }) });
    }
  }

  // 学校を出る前：学校（机・ロッカー）にあるものを、かばんへ
  if (isSchoolDay && plan.leaveSchoolAt) {
    const t = hhmmToMinutes(plan.leaveSchoolAt);
    const slot = key('leaveschool');
    if (M >= t && M < t + LATE_OK_MIN && !sent[slot]) {
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
    if (M >= t && M < t + LATE_OK_MIN && !sent[key(name)]) {
      mark(key(name));
      const askAgainOnNone = isSchoolDay && name === 'evening';
      const payload = discordPayload({ ...common, kind: 'evening', askAgainOnNone, classroomUrl: s.classroomUrl || undefined, captureMissing: isSchoolDay && asking && !cst.all });
      const tomorrow = addDays(parseDate(D), 1);
      const left = items.filter((i) => isActive(i) && !i.done && parseDate(i.due) <= tomorrow);
      const missingRange = items.some((i) => isActive(i) && !i.range);
      const askCapture = isSchoolDay && asking && (!cst.all || (cst.allNone && askAgainOnNone));
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
      if (M >= t && M < t + LATE_OK_MIN && !sent[slot]) {
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

// ===== discord.js =====
// Discord とのやりとり：署名の確認、REST、ボタンとスラッシュコマンドの応答。

const API = 'https://discord.com/api/v10';

function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 || /[^0-9a-f]/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Discord からの Interaction の署名（Ed25519）を確かめる。本文は 1 回しか読めないので文字列で返す。 */
async function verifyDiscordRequest(request, publicKeyHex) {
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
class DiscordRest {
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

const SUBJECT_CHOICES = ['国語', '数学', '英語', '理科', '社会', 'その他'].map((s) => ({ name: s, value: s }));
const COMMANDS = [
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
function parseDueWords(text, todayKey, ctx = {}) {
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
async function handleInteraction(interaction, ctx) {
  if (!interaction || interaction.type === 1) return { type: 1 };
  const state = withDefaults(ctx.state);
  const s = state.settings;
  const lp = localParts(ctx.now || new Date(), s.tz);
  const D = lp.dateKey;
  const stamp = now2(lp.local);
  const live = state.items.filter((i) => !i.deleted);
  const touch = (i) => { i.updatedAt = (ctx.now || new Date()).toISOString(); return i; };
  state.nudge.lastInteractionAt = (ctx.now || new Date()).toISOString();
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
        embeds: [{ title: '登録した', description: `・${item.subject}　${item.range}　｜　${item.where ? 'どこ：' + item.where : 'どこ：まだ書いてない'}　｜　${d.getMonth() + 1}/${d.getDate()} まで`, color: 0xff8fc5, footer: { text: item.where ? '宿題忘れゼロ' : '宿題忘れゼロ ・ どこにあるかは、あとでアプリで足せる' } }]
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
      const due = parseDueWords(v.itsu, D, dueCtx(subject));
      const item = newItem(subject, range, String(v.doko || '').trim(), due);
      state.items.push(item);
      setCapture(state, D, subject, 'added');
      await ctx.save(state);
      const d = parseDate(due);
      const cst = askable();
      return reply({
        content: `登録した：${subject}　${range || '（範囲はあとで。夜に聞く）'}　｜　${item.where ? 'どこ：' + item.where : 'どこ：まだ書いてない'}　｜　${d.getMonth() + 1}/${d.getDate()} まで。` + (cst.all ? ' これで全部。' : ` ほかは？ のこり：${cst.unanswered.join('・')}`),
        components: cst.all ? [] : captureRows(cst.unanswered)
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

// ===== index.js =====
// 宿題忘れゼロ — Cloudflare Worker。アプリとの同期 API、Discord の Interactions、5 分おきの催促。

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
      let kv = false, lastRunAt = null, lastRunVia = null, userIdSaved = false;
      try {
        if (env.SHUKUDAI) { const st = await loadState(env); kv = true; lastRunAt = st.nudge.lastRunAt || null; lastRunVia = st.nudge.lastRunVia || null; userIdSaved = !!st.settings.discord.userId; }
      } catch { kv = false; }
      return json(env, { ok: true, checks: { DISCORD_TOKEN: !!env.DISCORD_TOKEN, DISCORD_PUBLIC_KEY: !!env.DISCORD_PUBLIC_KEY, DISCORD_APP_ID: !!env.DISCORD_APP_ID, SYNC_TOKEN: !!env.SYNC_TOKEN, KV: kv }, userIdSaved, lastRunAt, lastRunVia, interactionsUrl: url.origin + '/interactions' });
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
