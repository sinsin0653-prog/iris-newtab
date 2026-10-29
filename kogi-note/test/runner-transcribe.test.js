import { env } from 'cloudflare:test';
import { beforeEach, it, expect, vi } from 'vitest';
import { resetDb, processingLecture, row, newSubject, addAttachment, T0 } from './helpers.js';
import { runOnce } from '../src/jobs/runner.js';
import { rateLimitDelayMs, temporaryDelayMs, MAX_ATTEMPTS, MAX_RATE_LIMITS } from '../src/jobs/backoff.js';
import { AiError } from '../src/ai/errors.js';
import { formatTime } from '../src/ai/prompts.js';

beforeEach(() => resetDb(env));
const segs = async (id) => (await env.DB.prepare('SELECT idx, text FROM segments WHERE lecture_id = ? ORDER BY idx').bind(id).all()).results;

it('backoff numbers', () => {
  expect(rateLimitDelayMs(37000, 5)).toBe(37000);
  expect([0, 1, 2, 3, 4].map((c) => rateLimitDelayMs(undefined, c))).toEqual([120000, 240000, 480000, 960000, 1800000]);
  expect([1, 2].map(temporaryDelayMs)).toEqual([120000, 240000]);
  expect(MAX_ATTEMPTS).toBe(3);
  expect(MAX_RATE_LIMITS).toBe(12);
});

it('returns null when nothing is due', async () => {
  expect(await runOnce(env, { ai: {}, now: T0 })).toBeNull();
  await processingLecture({ next_run_at: T0 + 1 });
  expect(await runOnce(env, { ai: {}, now: T0 })).toBeNull();
});

