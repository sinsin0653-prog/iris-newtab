// 授業の API：作る・読む・変える・消す・やり直す・要約の作り直し
import { HttpError, json, readJson } from '../http.js';
import { all, first, run, transcriptOf } from '../db.js';

const EXPIRY_MARGIN_MS = 600_000;
const AUDIO_STEPS = new Set(['wait_file', 'transcribe']);

export function needsAudio(row, now) {
  if (row.status === 'uploading') return true;
  return (
    row.status === 'error' &&
    AUDIO_STEPS.has(row.step) &&
    (row.audio_expires_at == null || row.audio_expires_at - now < EXPIRY_MARGIN_MS)
  );
}

function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// 送られた項目を確かめる（partial なら来たものだけ）
function cleanFields(body, partial) {
  const out = {};
  if (!partial || body.number !== undefined) {
    if (!Number.isInteger(body.number) || body.number < 1) throw new HttpError(400, 'bad_request', '第◯回は1以上の整数で入れてね');
    out.number = body.number;
  }
  if (!partial || body.date !== undefined) {
    if (!validDate(body.date)) throw new HttpError(400, 'bad_request', '日付の形がちがいます');
    out.date = body.date;
  }
  if (body.note_text !== undefined || !partial) {
    const note = body.note_text ?? '';
    if (typeof note !== 'string' || note.length > 100000) throw new HttpError(400, 'bad_request', 'メモは100000文字までです');
    out.note_text = note;
  }
  return out;
}

export async function loadRow(env, id) {
  const row = await first(env.DB, 'SELECT * FROM lectures WHERE id = ?', id);
  if (!row) throw new HttpError(404, 'not_found', '授業が見つかりません');
  return row;
}

async function view(env, id, now) {
  const row = await loadRow(env, id);
  const subject = await first(env.DB, 'SELECT name FROM subjects WHERE id = ?', row.subject_id);
  const { n } = await first(env.DB, 'SELECT count(*) AS n FROM segments WHERE lecture_id = ?', id);
  const attachments = await all(
    env.DB,
    'SELECT id, kind, mime, size, position FROM attachments WHERE lecture_id = ? ORDER BY position',
    id,
  );
  return {
    id: row.id,
    subject_id: row.subject_id,
    subject_name: subject?.name ?? '',
    number: row.number,
    date: row.date,
    note_text: row.note_text,
    status: row.status,
    step: row.step,
    waiting_reason: row.waiting_reason,
    segments_total: row.segments_total,
    segments_done: n,
    transcript: await transcriptOf(env, id),
    summary: row.summary_json ? JSON.parse(row.summary_json) : null,
    error_message: row.error_message,
    needs_audio: needsAudio(row, now),
    attachments,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function insertOrConflict(promise, number) {
  try {
    return await promise;
  } catch (err) {
    if (String(err?.message).includes('UNIQUE')) throw new HttpError(409, 'conflict', `第${number}回はもうあります`);
    throw err;
  }
}

export async function create({ request, env, now }) {
  const body = await readJson(request);
  const f = cleanFields(body, false);
  const subject = await first(env.DB, 'SELECT id FROM subjects WHERE id = ?', body.subject_id ?? '');
  if (!subject) throw new HttpError(404, 'not_found', '科目が見つかりません');
  const id = crypto.randomUUID();
  await insertOrConflict(
    run(
      env.DB,
      `INSERT INTO lectures (id, subject_id, number, date, note_text, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'uploading', ?, ?)`,
      id, subject.id, f.number, f.date, f.note_text, now, now,
    ),
    f.number,
  );
  return json({ id }, 201);
}

export async function get({ env, params, now }) {
  return json({ lecture: await view(env, params.id, now) });
}

export async function patch({ request, env, params, now }) {
  const f = cleanFields(await readJson(request), true);
  await loadRow(env, params.id);
  const cols = Object.keys(f);
  if (cols.length) {
    await insertOrConflict(
      run(env.DB, `UPDATE lectures SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
        ...cols.map((c) => f[c]), now, params.id),
      f.number,
    );
  }
  return json({ lecture: await view(env, params.id, now) });
}

const ignore = async (p) => {
  try {
    await p;
  } catch {
    // Gemini のファイルは 48 時間で消えるので、消せなくても先に進む
  }
};

export async function deleteLecture(env, ai, id) {
  const row = await first(env.DB, 'SELECT audio_file_name FROM lectures WHERE id = ?', id);
  if (!row) return;
  const atts = await all(env.DB, 'SELECT kv_key, gemini_file_name FROM attachments WHERE lecture_id = ?', id);
  const names = [row.audio_file_name, ...atts.map((a) => a.gemini_file_name)].filter(Boolean);
  await Promise.all(names.map((fileName) => ignore(ai.deleteFile({ fileName }))));
  await Promise.all(atts.map((a) => env.FILES.delete(a.kv_key)));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM segments WHERE lecture_id = ?').bind(id),
    env.DB.prepare('DELETE FROM attachments WHERE lecture_id = ?').bind(id),
    env.DB.prepare('DELETE FROM lectures WHERE id = ?').bind(id),
  ]);
}

export async function remove({ env, ai, params }) {
  await loadRow(env, params.id);
  await deleteLecture(env, ai, params.id);
  return json({ ok: true });
}

const RESET = `attempts = 0, rate_limit_count = 0, lease_count = 0, next_run_at = 0, error_message = NULL, waiting_reason = NULL`;

export async function retry({ env, params, now }) {
  const row = await loadRow(env, params.id);
  if (row.status !== 'error') throw new HttpError(409, 'not_error', 'エラーになっていない授業です');
  if (needsAudio(row, now)) throw new HttpError(409, 'audio_expired', '音声の期限が切れました。もう一回入れてね');
  await run(env.DB, `UPDATE lectures SET status = 'processing', ${RESET}, updated_at = ? WHERE id = ? AND status = 'error'`, now, params.id);
  return json({ lecture: await view(env, params.id, now) });
}

export async function resummarize({ env, params, now }) {
  const row = await loadRow(env, params.id);
  const allowed = row.status === 'done' || (row.status === 'error' && (row.step === 'attach' || row.step === 'summarize'));
  if (!allowed) throw new HttpError(409, 'busy', 'いまは要約を作り直せません');
  const { n } = await first(env.DB, 'SELECT count(*) AS n FROM segments WHERE lecture_id = ?', params.id);
  if (row.segments_total == null || n < row.segments_total) throw new HttpError(409, 'not_transcribed', 'まだ文字起こしが終わっていません');
  await run(env.DB, `UPDATE lectures SET status = 'processing', step = 'attach', ${RESET}, updated_at = ? WHERE id = ? AND status = ?`, now, params.id, row.status);
  return json({ lecture: await view(env, params.id, now) });
}
