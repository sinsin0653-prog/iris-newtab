/* @ds-bundle: {"format":4,"namespace":"Shukudai","components":[{"name":"DueChip"},{"name":"SubjectTag"},{"name":"BigButton"},{"name":"HomeworkCard"},{"name":"TodayHero"},{"name":"QuickAdd"},{"name":"BringCheck"},{"name":"AllDone"},{"name":"NudgeBar"},{"name":"DiscordPreview"},{"name":"CaptureAsk"}]} */
/* 宿題忘れゼロ — 依存なしの素の JavaScript。各関数は HTMLElement を返す。
   Shukudai.HomeworkCard({ item, today, onDone }) のように呼び、返った要素を appendChild する。 */
(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var DAY_MS = 86400000;
  var WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

  // ---- 小さな DOM ヘルパー（innerHTML は使わない） ----
  function el(tag, attrs) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'className') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'onClick') node.addEventListener('click', v);
      else if (k === 'onInput') node.addEventListener('input', v);
      else if (k === 'onSubmit') node.addEventListener('submit', v);
      else if (k === 'style') node.setAttribute('style', v);
      else node.setAttribute(k, v === true ? '' : String(v));
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) node.appendChild(typeof x === 'string' ? document.createTextNode(x) : x); });
      else node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  // ---- インラインの線画アイコン（currentColor、丸い端） ----
  var ICON_PATHS = {
    check: 'M6 12.5 L10 16.5 L18 7.5',
    plus: 'M12 5 V19 M5 12 H19',
    clock: 'M12 7 V12 L15.5 14.5 M12 21 A9 9 0 1 0 12 3 A9 9 0 0 0 12 21 Z',
    pin: 'M12 21 C12 21 5 14 5 9.5 A7 7 0 0 1 19 9.5 C19 14 12 21 12 21 Z M12 12 A2.5 2.5 0 1 0 12 7 A2.5 2.5 0 0 0 12 12 Z',
    bag: 'M5 9 H19 A1.5 1.5 0 0 1 20.5 10.5 V19 A1.5 1.5 0 0 1 19 20.5 H5 A1.5 1.5 0 0 1 3.5 19 V10.5 A1.5 1.5 0 0 1 5 9 Z M8.5 9 V7 A3.5 3.5 0 0 1 15.5 7 V9 M3.5 13.5 H20.5',
    book: 'M4 5 H10 A2 2 0 0 1 12 7 A2 2 0 0 1 14 5 H20 V18 H14 A2 2 0 0 0 12 20 A2 2 0 0 0 10 18 H4 Z M12 7 V20',
    undo: 'M9 14 L4 9 L9 4 M4 9 H15 A5 5 0 0 1 15 19 H12',
    close: 'M6 6 L18 18 M18 6 L6 18'
  };
  function icon(name, size) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size || 24));
    svg.setAttribute('height', String(size || 24));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('class', 'sk-icon');
    var p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', ICON_PATHS[name] || ICON_PATHS.book);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '2.5');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(p);
    return svg;
  }

  // ---- 科目 ----
  var SUBJECTS = [
    { key: 'kokugo', label: '国語' },
    { key: 'sugaku', label: '数学' },
    { key: 'eigo', label: '英語' },
    { key: 'rika', label: '理科' },
    { key: 'shakai', label: '社会' },
    { key: 'other', label: 'その他' }
  ];
  function subjectKey(label) {
    for (var i = 0; i < SUBJECTS.length; i++) if (SUBJECTS[i].label === label || SUBJECTS[i].key === label) return SUBJECTS[i].key;
    if (/算数/.test(label)) return 'sugaku';
    return 'other';
  }

  // ---- 日付 ----
  function parseDate(v) {
    if (v instanceof Date) return new Date(v.getFullYear(), v.getMonth(), v.getDate());
    if (typeof v === 'string') {
      var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
      if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
      var d = new Date(v);
      if (!isNaN(d)) return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }
    var now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  function toISO(d) {
    var mm = String(d.getMonth() + 1), dd = String(d.getDate());
    return d.getFullYear() + '-' + (mm.length < 2 ? '0' + mm : mm) + '-' + (dd.length < 2 ? '0' + dd : dd);
  }
  function formatDate(v) {
    var d = parseDate(v);
    return (d.getMonth() + 1) + '/' + d.getDate() + '（' + WEEKDAYS[d.getDay()] + '）';
  }
  function formatDateSpoken(v) {
    var d = parseDate(v);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + WEEKDAYS[d.getDay()] + '曜日';
  }

  /** 日付キー（YYYY-MM-DD）。createdOn / packedOn の比較に使う。 */
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
  function dueInfo(due, today, done, flags) {
    flags = flags || {};
    var t = parseDate(today || new Date());
    var d = parseDate(due);
    var days = Math.round((d - t) / DAY_MS);
    if (flags.submitted) return { state: 'submitted', label: '出した', days: days, icon: 'check', date: formatDate(d), spoken: '出した' };
    if (flags.dropped) return { state: 'dropped', label: '先生に言った', days: days, icon: 'check', date: formatDate(d), spoken: '先生に言った' };
    if (days < 0 && (flags.packed || done)) return { state: 'handin', label: '出した？', days: days, icon: 'bag', date: formatDate(d), spoken: '期限 ' + formatDateSpoken(d) + '、出した？' };
    if (done) return { state: 'done', label: 'できた', days: days, icon: 'check', date: formatDate(d), spoken: 'できた' };
    var label, state;
    if (days < 0) { state = 'overdue'; label = (-days) + '日すぎた'; }
    else if (days === 0) { state = 'today'; label = 'きょう'; }
    else if (days === 1) { state = 'soon'; label = 'あした'; }
    else if (days === 2) { state = 'soon'; label = 'あさって'; }
    else { state = 'later'; label = 'あと' + days + '日'; }
    return { state: state, label: label, days: days, icon: 'clock', date: formatDate(d), spoken: '期限 ' + formatDateSpoken(d) + '、' + label };
  }

  // ---- 部品 ----

  /** 期限チップ。props: { due, today?, done?, size?: 'md'|'lg', showDate? } */
  function DueChip(props) {
    props = props || {};
    var info = dueInfo(props.due, props.today, props.done, props.flags);
    var chip = el('span', {
      className: 'sk-chip sk-chip--' + info.state + (props.size === 'lg' ? ' sk-chip--lg' : ''),
      role: 'img',
      'aria-label': info.spoken
    }, icon(info.icon, props.size === 'lg' ? 28 : 20), el('span', { className: 'sk-chip__text', text: info.label }));
    if (props.showDate && info.state !== 'done') chip.appendChild(el('span', { className: 'sk-chip__date', text: info.date }));
    return chip;
  }

  /** 科目タグ。props: { subject, size?: 'md'|'lg' } */
  function SubjectTag(props) {
    props = props || {};
    var label = props.subject || 'その他';
    return el('span', { className: 'sk-tag sk-tag--' + subjectKey(label) + (props.size === 'lg' ? ' sk-tag--lg' : ''), text: label });
  }

  /** 大きなボタン。props: { label, kind?: 'primary'|'secondary'|'ghost', icon?, full?, type?, disabled?, onClick } */
  function BigButton(props) {
    props = props || {};
    var kind = props.kind || 'primary';
    return el('button', {
      className: 'sk-btn sk-btn--' + kind + (props.full ? ' sk-btn--full' : ''),
      type: props.type || 'button',
      disabled: !!props.disabled,
      onClick: props.onClick
    }, props.icon ? icon(props.icon, 24) : null, el('span', { className: 'sk-btn__label', text: props.label || '' }));
  }

  /** 宿題カード。props: { item, today?, onDone(item, done), onOpen?(item), onSubmit?(item), onDrop?(item) } */
  function HomeworkCard(props) {
    props = props || {};
    var item = props.item || {};
    var flags = { packed: item.packed, submitted: item.submitted, dropped: item.dropped };
    var info = dueInfo(item.due, props.today, item.done, flags);
    var card = el('article', { className: 'sk-card sk-card--' + info.state + (item.done ? ' is-done' : '') + (info.state === 'submitted' || info.state === 'dropped' ? ' is-closed' : '') });

    var check = el('button', {
      className: 'sk-card__check',
      type: 'button',
      'aria-pressed': item.done ? 'true' : 'false',
      'aria-label': item.done ? 'もどす（まだにする）' : 'できた にする'
    }, icon('check', 28));
    check.addEventListener('click', function () {
      var next = !item.done;
      item.done = next;
      card.className = 'sk-card sk-card--' + dueInfo(item.due, props.today, next, flags).state + (next ? ' is-done' : '');
      check.setAttribute('aria-pressed', next ? 'true' : 'false');
      check.setAttribute('aria-label', next ? 'もどす（まだにする）' : 'できた にする');
      if (!window.matchMedia || !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        check.classList.remove('is-pop'); void check.offsetWidth; check.classList.add('is-pop');
      }
      var old = card.querySelector('.sk-chip');
      if (old) old.replaceWith(DueChip({ due: item.due, today: props.today, done: next, flags: flags }));
      if (props.onDone) props.onDone(item, next);
    });

    var where = item.where
      ? el('p', { className: 'sk-card__where' }, icon('pin', 20), el('span', { text: item.where }))
      : el('p', { className: 'sk-card__where is-missing' }, icon('pin', 20), el('span', { text: 'どこにある？まだ書いてない' }));

    var body = el(props.onOpen ? 'button' : 'div', {
      className: 'sk-card__body',
      type: props.onOpen ? 'button' : null,
      onClick: props.onOpen ? function () { props.onOpen(item); } : null
    },
      el('div', { className: 'sk-card__meta' }, SubjectTag({ subject: item.subject }), DueChip({ due: item.due, today: props.today, done: item.done, flags: flags })),
      el('h3', { className: 'sk-card__range' + (item.range ? '' : ' is-missing'), text: item.range || '範囲？まだ書いてない' }),
      where,
      item.location === 'school' && !isPackedToday(item, props.today) ? el('p', { className: 'sk-card__submit', text: '学校にある。帰る前にかばんへ。' }) : null,
      item.submitTo ? el('p', { className: 'sk-card__submit', text: '出すところ：' + item.submitTo }) : null
    );

    card.appendChild(check);
    card.appendChild(body);
    // 期限が来たら「出した」を聞く。期限切れには出口（先生に言った）も
    if ((info.state === 'handin' || info.state === 'overdue') && (props.onSubmit || props.onDrop)) {
      var actions = el('div', { className: 'sk-card__actions' },
        props.onSubmit ? BigButton({ label: '出した', kind: 'secondary', icon: 'check', onClick: function () { props.onSubmit(item); } }) : null,
        props.onDrop ? BigButton({ label: '先生に言った', kind: 'ghost', onClick: function () { props.onDrop(item); } }) : null
      );
      body.appendChild(actions);
    }
    return card;
  }

  /** ホームの主役。props: { item, today?, remaining?, onDone(item), onAdd? } ― item がなければ AllDone を返す。 */
  function TodayHero(props) {
    props = props || {};
    var item = props.item;
    if (!item) return AllDone({ onAdd: props.onAdd });
    var info = dueInfo(item.due, props.today, item.done, { packed: item.packed, submitted: item.submitted, dropped: item.dropped });
    var remaining = props.remaining || 0;
    var hero = el('section', { className: 'sk-hero sk-hero--' + info.state, 'aria-labelledby': 'sk-hero-range' },
      el('p', { className: 'sk-hero__eyebrow', text: info.state === 'overdue' ? 'まずこれ。やりかけでも持っていこう' : 'いま、いちばん近いのはこれ' }),
      DueChip({ due: item.due, today: props.today, done: item.done, size: 'lg', showDate: true, flags: { packed: item.packed, submitted: item.submitted, dropped: item.dropped } }),
      el('h2', { className: 'sk-hero__range' + (item.range ? '' : ' is-missing'), id: 'sk-hero-range', text: item.range || '範囲？まだ書いてない' }),
      el('div', { className: 'sk-hero__meta' },
        SubjectTag({ subject: item.subject, size: 'lg' }),
        el('span', { className: 'sk-hero__where' + (item.where ? '' : ' is-missing') }, icon('pin', 22), el('span', { text: item.where || 'どこにある？まだ書いてない' }))
      ),
      BigButton({ label: 'やった！', kind: 'primary', icon: 'check', full: true, onClick: function () { if (props.onDone) props.onDone(item); } }),
      el('p', { className: 'sk-hero__rest', text: remaining > 0 ? 'ほかに ' + remaining + ' つ。これが終わってから。' : 'これが最後！' })
    );
    return hero;
  }

  var WHERE_PRESETS = ['教科書', 'ノート', 'プリント', 'ワーク', 'Classroom', 'タブレット'];
  var LOCATION_PRESETS = [{ key: 'bag', label: 'かばん' }, { key: 'school', label: '学校（机・ロッカー）' }, { key: 'home', label: '家' }, { key: 'online', label: 'ネット' }];

  /** 次に学校がある日（きょうは含まない）。schoolDays は曜日の配列（0=日）。 */
  function nextSchoolDay(today, schoolDays) {
    var t = parseDate(today || new Date());
    var days = Array.isArray(schoolDays) && schoolDays.length ? schoolDays : [1, 2, 3, 4, 5];
    for (var k = 1; k <= 14; k++) { var d = addDays(t, k); if (days.indexOf(d.getDay()) >= 0) return d; }
    return addDays(t, 1);
  }
  /** 次にその科目の授業がある日。時間割になければ次の学校の日。 */
  function nextLesson(subject, today, timetable, schoolDays) {
    var t = parseDate(today || new Date());
    var tt = timetable || {};
    for (var k = 1; k <= 14; k++) {
      var d = addDays(t, k);
      var list = tt[String(d.getDay())];
      if (Array.isArray(list) && list.indexOf(subject) >= 0) return { date: d, lesson: true };
    }
    return { date: nextSchoolDay(t, schoolDays), lesson: false };
  }

  // ---- 履修科目（大学の時間割）から、曜日ごとの予定を作る ----
  var DEFAULT_PERIODS = { 1: ['09:00', '10:30'], 2: ['10:40', '12:10'], 3: ['13:00', '14:30'], 4: ['14:40', '16:10'], 5: ['16:20', '17:50'], 6: ['18:00', '19:30'] };
  function hm(t) { var m = /^(\d{1,2}):(\d{2})$/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; }
  function hhmmOf(min) { min = ((Math.round(min) % 1440) + 1440) % 1440; var h = Math.floor(min / 60), m = min % 60; return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m; }
  function courseName(c) { return (c && (c.short || c.name)) || ''; }
  function isSlotted(c) { return !!c && c.day !== null && c.day !== undefined && c.day !== '' && !!c.period; }
  function coursesOf(s) { return s && Array.isArray(s.courses) ? s.courses.filter(function (c) { return c && courseName(c); }) : []; }
  /**
   * その曜日の予定。履修科目（settings.courses）があればそこから作り、なければ設定の値を使う。
   * → { hasCourses, school, lessons: [{ subject, name, period, room, teacher, start, end }], leaveAt, afterSchoolAt, leaveSchoolAt }
   * 出る時間 = 最初の授業の開始 − 通学時間（commuteMinutes、既定 60 分）。放課後 = 最後の授業の終わり + 30 分。
   */
  function dayPlan(dow, s) {
    s = s || {};
    var courses = coursesOf(s);
    if (!courses.length) {
      var days = Array.isArray(s.schoolDays) && s.schoolDays.length ? s.schoolDays : [1, 2, 3, 4, 5];
      return { hasCourses: false, school: days.indexOf(dow) >= 0, lessons: [], leaveAt: s.leaveAt || '07:50', afterSchoolAt: (s.afterSchoolByDay || {})[dow] || s.afterSchoolAt || '15:45', leaveSchoolAt: s.leaveSchoolAt || '16:30' };
    }
    var periods = s.periods || DEFAULT_PERIODS;
    var lessons = courses.filter(function (c) { return isSlotted(c) && +c.day === dow && periods[c.period] && hm(periods[c.period][0]) !== null; }).map(function (c) {
      return { subject: courseName(c), name: c.name || courseName(c), period: +c.period, room: c.room || '', teacher: c.teacher || '', start: periods[c.period][0], end: periods[c.period][1] };
    }).sort(function (a, b) { return a.period - b.period; });
    if (!lessons.length) return { hasCourses: true, school: false, lessons: [], leaveAt: null, afterSchoolAt: null, leaveSchoolAt: null };
    var first = lessons[0], last = lessons[lessons.length - 1];
    var commute = (s.commuteMinutes === 0 || +s.commuteMinutes > 0) ? +s.commuteMinutes : 60;
    var leave = (s.leaveByDay || {})[dow] || hhmmOf(hm(first.start) - commute);
    var after = (s.afterSchoolByDay || {})[dow] || hhmmOf(hm(last.end) + 30);
    return { hasCourses: true, school: true, lessons: lessons, leaveAt: leave, afterSchoolAt: after, leaveSchoolAt: hhmmOf(hm(last.end) + 10) };
  }
  /** 曜日 → 科目名（履修科目があればそこから。なければ設定の timetable）。次の授業を探すのに使う。 */
  function effectiveTimetable(s) {
    s = s || {};
    var courses = coursesOf(s);
    if (!courses.length) return s.timetable || {};
    var tt = {};
    courses.forEach(function (c) {
      if (!isSlotted(c)) return;
      var k = String(+c.day), n = courseName(c);
      tt[k] = tt[k] || [];
      if (tt[k].indexOf(n) < 0) tt[k].push(n);
    });
    return tt;
  }
  /** 学校（授業）のある曜日。 */
  function effectiveSchoolDays(s) {
    s = s || {};
    var courses = coursesOf(s);
    if (!courses.length) return Array.isArray(s.schoolDays) && s.schoolDays.length ? s.schoolDays.slice() : [1, 2, 3, 4, 5];
    var out = [];
    courses.forEach(function (c) { if (isSlotted(c) && out.indexOf(+c.day) < 0) out.push(+c.day); });
    return out.sort(function (a, b) { return a - b; });
  }
  /** 科目名の一覧（履修科目があればそこから。曜日のない授業も入る）。 */
  function allSubjects(s) {
    var courses = coursesOf(s);
    if (!courses.length) return SUBJECTS.map(function (x) { return x.label; });
    var out = [];
    courses.forEach(function (c) { var n = courseName(c); if (out.indexOf(n) < 0) out.push(n); });
    return out;
  }
  /** その日に聞く科目：その日の授業（時限順）。週の最後の授業日には、曜日のない授業（集中講義など）も。 */
  function daySubjects(today, s) {
    s = s || {};
    var d = parseDate(today || new Date());
    var courses = coursesOf(s);
    if (!courses.length) return captureSubjects({ today: d, timetable: s.timetable });
    var plan = dayPlan(d.getDay(), s);
    var out = [];
    plan.lessons.forEach(function (l) { if (out.indexOf(l.subject) < 0) out.push(l.subject); });
    var days = effectiveSchoolDays(s);
    if (plan.school && d.getDay() === days[days.length - 1]) courses.forEach(function (c) { if (!isSlotted(c)) { var n = courseName(c); if (out.indexOf(n) < 0) out.push(n); } });
    return out;
  }
  /** いま聞いていい科目：授業が終わって 5 分たったもの。放課後（afterSchoolAt）を過ぎたらその日の全部。 */
  function askableSubjects(today, minutes, s) {
    s = s || {};
    var d = parseDate(today || new Date());
    if (!coursesOf(s).length) return daySubjects(d, s);
    var plan = dayPlan(d.getDay(), s);
    if (!plan.school) return [];
    if (minutes >= hm(plan.afterSchoolAt)) return daySubjects(d, s);
    var out = [];
    plan.lessons.forEach(function (l) { if (hm(l.end) + 5 <= minutes && out.indexOf(l.subject) < 0) out.push(l.subject); });
    return out;
  }
  /** その日のその科目の授業。 */
  function lessonOn(subject, date, s) {
    var d = parseDate(date);
    var plan = dayPlan(d.getDay(), s);
    for (var i = 0; i < plan.lessons.length; i++) if (plan.lessons[i].subject === subject) return plan.lessons[i];
    return null;
  }
  /** 出すところ（授業から作る）：「10/12（月） 2限 B-201」 */
  function submitPlace(subject, due, s) {
    var l = lessonOn(subject, due, s);
    return l ? formatDate(due) + ' ' + l.period + '限' + (l.room ? ' ' + l.room : '') : '';
  }
  /** いま（授業中）か、つぎの授業。きょうもう無ければ null。 */
  function nextClass(now, s) {
    var n = toNow(now);
    var plan = dayPlan(n.getDay(), s);
    var m = n.getHours() * 60 + n.getMinutes();
    for (var i = 0; i < plan.lessons.length; i++) {
      var l = plan.lessons[i];
      if (hm(l.end) > m) return { lesson: l, during: hm(l.start) <= m };
    }
    return null;
  }

  /** さっと登録。props: { today?, subjects?, moreSubjects?（「ほかの授業」に畳む）, wherePresets?, timetable?, schoolDays?, paperSpot?, allowEmptyRange?, initial?, onSubmit(item), onCancel?(draft) } */
  function QuickAdd(props) {
    props = props || {};
    var today = parseDate(props.today || new Date());
    var subjects = props.subjects || SUBJECTS.map(function (s) { return s.label; });
    var init = props.initial || {};
    var state = { subject: init.subject || null, where: Array.isArray(init.whereList) ? init.whereList.slice() : [], due: init.due || null, location: init.location || null, dueChoice: null };

    function choiceGroup(legendText, options, multi, onPick) {
      var group = el('div', { className: 'sk-choices', role: multi ? 'group' : 'radiogroup', 'aria-label': legendText });
      options.forEach(function (opt) {
        var b = el('button', { className: 'sk-choice', type: 'button', role: multi ? null : 'radio', 'aria-checked': 'false', 'aria-pressed': multi ? 'false' : null, text: opt.label }, opt.icon ? icon(opt.icon, 20) : null);
        if (opt.icon) b.insertBefore(b.lastChild, b.firstChild);
        b.addEventListener('click', function () {
          if (!multi) {
            Array.prototype.forEach.call(group.children, function (c) { c.setAttribute('aria-checked', 'false'); c.classList.remove('is-on'); });
            b.setAttribute('aria-checked', 'true'); b.classList.add('is-on');
          } else {
            var on = b.classList.toggle('is-on');
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
          }
          onPick(opt, b.classList.contains('is-on'));
        });
        if (!multi && state.subject && opt.value === state.subject) { b.setAttribute('aria-checked', 'true'); b.classList.add('is-on'); }
        group.appendChild(b);
      });
      return group;
    }

    var rangeInput = el('input', { className: 'sk-input', type: 'text', id: 'sk-range', name: 'range', autocomplete: 'off', enterkeyhint: 'done', placeholder: 'p.24〜27 ／ プリント1枚 ／ ワーク §3', value: init.range || '' });
    var rangeHint = el('p', { className: 'sk-hint', id: 'sk-range-hint', 'aria-live': 'polite' });
    rangeInput.setAttribute('aria-describedby', 'sk-range-hint');

    var whereOther = el('input', { className: 'sk-input sk-input--sub', type: 'text', name: 'whereOther', placeholder: 'ほかの場所（ロッカー、先生の机…）', autocomplete: 'off', value: init.whereOther || '' });
    var paperHint = el('p', { className: 'sk-hint sk-hint--calm', 'aria-live': 'polite' });
    function updatePaperHint() {
      paperHint.textContent = (props.paperSpot && state.where.indexOf('プリント') >= 0) ? '家に着いたら、プリントは「' + props.paperSpot + '」へ。' : '';
    }
    var dateInput = el('input', { className: 'sk-input sk-input--sub', type: 'date', name: 'dueDate', min: toISO(today), hidden: true, 'aria-label': '日付をえらぶ' });
    dateInput.addEventListener('input', function () { state.due = dateInput.value || null; });

    var nextWeek = addDays(today, 7);
    // 既定は「次の○○の授業」。時間割がなければ「次の学校の日」。土曜に登録して日曜に鳴る、を防ぐ
    function defaultDue() {
      var n = state.subject ? nextLesson(state.subject, today, props.timetable, props.schoolDays) : { date: nextSchoolDay(today, props.schoolDays), lesson: false };
      var d = n.date;
      var label = (n.lesson ? '次の' + state.subject : '次の学校の日') + '（' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + WEEKDAYS[d.getDay()] + '）';
      return { label: label, value: toISO(d) };
    }
    var dueGroup = null;
    function buildDueOptions() {
      var def = defaultDue();
      var opts = [def];
      var tomorrow = toISO(addDays(today, 1)), dayAfter = toISO(addDays(today, 2)), week = toISO(nextWeek);
      if (tomorrow !== def.value) opts.push({ label: 'あした', value: tomorrow });
      if (dayAfter !== def.value) opts.push({ label: 'あさって', value: dayAfter });
      if (week !== def.value) opts.push({ label: '来週の' + WEEKDAYS[nextWeek.getDay()] + '曜', value: week });
      opts.push({ label: '日付をえらぶ', value: 'pick' });
      return opts;
    }
    function buildDueGroup() {
      var g = choiceGroup('いつまで', buildDueOptions(), false, function (opt) {
        state.dueChoice = opt.value;
        if (opt.value === 'pick') { dateInput.hidden = false; dateInput.focus(); state.due = dateInput.value || null; }
        else { dateInput.hidden = true; state.due = opt.value; }
      });
      return g;
    }

    var more = (props.moreSubjects || []).filter(function (x) { return subjects.indexOf(x) < 0; });
    var subjectGroup = choiceGroup('科目', subjects.concat(more).map(function (s) { return { label: s, value: s }; }), false, function (opt) {
      state.subject = opt.value;
      if (dueGroup && !state.dueChoice) {
        var fresh = buildDueGroup();
        dueGroup.replaceWith(fresh); dueGroup = fresh;
      }
    });
    var moreBtn = null;
    if (more.length) {
      var hiddenCount = 0;
      Array.prototype.forEach.call(subjectGroup.children, function (c, i) {
        if (i >= subjects.length && c.textContent !== state.subject) { c.hidden = true; hiddenCount++; }
      });
      if (hiddenCount) moreBtn = el('button', { className: 'sk-more', type: 'button', text: 'ほかの授業（' + hiddenCount + '）', onClick: function () {
        Array.prototype.forEach.call(subjectGroup.children, function (c) { c.hidden = false; });
        moreBtn.remove();
      } });
    }

    var form = el('form', { className: 'sk-quick', novalidate: true },
      el('div', { className: 'sk-quick__head' },
        el('h2', { className: 'sk-quick__title', text: 'さっと登録' }),
        props.onCancel ? el('button', { className: 'sk-iconbtn', type: 'button', 'aria-label': 'とじる', onClick: function () { props.onCancel(draft()); } }, icon('close', 24)) : null
      ),
      el('div', { className: 'sk-field' },
        el('p', { className: 'sk-field__label', text: '01 科目' }),
        subjectGroup,
        moreBtn
      ),
      el('div', { className: 'sk-field' },
        el('label', { className: 'sk-field__label', 'for': 'sk-range' }, icon('book', 20), el('span', { text: '02 範囲（ここだけ書く）' })),
        rangeInput, rangeHint
      ),
      el('div', { className: 'sk-field' },
        el('p', { className: 'sk-field__label' }, icon('pin', 20), el('span', { text: '03 どこにある？' })),
        choiceGroup('どこにある', (props.wherePresets || WHERE_PRESETS).map(function (w) { return { label: w, value: w }; }), true, function (opt, on) {
          var i = state.where.indexOf(opt.value);
          if (on && i < 0) state.where.push(opt.value); else if (!on && i >= 0) state.where.splice(i, 1);
          if (/classroom|タブレット|lms|moodle|メール/i.test(opt.value)) { if (on && !state.location) state.location = 'online'; }
          updatePaperHint();
        }),
        whereOther,
        paperHint,
        el('p', { className: 'sk-field__sub', text: 'いま、どこ？' }),
        choiceGroup('いまどこにある', LOCATION_PRESETS.map(function (l) { return { label: l.label, value: l.key }; }), false, function (opt) { state.location = opt.value; })
      ),
      el('div', { className: 'sk-field' },
        el('p', { className: 'sk-field__label' }, icon('clock', 20), el('span', { text: '04 いつまで？' })),
        (function () { dueGroup = buildDueGroup(); return dueGroup; })(),
        dateInput
      ),
      el('div', { className: 'sk-quick__actions' },
        BigButton({ label: 'これで登録', kind: 'primary', icon: 'plus', full: true, type: 'submit' }),
        props.onCancel ? BigButton({ label: 'あとで（書きかけはとっておく）', kind: 'ghost', full: true, onClick: function () { props.onCancel(draft()); } }) : null
      )
    );

    function draft() {
      return { subject: state.subject, range: rangeInput.value, whereList: state.where.slice(), whereOther: whereOther.value, due: state.due, location: state.location };
    }
    function submit(allowEmpty) {
      var range = rangeInput.value.trim();
      if (!range && !allowEmpty) {
        rangeHint.textContent = props.allowEmptyRange ? '範囲が空のまま登録する？ 下の「範囲はあとで」を押す。' : '範囲だけは書いて！（例：p.24〜27）';
        rangeInput.classList.add('is-error');
        rangeInput.focus();
        return;
      }
      rangeHint.textContent = '';
      rangeInput.classList.remove('is-error');
      var where = state.where.slice();
      if (whereOther.value.trim()) where.push(whereOther.value.trim());
      var nowDate = new Date();
      var item = {
        id: 'hw_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        subject: state.subject || 'その他',
        range: range,
        rangeMissing: !range,
        where: where.join('・'),
        location: state.location || (where.length ? 'bag' : null),
        submitTo: '',
        due: state.due || defaultDue().value,
        done: false,
        packed: false,
        createdAt: nowDate.toISOString(),
        createdOn: toISO(nowDate)
      };
      if (props.onSubmit) props.onSubmit(item);
    }
    form.getDraft = draft;
    form.addEventListener('submit', function (e) { e.preventDefault(); submit(false); });
    if (props.allowEmptyRange) {
      var acts = form.querySelector('.sk-quick__actions');
      var later = BigButton({ label: '範囲はあとで（夜に聞く）', kind: 'ghost', full: true, onClick: function () { submit(true); } });
      acts.insertBefore(later, acts.children[1] || null);
    }
    return form;
  }

  /** あさのチェック。props: { items, today?, title?, dateText?, paperSpot?, onToggle(item, packed), onClose? } */
  function BringCheck(props) {
    props = props || {};
    var items = props.items || [];
    var count = el('p', { className: 'sk-bring__count', 'aria-live': 'polite' });
    function updateCount() {
      var packed = items.filter(function (i) { return i.packed; }).length;
      count.textContent = packed === items.length && items.length > 0 ? 'ぜんぶ入れた。いってらっしゃい！' : 'かばんに入れた ' + packed + ' / ' + items.length;
    }
    var list = el('ul', { className: 'sk-bring__list' });
    items.forEach(function (item) {
      var box = el('button', { className: 'sk-bring__box', type: 'button', 'aria-pressed': item.packed ? 'true' : 'false', 'aria-label': (item.subject || '') + ' ' + (item.range || '') + ' をかばんに入れた' }, icon('bag', 26));
      var row = el('li', { className: 'sk-bring__row' + (item.packed ? ' is-packed' : '') },
        box,
        el('div', { className: 'sk-bring__text' },
          el('div', { className: 'sk-bring__meta' }, SubjectTag({ subject: item.subject }), DueChip({ due: item.due, today: props.today, done: item.done, flags: { packed: item.packed, submitted: item.submitted, dropped: item.dropped } })),
          el('p', { className: 'sk-bring__range', text: item.range || '' }),
          el('p', { className: 'sk-bring__status' + (item.done ? '' : ' is-pending'), text: (item.done ? 'できてる。あとは入れるだけ' : 'まだ。やりかけでも持っていこう') + (item.location === 'school' ? '（学校にある）' : '') + (props.paperSpot && /プリント/.test(item.where || '') ? '　プリントは「' + props.paperSpot + '」' : '') })
        )
      );
      box.addEventListener('click', function () {
        item.packed = !item.packed;
        item.packedOn = item.packed ? toISO(parseDate(props.today || new Date())) : null;
        box.setAttribute('aria-pressed', item.packed ? 'true' : 'false');
        row.classList.toggle('is-packed', item.packed);
        updateCount();
        if (props.onToggle) props.onToggle(item, item.packed);
      });
      list.appendChild(row);
    });
    updateCount();
    return el('section', { className: 'sk-bring', 'aria-labelledby': 'sk-bring-title' },
      el('div', { className: 'sk-bring__head' },
        el('div', null,
          el('h2', { className: 'sk-bring__title', id: 'sk-bring-title', text: props.title || 'あさのチェック' }),
          el('p', { className: 'sk-bring__date', text: props.dateText || (formatDate(props.today || new Date()) + ' に持っていくもの') })
        ),
        props.onClose ? el('button', { className: 'sk-iconbtn', type: 'button', 'aria-label': 'とじる', onClick: props.onClose }, icon('close', 24)) : null
      ),
      items.length ? list : el('p', { className: 'sk-bring__empty', text: 'きょう持っていく宿題はない。' }),
      count
    );
  }

  /** 全部終わった。props: { onAdd?, message? } */
  function AllDone(props) {
    props = props || {};
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 160 120');
    svg.setAttribute('width', '160'); svg.setAttribute('height', '120');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'sk-alldone__art');
    [['ellipse', { cx: 50, cy: 70, rx: 46, ry: 40, 'class': 'sk-alldone__blob sk-alldone__blob--pale' }],
     ['ellipse', { cx: 112, cy: 56, rx: 40, ry: 36, 'class': 'sk-alldone__blob sk-alldone__blob--grey' }],
     ['ellipse', { cx: 88, cy: 92, rx: 30, ry: 24, 'class': 'sk-alldone__blob sk-alldone__blob--pink' }],
     ['path', { d: 'M56 66 L74 84 L108 46', fill: 'none', 'stroke-width': '8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'class': 'sk-alldone__check' }]
    ].forEach(function (s) {
      var n = document.createElementNS(SVG_NS, s[0]);
      Object.keys(s[1]).forEach(function (k) { n.setAttribute(k, String(s[1][k])); });
      svg.appendChild(n);
    });
    return el('section', { className: 'sk-alldone' },
      svg,
      el('h2', { className: 'sk-alldone__title', text: 'ぜんぶ終わった！' }),
      el('p', { className: 'sk-alldone__body', text: props.message || 'いまは宿題がない。思い出したら、すぐ入れておこう。' }),
      BigButton({ label: '宿題を追加', kind: 'secondary', icon: 'plus', onClick: props.onAdd })
    );
  }

  // ---- 焦らせる：出発時刻までの残り時間と段階 ----
  function parseTime(hhmm) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
    return m ? { h: +m[1], m: +m[2] } : { h: 7, m: 50 };
  }
  function toNow(v) { return v instanceof Date ? v : (v ? new Date(v) : new Date()); }
  function minutesUntilLeave(leaveAt, now) {
    now = toNow(now);
    var t = parseTime(leaveAt);
    var leave = new Date(now.getFullYear(), now.getMonth(), now.getDate(), t.h, t.m);
    return Math.round((leave - now) / 60000);
  }
  function spanLabel(mins) {
    var a = Math.abs(mins), h = Math.floor(a / 60), m = a % 60;
    var body = a >= 60 ? (h + '時間' + (m ? m + '分' : '')) : (a + '分');
    return mins >= 0 ? 'あと' + body : body + 'すぎた';
  }
  /**
   * 焦らせる段階。items のうち、きょうが期限か期限を過ぎていて、まだ「かばんに入れた」が押されていないものを見る。
   * stage: clear（全部入れた）/ calm（出発 60 分より前）/ soon（60〜16 分前）/ urgent（15 分以内）/ late（出発時刻を過ぎた）
   */
  function nudgeStage(opts) {
    opts = opts || {};
    var now = toNow(opts.now);
    var today = parseDate(opts.today || now);
    var pending = (opts.items || []).filter(function (i) {
      if (!isActive(i) || isOnline(i) || isPackedToday(i, today)) return false;
      var st = dueInfo(i.due, today, false).state;
      return st === 'today' || st === 'overdue';
    });
    var mins = minutesUntilLeave(opts.leaveAt || '07:50', now);
    if (!pending.length) return { stage: 'clear', minutes: mins, label: 'ぜんぶ入れた', items: [], leaveAt: opts.leaveAt || '07:50' };
    pending.sort(function (a, b) { return parseDate(a.due) - parseDate(b.due); });
    var stage = mins > 60 ? 'calm' : mins > 15 ? 'soon' : mins >= 0 ? 'urgent' : 'late';
    return { stage: stage, minutes: mins, label: spanLabel(mins), items: pending, leaveAt: opts.leaveAt || '07:50' };
  }

  var NUDGE_LINES = {
    calm: 'いまのうちに。かばんに入れたら押す。',
    soon: 'そろそろ。やりかけでも入れよう。',
    urgent: 'いますぐ。できてなくても、入れる。',
    late: '出る時間すぎてる。入れて、押して、出よう。'
  };

  /** 焦らせるバー。props: { items, leaveAt?, now?, today?, snoozeLeft?, snoozedUntil?, onPack(item), onDone(item), onSnooze(), onWake() } */
  function NudgeBar(props) {
    props = props || {};
    var n = nudgeStage(props);
    if (props.snoozedUntil && (n.stage === 'calm' || n.stage === 'soon')) {
      var until = new Date(props.snoozedUntil);
      return el('section', { className: 'sk-nudge sk-nudge--snoozed', role: 'status' },
        icon('clock', 24),
        el('p', { className: 'sk-nudge__clear', text: formatClock(until) + ' にもう一度言う。' + (n.items.length ? 'まだ ' + n.items.length + ' つ。' : '') }),
        BigButton({ label: 'いまやる', kind: 'ghost', onClick: props.onWake })
      );
    }
    if (n.stage === 'clear') {
      return el('section', { className: 'sk-nudge sk-nudge--clear', role: 'status' },
        icon('check', 28),
        el('p', { className: 'sk-nudge__clear', text: 'ぜんぶ入れた。いってらっしゃい！' }));
    }
    var first = n.items[0];
    var rest = n.items.length - 1;
    var canSnooze = (n.stage === 'calm' || n.stage === 'soon') && (props.snoozeLeft === undefined || props.snoozeLeft > 0);
    var bar = el('section', { className: 'sk-nudge sk-nudge--' + n.stage, role: n.stage === 'urgent' || n.stage === 'late' ? 'alert' : 'status', 'aria-live': 'polite' },
      el('p', { className: 'sk-nudge__eyebrow', text: '出る時間 ' + n.leaveAt + ' まで' }),
      el('p', { className: 'sk-nudge__count' + (n.label.length >= 6 ? ' sk-nudge__count--long' : n.label.length === 5 ? ' sk-nudge__count--mid' : ''), text: n.label }),
      el('div', { className: 'sk-nudge__item' },
        SubjectTag({ subject: first.subject }),
        el('span', { className: 'sk-nudge__range', text: first.range || '' }),
        el('span', { className: 'sk-nudge__state', text: first.done ? 'できてる' : 'まだ' })
      ),
      el('p', { className: 'sk-nudge__line', text: NUDGE_LINES[n.stage] + (rest > 0 ? ' ほかに ' + rest + ' つ。' : '') }),
      el('div', { className: 'sk-nudge__actions' },
        BigButton({ label: n.items.length > 1 ? first.subject + '、入れた' : 'かばんに入れた', kind: 'primary', icon: 'bag', full: true, onClick: function () { if (props.onPack) props.onPack(first); } }),
        canSnooze ? BigButton({ label: '10分あとで' + (props.snoozeLeft !== undefined ? '（あと ' + props.snoozeLeft + ' 回）' : ''), kind: 'ghost', full: true, onClick: props.onSnooze }) : null
      )
    );
    return bar;
  }

  // ---- 捕まえる：そもそも登録し忘れないために、こっちから聞く ----
  function createdOn(item) {
    if (!item) return null;
    if (item.createdOn) return item.createdOn;
    return item.createdAt ? toISO(new Date(item.createdAt)) : null;
  }
  /**
   * きょうの分を科目ごとに見る。capture[日付] は { 科目: 'added'|'none' }（古い形：'none'/'added' の文字列＝全部）。
   * きょう作った宿題は、その科目を 'added' にする。
   * → { subjects, answered: {科目: 'added'|'none'}, unanswered: [...], all: 全部答えた, allNone: 全部なし, anyAdded }
   */
  function captureStatus(opts) {
    opts = opts || {};
    var today = parseDate(opts.today || new Date());
    var key = toISO(today);
    var subjects = captureSubjects({ today: today, timetable: opts.timetable, subjects: opts.subjects });
    var raw = (opts.capture || {})[key];
    var answered = {};
    if (raw === 'none' || raw === 'added') subjects.forEach(function (sub) { answered[sub] = raw; });
    else if (raw && typeof raw === 'object') {
      Object.keys(raw).forEach(function (k) { if (k !== '*') answered[k] = raw[k]; });
      if (raw['*']) subjects.forEach(function (sub) { if (!answered[sub]) answered[sub] = raw['*']; });
    }
    (opts.items || []).forEach(function (i) {
      if (!i.deleted && createdOn(i) === key) answered[i.subject] = 'added';
    });
    var unanswered = subjects.filter(function (sub) { return answered[sub] !== 'added' && answered[sub] !== 'none'; });
    var anyAdded = Object.keys(answered).some(function (k) { return answered[k] === 'added'; });
    return { key: key, subjects: subjects, answered: answered, unanswered: unanswered, all: unanswered.length === 0, allNone: unanswered.length === 0 && !anyAdded, anyAdded: anyAdded };
  }
  /** 全部答えたら 'added'（何か登録した）か 'none'（全部なし）。まだなら null。 */
  function captureAnswered(opts) {
    var st = captureStatus(opts);
    if (!st.all) return null;
    return st.anyAdded ? 'added' : 'none';
  }
  /** きょう聞く科目。時間割があればその日の科目、なければ 6 科目。 */
  function captureSubjects(opts) {
    opts = opts || {};
    if (Array.isArray(opts.subjects)) return opts.subjects.slice(0, 7);
    var today = parseDate(opts.today || new Date());
    var tt = opts.timetable || {};
    var list = tt[String(today.getDay())];
    if (Array.isArray(list) && list.length) return list.slice(0, 7);
    return SUBJECTS.map(function (s) { return s.label; });
  }
  /** 聞き方は回を追うごとに変える（同じ文は慣れる）。 */
  function captureWording(askNo, today, subs) {
    var d = parseDate(today || new Date());
    if (askNo === 0) return (subs.length ? subs.join('・') + '、おわった。' : '') + '課題出た？';
    if (askNo <= 1) return 'きょう、宿題出た？';
    if (askNo === 2) return WEEKDAYS[d.getDay()] + '曜。' + subs.join('・') + '。どれか出た？';
    if (askNo === 3) return 'まだ答えてない。Classroom と連絡帳を開いて確かめて。';
    return 'まだ ' + subs.join('・') + ' が答えてない。見て押すだけ。';
  }

  /**
   * 放課後の「きょう、宿題出た？」。科目ごとに「出た／なし」。
   * props: { items?, capture?, timetable?, subjects?, today?, asked?（0 は授業の直後）, handin?: items, onPick(subject), onNone(subject), onNoneAll(), onReopen(), onSubmit(item), onDrop(item) }
   */
  function CaptureAsk(props) {
    props = props || {};
    var st = captureStatus(props);
    var asked = props.asked === 0 ? 0 : (props.asked || 1);
    var handin = (props.handin || []);
    var handinRows = handin.length ? el('div', { className: 'sk-capture__handin' },
      el('p', { className: 'sk-capture__sub', text: '持っていったぶん、出した？' }),
      handin.map(function (item) {
        return el('div', { className: 'sk-capture__row' },
          SubjectTag({ subject: item.subject }),
          el('span', { className: 'sk-capture__name', text: item.range || '' }),
          el('button', { className: 'sk-choice sk-choice--yes', type: 'button', text: '出した', onClick: function () { if (props.onSubmit) props.onSubmit(item); } }),
          dueInfo(item.due, props.today, item.done, { packed: item.packed }).state === 'handin' && props.onDrop ? el('button', { className: 'sk-choice', type: 'button', text: '先生に言った', onClick: function () { props.onDrop(item); } }) : null
        );
      })) : null;
    if (st.all) {
      return el('section', { className: 'sk-capture sk-capture--done', role: 'status' },
        el('div', { className: 'sk-capture__doneRow' },
          icon('check', 28),
          el('p', { className: 'sk-capture__done', text: st.anyAdded ? 'きょうの分、入れた。えらい。' : 'きょうは宿題なし。OK。' }),
          props.onReopen ? el('button', { className: 'sk-choice', type: 'button', text: 'やっぱりあった', onClick: props.onReopen }) : null
        ),
        handinRows);
    }
    return el('section', { className: 'sk-capture' + (asked >= 3 ? ' sk-capture--again' : ''), role: asked >= 3 ? 'alert' : 'status' },
      el('p', { className: 'sk-capture__eyebrow', text: asked === 0 ? '授業のあと' : asked > 1 ? '放課後のチェック ・ ' + asked + ' 回目' : '放課後のチェック' }),
      el('h2', { className: 'sk-capture__title', text: captureWording(asked, props.today, st.unanswered) }),
      el('p', { className: 'sk-capture__line', text: '科目ごとに「出た」か「なし」。出たら 10 秒で登録、範囲はあとでもいい。' }),
      el('div', { className: 'sk-capture__rows', role: 'group', 'aria-label': '科目ごとの答え' }, st.unanswered.map(function (sub) {
        return el('div', { className: 'sk-capture__row' },
          el('span', { className: 'sk-capture__name', text: sub }),
          el('button', { className: 'sk-choice sk-choice--yes', type: 'button', text: '出た', 'aria-label': sub + '：出た', onClick: function () { if (props.onPick) props.onPick(sub); } }),
          el('button', { className: 'sk-choice', type: 'button', text: 'なし', 'aria-label': sub + '：なし', onClick: function () { if (props.onNone) props.onNone(sub); } })
        );
      })),
      Object.keys(st.answered).length ? el('p', { className: 'sk-capture__sub', text: '答えた：' + st.subjects.filter(function (x) { return st.answered[x]; }).map(function (x) { return x + (st.answered[x] === 'added' ? '（入れた）' : '（なし）'); }).join('、') }) : null,
      st.unanswered.length > 1 && props.onNoneAll ? BigButton({ label: 'のこりは ぜんぶ なし', kind: 'ghost', full: true, onClick: props.onNoneAll }) : null,
      handinRows
    );
  }

  // ---- Discord へ送るメッセージ ----
  // Discord はほぼダークテーマ：黒の帯は見えないので、late と overdue は白（ink のダーク値）
  var EMBED_COLORS = { calm: 0xffe1ef, soon: 0xffe1ef, urgent: 0xff8fc5, late: 0xf5f5f5, evening: 0xffe1ef, overdue: 0xf5f5f5, clear: 0xf2f2f2 };
  var FOOTER = { calm: '宿題忘れゼロ', soon: '宿題忘れゼロ ・ 15 分前にもう一度言う', urgent: '宿題忘れゼロ ・ 押すまで 10 分ごとに言う', late: '宿題忘れゼロ ・ 押すまで 10 分ごとに言う', evening: '宿題忘れゼロ ・ まだなら 21:30 にもう一度', overdue: '宿題忘れゼロ ・ 出すか、先生に言うまで', clear: '宿題忘れゼロ' };

  function itemLine(i, today) {
    var d = dueInfo(i.due, today, i.done, { packed: i.packed });
    var status = d.state === 'handin' ? '持っていった → 出した？' : (i.done ? 'できてる' : 'まだ') + (d.state === 'overdue' ? '（' + d.label + '）' : '');
    return '・' + (i.subject || '') + '　' + (i.range || '範囲？') + '　｜　' + (i.where ? 'どこ：' + i.where : 'どこ：まだ書いてない') + (i.location === 'school' ? '（学校）' : '') + '　｜　' + status;
  }

  /**
   * Discord の Webhook / Bot に渡す JSON。kind: 'evening'（前日 20:00）/ 'morning'（出発前、nudgeStage の段階で色と言葉が変わる）/ 'overdue'（期限を過ぎた夕方）。
   * props: { kind, items, today?, now?, leaveAt?, userId?, appUrl? }
   */
  function discordPayload(props) {
    props = props || {};
    var now = toNow(props.now);
    var today = parseDate(props.today || now);
    var kind = props.kind || 'morning';
    var live = (props.items || []).filter(function (i) { return !i.deleted; });
    var items, title, stageKey, mention = '', est = null;
    if (kind === 'evening') {
      var tomorrow = addDays(today, 1);
      items = live.filter(function (i) { return isActive(i) && !i.done && parseDate(i.due) <= tomorrow; });
      title = 'あしたまで ' + items.length + ' つ。いまのうちに。';
      est = (props.capture !== undefined || props.timetable || props.subjects) ? captureStatus({ items: live, capture: props.capture, today: today, timetable: props.timetable, subjects: props.subjects }) : null;
      if (est && !est.all) title = 'まだ答えてない科目：' + est.unanswered.join('・') + '。出た？ ' + (items.length ? title : '');
      else if (est && est.allNone && props.askAgainOnNone) title = 'きょうは全部「なし」。ほんとに？ Classroom は見た？ ' + (items.length ? title : '');
      else if (props.captureMissing) title = 'きょう登録ゼロ。ほんとに宿題なし？ ' + (items.length ? title : '');
      stageKey = 'evening';
    } else if (kind === 'capture') {
      var cst = captureStatus({ items: live, capture: props.capture, today: today, timetable: props.timetable, subjects: props.subjects });
      var subs = cst.unanswered;
      var askNo = props.askNo === 0 ? 0 : (props.askNo || 1);
      title = captureWording(askNo, today, subs);
      var rows = [];
      var caps = [];
      subs.forEach(function (sub) { caps.push({ type: 2, style: 2, label: sub + '：出た', custom_id: 'cap:' + sub }); caps.push({ type: 2, style: 2, label: sub + '：なし', custom_id: 'capno:' + sub }); });
      for (var r = 0; r < caps.length && rows.length < 3; r += 5) rows.push({ type: 1, components: caps.slice(r, r + 5) });
      // 持っていったぶん、出した？
      var handin = live.filter(function (i) { return isActive(i) && i.packed && parseDate(i.due) <= today; }).slice(0, 2);
      if (handin.length) rows.push({ type: 1, components: handin.map(function (i) { return { type: 2, style: 3, label: '出した：' + i.subject, custom_id: 'submit:' + i.id }; }) });
      var tail = [];
      if (subs.length > 1) tail.push({ type: 2, style: 2, label: 'のこりは ぜんぶ なし', custom_id: 'capnone' });
      if (props.appUrl) tail.push({ type: 2, style: 5, label: 'アプリで登録', url: props.appUrl });
      if (tail.length && rows.length < 5) rows.push({ type: 1, components: tail });
      var desc = '科目ごとに「出た」か「なし」。「出た」→ 範囲とどこにあるかを書く（範囲は空でもいい）。';
      if (Object.keys(cst.answered).length) desc += '\n答えた：' + cst.subjects.filter(function (x) { return cst.answered[x]; }).map(function (x) { return x + (cst.answered[x] === 'added' ? '（入れた）' : '（なし）'); }).join('、');
      if (handin.length) desc += '\n持っていったぶん：' + handin.map(function (i) { return i.subject + ' ' + (i.range || ''); }).join('、') + ' → 出した？';
      return {
        content: ((askNo >= 3 && props.userId) ? '<@' + props.userId + '> ' : '') + title,
        embeds: [{ title: title, description: desc, color: askNo >= 3 ? 0xff8fc5 : 0xffe1ef, footer: { text: '宿題忘れゼロ ・ 放課後のチェック' }, timestamp: now.toISOString() }],
        components: rows,
        allowed_mentions: { users: props.userId ? [props.userId] : [] }
      };
    } else if (kind === 'overdue') {
      items = live.filter(function (i) { return isActive(i) && parseDate(i.due) < today; });
      var notDone = items.filter(function (i) { return !i.done && !i.packed; }).length;
      title = notDone ? '出してないのが ' + items.length + ' つ。あしたの朝いちで出そう。' : '持っていったぶん ' + items.length + ' つ、出した？';
      stageKey = 'overdue';
      mention = (props.userId && !props.quietMention) ? '<@' + props.userId + '> ' : '';
    } else {
      var n = nudgeStage({ items: live, today: today, now: now, leaveAt: props.leaveAt });
      items = n.items;
      stageKey = n.stage;
      if (n.stage === 'clear') { title = 'ぜんぶ入れた。いってらっしゃい！'; }
      else if (n.stage === 'late') { title = '出る時間 ' + n.leaveAt + ' を ' + n.label + '。かばんに入れた？'; mention = props.userId ? '<@' + props.userId + '> ' : ''; }
      else { title = '出るまで ' + n.label + '。' + (n.stage === 'urgent' ? 'いますぐ入れる。' : 'きょう持っていくもの ' + items.length + ' つ。'); mention = (n.stage === 'urgent' && props.userId) ? '<@' + props.userId + '> ' : ''; }
    }
    var lines = items.map(function (i) { return itemLine(i, today); });
    var missing = kind === 'evening' ? live.filter(function (i) { return isActive(i) && !i.range; }).slice(0, 3) : [];
    if (missing.length) lines.push('範囲が空：' + missing.map(function (i) { return i.subject; }).join('・') + ' → 下の「範囲を書く」');
    var compRows = [];
    var row1 = [];
    if (items.length) {
      if (kind === 'overdue') {
        items.slice(0, 2).forEach(function (i) { row1.push({ type: 2, style: 3, label: '出した：' + i.subject, custom_id: 'submit:' + i.id }); row1.push({ type: 2, style: 2, label: '先生に言った：' + i.subject, custom_id: 'drop:' + i.id }); });
      } else if (items.length > 1 && items.length <= 4) {
        items.forEach(function (i) { row1.push({ type: 2, style: 3, label: '入れた：' + i.subject, custom_id: 'pack:' + i.id }); });
      } else {
        row1.push({ type: 2, style: 3, label: 'かばんに入れた', custom_id: 'pack:' + items.map(function (i) { return i.id; }).join(',') });
      }
      if (kind !== 'overdue') row1.push({ type: 2, style: 2, label: 'やった', custom_id: 'done:' + items[0].id });
      compRows.push({ type: 1, components: row1.slice(0, 5) });
      var row2 = [];
      if (stageKey === 'calm' || stageKey === 'soon' || stageKey === 'evening') row2.push({ type: 2, style: 2, label: '10分あとで', custom_id: 'snooze:' + items[0].id });
      if (props.appUrl) row2.push({ type: 2, style: 5, label: 'アプリで見る', url: props.appUrl });
      if (row2.length) compRows.push({ type: 1, components: row2 });
    }
    if (kind === 'evening') {
      if (missing.length) compRows.push({ type: 1, components: missing.map(function (i) { return { type: 2, style: 2, label: '範囲を書く：' + i.subject, custom_id: 'fix:' + i.id }; }) });
      if (est && !est.all) {
        var capBtns = [];
        est.unanswered.slice(0, 2).forEach(function (sub) { capBtns.push({ type: 2, style: 2, label: sub + '：出た', custom_id: 'cap:' + sub }); capBtns.push({ type: 2, style: 2, label: sub + '：なし', custom_id: 'capno:' + sub }); });
        compRows.push({ type: 1, components: capBtns.slice(0, 5) });
      } else if (est && est.allNone && props.askAgainOnNone) {
        compRows.push({ type: 1, components: [{ type: 2, style: 2, label: 'やっぱりあった', custom_id: 'capreopen' }].concat(props.classroomUrl ? [{ type: 2, style: 5, label: 'Classroom を見る', url: props.classroomUrl }] : []) });
      }
    }
    return {
      content: mention + title,
      embeds: [{
        title: title,
        description: lines.length ? lines.join('\n') : (kind === 'evening' ? 'あしたまでの宿題はない。' : 'きょう持っていく宿題はない。'),
        color: EMBED_COLORS[stageKey] || EMBED_COLORS.calm,
        footer: { text: FOOTER[stageKey] || FOOTER.calm },
        timestamp: now.toISOString()
      }],
      components: compRows.slice(0, 5),
      allowed_mentions: { users: props.userId ? [props.userId] : [] }
    };
  }

  /** Discord ではこう見える、の見本。props: discordPayload と同じ、または { payload, botName?, time? } */
  function DiscordPreview(props) {
    props = props || {};
    var payload = props.payload || discordPayload(props);
    var embed = payload.embeds && payload.embeds[0];
    var hex = embed ? '#' + ('000000' + embed.color.toString(16)).slice(-6) : '#ffe1ef';
    var buttons = (payload.components && payload.components[0] ? payload.components[0].components : []);
    var styleName = { 1: 'primary', 2: 'secondary', 3: 'success', 4: 'danger', 5: 'link' };
    return el('div', { className: 'sk-dc', role: 'img', 'aria-label': 'Discord のメッセージ：' + (embed ? embed.title : '') },
      el('div', { className: 'sk-dc__avatar', text: '宿', 'aria-hidden': 'true' }),
      el('div', { className: 'sk-dc__body' },
        el('div', { className: 'sk-dc__head' },
          el('span', { className: 'sk-dc__name', text: props.botName || '宿題忘れゼロ' }),
          el('span', { className: 'sk-dc__bot', text: 'BOT' }),
          el('span', { className: 'sk-dc__time', text: props.time || 'きょう ' + formatClock(toNow(props.now)) })
        ),
        el('p', { className: 'sk-dc__content' }, (payload.content || '').split(/(<@\w+>)/).map(function (part) {
          return /^<@\w+>$/.test(part) ? el('span', { className: 'sk-dc__mention', text: '@あなた' }) : part;
        })),
        embed ? el('div', { className: 'sk-dc__embed', style: 'border-left-color:' + hex },
          el('p', { className: 'sk-dc__title', text: embed.title }),
          el('p', { className: 'sk-dc__desc' }, embed.description.split('\n').reduce(function (acc, l, i) { if (i) acc.push(el('br')); acc.push(l); return acc; }, [])),
          el('p', { className: 'sk-dc__footer', text: embed.footer ? embed.footer.text : '' })
        ) : null,
        buttons.length ? el('div', { className: 'sk-dc__buttons' }, buttons.map(function (b) {
          return el('span', { className: 'sk-dc__btn sk-dc__btn--' + (styleName[b.style] || 'secondary'), text: b.label });
        })) : null
      )
    );
  }
  function formatClock(d) {
    var h = String(d.getHours()), m = String(d.getMinutes());
    return (h.length < 2 ? '0' + h : h) + ':' + (m.length < 2 ? '0' + m : m);
  }

  window.Shukudai = {
    DueChip: DueChip,
    SubjectTag: SubjectTag,
    BigButton: BigButton,
    HomeworkCard: HomeworkCard,
    TodayHero: TodayHero,
    QuickAdd: QuickAdd,
    BringCheck: BringCheck,
    AllDone: AllDone,
    NudgeBar: NudgeBar,
    DiscordPreview: DiscordPreview,
    CaptureAsk: CaptureAsk,
    captureAnswered: captureAnswered,
    captureStatus: captureStatus,
    captureSubjects: captureSubjects,
    captureWording: captureWording,
    isActive: isActive,
    isOnline: isOnline,
    isPackedToday: isPackedToday,
    nextSchoolDay: nextSchoolDay,
    nextLesson: nextLesson,
    DEFAULT_PERIODS: DEFAULT_PERIODS,
    dayPlan: dayPlan,
    effectiveTimetable: effectiveTimetable,
    effectiveSchoolDays: effectiveSchoolDays,
    allSubjects: allSubjects,
    daySubjects: daySubjects,
    askableSubjects: askableSubjects,
    lessonOn: lessonOn,
    submitPlace: submitPlace,
    nextClass: nextClass,
    LOCATION_PRESETS: LOCATION_PRESETS,
    nudgeStage: nudgeStage,
    discordPayload: discordPayload,
    minutesUntilLeave: minutesUntilLeave,
    icon: icon,
    dueInfo: dueInfo,
    formatDate: formatDate,
    SUBJECTS: SUBJECTS,
    WHERE_PRESETS: WHERE_PRESETS
  };
})();
