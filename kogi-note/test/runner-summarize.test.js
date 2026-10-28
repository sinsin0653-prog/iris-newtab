import { env } from 'cloudflare:test';
import { beforeEach, it, expect, vi } from 'vitest';
import { resetDb, processingLecture, row, addSegment, addAttachment, T0 } from './helpers.js';
import { runOnce } from '../src/jobs/runner.js';

beforeEach(() => resetDb(env));
const summary = { theme: 'T', flow: [], key_points: [], announcements: [] };
const fileFor = ({ displayName }) => ({ fileName: `files/${displayName}`, fileUri: `u/${displayName}`, expiresAt: T0 + 172800000, state: 'ACTIVE' });
const attRows = async (id) => (await env.DB.prepare('SELECT * FROM attachments WHERE lecture_id = ? ORDER BY position').bind(id).all()).results;

it('uploads 7 attachments over two runs, then summarizes and cleans up', async () => {
  const uploaded = []; const deleted = [];
  const ai = {
    uploadFile: async (a) => { uploaded.push(a); if (uploaded.length === 1) expect([...new Uint8Array(await new Response(a.body).arrayBuffer())]).toEqual([1, 2, 3]); return fileFor(a); },
    getFileState: async () => 'ACTIVE',
    summarize: vi.fn(async () => summary),
    deleteFile: async ({ fileName }) => { deleted.push(fileName); },
  };
  const id = await processingLecture({ step: 'attach', segments_total: 3, note_text: '手で打ったメモ' });
  await addSegment(id, 1, '[30:00] 後半'); await addSegment(id, 0, '[00:00] 本文'); await addSegment(id, 2, '');
  for (let i = 0; i < 7; i++) await addAttachment(id, { position: i, kind: i === 6 ? 'handout_pdf' : 'note_image', mime: i === 6 ? 'application/pdf' : 'image/jpeg' });
  await runOnce(env, { ai, now: T0 });
  expect(uploaded).toHaveLength(5);
  expect(uploaded[0].body).toBeInstanceOf(ReadableStream);
  expect(uploaded[0]).toMatchObject({ mime: 'image/jpeg', size: 3 });
  expect((await row(id)).step).toBe('attach');
  await runOnce(env, { ai, now: T0 });
  expect(uploaded).toHaveLength(7);
  expect((await row(id)).step).toBe('summarize');
  await runOnce(env, { ai, now: T0 });
  const arg = ai.summarize.mock.calls[0][0];
  expect(arg.transcript).toBe('[00:00] 本文\n[30:00] 後半');
  expect(arg.noteText).toBe('手で打ったメモ');
  expect(arg.attachments).toHaveLength(7);
  expect(arg.attachments[0]).toMatchObject({ mime: 'image/jpeg', kind: 'note_image' });
  expect(arg.attachments[6]).toMatchObject({ mime: 'application/pdf', kind: 'handout_pdf' });
  expect(await row(id)).toMatchObject({ status: 'done', step: null, summary_json: JSON.stringify(summary) });
  expect(deleted).toHaveLength(7);
  const { n } = await env.DB.prepare('SELECT count(*) n FROM attachments WHERE gemini_file_name IS NOT NULL OR gemini_file_uri IS NOT NULL').first();
  expect(n).toBe(0);
});

it('re-uploads attachments whose Gemini copy expires within an hour', async () => {
  const ai = { uploadFile: vi.fn(async (a) => fileFor(a)) };
  const id = await processingLecture({ step: 'attach', segments_total: 1 });
  const fresh = await addAttachment(id, { position: 0, gemini: { name: 'files/x', uri: 'u/x', expiresAt: T0 + 7200_000 } });
  const old = await addAttachment(id, { position: 1, gemini: { name: 'files/y', uri: 'u/y', expiresAt: T0 + 3599_999 } });
  await runOnce(env, { ai, now: T0 });
  expect(ai.uploadFile.mock.calls.map(([a]) => a.displayName)).toEqual([old.id]);
  expect((await row(id)).step).toBe('summarize');
  expect((await attRows(id)).find((a) => a.id === fresh.id).gemini_file_uri).toBe('u/x');
});

