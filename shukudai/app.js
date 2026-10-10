// 宿題忘れゼロ — アプリ本体。部品とロジックは window.Shukudai（ds/bundle.js）。
import { pullState, pushState, testDm, mergeItems, mergeCapture } from './sync.js';

const KEY = 'shukudai.state.v1';
const FONT_CSS = 'https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Dela+Gothic+One&family=Zen+Kaku+Gothic+New:wght@500;700;900&display=swap';
const DEFAULT_SETTINGS = {
  leaveAt: '07:50', wakeAt: '06:30', quietFrom: '22:00', quietTo: '06:30', tz: 'Asia/Tokyo',
  escalation: 'full', snoozeMax: 3, appUrl: '', theme: 'auto',
  afterSchoolAt: '15:45', afterSchoolByDay: {}, leaveSchoolAt: '16:30', schoolDays: [1, 2, 3, 4, 5], timetable: {}, classroomUrl: '', paperSpot: '',
  watch: { good: true, evening: false, late: false },
  courses: [], periods: null, commuteMinutes: 60, leaveByDay: {},
  discord: { userId: '', watchChannelId: '' },
  sync: { url: '', token: '' },
  updatedAt: null
};

let S; // window.Shukudai
let state = load();
let ui = { sheet: null, toast: null, undo: null, syncStatus: '', deleteArmed: false, lastPull: null, doneToday: 0, board: false };
const root = document.getElementById('app');

// ---------- 保存 ----------
function load() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { raw = null; }
  const st = raw && typeof raw === 'object' ? raw : {};
  return {
    v: 1,
    items: Array.isArray(st.items) ? st.items : [],
    settings: { ...DEFAULT_SETTINGS, ...(st.settings || {}), discord: { ...DEFAULT_SETTINGS.discord, ...((st.settings || {}).discord || {}) }, sync: { ...DEFAULT_SETTINGS.sync, ...((st.settings || {}).sync || {}) }, watch: { ...DEFAULT_SETTINGS.watch, ...((st.settings || {}).watch || {}) } },
    draft: st.draft || null,
    nudge: { snoozeUntil: null, snoozeCount: {}, ...(st.nudge || {}) },
    capture: st.capture && typeof st.capture === 'object' ? st.capture : {}
  };
}
let pushTimer = null;
function save({ push = true } = {}) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { setStatus('端末に保存できなかった。もう一回押して'); }
  if (push && state.settings.sync.url && state.settings.sync.token) {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(doPush, 900);
  }
}
async function doPush() {
  try {
    const merged = await pushState(state.settings.sync, state);
    if (merged && Array.isArray(merged.items)) { state.items = mergeItems(state.items, merged.items); state.capture = mergeCapture(state.capture, merged.capture); localStorage.setItem(KEY, JSON.stringify(state)); }
    setStatus('同期した ' + clock());
    render();
  } catch (e) { setStatus('同期できなかった（' + (e.message || e) + '）。端末には保存してある'); }
}
async function doPull() {
  if (!state.settings.sync.url || !state.settings.sync.token) return;
  try {
    const remote = await pullState(state.settings.sync);
    if (remote && Array.isArray(remote.items)) {
      state.items = mergeItems(state.items, remote.items);
      state.capture = mergeCapture(state.capture, remote.capture);
      // サーバーの準備ページ（/setup）で入れた Discord ユーザー ID を、アプリの設定にも映す
      const rid = remote.settings && remote.settings.discord && remote.settings.discord.userId;
      if (rid && !state.settings.discord.userId) state.settings.discord = { ...state.settings.discord, userId: rid };
      save({ push: false });
      ui.lastPull = Date.now();
      setStatus('同期した ' + clock());
      render();
    }
  } catch (e) { setStatus('同期できなかった（' + (e.message || e) + '）'); }
}
function setStatus(msg) { ui.syncStatus = msg; const el = document.querySelector('[data-sync-status]'); if (el) el.textContent = msg; }

// ---------- 小道具 ----------
const nowIso = () => new Date().toISOString();
const todayISO = () => S.formatDate ? isoOf(new Date()) : '';
function isoOf(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function clock(d = new Date()) { return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
function h(tag, attrs, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'className') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c);
  return n;
}
const live = () => state.items.filter((i) => !i.deleted);
const active = () => live().filter((i) => S.isActive(i));
function touch(item) { item.updatedAt = nowIso(); }
function sorted() {
  const items = live();
  const t = todayISO();
  // まだ：できてない、または できたけど出していない（期限が来ている）
  const pending = items.filter((i) => S.isActive(i) && (!i.done || S.dueInfo(i.due, t, i.done, { packed: i.packed }).state === 'handin')).sort((a, b) => (a.due || '').localeCompare(b.due || '') || (a.createdAt || '').localeCompare(b.createdAt || ''));
  const weekAgo = Date.now() - 7 * 86400000;
  const done = items.filter((i) => !pending.includes(i) && (i.done || i.submitted || i.dropped) && Date.parse(i.updatedAt || i.createdAt || 0) > weekAgo).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return { pending, done };
}
/** 持っていくもの。18:00 以降は「あしたの準備」（あした分＋期限切れ）。ネット提出は入れない。 */
function bringMode() { return minutesNow() >= 18 * 60 ? 'tomorrow' : 'today'; }
function bringItems() {
  const t = todayISO();
  const tomorrow = isoOf(new Date(Date.now() + 86400000));
  return active().filter((i) => !S.isOnline(i)).filter((i) => {
    const st = S.dueInfo(i.due, t, false).state;
    return st === 'today' || st === 'overdue' || (bringMode() === 'tomorrow' && i.due === tomorrow);
  }).sort((a, b) => (a.due || '').localeCompare(b.due || ''));
}
function handinItems() {
  const t = todayISO();
  return active().filter((i) => i.packed && (i.due || '') <= t);
}
function minutesNow(d = new Date()) { return d.getHours() * 60 + d.getMinutes(); }
function hhmm(t) { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : 0; }
const hasCourses = (s = state.settings) => Array.isArray(s.courses) && s.courses.length > 0;
/** その日の予定（履修科目があれば、曜日ごとの出る時間・放課後・授業） */
function planFor(d = new Date()) { return S.dayPlan(d.getDay(), state.settings); }
function leaveToday() { return planFor().leaveAt || state.settings.leaveAt; }
/**
 * 「課題出た？」を出すか。
 * 履修科目があれば、授業が終わって 5 分たったら、終わった授業だけを聞く（asked 0）。放課後を過ぎたら、その日の全部を回数つきで。
 * 履修科目がなければ、放課後から。
 */
