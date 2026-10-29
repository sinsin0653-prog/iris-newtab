// 音声アップロードの中継：ブラウザ → Worker → Gemini（ためこまずに流す）
import { HttpError, json, readJson } from '../http.js';
import { run } from '../db.js';
import { loadRow } from './lectures.js';
import { normalizeAudioMime } from '../mime.js';
import { AiError } from '../ai/errors.js';

const TARGET_CHUNK = 16777216;
export const MAX_CHUNK_BYTES = 104857600;
const MAX_AUDIO_BYTES = 2147483648;

export function chunkSizeFor(granularity) {
  if (!granularity) return TARGET_CHUNK;
  return granularity * Math.max(1, Math.floor(TARGET_CHUNK / granularity));
}

const upstream = () => new HttpError(502, 'upstream', 'Gemini に送れませんでした');

export async function start({ request, env, ai, params, now }) {
  const body = await readJson(request);
  const row = await loadRow(env, params.id);
  const mime = normalizeAudioMime(body.mime);
  if (!(mime.startsWith('audio/') || mime === 'video/mp4')) throw new HttpError(400, 'bad_request', '音声のファイルを選んでね');
  const size = body.size;
  if (!Number.isInteger(size) || size < 1 || size > MAX_AUDIO_BYTES) throw new HttpError(400, 'bad_request', '音声は2GBまでです');
  const d = body.duration_sec;
  const duration = typeof d === 'number' && Number.isFinite(d) && d > 0 ? Math.round(d) : null;
  if (row.status === 'processing') throw new HttpError(409, 'busy', 'いま処理中です');

  let session;
  try {
    session = await ai.startAudioUpload({ mime, size, displayName: params.id });
  } catch (err) {
    if (err instanceof AiError) throw upstream();
    throw err;
  }
  if (row.audio_file_name) {
    try {
      await ai.deleteFile({ fileName: row.audio_file_name });
    } catch {
      // 古いファイルは 48 時間で消えるので気にしない
    }
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM segments WHERE lecture_id = ?').bind(params.id),
    env.DB.prepare(
      `UPDATE lectures SET audio_mime = ?, audio_size = ?, audio_duration_sec = ?, audio_upload_url = ?, audio_upload_offset = 0,
         audio_file_name = NULL, audio_file_uri = NULL, audio_expires_at = NULL, segments_total = NULL,
         status = 'uploading', step = NULL, error_message = NULL, waiting_reason = NULL, updated_at = ? WHERE id = ?`,
    ).bind(mime, size, duration, session.uploadUrl, now, params.id),
  ]);
  return json({ chunk_size: chunkSizeFor(session.granularity) });
}

async function resync(env, ai, row, offset) {
  let real;
  try {
    real = await ai.queryUploadOffset({ uploadUrl: row.audio_upload_url });
  } catch {
    return false;
  }
  if (!Number.isInteger(real) || real < 0 || real >= row.audio_size || real === offset) return false;
  await run(env.DB, 'UPDATE lectures SET audio_upload_offset = ? WHERE id = ?', real, row.id);
  throw new HttpError(409, 'offset_mismatch', '送る位置がずれました', { expected_offset: real });
}

export async function chunk({ request, env, ai, params, url, now }) {
  const length = Number(request.headers.get('Content-Length'));
  if (!request.headers.has('Content-Length') || !Number.isInteger(length) || length < 1 || length > MAX_CHUNK_BYTES) {
    throw new HttpError(400, 'bad_request', 'かけらの大きさがおかしいです');
  }
  const offset = Number(url.searchParams.get('offset'));
  if (!Number.isInteger(offset) || offset < 0) throw new HttpError(400, 'bad_request', '送る位置がおかしいです');
  const row = await loadRow(env, params.id);

  // 最後のかけらは確定したのに、返事だけが届かなかった
  if (!row.audio_upload_url && row.audio_file_name && offset + length === row.audio_size) {
    return json({ next_offset: row.audio_size, done: true });
  }
  if (row.status !== 'uploading' || !row.audio_upload_url) throw new HttpError(409, 'not_uploading', 'いまは音声を受け取れません');
  if (offset !== row.audio_upload_offset) {
    let real = await ai.queryUploadOffset({ uploadUrl: row.audio_upload_url }).catch(() => row.audio_upload_offset);
    if (!Number.isInteger(real) || real < 0 || real >= row.audio_size) real = row.audio_upload_offset;
    await run(env.DB, 'UPDATE lectures SET audio_upload_offset = ? WHERE id = ?', real, row.id);
    throw new HttpError(409, 'offset_mismatch', '送る位置がずれました', { expected_offset: real });
  }
  if (offset + length > row.audio_size) throw new HttpError(400, 'bad_request', '音声の大きさを超えています');
  const isLast = offset + length === row.audio_size;

  let file;
  try {
    file = await ai.uploadAudioChunk({ uploadUrl: row.audio_upload_url, offset, body: request.body, size: length, isLast });
  } catch (err) {
    if (!(err instanceof AiError)) throw err;
    if (!isLast) await resync(env, ai, row, offset);
    throw upstream();
  }
  const next = offset + length;
  if (!isLast) {
    await run(env.DB, 'UPDATE lectures SET audio_upload_offset = ?, updated_at = ? WHERE id = ?', next, now, row.id);
    return json({ next_offset: next, done: false });
  }
  await run(
    env.DB,
    `UPDATE lectures SET audio_upload_offset = ?, audio_file_name = ?, audio_file_uri = ?, audio_expires_at = ?, audio_upload_url = NULL,
       status = 'processing', step = 'wait_file', attempts = 0, rate_limit_count = 0, lease_count = 0, next_run_at = 0, updated_at = ?
     WHERE id = ?`,
    next, file.fileName, file.fileUri, file.expiresAt, now, row.id,
  );
  return json({ next_offset: next, done: true });
}