it('wait_file → attach → transcribe x3 (with glossary and handouts) → notes, spacing segments by 65s', async () => {
  const ai = { getFileState: async () => 'ACTIVE', transcribeSegment: vi.fn(async ({ startSec }) => `[${formatTime(startSec)}] 区間`), deleteFile: vi.fn(async () => {}),
    uploadFile: async (a) => ({ fileName: `files/${a.displayName}`, fileUri: `u/${a.displayName}`, expiresAt: T0 + 172800000, state: 'ACTIVE' }) };
  const subject_id = await newSubject('統計学');
  await env.DB.prepare("UPDATE subjects SET glossary = '帰無仮説' WHERE id = ?").bind(subject_id).run();
  const id = await processingLecture({ subject_id, step: 'wait_file', audio_duration_sec: 5400 });
  await addAttachment(id, { position: 0, kind: 'note_image' });
  await addAttachment(id, { position: 1, kind: 'handout_pdf', mime: 'application/pdf' });
  expect(await runOnce(env, { ai, now: T0 })).toEqual({ id, step: 'wait_file' });
  expect(await row(id)).toMatchObject({ step: 'attach', segments_total: 3, next_run_at: T0, lease_until: 0, lease_count: 0 });
  await runOnce(env, { ai, now: T0 });
  expect(await row(id)).toMatchObject({ step: 'transcribe' });
  await runOnce(env, { ai, now: T0 });
  const first = ai.transcribeSegment.mock.calls[0][0];
  expect(first.glossary).toBe('帰無仮説');
  expect(first.handouts).toEqual([{ fileUri: expect.stringMatching(/^u\//), mime: 'application/pdf' }]);
  expect(await runOnce(env, { ai, now: T0 + 64999 })).toBeNull();
  await runOnce(env, { ai, now: T0 + 65000 });
  await runOnce(env, { ai, now: T0 + 130000 });
  expect(ai.transcribeSegment.mock.calls.map(([a]) => [a.startSec, a.endSec, a.fileUri, a.mime])).toEqual([[0, 1800, 'u/a', 'audio/mp4'], [1800, 3600, 'u/a', 'audio/mp4'], [3600, 5400, 'u/a', 'audio/mp4']]);
  expect(ai.deleteFile).toHaveBeenCalledWith({ fileName: 'files/a' });
  expect(await row(id)).toMatchObject({ step: 'notes', audio_file_name: null, audio_file_uri: null, status: 'processing', next_run_at: T0 + 130000 });
  expect((await segs(id)).map((s) => s.text)).toEqual(['[00:00] 区間', '[30:00] 区間', '[60:00] 区間']);
});

it('the last segment ends at the audio length', async () => {
  const ai = { getFileState: async () => 'ACTIVE', transcribeSegment: vi.fn(async () => 't'), deleteFile: async () => {} };
  const id = await processingLecture({ audio_duration_sec: 2000 });
  await runOnce(env, { ai, now: T0 }); // wait_file
  await runOnce(env, { ai, now: T0 }); // attach（添付なし）
  await runOnce(env, { ai, now: T0 });
  await runOnce(env, { ai, now: T0 + 65000 });
  expect(ai.transcribeSegment.mock.calls.map(([a]) => [a.startSec, a.endSec])).toEqual([[0, 1800], [1800, 2000]]);
});

it('unknown duration means 4 segments of 30 minutes', async () => {
  const ai = { getFileState: async () => 'ACTIVE' };
  const id = await processingLecture({ audio_duration_sec: null });
  await runOnce(env, { ai, now: T0 });
  expect((await row(id)).segments_total).toBe(4);
});

it('deleting the audio failing does not stop the move to notes', async () => {
  const ai = { transcribeSegment: async () => '', deleteFile: async () => { throw new AiError('temporary', 'x'); } };
  const id = await processingLecture({ step: 'transcribe', segments_total: 1 });
  await runOnce(env, { ai, now: T0 });
  expect(await row(id)).toMatchObject({ step: 'notes', status: 'processing' });
  expect(await segs(id)).toEqual([{ idx: 0, text: '' }]);
});

it('PROCESSING waits 60s; FAILED is an error', async () => {
  const id = await processingLecture();
  await runOnce(env, { ai: { getFileState: async () => 'PROCESSING' }, now: T0 });
  expect(await row(id)).toMatchObject({ step: 'wait_file', next_run_at: T0 + 60000, status: 'processing' });
  await runOnce(env, { ai: { getFileState: async () => 'FAILED' }, now: T0 + 60000 });
  expect(await row(id)).toMatchObject({ status: 'error', error_message: '準備に失敗しました：Gemini が音声を読めませんでした' });
});

it('429 waits without counting attempts and grows the wait', async () => {
  const ai = { getFileState: async () => { throw new AiError('rate_limited', 'quota'); } };
  const id = await processingLecture();
  await runOnce(env, { ai, now: T0 });
  expect(await row(id)).toMatchObject({ attempts: 0, rate_limit_count: 1, waiting_reason: 'rate_limited', next_run_at: T0 + 120000, lease_until: 0 });
  await runOnce(env, { ai, now: T0 + 120000 });
  expect(await row(id)).toMatchObject({ rate_limit_count: 2, next_run_at: T0 + 120000 + 240000 });
  await runOnce(env, { ai: { getFileState: async () => { throw new AiError('rate_limited', 'q', 5000); } }, now: T0 + 360000 });
  expect((await row(id)).next_run_at).toBe(T0 + 365000);
});

it('gives up after MAX_RATE_LIMITS consecutive 429s', async () => {
  const id = await processingLecture({ rate_limit_count: 11 });
  await runOnce(env, { ai: { getFileState: async () => { throw new AiError('rate_limited', 'quota'); } }, now: T0 });
  const r = await row(id);
  expect(r).toMatchObject({ status: 'error', waiting_reason: null });
  expect(r.error_message).toContain('無料枠の上限に何度もかかりました');
});

it('temporary errors retry at 2 and 4 minutes, then fail on the third', async () => {
  const ai = { getFileState: async () => { throw new AiError('temporary', 'down'); } };
  const id = await processingLecture();
  await runOnce(env, { ai, now: T0 });
  expect(await row(id)).toMatchObject({ attempts: 1, next_run_at: T0 + 120000, status: 'processing' });
  await runOnce(env, { ai, now: T0 + 120000 });
  expect(await row(id)).toMatchObject({ attempts: 2, next_run_at: T0 + 360000 });
  await runOnce(env, { ai, now: T0 + 360000 });
  const r = await row(id);
  expect(r.status).toBe('error');
  expect(r.error_message).toBe('準備に失敗しました：down');
});

it('permanent error fails immediately; success resets attempts and rate_limit_count', async () => {
  const id = await processingLecture({ attempts: 2, rate_limit_count: 3, waiting_reason: 'rate_limited' });
  await runOnce(env, { ai: { getFileState: async () => 'ACTIVE' }, now: T0 });
  expect(await row(id)).toMatchObject({ attempts: 0, rate_limit_count: 0, waiting_reason: null, step: 'attach' });
  await runOnce(env, { ai: {}, now: T0 });
  expect((await row(id)).step).toBe('transcribe');
  await runOnce(env, { ai: { transcribeSegment: async () => { throw new AiError('permanent', 'blocked'); } }, now: T0 });
  expect(await row(id)).toMatchObject({ status: 'error', error_message: '文字起こしに失敗しました：blocked' });
});

it('non-AI exceptions are errors too', async () => {
  const id = await processingLecture();
  await runOnce(env, { ai: { getFileState: async () => { throw new TypeError('boom'); } }, now: T0 });
  expect(await row(id)).toMatchObject({ status: 'error', lease_until: 0 });
});

it('expired audio fails without calling Gemini', async () => {
  const ai = { getFileState: vi.fn() };
  const id = await processingLecture({ step: 'transcribe', segments_total: 3, audio_expires_at: T0 + 599999 });
  await runOnce(env, { ai, now: T0 });
  expect(ai.getFileState).not.toHaveBeenCalled();
  expect(await row(id)).toMatchObject({ status: 'error', error_message: '音声の期限が切れました。もう一回入れてね' });
});

it('a lecture whose last 3 leases never wrote back becomes an error without calling AI', async () => {
  const ai = { getFileState: vi.fn(async () => 'ACTIVE') };
  const id = await processingLecture({ lease_until: T0 + 1, lease_count: 3 });
  await runOnce(env, { ai, now: T0 + 2 });
  expect(ai.getFileState).not.toHaveBeenCalled();
  const r = await row(id);
  expect(r.status).toBe('error');
  expect(r.error_message.startsWith('準備に失敗しました：処理が途中で止まりました')).toBe(true);
  const ok = await processingLecture({ number: 2, lease_count: 1 });
  await runOnce(env, { ai, now: T0 + 2 });
  expect(await row(ok)).toMatchObject({ step: 'attach', lease_count: 0 });
});

it('two runners do not take the same lecture; a stale lease is picked up after 10 minutes', async () => {
  const id = await processingLecture({ lease_until: T0 + 1 });
  expect(await runOnce(env, { ai: {}, now: T0 })).toBeNull();
  let release;
  const gate = new Promise((r) => { release = r; });
  const ai = { getFileState: vi.fn(async () => { await gate; return 'ACTIVE'; }) };
  const a = runOnce(env, { ai, now: T0 + 2 });
  const b = runOnce(env, { ai, now: T0 + 2 });
  await new Promise((r) => setTimeout(r, 50));
  release();
  const results = await Promise.all([a, b]);
  expect(results.filter(Boolean)).toEqual([{ id, step: 'wait_file' }]);
  expect(ai.getFileState).toHaveBeenCalledTimes(1);
});
