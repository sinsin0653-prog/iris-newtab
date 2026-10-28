import { env } from 'cloudflare:test';
import { beforeEach, it, expect } from 'vitest';
import { resetDb, call, newLecture, T0 } from './helpers.js';
import { chunkSizeFor, MAX_CHUNK_BYTES } from '../src/api/audio.js';
import { normalizeAudioMime } from '../src/mime.js';
import { AiError } from '../src/ai/errors.js';

beforeEach(() => resetDb(env));
const row = (id) => env.DB.prepare('SELECT * FROM lectures WHERE id = ?').bind(id).first();
const fakeAi = (over = {}) => {
  const log = [];
  return {
    log,
    startAudioUpload: async (a) => { log.push(['start', a]); return { uploadUrl: 'https://up.test/s', granularity: 8388608 }; },
    uploadAudioChunk: async (a) => { log.push(['chunk', a.offset, a.size, a.isLast]); return a.isLast ? { fileName: 'files/new', fileUri: 'u', expiresAt: T0 + 172800000 } : null; },
    queryUploadOffset: async () => 4,
    deleteFile: async (a) => { log.push(['delete', a.fileName]); },
    ...over,
  };
};
const start = (id, ai, json = { mime: 'audio/mp4', size: 10, duration_sec: 5400 }) => call(`/api/lectures/${id}/audio/start`, { method: 'POST', ai, json });
const put = (id, ai, offset, n, headers) => call(`/api/lectures/${id}/audio/chunk?offset=${offset}`, { method: 'PUT', ai, body: new Uint8Array(n), headers });

it('chunkSizeFor rounds to the granularity', () => {
  expect(chunkSizeFor(null)).toBe(16777216);
  expect(chunkSizeFor(8388608)).toBe(16777216);
  expect(chunkSizeFor(10_000_000)).toBe(10_000_000);
  expect(chunkSizeFor(20_000_000)).toBe(20_000_000);
});

it('normalizeAudioMime', () => {
  expect(normalizeAudioMime('audio/x-m4a')).toBe('audio/mp4');
  expect(normalizeAudioMime('Audio/M4A; codecs=mp4a')).toBe('audio/mp4');
  expect(normalizeAudioMime('audio/x-wav')).toBe('audio/wav');
  expect(normalizeAudioMime('audio/mp3')).toBe('audio/mpeg');
  expect(normalizeAudioMime('audio/x-aac')).toBe('audio/aac');
  expect(normalizeAudioMime('audio/x-flac')).toBe('audio/flac');
  expect(normalizeAudioMime('audio/ogg')).toBe('audio/ogg');
});

it('uploads in two chunks and queues the lecture', async () => {
  const ai = fakeAi();
  const id = await newLecture();
  expect((await start(id, ai)).body).toEqual({ chunk_size: 16777216 });
  expect((await put(id, ai, 0, 6)).body).toEqual({ next_offset: 6, done: false });
  expect((await put(id, ai, 6, 4)).body).toEqual({ next_offset: 10, done: true });
  expect(ai.log.filter((l) => l[0] === 'chunk')).toEqual([['chunk', 0, 6, false], ['chunk', 6, 4, true]]);
  expect(await row(id)).toMatchObject({ status: 'processing', step: 'wait_file', audio_file_name: 'files/new', audio_file_uri: 'u', audio_expires_at: T0 + 172800000, audio_upload_url: null, audio_duration_sec: 5400, attempts: 0, lease_count: 0, next_run_at: 0 });
});

it('offset mismatch resyncs from Gemini and returns expected_offset', async () => {
  const ai = fakeAi();
  const id = await newLecture();
  await start(id, ai);
  const r = await put(id, ai, 6, 4);
  expect(r.status).toBe(409);
  expect(r.body.error).toMatchObject({ code: 'offset_mismatch', expected_offset: 4 });
  expect((await row(id)).audio_upload_offset).toBe(4);
});

it('starting again deletes the old Gemini file and clears segments', async () => {
  const ai = fakeAi();
  const id = await newLecture({ status: 'error', step: 'transcribe', audio_file_name: 'files/old', audio_upload_offset: 7, segments_total: 3, error_message: 'x' });
  await env.DB.batch([0, 1].map((i) => env.DB.prepare('INSERT INTO segments VALUES (?,?,?)').bind(id, i, 't')));
  expect((await start(id, ai)).status).toBe(200);
  expect(ai.log).toContainEqual(['delete', 'files/old']);
  expect((await env.DB.prepare('SELECT count(*) n FROM segments WHERE lecture_id=?').bind(id).first()).n).toBe(0);
  expect(await row(id)).toMatchObject({ status: 'uploading', step: null, audio_upload_offset: 0, audio_file_name: null, segments_total: null, error_message: null, audio_upload_url: 'https://up.test/s' });
});

