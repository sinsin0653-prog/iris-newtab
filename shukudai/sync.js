// サーバー（worker/）との同期。端末が正、サーバーは Discord のための写し。失敗しても端末のデータは消さない。
export async function pullState(sync) {
  if (!sync || !sync.url || !sync.token) return null;
  const res = await fetch(`${sync.url.replace(/\/$/, '')}/api/state`, { headers: { Authorization: `Bearer ${sync.token}` } });
  if (!res.ok) throw new Error(`pull ${res.status}`);
  return res.json();
}

export async function pushState(sync, state) {
  if (!sync || !sync.url || !sync.token) return null;
  const { sync: _omit, ...settings } = state.settings;
  const res = await fetch(`${sync.url.replace(/\/$/, '')}/api/state`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${sync.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: state.items, settings, capture: state.capture || {}, nudge: { snoozeUntil: (state.nudge || {}).snoozeUntil || null, snoozeCount: (state.nudge || {}).snoozeCount || {} } })
  });
  if (!res.ok) throw new Error(`push ${res.status}`);
  return res.json();
}

export async function testDm(sync) {
  const res = await fetch(`${sync.url.replace(/\/$/, '')}/api/test-dm`, { method: 'POST', headers: { Authorization: `Bearer ${sync.token}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `test-dm ${res.status}`);
  return body;
}

/** 宿題 1 件ずつ updatedAt の新しい方。消したものは deleted:true の墓標で残す。 */
export function mergeItems(a = [], b = []) {
  const byId = new Map();
  for (const list of [a, b]) for (const it of list) {
    if (!it || typeof it.id !== 'string') continue;
    const prev = byId.get(it.id);
    if (!prev || String(it.updatedAt || '') >= String(prev.updatedAt || '')) byId.set(it.id, it);
  }
  return [...byId.values()].sort((x, y) => String(x.createdAt || '').localeCompare(String(y.createdAt || '')));
}

/** 「答えた」は負けない：どちらかが none / added なら残す。added は none より強い。 */
function normCapture(v) {
  if (v === 'none' || v === 'added') return { '*': v };
  return v && typeof v === 'object' ? { ...v } : {};
}
export function mergeCapture(a = {}, b = {}) {
  const out = {};
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    const merged = normCapture((a || {})[k]);
    for (const [sub, v] of Object.entries(normCapture((b || {})[k]))) if (v === 'added' || (v === 'none' && merged[sub] !== 'added')) merged[sub] = v;
    if (Object.keys(merged).length) out[k] = merged;
  }
  return out;
}
