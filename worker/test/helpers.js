export function jst(date, time) { return new Date(`${date}T${time}:00+09:00`); }
export function items() {
  return [
    { id: 'a', subject: '英語', range: 'ワーク p.12〜13', where: '', due: '2026-10-09', done: false, packed: false, createdAt: '2026-10-08T10:00:00Z', updatedAt: '2026-10-08T10:00:00Z' },
    { id: 'b', subject: '数学', range: 'p.24〜27', where: '教科書', due: '2026-10-09', done: true, packed: false, createdAt: '2026-10-08T10:01:00Z', updatedAt: '2026-10-08T10:01:00Z' },
    { id: 'c', subject: '社会', range: '切り抜き', where: 'プリント', due: '2026-10-07', done: false, packed: false, createdAt: '2026-10-06T10:00:00Z', updatedAt: '2026-10-06T10:00:00Z' },
    { id: 'd', subject: '理科', range: 'レポート', where: 'Classroom', due: '2026-10-16', done: false, packed: false, createdAt: '2026-10-08T10:02:00Z', updatedAt: '2026-10-08T10:02:00Z' }
  ];
}
export function stateWith(overrides = {}) {
  return {
    v: 1,
    items: items(),
    settings: { leaveAt: '07:50', wakeAt: '06:30', quietFrom: '22:00', quietTo: '06:30', tz: 'Asia/Tokyo', escalation: 'full', snoozeMax: 3, discord: { userId: '123' }, appUrl: 'https://example.invalid/app', ...(overrides.settings || {}) },
    nudge: { sent: {}, snoozeUntil: null, snoozeCount: {}, ...(overrides.nudge || {}) },
    ...(overrides.items ? { items: overrides.items } : {})
  };
}
