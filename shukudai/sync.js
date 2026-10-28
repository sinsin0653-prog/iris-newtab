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