it('rejects bad mime, too large size, and start while processing', async () => {
  const ai = fakeAi();
  const id = await newLecture();
  expect((await start(id, ai, { mime: 'image/png', size: 10, duration_sec: 1 })).status).toBe(400);
  expect((await start(id, ai, { mime: 'audio/mp4', size: 2147483649, duration_sec: 1 })).status).toBe(400);
  expect((await start(id, ai, { mime: 'audio/mp4', size: 0, duration_sec: 1 })).status).toBe(400);
  const busy = await newLecture({ number: 2, status: 'processing', step: 'transcribe' });
  expect((await start(busy, ai)).body.error.code).toBe('busy');
  expect((await start('nope', ai)).status).toBe(404);
});

it('normalizes audio/x-m4a to audio/mp4 before saving and sending', async () => {
  const ai = fakeAi();
  const id = await newLecture();
  await start(id, ai, { mime: 'audio/x-m4a', size: 10, duration_sec: 60 });
  expect((await row(id)).audio_mime).toBe('audio/mp4');
  expect(ai.log[0][1].mime).toBe('audio/mp4');
  expect(ai.log[0][1].size).toBe(10);
});

it('video/mp4 is accepted', async () => {
  const id = await newLecture();
  expect((await start(id, fakeAi(), { mime: 'video/mp4', size: 10, duration_sec: 60 })).status).toBe(200);
});

it('Gemini failure on start is 502 and leaves the row unchanged', async () => {
  const ai = fakeAi({ startAudioUpload: async () => { throw new AiError('temporary', 'x'); } });
  const id = await newLecture({ status: 'error', step: 'transcribe', audio_file_name: 'files/old' });
  const r = await start(id, ai);
  expect(r.status).toBe(502);
  expect(r.body.error.code).toBe('upstream');
  expect(await row(id)).toMatchObject({ status: 'error', step: 'transcribe', audio_file_name: 'files/old' });
  expect(ai.log).toEqual([]);
});

it('non-positive or missing duration is stored as null', async () => {
  for (const [n, d] of [[1, 0], [2, -1], [3, 'x'], [4, undefined]]) {
    const id = await newLecture({ number: n });
    await start(id, fakeAi(), { mime: 'audio/mp4', size: 10, duration_sec: d });
    expect((await row(id)).audio_duration_sec).toBeNull();
  }
});

it('Gemini failure after the bytes arrived resyncs instead of 502', async () => {
  const ai = fakeAi({ uploadAudioChunk: async () => { throw new AiError('temporary', 't'); } });
  const id = await newLecture();
  await start(id, ai);
  const r = await put(id, ai, 0, 6);
  expect(r.status).toBe(409);
  expect(r.body.error).toMatchObject({ code: 'offset_mismatch', expected_offset: 4 });
  expect((await row(id)).audio_upload_offset).toBe(4);
  const same = fakeAi({ uploadAudioChunk: async () => { throw new AiError('temporary', 't'); }, queryUploadOffset: async () => 4 });
  const r2 = await put(id, same, 4, 6);
  expect(r2.status).toBe(502);
  expect(r2.body.error.code).toBe('upstream');
  expect((await row(id)).audio_upload_offset).toBe(4);
  const queryFails = fakeAi({ uploadAudioChunk: async () => { throw new AiError('temporary', 't'); }, queryUploadOffset: async () => { throw new AiError('temporary', 'q'); } });
  expect((await put(id, queryFails, 4, 6)).status).toBe(502);
});

it('re-sending the finalized last chunk returns done without touching Gemini', async () => {
  const ai = fakeAi();
  const id = await newLecture();
  await start(id, ai);
  await put(id, ai, 0, 6);
  await put(id, ai, 6, 4);
  const before = ai.log.length;
  expect((await put(id, ai, 6, 4)).body).toEqual({ next_offset: 10, done: true });
  expect(ai.log.length).toBe(before);
});

it('chunk while not uploading is 409', async () => {
  const id = await newLecture({ status: 'done' });
  expect((await put(id, fakeAi(), 0, 4)).body.error.code).toBe('not_uploading');
});

it('chunk over 100MB, missing length or past the end is 400', async () => {
  const ai = fakeAi();
  const id = await newLecture();
  await start(id, ai);
  expect((await put(id, ai, 0, 4, { 'Content-Length': null })).status).toBe(400);
  expect((await put(id, ai, 0, 0)).status).toBe(400);
  expect((await put(id, ai, 0, 11)).status).toBe(400);
  expect(ai.log.filter((l) => l[0] === 'chunk')).toEqual([]);
  expect(MAX_CHUNK_BYTES).toBe(104857600);
});

it('an out-of-range offset from Gemini on mismatch keeps the stored offset', async () => {
  const ai = fakeAi({ queryUploadOffset: async () => 99 });
  const id = await newLecture();
  await start(id, ai);
  const r = await put(id, ai, 6, 4);
  expect(r.status).toBe(409);
  expect(r.body.error.expected_offset).toBe(0);
  expect((await row(id)).audio_upload_offset).toBe(0);
});
