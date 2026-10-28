// テスト用の道具

export const T0 = 1_800_000_000_000;

const TABLES = ['segments', 'attachments', 'lectures', 'subjects', 'login_failures'];
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function resetDb(env) {
  await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  let cursor;
  do {
    const page = await env.FILES.list({ prefix: 'att/', cursor });
    await Promise.all(page.keys.map((k) => env.FILES.delete(k.name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

export function makeRequest(path, { method = 'GET', json, body, headers = {}, cookie } = {}) {
  const h = new Headers();
  if (MUTATING.has(method)) h.set('X-Kogi', '1');
  let payload = body;
  if (json !== undefined) {
    payload = JSON.stringify(json);
    h.set('Content-Type', 'application/json');
  }
  if (typeof payload === 'string') h.set('Content-Length', String(new TextEncoder().encode(payload).byteLength));
  else if (payload instanceof ArrayBuffer || ArrayBuffer.isView(payload)) h.set('Content-Length', String(payload.byteLength));
  if (cookie) h.set('Cookie', cookie);
  for (const [k, v] of Object.entries(headers)) {
    if (v === null) h.delete(k);
    else h.set(k, v);
  }
  return new Request(`http://kogi.test${path}`, { method, headers: h, body: payload });
}
