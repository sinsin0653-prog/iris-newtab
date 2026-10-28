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

// ---- Task 3: API を呼ぶ道具と、データを直接作る道具
import { env } from 'cloudflare:test';
import { login } from '../src/auth.js';
import { handleRequest } from '../src/router.js';

export async function loginCookie(e = env, now = T0) {
  const res = await login(makeRequest('/api/login', { method: 'POST', json: { password: e.APP_PASSWORD } }), e, now);
  return res.headers.get('set-cookie').split(';')[0];
}

export async function rawCall(path, opts = {}) {
  const cookie = opts.cookie === undefined ? await loginCookie(env) : opts.cookie;
  return handleRequest(makeRequest(path, { ...opts, cookie }), opts.env ?? env, { ai: opts.ai ?? {}, now: opts.now ?? T0 });
}

export async function call(path, opts = {}) {
  const res = await rawCall(path, opts);
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  return { status: res.status, body: isJson ? await res.json() : null };
}

export async function newSubject(name = '科目') {
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO subjects (id, name, created_at) VALUES (?, ?, ?)').bind(id, name, T0).run();
  return id;
}

export async function newLecture(fields = {}) {
  const row = { id: crypto.randomUUID(), number: 1, date: '2026-10-28', status: 'uploading', created_at: T0, updated_at: T0, ...fields };
  if (!row.subject_id) row.subject_id = await newSubject();
  const cols = Object.keys(row);
  await env.DB.prepare(`INSERT INTO lectures (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).bind(...cols.map((c) => row[c])).run();
  return row.id;
}

// ---- Task 5: fetch のニセモノと、それを使う Gemini クライアント
import { createGemini } from '../src/ai/gemini.js';

export function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => {
    const req = new Request(url, init);
    calls.push(req);
    return handler(req, calls.length);
  };
  f.calls = calls;
  return f;
}

export const g = (fetch) => createGemini({ apiKey: 'KEY', model: 'm', baseUrl: 'https://gem.test', fetch });

// ---- Task 8: 見回りのテスト用
export const processingLecture = (fields = {}) =>
  newLecture({ status: 'processing', step: 'wait_file', audio_mime: 'audio/mp4', audio_file_name: 'files/a', audio_file_uri: 'u/a', audio_expires_at: T0 + 172800000, ...fields });

export const row = (id) => env.DB.prepare('SELECT * FROM lectures WHERE id = ?').bind(id).first();

// ---- Task 9
export const addSegment = (lectureId, idx, text) =>
  env.DB.prepare('INSERT INTO segments (lecture_id, idx, text) VALUES (?, ?, ?)').bind(lectureId, idx, text).run();

export async function addAttachment(lectureId, { position = 0, kind = 'note_image', mime = 'image/jpeg', gemini = {} } = {}) {
  const id = crypto.randomUUID();
  const kv_key = `att/${lectureId}/${id}`;
  await env.FILES.put(kv_key, new Uint8Array([1, 2, 3]));
  await env.DB.prepare(
    `INSERT INTO attachments (id, lecture_id, kind, mime, size, kv_key, position, gemini_file_name, gemini_file_uri, gemini_expires_at, created_at)
     VALUES (?, ?, ?, ?, 3, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, lectureId, kind, mime, kv_key, position, gemini.name ?? null, gemini.uri ?? null, gemini.expiresAt ?? null, T0).run();
  return { id, kv_key };
}