function captureView() {
  const today = todayISO();
  const now = new Date();
  const s = state.settings;
  const plan = planFor(now);
  if (!plan.school) return null;
  const m = minutesNow(now);
  if (m >= hhmm(s.quietFrom || '22:00')) return null;
  const after = hhmm(plan.afterSchoolAt);
  if (m < after && !plan.hasCourses) return null;
  const subjects = S.askableSubjects(today, m, s);
  if (!subjects.length) return null;
  const st = S.captureStatus({ items: state.items, capture: state.capture, today, subjects });
  const handin = handinItems();
  if (m < after) return st.all && !handin.length ? null : { asked: 0, handin, subjects };
  if (st.all && m - after > 120 && !handin.length) return null;
  const elapsed = m - after;
  const asked = elapsed < 90 ? Math.floor(elapsed / 30) + 1 : 3 + Math.floor((elapsed - 60) / 60);
  return { asked, handin, subjects };
}
function setCapture(subject, value) {
  const D = todayISO();
  const cur = state.capture[D];
  const obj = (cur === 'none' || cur === 'added') ? { '*': cur } : (cur && typeof cur === 'object' ? { ...cur } : {});
  if (value) obj[subject] = value; else delete obj[subject];
  state.capture[D] = obj;
}
function applyTheme() {
  const pref = state.settings.theme || 'auto';
  const dark = pref === 'dark' || (pref === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]:not([media])');
  if (meta) meta.content = dark ? '#0f0f0f' : '#ffffff';
}