it('an attachment whose KV value is missing is dropped and attach moves on', async () => {
  const ai = { uploadFile: vi.fn(), deleteFile: vi.fn(async () => {}) };
  const id = await processingLecture({ step: 'attach', segments_total: 1 });
  const a = await addAttachment(id, { position: 0 });
  await env.FILES.delete(a.kv_key);
  await runOnce(env, { ai, now: T0 });
  expect(ai.uploadFile).not.toHaveBeenCalled();
  expect((await row(id)).step).toBe('summarize');
  expect(await attRows(id)).toEqual([]);
});

it('deletes the fresh Gemini copy when the attachment was removed during upload', async () => {
  const deleteFile = vi.fn(async () => {});
  const id = await processingLecture({ step: 'attach', segments_total: 1 });
  const a = await addAttachment(id, { position: 0 });
  const ai = { uploadFile: async () => { await env.DB.prepare('DELETE FROM attachments WHERE id = ?').bind(a.id).run(); return { fileName: 'files/new', fileUri: 'u/new', expiresAt: T0 + 1, state: 'ACTIVE' }; }, deleteFile };
  await runOnce(env, { ai, now: T0 });
  expect(deleteFile).toHaveBeenCalledWith({ fileName: 'files/new' });
  expect((await row(id)).status).toBe('processing');
});

it('waits while an attachment is PROCESSING; FAILED is an error', async () => {
  const id = await processingLecture({ step: 'summarize', segments_total: 1 });
  await addSegment(id, 0, '[00:00] 本文');
  await addAttachment(id, { position: 0, kind: 'handout_pdf', mime: 'application/pdf', gemini: { name: 'files/p', uri: 'u/p', expiresAt: T0 + 172800000 } });
  const summarize = vi.fn();
  await runOnce(env, { ai: { getFileState: async () => 'PROCESSING', summarize }, now: T0 });
  expect(await row(id)).toMatchObject({ step: 'summarize', status: 'processing', next_run_at: T0 + 60000 });
  expect(summarize).not.toHaveBeenCalled();
  await runOnce(env, { ai: { getFileState: async () => 'FAILED', summarize }, now: T0 + 60000 });
  expect((await row(id)).status).toBe('error');
  expect((await row(id)).error_message).toContain('メモかレジュメ');
});

it('no attachments goes straight to summarize', async () => {
  const ai = { summarize: vi.fn(async () => summary) };
  const id = await processingLecture({ step: 'attach', segments_total: 1 });
  await addSegment(id, 0, '[00:00] 本文');
  await runOnce(env, { ai, now: T0 });
  expect((await row(id)).step).toBe('summarize');
  await runOnce(env, { ai, now: T0 });
  expect(ai.summarize.mock.calls[0][0].attachments).toEqual([]);
  expect((await row(id)).status).toBe('done');
});

it('all-silent transcript errors without calling summarize', async () => {
  const ai = { summarize: vi.fn(), getFileState: vi.fn() };
  const id = await processingLecture({ step: 'summarize', segments_total: 2 });
  await addSegment(id, 0, ''); await addSegment(id, 1, '');
  await runOnce(env, { ai, now: T0 });
  expect(ai.summarize).not.toHaveBeenCalled();
  expect(await row(id)).toMatchObject({ status: 'error' });
  expect((await row(id)).error_message).toContain('話し声');
});

it('end to end: wait_file → done with a fake AI', async () => {
  const ai = {
    getFileState: async () => 'ACTIVE',
    transcribeSegment: async () => '[00:00] こんにちは',
    deleteFile: async () => {},
    uploadFile: async (a) => fileFor(a),
    summarize: async () => summary,
  };
  const id = await processingLecture({ audio_duration_sec: 60 });
  await addAttachment(id, { position: 0 });
  let now = T0;
  for (let i = 0; i < 4; i++) { await runOnce(env, { ai, now }); now += 65000; }
  expect(await row(id)).toMatchObject({ status: 'done', segments_total: 1 });
});
