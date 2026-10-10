// 宿題忘れゼロ — Cloudflare Worker（1 ファイル版）
// このファイルは worker/scripts/build-single.mjs が src/ から作る。直すときは src/ を直して作り直す。
//
// 使い方（ブラウザだけ）：Cloudflare → Workers & Pages → 自分の Worker →「コードを編集」→
// 中身を全部消して、このファイルの中身を全部貼る →「デプロイ」。
// 要るもの：KV のバインディング SHUKUDAI、シークレット DISCORD_TOKEN / DISCORD_PUBLIC_KEY / DISCORD_APP_ID / SYNC_TOKEN、
// Cron トリガー */5 * * * *。準備ができたか、つながったかは https://<Worker の URL>/setup で見る。

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
  if (askNo === 3) return 'まだ答えてない。Classroom と連絡帳を開いて確かめて。';
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
    else if (est && est.allNone && props.askAgainOnNone) title = 'きょうは全部「なし」。ほんとに？ Classroom は見た？ ' + (items.length ? title : '');
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
    <p class="note">Worker の「Settings」→「Trigger Events」→「Cron Triggers」に */5 * * * * を入れる。5 分たってこのページを読み直すと、時刻が出る。</p>
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
    $('cron').textContent = h.lastRunAt ? '最後に見回った：' + new Date(h.lastRunAt).toLocaleString('ja-JP') : 'まだ一度も見回っていない。';
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
  const subjects = daySubjects(D, s);
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
  for (const l of plan.lessons) {
    const t = hhmmToMinutes(l.end) + 5;
    const slot = key(`class${l.period}`);
    if (M >= t && !sent[slot]) {
      mark(slot);
      const one = captureStatus({ items, capture: st.capture, today: D, subjects: [l.subject] });
      if (M - t <= 20 && !one.all) actions.push({ slot, kind: 'capture', payload: discordPayload({ ...common, kind: 'capture', subjects: [l.subject], askNo: 0 }) });
    }
  }

  // 捕まえる（2）：放課後、その日の科目ごとに答え終わるまで。30 分おきに 3 回、そのあとは 1 時間おきに静かな時間まで
  const cst = captureStatus({ items, capture: st.capture, today: D, subjects });
  if (isSchoolDay && !cst.all) {
    const base = hhmmToMinutes(plan.afterSchoolAt);
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
  if (isSchoolDay && plan.leaveSchoolAt) {
    const t = hhmmToMinutes(plan.leaveSchoolAt);
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
