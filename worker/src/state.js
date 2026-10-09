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
  captureRepeatMinutes: 30,
  captureMax: 3,
  schoolDays: [1, 2, 3, 4, 5],
  timetable: {},
  discord: { userId: null, watchChannelId: null }
});

export function emptyState() {
  return { v: 1, items: [], settings: { ...DEFAULT_SETTINGS, discord: { ...DEFAULT_SETTINGS.discord } }, nudge: { sent: {}, snoozeUntil: null, snoozeCount: {} }, capture: {}, updatedAt: null };
}

export function withDefaults(state) {
  const s = state && typeof state === 'object' ? state : {};
  const settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
  settings.discord = { ...DEFAULT_SETTINGS.discord, ...((s.settings && s.settings.discord) || {}) };
  if (!Array.isArray(settings.overdueAt)) settings.overdueAt = [...DEFAULT_SETTINGS.overdueAt];
  return {
    v: 1,
    items: Array.isArray(s.items) ? s.items.filter((i) => i && typeof i.id === 'string') : [],
    settings,
    nudge: { sent: {}, snoozeUntil: null, snoozeCount: {}, ...(s.nudge || {}) },
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

/** 端末から来た state を保存済みの state に合わせる。設定は新しい方、nudge はサーバーのものを守る。 */
export function mergeState(server, incoming) {
  const s = withDefaults(server), c = withDefaults(incoming);
  const settingsNewer = String(c.settings.updatedAt || '') >= String(s.settings.updatedAt || '');
  return {
    v: 1,
    items: mergeItems(s.items, c.items),
    settings: settingsNewer ? { ...c.settings, discord: { ...c.settings.discord } } : s.settings,
    nudge: s.nudge,
    capture: mergeCapture(s.capture, c.capture),
    updatedAt: new Date().toISOString()
  };
}

/** 「答えた」は負けない：どちらかが none / added なら残す。added は none より強い。 */
export function mergeCapture(a = {}, b = {}) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    if (v === 'added' || (v === 'none' && out[k] !== 'added')) out[k] = v;
  }
  return out;
}
