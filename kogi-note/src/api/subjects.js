// 科目の API
import { HttpError, json, readJson } from '../http.js';
import { all, first, run } from '../db.js';
import { deleteStatements } from './lectures.js';

function cleanName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 100) throw new HttpError(400, 'bad_request', '科目名は1〜100文字で入れてね');
  return name;
}

async function mustExist(env, id) {
  const subject = await first(env.DB, 'SELECT id, name FROM subjects WHERE id = ?', id);
  if (!subject) throw new HttpError(404, 'not_found', '科目が見つかりません');
  return subject;
}

export async function list({ env }) {
  const subjects = await all(
    env.DB,
    `SELECT s.id, s.name, COUNT(l.id) AS lecture_count, COALESCE(MAX(l.updated_at), s.created_at) AS last_updated
     FROM subjects s LEFT JOIN lectures l ON l.subject_id = s.id
     GROUP BY s.id ORDER BY s.created_at, s.id`,
  );
  return json({ subjects });
}

export async function create({ request, env, now }) {
  const name = cleanName((await readJson(request)).name);
  const id = crypto.randomUUID();
  await run(env.DB, 'INSERT INTO subjects (id, name, created_at) VALUES (?, ?, ?)', id, name, now);
  return json({ id, name }, 201);
}

export async function rename({ request, env, params }) {
  const name = cleanName((await readJson(request)).name);
  await mustExist(env, params.id);
  await run(env.DB, 'UPDATE subjects SET name = ? WHERE id = ?', name, params.id);
  return json({ id: params.id, name });
}

export async function remove({ env, params, now }) {
  await mustExist(env, params.id);
  await env.DB.batch([
    ...deleteStatements(env, 'subject_id = ?', params.id, now),
    env.DB.prepare('DELETE FROM subjects WHERE id = ?').bind(params.id),
  ]);
  return json({ ok: true });
}

export async function lectures({ env, params }) {
  const subject = await mustExist(env, params.id);
  const rows = await all(
    env.DB,
    `SELECT l.id, l.number, l.date, l.status, l.step, l.waiting_reason, l.segments_total,
            (SELECT COUNT(*) FROM segments g WHERE g.lecture_id = l.id) AS segments_done, l.error_message
     FROM lectures l WHERE l.subject_id = ? ORDER BY l.number`,
    params.id,
  );
  return json({ subject, lectures: rows });
}
