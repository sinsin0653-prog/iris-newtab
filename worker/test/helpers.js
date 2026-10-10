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

// 架空の大学の時間割（テスト用。実在の時間割は入れない）
export function uniCourses() {
  return [
    { name: '統計学 I', short: '統計学', day: 1, period: 1, room: 'A-101' },
    { name: 'フランス語(a)', short: 'フランス語(a)', day: 1, period: 2, room: 'B-201' },
    { name: '英語演習 II', short: '英語演習', day: 2, period: 4, room: 'C-301' },
    { name: '英語演習 II', short: '英語演習', day: 4, period: 2, room: 'C-302' },
    { name: 'ゼミ', short: 'ゼミ', day: 5, period: 5, room: 'D-401' },
    { name: '集中講義 A', short: '集中講義', day: null, period: null }
  ];
}
export function uniState(overrides = {}) {
  const st = stateWith({ settings: { courses: uniCourses(), commuteMinutes: 60, ...(overrides.settings || {}) }, nudge: overrides.nudge || {} });
  st.items = overrides.items || [];
  if (overrides.capture) st.capture = overrides.capture;
  return st;
}