// ---------- 画面 ----------
/** 「いま 2限 フランス語(a) B-201（〜12:10）」／「つぎ 4限 …（14:40〜）」 */
function nextClassLine() {
  if (!hasCourses()) return null;
  const nc = S.nextClass(new Date(), state.settings);
  if (!nc) return null;
  const l = nc.lesson;
  return h('p', { className: 'brand__next', text: (nc.during ? 'いま ' : 'つぎ ') + l.period + '限 ' + l.subject + (l.room ? ' ' + l.room : '') + (nc.during ? '（〜' + l.end + '）' : '（' + l.start + '〜）') });
}
function render() {
  if (!S) return;
  applyTheme();
  const today = todayISO();
  const { pending, done } = sorted();
  const hero = pending[0] || null;
  const rest = pending.slice(1);
  const plan = planFor();
  const leaveAt = plan.leaveAt || state.settings.leaveAt;
  const n = S.nudgeStage({ items: live(), leaveAt, now: new Date(), today });
  const snoozed = state.nudge.snoozeUntil && new Date(state.nudge.snoozeUntil) > new Date();
  const schoolToday = plan.school;
  // 学校のある日の、出発 60 分前から、学校に着くころまで（履修科目があれば最初の授業が始まるまで、なければ出発後 60 分）。
  // 全部入れたあとも「いってらっしゃい」として残す（消えない）。「あとで」中は 1 行にたたむ。学校に着いたあとの「出した？」は放課後のチェックが聞く
  const untilArrive = plan.hasCourses && plan.lessons.length ? hhmm(plan.lessons[0].start) - hhmm(leaveAt) : 60;
  const showNudge = schoolToday && bringMode() === 'today' && bringItems().length > 0 && n.minutes <= 60 && n.minutes >= -untilArrive;
  const snoozeLeft = Math.max(0, (state.settings.snoozeMax || 3) - ((state.nudge.snoozeCount || {})[today] || 0));

  const mark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  mark.setAttribute('viewBox', '0 0 36 36'); mark.setAttribute('class', 'brand__mark'); mark.setAttribute('aria-hidden', 'true');
  [[4, '#ffffff'], [14, '#ffffff'], [24, '#ff8fc5']].forEach(([x, f]) => { const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect'); r.setAttribute('x', x); r.setAttribute('y', 4); r.setAttribute('width', 8); r.setAttribute('height', 28); r.setAttribute('rx', 4); r.setAttribute('fill', f); mark.prepend(r); });
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect'); bg.setAttribute('width', 36); bg.setAttribute('height', 36); bg.setAttribute('rx', 10); bg.setAttribute('fill', '#111111'); mark.prepend(bg);

  const top = h('header', { className: 'top' },
    h('div', { className: 'brand' }, mark, h('div', null,
      h('h1', { className: 'brand__name', text: '宿題忘れゼロ' }),
      h('p', { className: 'brand__date', text: S.formatDate(new Date()) + (plan.hasCourses ? (plan.school ? '　出る ' + plan.leaveAt : '　きょうは授業なし') : '　出る時間 ' + leaveAt) }),
      nextClassLine()
    )),
    h('div', { className: 'top__actions' },
      h('button', { className: 'sk-iconbtn', type: 'button', 'aria-label': bringMode() === 'tomorrow' ? 'あしたの準備' : 'あさのチェック', title: bringMode() === 'tomorrow' ? 'あしたの準備' : 'あさのチェック', onClick: () => openSheet('bring') }, S.icon('bag', 24)),
      h('button', { className: 'sk-pill', type: 'button', onClick: () => openSheet('week') }, 'こんしゅう'),
      h('button', { className: 'sk-pill', type: 'button', onClick: () => openSheet('settings') }, '設定')
    )
  );

  const parts = [top];
  const nudging = showNudge && !snoozed && (n.stage === 'soon' || n.stage === 'urgent' || n.stage === 'late');
  root.classList.toggle('is-nudging', !!nudging);
  if (showNudge) parts.push(S.NudgeBar({ items: live(), leaveAt, now: new Date(), today, snoozeLeft, snoozedUntil: snoozed ? state.nudge.snoozeUntil : null, onPack: packItem, onSnooze: snooze, onWake: () => { state.nudge.snoozeUntil = null; save(); render(); } }));
  if (state.draft && !ui.sheet) parts.push(h('button', { className: 'draft', type: 'button', onClick: () => openSheet('add', state.draft) }, S.icon('book', 20), h('span', { text: '書きかけ 1 つ：' + (state.draft.subject || '科目なし') + ' ' + (state.draft.range || '') }), h('span', { className: 'draft__go', text: 'つづきを書く' })));
  const cap = captureView();
  if (cap) parts.push(S.CaptureAsk({
    items: state.items, capture: state.capture, subjects: cap.subjects, today, asked: cap.asked, handin: cap.handin,
    onPick: (subject) => openSheet('add', { subject, fromCapture: true }),
    onNone: (subject) => { setCapture(subject, 'none'); save(); render(); },
    onNoneAll: () => { for (const sub of S.captureStatus({ items: state.items, capture: state.capture, today, subjects: cap.subjects }).unanswered) setCapture(sub, 'none'); save(); render(); },
    onReopen: () => { const cur = state.capture[today]; if (cur && typeof cur === 'object') { for (const k of Object.keys(cur)) if (cur[k] === 'none') delete cur[k]; } else if (cur === 'none') delete state.capture[today]; save(); render(); },
    onSubmit: submitItem, onDrop: dropItem
  }));
  const heroEl = S.TodayHero({ item: hero, today, remaining: rest.length, onDone: (item) => completeItem(item, true, { heroEl }), onAdd: () => openSheet('add') });
  parts.push(heroEl);
  if (rest.length) {
    parts.push(h('p', { className: 'section-label', text: 'そのあと ' + rest.length }));
    parts.push(h('div', { className: 'list' }, rest.map((item) => S.HomeworkCard({ item, today, onDone: (it, next) => completeItem(it, next, { fromCard: true }), onOpen: (it) => openSheet('edit', it), onSubmit: submitItem, onDrop: dropItem }))));
  }
  if (done.length) {
    parts.push(h('p', { className: 'section-label', text: 'できた ' + done.length }));
    parts.push(h('div', { className: 'list' }, done.map((item) => S.HomeworkCard({ item, today, onDone: (it, next) => completeItem(it, next, { fromCard: true }), onOpen: (it) => openSheet('edit', it) }))));
  }
  if (!navigator.onLine) parts.push(h('p', { className: 'offline', text: 'オフライン。端末には保存してある。' }));

  // 朝、バーがピンクになっているあいだは「追加」を脇役に（ピンクは 1 画面に 1 つ）
  const fab = h('div', { className: 'fab' }, S.BigButton({ label: '宿題を追加', kind: nudging ? 'secondary' : 'primary', icon: 'plus', full: true, onClick: () => openSheet('add') }));
  if (ui.board) { renderBoard(); return; }
  root.replaceChildren(...parts, fab);
  if (ui.toast) root.append(ui.toast);
  if (ui.sheet) root.append(ui.sheet);
}

// ---------- 操作 ----------
const DONE_LINES = ['できた。', '1 つ消えた。', 'はい、つぎ。', 'いい調子。'];
function completeItem(item, next, { fromCard = false, heroEl = null } = {}) {
  item.done = next; touch(item); save();
  if (!next) { render(); return; }
  ui.doneToday++;
  // 手応えを残す：主役なら打ち消し線に変えてから、カードなら 220ms の膨らみを見せてから、次へ
  if (heroEl) { heroEl.classList.add('is-done'); const chip = heroEl.querySelector('.sk-chip'); if (chip) chip.replaceWith(S.DueChip({ due: item.due, today: todayISO(), done: true, size: 'lg' })); }
  showUndo(item);
  setTimeout(render, fromCard || heroEl ? 600 : 0);
}
function submitItem(item) {
  item.submitted = true; item.submittedAt = nowIso(); touch(item); save();
  toast('出した。えらい。', null); render();
}
function dropItem(item) {
  item.dropped = true; item.droppedAt = nowIso(); touch(item); save();
  toast('先生に言った。これで終わり。', null); render();
}
function toast(text, action) {
  clearTimeout(ui.undo);
  ui.toast = h('div', { className: 'toast', role: 'status' }, text, action);
  ui.undo = setTimeout(hideToast, 5000);
}
function packItem(item) {
  const t = todayISO();
  for (const i of bringItems()) if (i.id === item.id) { i.packed = true; i.packedAt = nowIso(); i.packedOn = t; touch(i); }
  save(); render();
}
function snooze() {
  const t = todayISO();
  const used = (state.nudge.snoozeCount || {})[t] || 0;
  if (used >= (state.settings.snoozeMax || 3)) return;
  state.nudge.snoozeCount = { [t]: used + 1 };
  state.nudge.snoozeUntil = new Date(Date.now() + 10 * 60000).toISOString();
  save({ push: false }); render();
}
function showUndo(item) {
  const leftover = sorted().pending.filter((i) => i.id !== item.id && !i.done).length;
  const line = leftover === 0 ? 'ぜんぶ終わった！' : DONE_LINES[(ui.doneToday - 1) % DONE_LINES.length];
  toast(line, S.BigButton({ label: 'もどす', kind: 'ghost', icon: 'undo', onClick: () => { item.done = false; touch(item); save(); hideToast(); render(); } }));
  const old = root.querySelector('.toast'); if (old) old.remove();
  root.append(ui.toast);
}
function hideToast() { clearTimeout(ui.undo); ui.toast = null; const t = root.querySelector('.toast'); if (t) t.remove(); }
function addItem(item) {
  if (!item.submitTo) item.submitTo = S.submitPlace(item.subject, item.due, state.settings);
  state.items.push(item); setCapture(item.subject, 'added'); state.draft = null; save(); closeSheet(); render();
}

// ---------- シート ----------
function openSheet(kind, item) {
  ui.deleteArmed = false;
  let content;
  if (kind === 'add') content = S.QuickAdd({ today: todayISO(), initial: item || null, ...subjectChoices(), timetable: S.effectiveTimetable(state.settings), schoolDays: S.effectiveSchoolDays(state.settings), paperSpot: state.settings.paperSpot, allowEmptyRange: !!(item && item.fromCapture), onSubmit: addItem, onCancel: (draft) => { state.draft = (draft && (draft.range || draft.subject)) ? draft : null; save({ push: false }); closeSheet(); } });
  else if (kind === 'week') content = weekSheet();
  else if (kind === 'import') content = importSheet(item);
  else if (kind === 'bring') content = bringSheet();
  else if (kind === 'edit') content = editSheet(item);
  else content = settingsSheet();
  const sheet = h('div', { className: 'sheet', role: 'dialog', 'aria-modal': 'true' }, content);
  ui.sheet = h('div', { className: 'sheet-backdrop', onClick: (e) => { if (e.target === ui.sheet) closeSheet(); } }, sheet);
  render();
  const first = sheet.querySelector('input, button'); if (first) first.focus();
}
function closeSheet() { ui.sheet = null; render(); }
const UNI_WHERE = ['教科書', 'プリント', 'レジュメ', 'ノート', 'LMS', 'Classroom', 'メール'];
/** 登録シートの科目：きょうの授業を先頭に、ほかの授業は「ほかの授業」に畳む。 */
function subjectChoices() {
  const all = S.allSubjects(state.settings);
  if (!hasCourses()) return { subjects: all };
  const todays = S.daySubjects(todayISO(), state.settings);
  return { subjects: todays.length ? todays : all, moreSubjects: all, wherePresets: UNI_WHERE };
}

function bringSheet() {
  const items = bringItems();
  const tomorrow = new Date(Date.now() + 86400000);
  const evening = bringMode() === 'tomorrow';
  return h('div', { className: 'panel' },
    S.BringCheck({ items, today: todayISO(), paperSpot: state.settings.paperSpot, title: evening ? 'あしたの準備' : 'あさのチェック', dateText: evening ? S.formatDate(tomorrow) + ' に持っていくもの。前の晩に詰める。' : undefined, onToggle: (it) => { if (it.packed) it.packedOn = evening ? isoOf(tomorrow) : todayISO(); touch(it); save(); }, onClose: closeSheet }),
    h('div', { className: 'panel__actions' }, S.BigButton({ label: 'とじる', kind: 'secondary', full: true, onClick: closeSheet }))
  );
}

function weekDays() {
  const out = [];
  const base = new Date();
  for (let k = 0; k < 7; k++) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + k);
    const key = isoOf(d);
    out.push({ d, key, items: active().filter((i) => i.due === key || (k === 0 && (i.due || '') < key)) });
  }
  return out;
}
function weekGrid(big) {
  const today = todayISO();
  return h('div', { className: 'week' + (big ? ' week--big' : '') }, weekDays().map(({ d, key, items }, k) =>
    h('section', { className: 'week__day' + (k === 0 ? ' is-today' : '') + (!S.dayPlan(d.getDay(), state.settings).school ? ' is-off' : '') },
      h('p', { className: 'week__date', text: (k === 0 ? 'きょう ' : k === 1 ? 'あした ' : '') + S.formatDate(d) }),
      (() => { const ls = S.dayPlan(d.getDay(), state.settings).lessons; return ls.length ? h('p', { className: 'week__classes', text: ls.map((l) => l.period + '限 ' + l.subject + (l.room ? ' ' + l.room : '')).join('　') }) : null; })(),
      items.length ? h('div', { className: 'week__items' }, items.map((i) => h('div', { className: 'week__item' + (i.done ? ' is-done' : '') }, S.SubjectTag({ subject: i.subject }), h('span', { className: 'week__range', text: i.range || '範囲？' }), S.DueChip({ due: i.due, today, done: i.done, flags: { packed: i.packed } })))) : h('p', { className: 'week__empty', text: 'なし' })
    )));
}
function weekSheet() {
  return h('div', { className: 'panel' },
    h('div', { className: 'panel__head' }, h('h2', { className: 'panel__title', text: 'こんしゅう' }), h('button', { className: 'sk-iconbtn', type: 'button', 'aria-label': 'とじる', onClick: closeSheet }, S.icon('close', 24))),
    weekGrid(false),
    h('p', { className: 'panel__note', text: 'リビングのタブレットなどに出すときは、このページの URL の最後に ?board=1 を付ける（操作なしの大きい表示）。' }),
    h('div', { className: 'panel__actions' }, S.BigButton({ label: 'とじる', kind: 'secondary', full: true, onClick: closeSheet }))
  );
}
/** ?board=1：家族が見る大きい表示。操作ボタンなし、1 分ごとに更新。 */
function renderBoard() {
  document.body.classList.add('is-board');
  const today = todayISO();
  const n = S.nudgeStage({ items: live(), leaveAt: leaveToday(), now: new Date(), today });
  const line = n.stage === 'clear' ? 'きょうのぶんは、ぜんぶ かばんの中。' : `まだ かばんに入れていないもの：${n.items.map((i) => i.subject).join('・')}`;
  root.replaceChildren(
    h('header', { className: 'top' }, h('div', { className: 'brand' }, h('div', null, h('h1', { className: 'brand__name', text: '宿題忘れゼロ' }), h('p', { className: 'brand__date', text: S.formatDate(new Date()) + '　' + clock() })))),
    h('p', { className: 'board__line', text: line }),
    weekGrid(true)
  );
}
function editSheet(item) {
  const draft = { ...item };
  const input = (name, placeholder, type = 'text') => h('input', { className: 'sk-input', type, name, value: draft[name] || '', placeholder, autocomplete: 'off', onInput: (e) => { draft[name] = e.target.value; } });
  const names = S.allSubjects(state.settings);
  if (draft.subject && !names.includes(draft.subject)) names.push(draft.subject);
  const subjectChoices = h('div', { className: 'sk-choices', role: 'radiogroup', 'aria-label': '科目' }, names.map((label) => {
    const b = h('button', { className: 'sk-choice' + (draft.subject === label ? ' is-on' : ''), type: 'button', role: 'radio', 'aria-checked': draft.subject === label ? 'true' : 'false', text: label });
    b.addEventListener('click', () => { draft.subject = label; for (const c of subjectChoices.children) { c.classList.toggle('is-on', c === b); c.setAttribute('aria-checked', c === b ? 'true' : 'false'); } });
    return b;
  }));
  const del = S.BigButton({ label: '消す', kind: 'ghost', full: true, onClick: () => {
    if (!ui.deleteArmed) { ui.deleteArmed = true; del.querySelector('.sk-btn__label').textContent = 'ほんとに消す？ もう一回押す'; return; }
    item.deleted = true; touch(item); save(); closeSheet();
  } });
  return h('form', { className: 'panel', onSubmit: (e) => { e.preventDefault(); const autoBefore = S.submitPlace(item.subject, item.due, state.settings); const subject = draft.subject || 'その他'; const due = draft.due || item.due; let submitTo = (draft.submitTo || '').trim(); if (!submitTo || submitTo === autoBefore) submitTo = S.submitPlace(subject, due, state.settings); const range = (draft.range || '').trim() || item.range; Object.assign(item, { subject, range, rangeMissing: !range, where: (draft.where || '').trim(), submitTo, due }); touch(item); save(); closeSheet(); } },
    h('div', { className: 'panel__head' }, h('h2', { className: 'panel__title', text: '直す' }), h('button', { className: 'sk-iconbtn', type: 'button', 'aria-label': 'とじる', onClick: closeSheet }, S.icon('close', 24))),
    h('div', { className: 'sk-field' }, h('p', { className: 'sk-field__label', text: '01 科目' }), subjectChoices),
    h('div', { className: 'sk-field' }, h('label', { className: 'sk-field__label', text: '02 範囲' }), input('range', 'p.24〜27')),
    h('div', { className: 'sk-field' }, h('label', { className: 'sk-field__label', text: '03 どこにある？' }), input('where', '教科書、プリント、Classroom…')),
    h('div', { className: 'sk-field' }, h('label', { className: 'sk-field__label', text: '04 いつまで？' }), input('due', '', 'date')),
    h('div', { className: 'sk-field' }, h('label', { className: 'sk-field__label', text: '05 出すところ（任意）' }), input('submitTo', '先生に直接、提出箱…')),
    h('div', { className: 'panel__actions' },
      S.BigButton({ label: 'これで保存', kind: 'primary', icon: 'check', full: true, type: 'submit' }),
      item.packed ? S.BigButton({ label: 'かばんから出した（入れたを取り消す）', kind: 'secondary', full: true, onClick: () => { item.packed = false; touch(item); save(); closeSheet(); } }) : null,
      del
    )
  );
}

