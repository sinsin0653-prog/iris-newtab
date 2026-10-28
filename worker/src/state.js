// 保存する形と、端末と Discord の両方から来る変更の合わせ方。
export const DEFAULT_SETTINGS = Object.freeze({
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

export function emptyState() {
  return { v: 1, items: [], settings: { ...DEFAULT_SETTINGS, discord: { ...DEFAULT_SETTINGS.discord } }, nudge: { sent: {}, snoozeUntil: null, snoozeCount: {} }, capture: {}, updatedAt: null };
}

export function withDefaults(state) {
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
export function mergeItems(a = [], b = []) {
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

/**
 * 毎週くりかえす宿題（repeat: 'weekly'）。終わった（できた・出した・先生に言った）か期限を過ぎたら、
 * 来週の分を作る。id は「元の id_期限」で決まるので、何度呼んでも、端末とサーバーで別々に呼んでも 1 つだけ。
 * やめるときは、いちばん新しい分の repeat を外す。過ぎてしまった週は飛ばして、いまから先のいちばん近い同じ曜日にする。
 */
export function materializeRepeats(items = [], today, nowIso) {
  const addDays7 = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const byId = new Map(items.filter((i) => i && typeof i.id === 'string').map((i) => [i.id, i]));
  const added = [];
  for (const it of items) {
    if (!it || it.deleted || it.repeat !== 'weekly' || !/^\d{4}-\d{2}-\d{2}$/.test(it.due || '')) continue;
    let cur = it;
    for (let n = 0; n < 8; n++) {
      const finished = !!(cur.done || cur.submitted || cur.dropped);
      if (!finished && !(cur.due < today)) break;
      let due = addDays7(cur.due, 7);
      while (due < today) due = addDays7(due, 7);
      const root = cur.seriesId || cur.id;
      const id = root + '_' + due;
      const have = byId.get(id);
      if (have) { if (have.deleted || have.repeat !== 'weekly') break; cur = have; continue; }
      const next = { id, seriesId: root, subject: cur.subject, range: cur.range, rangeMissing: !cur.range, where: cur.where || '', location: cur.location || null, submitTo: cur.submitTo || '', due, repeat: 'weekly', done: false, packed: false, createdAt: nowIso, createdOn: today, updatedAt: nowIso };
      byId.set(id, next); added.push(next);
      cur = next;
    }
  }
  return added.length ? items.concat(added) : items;
}

/** 端末から来た state を保存済みの state に合わせる。設定は新しい方、nudge はサーバーのものを守る。 */
export function mergeState(server, incoming) {
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
export function mergeCapture(a = {}, b = {}) {
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
export function mergeNudge(server = {}, client = {}) {
  const out = { ...server };
  if (client && client.snoozeUntil && (!server.snoozeUntil || String(client.snoozeUntil) > String(server.snoozeUntil))) out.snoozeUntil = client.snoozeUntil;
  if (client && client.snoozeCount && typeof client.snoozeCount === 'object') {
    out.snoozeCount = { ...(server.snoozeCount || {}) };
    for (const [d, n] of Object.entries(client.snoozeCount)) out.snoozeCount[d] = Math.max(out.snoozeCount[d] || 0, +n || 0);
  }
  return out;
}
