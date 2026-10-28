import { env } from 'cloudflare:test';
import { beforeEach, it, expect } from 'vitest';
import { resetDb, call, newSubject, newLecture, T0 } from './helpers.js';
import { needsAudio } from '../src/api/lectures.js';

beforeEach(() => resetDb(env));
const row = (id) => env.DB.prepare('SELECT * FROM lectures WHERE id = ?').bind(id).first();
const seg = (id, idx, text) => env.DB.prepare('INSERT INTO segments VALUES (?,?,?)').bind(id, idx, text).run();

it('creates a lecture as uploading and reads it back', async () => {
  const s = await newSubject('心理学');
  const r = await call('/api/lectures', { method: 'POST', json: { subject_id: s, number: 1, date: '2026-10-28', note_text: 'メモ' } });
  expect(r.status).toBe(201);
  const { lecture } = (await call(`/api/lectures/${r.body.id}`)).body;
  expect(lecture).toMatchObject({ subject_name: '心理学', number: 1, date: '2026-10-28', note_text: 'メモ', status: 'uploading', needs_audio: true, transcript: '', summary: null, attachments: [], segments_done: 0 });
});

it('validates number, date, note_text, subject and duplicates', async () => {
  const s = await newSubject('a');
  for (const bad of [{ number: 0 }, { number: 1.5 }, { number: '1' }, { date: '2026/10/28' }, { date: '2026-13-01' }, { note_text: 'x'.repeat(100001) }])
    expect((await call('/api/lectures', { method: 'POST', json: { subject_id: s, number: 1, date: '2026-10-28', ...bad } })).status).toBe(400);
  expect((await call('/api/lectures', { method: 'POST', json: { subject_id: 'nope', number: 1, date: '2026-10-28' } })).status).toBe(404);
  await call('/api/lectures', { method: 'POST', json: { subject_id: s, number: 1, date: '2026-10-28' } });
  const dup = await call('/api/lectures', { method: 'POST', json: { subject_id: s, number: 1, date: '2026-10-29' } });
  expect(dup.status).toBe(409);
  expect(dup.body.error.message).toContain('第1回');
});

it('joins segments in order, skips empty ones and parses the summary', async () => {
  const id = await newLecture({ summary_json: JSON.stringify({ theme: 'T', flow: [], key_points: [], announcements: [] }) });
  await seg(id, 1, '[30:00] 後半');
  await seg(id, 0, '[00:00] 前半');
  await seg(id, 2, '');
  const { lecture } = (await call(`/api/lectures/${id}`)).body;
  expect(lecture.transcript).toBe('[00:00] 前半\n[30:00] 後半');
  expect(lecture.summary.theme).toBe('T');
  expect(lecture.segments_done).toBe(3);
});

it('patches number, date and note_text with the same checks', async () => {
  const id = await newLecture();
  const r = await call(`/api/lectures/${id}`, { method: 'PATCH', json: { note_text: '直したメモ', number: 3 }, now: T0 + 5 });
  expect(r.body.lecture).toMatchObject({ note_text: '直したメモ', number: 3, updated_at: T0 + 5 });
  expect((await call(`/api/lectures/${id}`, { method: 'PATCH', json: { date: 'x' } })).status).toBe(400);
  expect((await call('/api/lectures/nope', { method: 'PATCH', json: { number: 2 } })).status).toBe(404);
});

it('needsAudio', () => {
  expect(needsAudio({ status: 'uploading' }, T0)).toBe(true);
  expect(needsAudio({ status: 'error', step: 'transcribe', audio_expires_at: null }, T0)).toBe(true);
  expect(needsAudio({ status: 'error', step: 'transcribe', audio_expires_at: T0 + 599_999 }, T0)).toBe(true);
  expect(needsAudio({ status: 'error', step: 'transcribe', audio_expires_at: T0 + 600_000 }, T0)).toBe(false);
  expect(needsAudio({ status: 'error', step: 'summarize', audio_expires_at: null }, T0)).toBe(false);
  expect(needsAudio({ status: 'done' }, T0)).toBe(false);
});

