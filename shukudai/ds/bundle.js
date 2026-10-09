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

  /** 期限の状態。色・言葉・アイコンの 3 点セットの元。 */
  function dueInfo(due, today, done) {
    var t = parseDate(today || new Date());
    var d = parseDate(due);
    var days = Math.round((d - t) / DAY_MS);
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
    var info = dueInfo(props.due, props.today, props.done);
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

  /** 宿題カード。props: { item, today?, onDone(item, done), onOpen?(item) } */
  function HomeworkCard(props) {
    props = props || {};
    var item = props.item || {};
    var info = dueInfo(item.due, props.today, item.done);
    var card = el('article', { className: 'sk-card sk-card--' + info.state + (item.done ? ' is-done' : '') });

    var check = el('button', {
      className: 'sk-card__check',
      type: 'button',
      'aria-pressed': item.done ? 'true' : 'false',
      'aria-label': item.done ? 'もどす（まだにする）' : 'できた にする'
    }, icon('check', 28));
    check.addEventListener('click', function () {
      var next = !item.done;
      item.done = next;
      card.className = 'sk-card sk-card--' + dueInfo(item.due, props.today, next).state + (next ? ' is-done' : '');
      check.setAttribute('aria-pressed', next ? 'true' : 'false');
      check.setAttribute('aria-label', next ? 'もどす（まだにする）' : 'できた にする');
      if (!window.matchMedia || !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        check.classList.remove('is-pop'); void check.offsetWidth; check.classList.add('is-pop');
      }
      var old = card.querySelector('.sk-chip');
      if (old) old.replaceWith(DueChip({ due: item.due, today: props.today, done: next }));
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
      el('div', { className: 'sk-card__meta' }, SubjectTag({ subject: item.subject }), DueChip({ due: item.due, today: props.today, done: item.done })),
      el('h3', { className: 'sk-card__range', text: item.range || '（範囲が書いてない）' }),
      where,
      item.submitTo ? el('p', { className: 'sk-card__submit', text: '出すところ：' + item.submitTo }) : null
    );

    card.appendChild(check);
    card.appendChild(body);
    return card;
  }

  /** ホームの主役。props: { item, today?, remaining?, onDone(item), onAdd? } ― item がなければ AllDone を返す。 */
  function TodayHero(props) {
    props = props || {};
    var item = props.item;
    if (!item) return AllDone({ onAdd: props.onAdd });
    var info = dueInfo(item.due, props.today, item.done);
    var remaining = props.remaining || 0;
    var hero = el('section', { className: 'sk-hero sk-hero--' + info.state, 'aria-labelledby': 'sk-hero-range' },
      el('p', { className: 'sk-hero__eyebrow', text: info.state === 'overdue' ? 'まずこれ。やりかけでも持っていこう' : 'いま、いちばん近いのはこれ' }),
      DueChip({ due: item.due, today: props.today, done: item.done, size: 'lg', showDate: true }),
      el('h2', { className: 'sk-hero__range', id: 'sk-hero-range', text: item.range || '（範囲が書いてない）' }),
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

  /** さっと登録。props: { today?, subjects?, initial?, onSubmit(item), onCancel? } */
  function QuickAdd(props) {
    props = props || {};
    var today = parseDate(props.today || new Date());
    var subjects = props.subjects || SUBJECTS.map(function (s) { return s.label; });
    var state = { subject: (props.initial && props.initial.subject) || null, where: [], due: null };

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

    var rangeInput = el('input', { className: 'sk-input', type: 'text', id: 'sk-range', name: 'range', autocomplete: 'off', enterkeyhint: 'done', placeholder: 'p.24〜27 ／ プリント1枚 ／ ワーク §3', value: (props.initial && props.initial.range) || '' });
    var rangeHint = el('p', { className: 'sk-hint', id: 'sk-range-hint', 'aria-live': 'polite' });
    rangeInput.setAttribute('aria-describedby', 'sk-range-hint');

    var whereOther = el('input', { className: 'sk-input sk-input--sub', type: 'text', name: 'whereOther', placeholder: 'ほかの場所（ロッカー、先生の机…）', autocomplete: 'off' });
    var dateInput = el('input', { className: 'sk-input sk-input--sub', type: 'date', name: 'dueDate', min: toISO(today), hidden: true, 'aria-label': '日付をえらぶ' });
    dateInput.addEventListener('input', function () { state.due = dateInput.value || null; });

    var nextWeek = addDays(today, 7);
    var dueOptions = [
      { label: 'あした', value: toISO(addDays(today, 1)) },
      { label: 'あさって', value: toISO(addDays(today, 2)) },
      { label: '来週の' + WEEKDAYS[nextWeek.getDay()] + '曜', value: toISO(nextWeek) },
      { label: '日付をえらぶ', value: 'pick' }
    ];

    var form = el('form', { className: 'sk-quick', novalidate: true },
      el('div', { className: 'sk-quick__head' },
        el('h2', { className: 'sk-quick__title', text: 'さっと登録' }),
        props.onCancel ? el('button', { className: 'sk-iconbtn', type: 'button', 'aria-label': 'とじる', onClick: props.onCancel }, icon('close', 24)) : null
      ),
      el('div', { className: 'sk-field' },
        el('p', { className: 'sk-field__label', text: '01 科目' }),
        choiceGroup('科目', subjects.map(function (s) { return { label: s, value: s }; }), false, function (opt) { state.subject = opt.value; })
      ),
      el('div', { className: 'sk-field' },
        el('label', { className: 'sk-field__label', 'for': 'sk-range' }, icon('book', 20), el('span', { text: '02 範囲（ここだけ書く）' })),
        rangeInput, rangeHint
      ),
      el('div', { className: 'sk-field' },
        el('p', { className: 'sk-field__label' }, icon('pin', 20), el('span', { text: '03 どこにある？' })),
        choiceGroup('どこにある', WHERE_PRESETS.map(function (w) { return { label: w, value: w }; }), true, function (opt, on) {
          var i = state.where.indexOf(opt.value);
          if (on && i < 0) state.where.push(opt.value); else if (!on && i >= 0) state.where.splice(i, 1);
        }),
        whereOther
      ),
      el('div', { className: 'sk-field' },
        el('p', { className: 'sk-field__label' }, icon('clock', 20), el('span', { text: '04 いつまで？' })),
        choiceGroup('いつまで', dueOptions, false, function (opt) {
          if (opt.value === 'pick') { dateInput.hidden = false; dateInput.focus(); state.due = dateInput.value || null; }
          else { dateInput.hidden = true; state.due = opt.value; }
        }),
        dateInput
      ),
      el('div', { className: 'sk-quick__actions' },
        BigButton({ label: 'これで登録', kind: 'primary', icon: 'plus', full: true, type: 'submit' }),
        props.onCancel ? BigButton({ label: 'あとで', kind: 'ghost', full: true, onClick: props.onCancel }) : null
      )
    );

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var range = rangeInput.value.trim();
      if (!range) {
        rangeHint.textContent = '範囲だけは書いて！（例：p.24〜27）';
        rangeInput.classList.add('is-error');
        rangeInput.focus();
        return;
      }
      rangeHint.textContent = '';
      rangeInput.classList.remove('is-error');
      var where = state.where.slice();
      if (whereOther.value.trim()) where.push(whereOther.value.trim());
      var item = {
        id: 'hw_' + Date.now().toString(36),
        subject: state.subject || 'その他',
        range: range,
        where: where.join('・'),
        submitTo: '',
        due: state.due || toISO(addDays(today, 1)),
        done: false,
        packed: false,
        createdAt: new Date().toISOString()
      };
      if (props.onSubmit) props.onSubmit(item);
    });
    return form;
  }

  /** あさのチェック。props: { items, today?, onToggle(item, packed), onClose? } */
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
          el('div', { className: 'sk-bring__meta' }, SubjectTag({ subject: item.subject }), DueChip({ due: item.due, today: props.today, done: item.done })),
          el('p', { className: 'sk-bring__range', text: item.range || '' }),
          el('p', { className: 'sk-bring__status' + (item.done ? '' : ' is-pending'), text: item.done ? 'できてる。あとは入れるだけ' : 'まだ。やりかけでも持っていこう' })
        )
      );
      box.addEventListener('click', function () {
        item.packed = !item.packed;
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
          el('h2', { className: 'sk-bring__title', id: 'sk-bring-title', text: 'あさのチェック' }),
          el('p', { className: 'sk-bring__date', text: formatDate(props.today || new Date()) + ' に持っていくもの' })
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
      if (i.packed) return false;
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

  /** 焦らせるバー。props: { items, leaveAt?, now?, today?, snoozeLeft?, onPack(item), onDone(item), onSnooze() } */
  function NudgeBar(props) {
    props = props || {};
    var n = nudgeStage(props);
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
      el('p', { className: 'sk-nudge__count', text: n.label }),
      el('div', { className: 'sk-nudge__item' },
        SubjectTag({ subject: first.subject }),
        el('span', { className: 'sk-nudge__range', text: first.range || '' }),
        el('span', { className: 'sk-nudge__state', text: first.done ? 'できてる' : 'まだ' })
      ),
      el('p', { className: 'sk-nudge__line', text: NUDGE_LINES[n.stage] + (rest > 0 ? ' ほかに ' + rest + ' つ。' : '') }),
      el('div', { className: 'sk-nudge__actions' },
        BigButton({ label: 'かばんに入れた', kind: 'primary', icon: 'bag', full: true, onClick: function () { if (props.onPack) props.onPack(first); } }),
        canSnooze ? BigButton({ label: '10分あとで' + (props.snoozeLeft !== undefined ? '（あと ' + props.snoozeLeft + ' 回）' : ''), kind: 'ghost', full: true, onClick: props.onSnooze }) : null
      )
    );
    return bar;
  }

  // ---- 捕まえる：そもそも登録し忘れないために、こっちから聞く ----
  /** きょうの分は答えた？ capture[today] が 'none'/'added' か、きょう作った宿題があれば答えた扱い。 */
  function captureAnswered(opts) {
    opts = opts || {};
    var today = parseDate(opts.today || new Date());
    var key = toISO(today);
    var cap = (opts.capture || {})[key];
    if (cap === 'none' || cap === 'added') return cap;
    var added = (opts.items || []).some(function (i) { return !i.deleted && i.createdAt && toISO(new Date(i.createdAt)) === key; });
    return added ? 'added' : null;
  }
  /** きょう聞く科目。時間割があればその日の科目、なければ 6 科目。 */
  function captureSubjects(opts) {
    opts = opts || {};
    var today = parseDate(opts.today || new Date());
    var tt = opts.timetable || {};
    var list = tt[String(today.getDay())];
    if (Array.isArray(list) && list.length) return list.slice(0, 8);
    return SUBJECTS.map(function (s) { return s.label; });
  }

  /** 放課後の「きょう、宿題出た？」。props: { subjects?, timetable?, today?, asked?, answered?, onPick(subject), onNone() } */
  function CaptureAsk(props) {
    props = props || {};
    var answered = props.answered || null;
    if (answered) {
      return el('section', { className: 'sk-capture sk-capture--done', role: 'status' },
        icon('check', 28),
        el('p', { className: 'sk-capture__done', text: answered === 'none' ? 'きょうは宿題なし。OK。' : 'きょうの分、入れた。えらい。' }));
    }
    var subjects = props.subjects || captureSubjects(props);
    var asked = props.asked || 1;
    return el('section', { className: 'sk-capture' + (asked >= 3 ? ' sk-capture--again' : ''), role: asked >= 3 ? 'alert' : 'status' },
      el('p', { className: 'sk-capture__eyebrow', text: asked > 1 ? '放課後のチェック ・ ' + asked + ' 回目' : '放課後のチェック' }),
      el('h2', { className: 'sk-capture__title', text: asked >= 3 ? 'まだ答えてない。宿題、出た？' : 'きょう、宿題出た？' }),
      el('p', { className: 'sk-capture__line', text: '出た科目を押す。1 つずつ、10 秒で。なければ「なし」。' }),
      el('div', { className: 'sk-choices', role: 'group', 'aria-label': '宿題が出た科目' }, subjects.map(function (sub) {
        return el('button', { className: 'sk-choice', type: 'button', text: sub, onClick: function () { if (props.onPick) props.onPick(sub); } });
      })),
      BigButton({ label: 'きょうは なし', kind: 'secondary', icon: 'check', full: true, onClick: props.onNone })
    );
  }

  // ---- Discord へ送るメッセージ ----
  var EMBED_COLORS = { calm: 0xffe1ef, soon: 0xffe1ef, urgent: 0xff8fc5, late: 0x111111, evening: 0xffe1ef, overdue: 0x111111, clear: 0xf2f2f2 };
  var FOOTER = { calm: '宿題忘れゼロ', soon: '宿題忘れゼロ ・ 15 分前にもう一度言う', urgent: '宿題忘れゼロ ・ 押すまで 10 分ごとに言う', late: '宿題忘れゼロ ・ 押すまで 10 分ごとに言う（あと 5 回）', evening: '宿題忘れゼロ ・ まだなら 21:30 にもう一度', overdue: '宿題忘れゼロ ・ 出すまで 16:00 / 19:00 / 21:00 に言う', clear: '宿題忘れゼロ' };

  function itemLine(i, today) {
    var d = dueInfo(i.due, today, i.done);
    return '・' + (i.subject || '') + '　' + (i.range || '') + '　｜　' + (i.where ? 'どこ：' + i.where : 'どこ：まだ書いてない') + '　｜　' + (i.done ? 'できてる' : 'まだ') + (d.state === 'overdue' ? '（' + d.label + '）' : '');
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
    var items, title, stageKey, mention = '';
    if (kind === 'evening') {
      var tomorrow = addDays(today, 1);
      items = (props.items || []).filter(function (i) { return !i.done && parseDate(i.due) <= tomorrow; });
      title = 'あしたまで ' + items.length + ' つ。いまのうちに。';
      if (props.captureMissing) title = 'きょう登録ゼロ。ほんとに宿題なし？ ' + (items.length ? title : '');
      stageKey = 'evening';
    } else if (kind === 'capture') {
      var subs = captureSubjects({ today: today, timetable: props.timetable });
      var askNo = props.askNo || 1;
      title = askNo >= 3 ? 'まだ答えてない。きょう、宿題出た？' : 'きょう、宿題出た？';
      var rows = [];
      for (var r = 0; r < subs.length; r += 5) {
        rows.push({ type: 1, components: subs.slice(r, r + 5).map(function (sub) { return { type: 2, style: 2, label: sub, custom_id: 'cap:' + sub }; }) });
      }
      rows.push({ type: 1, components: [{ type: 2, style: 3, label: 'きょうは なし', custom_id: 'capnone' }].concat(props.appUrl ? [{ type: 2, style: 5, label: 'アプリで登録', url: props.appUrl }] : []) });
      return {
        content: ((askNo >= 3 && props.userId) ? '<@' + props.userId + '> ' : '') + title,
        embeds: [{ title: title, description: '出た科目を押す → 範囲とどこにあるかを書く。10 秒。なければ「なし」。' + (askNo > 1 ? '\n答えるまで 30 分おきに聞く（' + askNo + ' 回目）。' : ''), color: askNo >= 3 ? 0xff8fc5 : 0xffe1ef, footer: { text: '宿題忘れゼロ ・ 放課後のチェック' }, timestamp: now.toISOString() }],
        components: rows,
        allowed_mentions: { users: props.userId ? [props.userId] : [] }
      };
    } else if (kind === 'overdue') {
      items = (props.items || []).filter(function (i) { return !i.done && dueInfo(i.due, today).state === 'overdue'; });
      title = '出してないのが ' + items.length + ' つ。あしたの朝いちで出そう。';
      stageKey = 'overdue';
      mention = props.userId ? '<@' + props.userId + '> ' : '';
    } else {
      var n = nudgeStage({ items: props.items, today: today, now: now, leaveAt: props.leaveAt });
      items = n.items;
      stageKey = n.stage;
      if (n.stage === 'clear') { title = 'ぜんぶ入れた。いってらっしゃい！'; }
      else if (n.stage === 'late') { title = '出る時間 ' + n.leaveAt + ' を ' + n.label + '。かばんに入れた？'; mention = props.userId ? '<@' + props.userId + '> ' : ''; }
      else { title = '出るまで ' + n.label + '。' + (n.stage === 'urgent' ? 'いますぐ入れる。' : 'きょう持っていくもの ' + items.length + ' つ。'); mention = (n.stage === 'urgent' && props.userId) ? '<@' + props.userId + '> ' : ''; }
    }
    var lines = items.map(function (i) { return itemLine(i, today); });
    var buttons = [];
    if (items.length) {
      buttons.push({ type: 2, style: 3, label: 'かばんに入れた', custom_id: 'pack:' + items.map(function (i) { return i.id; }).join(',') });
      buttons.push({ type: 2, style: 2, label: 'やった', custom_id: 'done:' + items[0].id });
      if (stageKey === 'calm' || stageKey === 'soon' || stageKey === 'evening') buttons.push({ type: 2, style: 2, label: '10分あとで', custom_id: 'snooze:' + items[0].id });
      if (props.appUrl) buttons.push({ type: 2, style: 5, label: 'アプリで見る', url: props.appUrl });
    }
    return {
      content: mention + title,
      embeds: [{
        title: title,
        description: lines.length ? lines.join('\n') : 'きょう持っていく宿題はない。',
        color: EMBED_COLORS[stageKey] || EMBED_COLORS.calm,
        footer: { text: FOOTER[stageKey] || FOOTER.calm },
        timestamp: now.toISOString()
      }],
      components: buttons.length ? [{ type: 1, components: buttons }] : [],
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
    captureSubjects: captureSubjects,
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