// ---------- 履修科目（大学の時間割） ----------
const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];
/** 貼り付けた JSON を読む。{ courses: [...], periods?, commuteMinutes? } でも、配列だけでもいい。day は 1〜6 か「月」〜「土」。 */
function parseCoursesText(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('読めなかった。JSON の形になっているか見て'); }
  const list = Array.isArray(data) ? data : (data && Array.isArray(data.courses) ? data.courses : null);
  if (!list || !list.length) throw new Error('courses が見つからない');
  const courses = list.map((c, i) => {
    if (!c || typeof c.name !== 'string' || !c.name.trim()) throw new Error((i + 1) + ' 個目に name（授業名）がない');
    let day = c.day;
    if (typeof day === 'string') day = DAY_NAMES.indexOf(day.trim().slice(0, 1));
    day = day === null || day === undefined || day === -1 || day === '' ? null : +day;
    if (day !== null && !(day >= 0 && day <= 6)) throw new Error(c.name + ' の day（曜日）がおかしい');
    const period = c.period === null || c.period === undefined || c.period === '' ? null : +c.period;
    if (period !== null && !(period >= 1 && period <= 8)) throw new Error(c.name + ' の period（時限）がおかしい');
    const str = (v, n) => (typeof v === 'string' || typeof v === 'number') ? String(v).trim().slice(0, n) : '';
    return { name: str(c.name, 80), short: str(c.short, 30) || str(c.name, 30), day, period: day === null ? null : period, room: str(c.room, 30), teacher: str(c.teacher, 40), code: str(c.code, 20), credits: +c.credits || null, required: !!c.required };
  });
  const out = { courses };
  if (data && data.periods && typeof data.periods === 'object') {
    const periods = {};
    for (const [k, v] of Object.entries(data.periods)) if (Array.isArray(v) && /^\d{1,2}:\d{2}$/.test(v[0]) && /^\d{1,2}:\d{2}$/.test(v[1])) periods[k] = [v[0], v[1]];
    if (Object.keys(periods).length) out.periods = periods;
  }
  if (data && (data.commuteMinutes === 0 || +data.commuteMinutes > 0)) out.commuteMinutes = +data.commuteMinutes;
  return out;
}
function b64urlEncode(str) { const bytes = new TextEncoder().encode(str); let bin = ''; bytes.forEach((b) => { bin += String.fromCharCode(b); }); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlDecode(s) { const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)); return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))); }
function coursesSummary(courses, periods) {
  const byDay = [1, 2, 3, 4, 5, 6, 0].map((d) => {
    const ls = courses.filter((c) => c.day === d && c.period).sort((a, b) => a.period - b.period);
    return ls.length ? h('p', { className: 'courses__day' }, h('span', { className: 'courses__dow', text: DAY_NAMES[d] }), ls.map((c) => c.period + '限 ' + (c.short || c.name) + (c.room ? ' ' + c.room : '')).join('　')) : null;
  });
  const floating = courses.filter((c) => c.day === null || c.day === undefined);
  return h('div', { className: 'courses' }, byDay, floating.length ? h('p', { className: 'courses__day' }, h('span', { className: 'courses__dow', text: '他' }), floating.map((c) => c.short || c.name).join('・') + '（曜日なし。週の最後の授業日に聞く）') : null);
}
/** #import=… で開いたとき：中身を見せてから入れる */
function importSheet(data) {
  return h('div', { className: 'panel' },
    h('div', { className: 'panel__head' }, h('h2', { className: 'panel__title', text: '時間割を入れる？' }), h('button', { className: 'sk-iconbtn', type: 'button', 'aria-label': 'とじる', onClick: closeSheet }, S.icon('close', 24))),
    h('p', { className: 'panel__note', text: data.courses.length + ' コマ。いまの履修科目は、これに入れかわる。' }),
    coursesSummary(data.courses, data.periods),
    h('div', { className: 'panel__actions' },
      S.BigButton({ label: 'この時間割を入れる', kind: 'primary', icon: 'check', full: true, onClick: () => { applyCourses(data); closeSheet(); toast('時間割を入れた。' + data.courses.length + ' コマ。', null); render(); } }),
      S.BigButton({ label: 'やめる', kind: 'ghost', full: true, onClick: closeSheet })
    )
  );
}
function applyCourses(data) {
  state.settings = { ...state.settings, courses: data.courses, ...(data.periods ? { periods: data.periods } : {}), ...(data.commuteMinutes !== undefined ? { commuteMinutes: data.commuteMinutes } : {}), updatedAt: nowIso() };
  save();
}
/** 設定の「授業（履修科目）」 */
function coursesSection(s, field) {
  const status = h('p', { className: 'panel__status' });
  const area = h('textarea', { className: 'sk-input courses__text', rows: '6', placeholder: '{ "courses": [ { "name": "統計学 I", "short": "統計学", "day": "月", "period": 1, "room": "A-101" } ] }', spellcheck: 'false', 'aria-label': '履修科目の JSON' });
  const load = S.BigButton({ label: '貼り付けたものを読み込む', kind: 'secondary', full: true, onClick: () => {
    try { const data = parseCoursesText(area.value); s.courses = data.courses; if (data.periods) s.periods = data.periods; if (data.commuteMinutes !== undefined) s.commuteMinutes = data.commuteMinutes; status.textContent = data.courses.length + ' コマ読んだ。「これで保存」で入る。'; }
    catch (e) { status.textContent = e.message; }
  } });
  const importBox = h('details', { className: 'details' }, h('summary', { className: 'section-label' }, hasCourses(s) ? '履修科目を貼り付けて入れかえる' : '履修科目（大学の時間割）を入れる'),
    h('p', { className: 'panel__note', text: '入れると、曜日ごとに「出る時間」が決まり、授業が終わるたびに「課題出た？」と聞き、期限は「次のその授業」、出すところは「その授業の教室」になる。' }),
    area, load, status);
  if (!hasCourses(s)) return importBox;
  const periods = s.periods || S.DEFAULT_PERIODS;
  const leaveLine = h('p', { className: 'panel__note courses__leave' });
  const refresh = () => { leaveLine.textContent = '出る時間：' + [1, 2, 3, 4, 5, 6].map((d) => { const p = S.dayPlan(d, s); return p.school ? DAY_NAMES[d] + ' ' + p.leaveAt : null; }).filter(Boolean).join('　'); };
  refresh();
  const commute = h('input', { className: 'sk-input sk-input--sub', type: 'number', min: '0', max: '240', step: '5', value: String(s.commuteMinutes === 0 || +s.commuteMinutes > 0 ? s.commuteMinutes : 60), onInput: (e) => { const v = +e.target.value; if (v >= 0) { s.commuteMinutes = v; refresh(); } } });
  const periodRows = h('div', { className: 'panel__actions' }, [1, 2, 3, 4, 5, 6].map((k) => {
    const cur = (periods[k] || ['', '']);
    const set = (i, v) => { s.periods = JSON.parse(JSON.stringify(s.periods || S.DEFAULT_PERIODS)); s.periods[k] = s.periods[k] || ['', '']; s.periods[k][i] = v; refresh(); };
    return h('div', { className: 'row row--tt' }, h('span', { className: 'row__day', text: k }),
      h('input', { className: 'sk-input sk-input--sub row__time', type: 'time', value: cur[0], 'aria-label': k + '限のはじまり', onInput: (e) => set(0, e.target.value) }),
      h('span', { text: '〜' }),
      h('input', { className: 'sk-input sk-input--sub row__time', type: 'time', value: cur[1], 'aria-label': k + '限のおわり', onInput: (e) => set(1, e.target.value) }));
  }));
  const copyStatus = h('p', { className: 'panel__status' });
  const exported = () => JSON.stringify({ courses: s.courses, periods: s.periods || undefined, commuteMinutes: s.commuteMinutes }, null, 1);
  let clearArmed = false;
  const clearBtn = S.BigButton({ label: '履修科目を消す', kind: 'ghost', full: true, onClick: () => {
    if (!clearArmed) { clearArmed = true; clearBtn.querySelector('.sk-btn__label').textContent = 'ほんとに消す？ もう一回押す'; return; }
    s.courses = []; copyStatus.textContent = '消した。「これで保存」で反映。';
  } });
  return h('div', { className: 'courses-block' },
    h('p', { className: 'section-label', text: '授業（履修科目）' }),
    coursesSummary(s.courses, periods),
    h('div', { className: 'grid-2' }, field('通学時間（分）', commute, '家から教室まで。出る時間 = 最初の授業 − これ'), h('div', null)),
    leaveLine,
    h('details', { className: 'details' }, h('summary', { className: 'section-label' }, '時限の時刻（学校に合わせて直す）'), periodRows),
    importBox,
    h('div', { className: 'panel__actions' },
      S.BigButton({ label: 'ほかの端末に入れるリンクをコピー', kind: 'secondary', full: true, onClick: async () => {
        const url = location.origin + location.pathname + '#import=' + b64urlEncode(exported());
        try { await navigator.clipboard.writeText(url); copyStatus.textContent = 'コピーした。ほかの端末で開くと入る。'; } catch { copyStatus.textContent = url; }
      } }),
      clearBtn, copyStatus)
  );
}
function settingsSheet() {
  const s = JSON.parse(JSON.stringify(state.settings));
  const field = (label, node, note) => h('div', { className: 'sk-field' }, h('label', { className: 'sk-field__label', text: label }), node, note ? h('p', { className: 'panel__note', text: note }) : null);
  const time = (key) => h('input', { className: 'sk-input sk-input--sub', type: 'time', value: s[key], onInput: (e) => { s[key] = e.target.value || s[key]; } });
  const text = (get, set, placeholder, type = 'text') => h('input', { className: 'sk-input sk-input--sub', type, value: get() || '', placeholder, autocomplete: 'off', spellcheck: 'false', onInput: (e) => set(e.target.value.trim()) });
  const chips = (options, get, set) => {
    const g = h('div', { className: 'sk-choices', role: 'radiogroup' }, options.map(([v, label]) => {
      const b = h('button', { className: 'sk-choice' + (get() === v ? ' is-on' : ''), type: 'button', role: 'radio', 'aria-checked': get() === v ? 'true' : 'false', text: label });
      b.addEventListener('click', () => { set(v); for (const c of g.children) { c.classList.toggle('is-on', c === b); c.setAttribute('aria-checked', c === b ? 'true' : 'false'); } });
      return b;
    }));
    return g;
  };
  const chipsMulti = (options, get, set) => h('div', { className: 'sk-choices', role: 'group' }, options.map(([k, label]) => {
    const b = h('button', { className: 'sk-choice' + (get(k) ? ' is-on' : ''), type: 'button', 'aria-pressed': get(k) ? 'true' : 'false', text: label });
    b.addEventListener('click', () => { set(k, !get(k)); b.classList.toggle('is-on', get(k)); b.setAttribute('aria-pressed', get(k) ? 'true' : 'false'); });
    return b;
  }));
  const status = h('p', { className: 'panel__status', 'data-sync-status': '', text: ui.syncStatus });
  return h('form', { className: 'panel', onSubmit: (e) => { e.preventDefault(); s.updatedAt = nowIso(); state.settings = s; save(); closeSheet(); doPull(); } },
    h('div', { className: 'panel__head' }, h('h2', { className: 'panel__title', text: '設定' }), h('button', { className: 'sk-iconbtn', type: 'button', 'aria-label': 'とじる', onClick: closeSheet }, S.icon('close', 24))),
    coursesSection(s, field),
    h('p', { className: 'section-label', text: '自分で決める' }),
    hasCourses(s) ? null : h('div', { className: 'grid-2' },
      field('出る時間', time('leaveAt'), 'ここが軸。60 分前からバーが出る'),
      field('起きる時間', time('wakeAt'), 'この時刻に Discord の 1 通目')
    ),
    h('div', { className: 'grid-2' }, field('静かにする（から）', time('quietFrom')), field('静かにする（まで）', time('quietTo'))),
    h('div', { className: 'grid-2' },
      hasCourses(s) ? null : field('学校を出る時刻', time('leaveSchoolAt'), '学校（ロッカー・机）にあるものを、帰る前に「かばんへ」と言う'),
      field('プリントの置き場所（家）', text(() => s.paperSpot, (v) => { s.paperSpot = v; }, '冷蔵庫横の赤いファイル'), 'プリントを登録したとき、ここへ、と出す')
    ),
    field('強さ', chips([['full', 'しっかり（Discord も）'], ['calm', 'アプリの中だけ']], () => s.escalation, (v) => { s.escalation = v; })),
    field('見た目', chips([['auto', '自動'], ['light', '白'], ['dark', '黒']], () => s.theme, (v) => { s.theme = v; })),
    hasCourses(s) ? null : h('p', { className: 'section-label', text: '捕まえる（登録し忘れを防ぐ）' }),
    hasCourses(s) ? null : field('放課後（聞きに行く時刻）', time('afterSchoolAt'), 'この時刻から「きょう、宿題出た？」。答えるまで 30 分おきに 3 回'),
    hasCourses(s) ? null : field('学校がある日', (() => {
      const names = ['日', '月', '火', '水', '木', '金', '土'];
      const g = h('div', { className: 'sk-choices', role: 'group' }, [1, 2, 3, 4, 5, 6, 0].map((d) => {
        const on = () => (s.schoolDays || []).includes(d);
        const b = h('button', { className: 'sk-choice' + (on() ? ' is-on' : ''), type: 'button', 'aria-pressed': on() ? 'true' : 'false', text: names[d] });
        b.addEventListener('click', () => { s.schoolDays = on() ? s.schoolDays.filter((x) => x !== d) : [...(s.schoolDays || []), d]; b.classList.toggle('is-on', on()); b.setAttribute('aria-pressed', on() ? 'true' : 'false'); });
        return b;
      }));
      return g;
    })()),
    hasCourses(s) ? null : field('時間割と、曜日ごとの放課後（任意）', h('div', { className: 'panel__actions' }, [1, 2, 3, 4, 5, 6].map((d) => {
      const names = ['日', '月', '火', '水', '木', '金', '土'];
      return h('div', { className: 'row row--tt' },
        h('span', { className: 'row__day', text: names[d] }),
        h('input', { className: 'sk-input sk-input--sub row__subjects', type: 'text', placeholder: '数学, 英語, 理科', value: ((s.timetable || {})[d] || []).join(', '), 'aria-label': names[d] + '曜の時間割', onInput: (e) => { s.timetable = { ...(s.timetable || {}), [d]: e.target.value.split(/[、,，\s]+/).map((x) => x.trim()).filter(Boolean) }; } }),
        h('input', { className: 'sk-input sk-input--sub row__time', type: 'time', value: (s.afterSchoolByDay || {})[d] || '', 'aria-label': names[d] + '曜の放課後', onInput: (e) => { s.afterSchoolByDay = { ...(s.afterSchoolByDay || {}) }; if (e.target.value) s.afterSchoolByDay[d] = e.target.value; else delete s.afterSchoolByDay[d]; } })
      );
    })), '科目を入れると、その日の科目だけを聞き、期限の既定が「次の○○」になる。右の時刻は部活がある日の放課後（空なら上の時刻）'),
    h('details', { className: 'details', open: !!(s.discord.userId || s.sync.url) },
      h('summary', { className: 'section-label' }, '大人と一緒に 1 回だけつなぐ（Discord・同期）'),
      h('p', { className: 'panel__note', text: 'ここは誰かと一緒にやる。終わったら触らない。' }),
    field('あなたの Discord ユーザー ID', text(() => s.discord.userId, (v) => { s.discord.userId = v; }, '18 桁くらいの数字'), 'Discord の設定 → 詳細設定 → 開発者モードを ON にして、自分の名前を右クリック →「ユーザー ID をコピー」'),
    field('見守りチャンネル ID（任意）', text(() => s.discord.watchChannelId, (v) => { s.discord.watchChannelId = v; }, '空なら使わない'), '家族や友だちが見られる場所。本人が選んだものだけ届く'),
    field('見守りチャンネルに届くもの', chipsMulti([['good', '良い知らせ（ぜんぶ入れた・出した）'], ['evening', '夜のまとめ'], ['late', '出発後の催促']], (k) => !!s.watch[k], (k, on) => { s.watch = { ...s.watch, [k]: on }; }), '既定は良い知らせだけ。失敗を流すかどうかは自分で決める'),
    field('Classroom の URL（任意）', text(() => s.classroomUrl, (v) => { s.classroomUrl = v; }, 'https://classroom.google.com/', 'url'), '全部「なし」と答えた夜に「Classroom は見た？」とリンクを出す'),
    h('p', { className: 'section-label', text: '同期（Discord に届かせるため）' }),
    field('サーバーの URL', text(() => s.sync.url, (v) => { s.sync.url = v; }, 'https://shukudai-worker.xxx.workers.dev', 'url')),
    field('合言葉（SYNC_TOKEN）', text(() => s.sync.token, (v) => { s.sync.token = v; }, 'wrangler secret put SYNC_TOKEN で決めたもの', 'password')),
    field('アプリの URL（Discord の「アプリで見る」）', text(() => s.appUrl, (v) => { s.appUrl = v; }, location.href.split('#')[0], 'url')),
    status
    ),
    h('div', { className: 'panel__actions' },
      S.BigButton({ label: 'これで保存', kind: 'primary', icon: 'check', full: true, type: 'submit' }),
      S.BigButton({ label: 'Discord にテスト送信', kind: 'secondary', icon: 'bag', full: true, onClick: async () => {
        status.textContent = '送っている…';
        try { state.settings = { ...s, updatedAt: nowIso() }; save({ push: false }); await pushState(s.sync, state); await testDm(s.sync); status.textContent = '届いた？ Discord の DM を見て'; }
        catch (e) { status.textContent = '送れなかった：' + (e.message || e); }
      } }),
      S.BigButton({ label: 'とじる', kind: 'ghost', full: true, onClick: closeSheet })
    )
  );
}

