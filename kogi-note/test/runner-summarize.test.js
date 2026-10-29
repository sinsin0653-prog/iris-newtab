import { env } from 'cloudflare:test';
import { beforeEach, it, expect, vi } from 'vitest';
import { AiError } from '../src/ai/errors.js';
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
  const notes = { sections: [{ heading: '導入', time: '00:05', body: 'b', terms: [], quotes: [] }] };
  ai.writeNotes = vi.fn(async () => notes);
  const id = await processingLecture({ step: 'attach', segments_total: 3, note_text: '手で打ったメモ', audio_file_name: null, audio_file_uri: null });
  await addSegment(id, 1, '[30:00] 後半'); await addSegment(id, 0, '[00:00] 本文'); await addSegment(id, 2, '');
  for (let i = 0; i < 7; i++) await addAttachment(id, { position: i, kind: i === 6 ? 'handout_pdf' : 'note_image', mime: i === 6 ? 'application/pdf' : 'image/jpeg' });
  await runOnce(env, { ai, now: T0 });
  expect(uploaded).toHaveLength(5);
  expect(uploaded[0].body).toBeInstanceOf(ReadableStream);
  expect(uploaded[0]).toMatchObject({ mime: 'image/jpeg', size: 3 });
  expect((await row(id)).step).toBe('attach');
  await runOnce(env, { ai, now: T0 });
  expect(uploaded).toHaveLength(7);
  // 音声がもう無い（文字起こし済み）ので transcribe を飛ばして notes へ
  expect((await row(id)).step).toBe('notes');
  await runOnce(env, { ai, now: T0 });
  await runOnce(env, { ai, now: T0 });
  await runOnce(env, { ai, now: T0 });
  // 空の区間（idx 2）は Gemini に頼まない
  expect(ai.writeNotes.mock.calls.map(([a]) => [a.startSec, a.endSec, a.segmentText])).toEqual([[0, 1800, '[00:00] 本文'], [1800, 3600, '[30:00] 後半']]);
  expect(ai.writeNotes.mock.calls[0][0].handouts).toEqual([{ fileUri: expect.any(String), mime: 'application/pdf' }]);
  const notesRow = await row(id);
  expect(notesRow.step).toBe('summarize');
  expect(JSON.parse(notesRow.notes_json).sections).toHaveLength(2); // 空の区間は飛ばす
  await runOnce(env, { ai, now: T0 });
  const arg = ai.summarize.mock.calls[0][0];
  expect(arg.transcript).toBe('[00:00] 本文\n[30:00] 後半');
  expect(arg.noteText).toBe('手で打ったメモ');
  expect(arg.notes.sections).toHaveLength(2);
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
  const id = await processingLecture({ step: 'attach', segments_total: 1, audio_file_name: null });
  const fresh = await addAttachment(id, { position: 0, gemini: { name: 'files/x', uri: 'u/x', expiresAt: T0 + 7200_000 } });
  const old = await addAttachment(id, { position: 1, gemini: { name: 'files/y', uri: 'u/y', expiresAt: T0 + 3599_999 } });
  await runOnce(env, { ai, now: T0 });
  expect(ai.uploadFile.mock.calls.map(([a]) => a.displayName)).toEqual([old.id]);
  expect((await row(id)).step).toBe('notes');
  expect((await attRows(id)).find((a) => a.id === fresh.id).gemini_file_uri).toBe('u/x');
});

