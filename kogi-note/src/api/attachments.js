// 添付（メモの写真・レジュメ）と使用量
import { HttpError, json } from '../http.js';
import { first, run } from '../db.js';
import { loadRow } from './lectures.js';

export const LIMIT_BYTES = 1073741824;
const WARN_BYTES = 858993459;
const MAX_PER_LECTURE = 20;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const KINDS = {
  note_image: { types: IMAGE_TYPES, max: 5242880 },
  handout_image: { types: IMAGE_TYPES, max: 5242880 },
  handout_pdf: { types: new Set(['application/pdf']), max: 20971520 },
};

const usedBytes = async (env) => (await first(env.DB, 'SELECT COALESCE(SUM(size), 0) AS used FROM attachments')).used;

export async function upload({ request, env, params, url, now }) {
  const kind = url.searchParams.get('kind');
  const rule = KINDS[kind];
  const mime = (request.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  if (!rule || !rule.types.has(mime)) throw new HttpError(400, 'bad_request', 'このファイルの種類は入れられません');
  const size = Number(request.headers.get('Content-Length'));
  if (!request.headers.has('Content-Length') || !Number.isInteger(size) || size < 1) throw new HttpError(400, 'bad_request', 'ファイルの大きさがわかりません');
  if (size > rule.max) throw new HttpError(413, 'too_large', kind === 'handout_pdf' ? 'PDF は20MBまでです' : '写真は5MBまでです');
  await loadRow(env, params.id);
  const { n, maxPos } = await first(env.DB, 'SELECT count(*) AS n, MAX(position) AS maxPos FROM attachments WHERE lecture_id = ?', params.id);
  if (n >= MAX_PER_LECTURE) throw new HttpError(409, 'too_many', 'ファイルは1回の授業につき20個までです');
  if ((await usedBytes(env)) + size > LIMIT_BYTES) throw new HttpError(507, 'storage_full', '置き場がいっぱいです');

  const body = await request.arrayBuffer();
  if (body.byteLength !== size) throw new HttpError(400, 'bad_request', 'ファイルが途中で切れました');
  const id = crypto.randomUUID();
  const kvKey = `att/${params.id}/${id}`;
  try {
    await env.FILES.put(kvKey, body);
  } catch {
    throw new HttpError(503, 'kv_write_failed', '今日はこれ以上ファイルを入れられません');
  }
  const position = maxPos === null ? 0 : maxPos + 1;
  await run(
    env.DB,
    'INSERT INTO attachments (id, lecture_id, kind, mime, size, kv_key, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, params.id, kind, mime, size, kvKey, position, now,
  );
  return json({ id, kind, mime, size, position }, 201);
}

async function mustExist(env, id) {
  const att = await first(env.DB, 'SELECT * FROM attachments WHERE id = ?', id);
  if (!att) throw new HttpError(404, 'not_found', 'ファイルが見つかりません');
  return att;
}

export async function get({ env, params }) {
  const att = await mustExist(env, params.id);
  const body = await env.FILES.get(att.kv_key, 'stream');
  if (!body) throw new HttpError(404, 'not_found', 'ファイルが見つかりません');
  return new Response(body, { headers: { 'content-type': att.mime, 'cache-control': 'private, max-age=3600' } });
}

export async function remove({ env, ai, params }) {
  const att = await mustExist(env, params.id);
  if (att.gemini_file_name) {
    try {
      await ai.deleteFile({ fileName: att.gemini_file_name });
    } catch {
      // 48 時間で消える
    }
  }
  await env.FILES.delete(att.kv_key);
  await run(env.DB, 'DELETE FROM attachments WHERE id = ?', att.id);
  return json({ ok: true });
}

export async function usage({ env }) {
  const used = await usedBytes(env);
  return json({ used_bytes: used, limit_bytes: LIMIT_BYTES, warn: used >= WARN_BYTES });
}