// ---------- 起動 ----------
/** URL の #import=… に時間割があれば、中身を見せてから入れる。 */
function checkImportHash() {
  const imp = /#import=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (!imp) return false;
  history.replaceState(null, '', location.pathname + location.search);
  try { openSheet('import', parseCoursesText(b64urlDecode(imp[1]))); } catch (e) { toast('時間割のリンクが読めなかった：' + e.message, null); render(); }
  return true;
}
function loadFonts() { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = FONT_CSS; document.head.appendChild(l); }
function boot() {
  S = window.Shukudai;
  if (!S) { setTimeout(boot, 30); return; }
  loadFonts();
  render();
  ui.board = /[?&]board=1/.test(location.search);
  if (ui.board) { renderBoard(); setInterval(renderBoard, 60000); }
  if (!checkImportHash() && /[?&#]add\b/.test(location.search + location.hash)) { history.replaceState(null, '', location.pathname); openSheet('add'); }
  // アプリを開いたまま取り込みリンクを踏んだとき（# だけ変わってページは読み直されない）
  window.addEventListener('hashchange', checkImportHash);
  doPull();
  setInterval(render, 30000);
  setInterval(doPull, 5 * 60000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { render(); doPull(); } });
  window.addEventListener('online', render); window.addEventListener('offline', render);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ui.sheet) closeSheet(); });
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}
boot();