it('an attachment whose KV value is missing is dropped and attach moves on', async () => {
  const ai = { uploadFile: vi.fn(), deleteFile: vi.fn(async () => {}) };
  const id = await processingLecture({ step: 'attach', segments_total: 1, audio_file_name: null });
  const a = await addAttachment(id, { position: 0 });
  await env.FILES.delete(a.kv_key);
  await runOnce(env, { ai, now: T0 });
  expect(ai.uploadFile).not.toHaveBeenCalled();
  expect((await row(id)).step).toBe('notes');
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

it('no attachments goes attach → notes → summarize; notes written per segment', async () => {
  const notes = { sections: [{ heading: '導入', time: '00:05', body: 'b', terms: [], quotes: [] }] };
  const ai = { summarize: vi.fn(async () => summary), writeNotes: vi.fn(async () => notes) };
  const id = await processingLecture({ step: 'attach', segments_total: 1, audio_file_name: null });
  await addSegment(id, 0, '[00:00] 本文');
  await runOnce(env, { ai, now: T0 });
  expect((await row(id)).step).toBe('notes');
  await runOnce(env, { ai, now: T0 });
  expect(ai.writeNotes.mock.calls[0][0]).toMatchObject({ startSec: 0, endSec: 1800, glossary: '', handouts: [] });
  expect((await row(id)).step).toBe('summarize');
  await runOnce(env, { ai, now: T0 });
  expect(ai.summarize.mock.calls[0][0].attachments).toEqual([]);
  expect(ai.summarize.mock.calls[0][0].notes).toEqual(notes);
  expect((await row(id)).status).toBe('done');
});

it('notes resume after a failure at the second segment and keep the first', async () => {
  const notes = (h) => ({ sections: [{ heading: h, time: '00:05', body: 'b', terms: [], quotes: [] }] });
  let calls = 0;
  const ai = { writeNotes: vi.fn(async () => { calls++; if (calls === 2) throw new AiError('temporary', 'x'); return notes(`n${calls}`); }) };
  const id = await processingLecture({ step: 'notes', segments_total: 2, audio_file_name: null });
  await addSegment(id, 0, 'a'); await addSegment(id, 1, 'b');
  await runOnce(env, { ai, now: T0 });
  await runOnce(env, { ai, now: T0 });
  expect(await row(id)).toMatchObject({ step: 'notes', attempts: 1 });
  await runOnce(env, { ai, now: T0 + 120000 });
  const r = await row(id);
  expect(r.step).toBe('summarize');
  expect(JSON.parse(r.notes_json).sections.map((s) => s.heading)).toEqual(['n1', 'n3']);
  expect(ai.writeNotes).toHaveBeenCalledTimes(3);
});

it('resummarize keeps the existing notes and skips notes when already complete', async () => {
  const ai = { summarize: vi.fn(async () => summary), writeNotes: vi.fn() };
  const notesJson = JSON.stringify({ sections: [{ heading: 'old', time: '00:05', body: 'b', terms: [], quotes: [] }], done: 1 });
  const id = await processingLecture({ step: 'attach', segments_total: 1, audio_file_name: null, notes_json: notesJson });
  await addSegment(id, 0, 'a');
  await runOnce(env, { ai, now: T0 });
  await runOnce(env, { ai, now: T0 });
  expect(ai.writeNotes).not.toHaveBeenCalled();
  expect((await row(id)).step).toBe('summarize');
});

it('all-silent transcript errors without calling notes or summarize', async () => {
  const ai = { summarize: vi.fn(), getFileState: vi.fn(), writeNotes: vi.fn() };
  const id = await processingLecture({ step: 'notes', segments_total: 2 });
  await addSegment(id, 0, ''); await addSegment(id, 1, '');
  await runOnce(env, { ai, now: T0 });
  expect(ai.summarize).not.toHaveBeenCalled();
  expect(ai.writeNotes).not.toHaveBeenCalled();
  expect(await row(id)).toMatchObject({ status: 'error' });
  expect((await row(id)).error_message).toContain('話し声');
});

it('end to end: wait_file → done with a fake AI', async () => {
  const ai = {
    getFileState: async () => 'ACTIVE',
    transcribeSegment: async () => '[00:00] こんにちは',
    deleteFile: async () => {},
    uploadFile: async (a) => fileFor(a),
    writeNotes: async () => ({ sections: [] }),
    summarize: async () => summary,
  };
  const id = await processingLecture({ audio_duration_sec: 60 });
  await addAttachment(id, { position: 0 });
  let now = T0;
  for (let i = 0; i < 5; i++) { await runOnce(env, { ai, now }); now += 65000; }
  expect(await row(id)).toMatchObject({ status: 'done', segments_total: 1 });
});