it('retry: only for errors, refuses expired audio, and does not double-queue', async () => {
  const id = await newLecture({ status: 'error', step: 'transcribe', attempts: 3, rate_limit_count: 2, lease_count: 2, error_message: 'x', audio_expires_at: T0 + 3600_000 });
  const r = await call(`/api/lectures/${id}/retry`, { method: 'POST' });
  expect(r.status).toBe(200);
  expect(await row(id)).toMatchObject({ status: 'processing', step: 'transcribe', attempts: 0, rate_limit_count: 0, lease_count: 0, next_run_at: 0, error_message: null });
  expect((await call(`/api/lectures/${id}/retry`, { method: 'POST' })).body.error.code).toBe('not_error');
  const expired = await newLecture({ number: 2, status: 'error', step: 'transcribe', audio_expires_at: T0 + 60_000 });
  const e = await call(`/api/lectures/${expired}/retry`, { method: 'POST' });
  expect(e.status).toBe(409);
  expect(e.body.error.code).toBe('audio_expired');
});

it('resummarize: done → processing/attach; processing → 409 busy; untranscribed → 409', async () => {
  const id = await newLecture({ status: 'done', segments_total: 1 });
  await seg(id, 0, 't');
  expect((await call(`/api/lectures/${id}/resummarize`, { method: 'POST' })).status).toBe(200);
  expect(await row(id)).toMatchObject({ status: 'processing', step: 'attach', attempts: 0 });
  expect((await call(`/api/lectures/${id}/resummarize`, { method: 'POST' })).body.error.code).toBe('busy');
  const errAtSummary = await newLecture({ number: 2, status: 'error', step: 'summarize', segments_total: 1 });
  await seg(errAtSummary, 0, 't');
  expect((await call(`/api/lectures/${errAtSummary}/resummarize`, { method: 'POST' })).status).toBe(200);
  const half = await newLecture({ number: 3, status: 'error', step: 'attach', segments_total: 2 });
  await seg(half, 0, 't');
  expect((await call(`/api/lectures/${half}/resummarize`, { method: 'POST' })).body.error.code).toBe('not_transcribed');
  const errAtTranscribe = await newLecture({ number: 4, status: 'error', step: 'transcribe', segments_total: 1 });
  expect((await call(`/api/lectures/${errAtTranscribe}/resummarize`, { method: 'POST' })).body.error.code).toBe('busy');
});

it('delete removes rows, KV values and Gemini files (ignoring Gemini errors)', async () => {
  const deleted = [];
  const ai = { deleteFile: async ({ fileName }) => { deleted.push(fileName); if (fileName === 'files/a') throw new Error('gone'); } };
  const id = await newLecture({ audio_file_name: 'files/a' });
  await env.FILES.put(`att/${id}/x`, 'v');
  await env.DB.prepare("INSERT INTO attachments (id, lecture_id, kind, mime, size, kv_key, position, gemini_file_name, created_at) VALUES ('x', ?, 'note_image', 'image/jpeg', 1, ?, 0, 'files/b', 1)").bind(id, `att/${id}/x`).run();
  await seg(id, 0, 't');
  expect((await call(`/api/lectures/${id}`, { method: 'DELETE', ai })).body).toEqual({ ok: true });
  expect(deleted.sort()).toEqual(['files/a', 'files/b']);
  expect(await env.FILES.get(`att/${id}/x`)).toBeNull();
  for (const t of ['lectures WHERE id', 'segments WHERE lecture_id', 'attachments WHERE lecture_id'])
    expect((await env.DB.prepare(`SELECT count(*) n FROM ${t} = ?`).bind(id).first()).n).toBe(0);
  expect((await call(`/api/lectures/${id}`)).status).toBe(404);
});

it('deleting a subject deletes its lectures', async () => {
  const s = await newSubject();
  const id = await newLecture({ subject_id: s });
  await seg(id, 0, 't');
  expect((await call(`/api/subjects/${s}`, { method: 'DELETE', ai: { deleteFile: async () => {} } })).status).toBe(200);
  expect(await row(id)).toBeNull();
  expect((await env.DB.prepare('SELECT count(*) n FROM segments').first()).n).toBe(0);
});
