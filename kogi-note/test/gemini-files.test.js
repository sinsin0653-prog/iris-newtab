import { it, expect } from 'vitest';
import { fakeFetch, g } from './helpers.js';
import { AiError } from '../src/ai/errors.js';
import { createGemini, CHUNK_TIMEOUT_MS } from '../src/ai/gemini.js';

it('startAudioUpload sends resumable start headers and returns upload url + granularity', async () => {
  const f = fakeFetch(() => new Response('{}', { headers: { 'x-goog-upload-url': 'https://up.test/s1', 'x-goog-upload-chunk-granularity': '8388608' } }));
  expect(await g(f).startAudioUpload({ mime: 'audio/mp4', size: 100, displayName: 'l1' })).toEqual({ uploadUrl: 'https://up.test/s1', granularity: 8388608 });
  const r = f.calls[0];
  expect(r.url).toBe('https://gem.test/upload/v1beta/files');
  expect(r.method).toBe('POST');
  expect(r.headers.get('x-goog-api-key')).toBe('KEY');
  expect(r.headers.get('x-goog-upload-protocol')).toBe('resumable');
  expect(r.headers.get('x-goog-upload-command')).toBe('start');
  expect(r.headers.get('x-goog-upload-header-content-length')).toBe('100');
  expect(r.headers.get('x-goog-upload-header-content-type')).toBe('audio/mp4');
  expect(await r.json()).toEqual({ file: { display_name: 'l1' } });
  expect(r.url).not.toContain('KEY');
});

it('startAudioUpload without granularity header returns null, without url is temporary', async () => {
  const ok = fakeFetch(() => new Response('{}', { headers: { 'x-goog-upload-url': 'https://up.test/s1' } }));
  expect((await g(ok).startAudioUpload({ mime: 'audio/mp4', size: 1, displayName: 'x' })).granularity).toBeNull();
  const bad = fakeFetch(() => new Response('{}'));
  await expect(g(bad).startAudioUpload({ mime: 'audio/mp4', size: 1, displayName: 'x' })).rejects.toMatchObject({ kind: 'temporary' });
});

it('uploadAudioChunk sends a middle chunk and returns null', async () => {
  const f = fakeFetch(() => new Response('', { headers: { 'x-goog-upload-status': 'active' } }));
  expect(await g(f).uploadAudioChunk({ uploadUrl: 'https://up.test/s1', offset: 0, body: new Uint8Array(4), size: 4, isLast: false })).toBeNull();
  expect(f.calls[0].url).toBe('https://up.test/s1');
  expect(f.calls[0].headers.get('x-goog-upload-command')).toBe('upload');
  expect(f.calls[0].headers.get('content-length')).toBe('4');
});

it('uploadAudioChunk finalizes on the last chunk and returns file info', async () => {
  const f = fakeFetch(() => Response.json({ file: { name: 'files/abc', uri: 'https://gem.test/v1beta/files/abc', state: 'PROCESSING', expirationTime: '2026-10-30T00:00:00Z' } }));
  const out = await g(f).uploadAudioChunk({ uploadUrl: 'https://up.test/s1', offset: 16, body: new Uint8Array(4), size: 4, isLast: true });
  expect(out).toEqual({ fileName: 'files/abc', fileUri: 'https://gem.test/v1beta/files/abc', expiresAt: Date.parse('2026-10-30T00:00:00Z') });
  expect(f.calls[0].headers.get('x-goog-upload-command')).toBe('upload, finalize');
  expect(f.calls[0].headers.get('x-goog-upload-offset')).toBe('16');
});

it('maps 429 with RetryInfo to rate_limited', async () => {
  const f = fakeFetch(() => Response.json({ error: { message: 'quota', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' }] } }, { status: 429 }));
  const err = await g(f).getFileState({ fileName: 'files/a' }).catch((e) => e);
  expect(err).toBeInstanceOf(AiError);
  expect(err).toMatchObject({ kind: 'rate_limited', retryAfterMs: 37000, message: 'quota' });
});

it('maps 429 with Retry-After header, and without any hint', async () => {
  const a = fakeFetch(() => new Response('{}', { status: 429, headers: { 'retry-after': '12' } }));
  await expect(g(a).getFileState({ fileName: 'files/a' })).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 12000 });
  const b = fakeFetch(() => new Response('nope', { status: 429 }));
  const err = await g(b).getFileState({ fileName: 'files/a' }).catch((e) => e);
  expect(err.kind).toBe('rate_limited');
  expect(err.retryAfterMs).toBeUndefined();
});

it('maps 503 and network failure to temporary, 400 to permanent', async () => {
  await expect(g(fakeFetch(() => new Response('', { status: 503 }))).getFileState({ fileName: 'files/a' })).rejects.toMatchObject({ kind: 'temporary', message: 'HTTP 503' });
  await expect(g(async () => { throw new TypeError('network'); }).getFileState({ fileName: 'files/a' })).rejects.toMatchObject({ kind: 'temporary' });
  await expect(g(fakeFetch(() => Response.json({ error: { message: 'bad' } }, { status: 400 }))).getFileState({ fileName: 'files/a' })).rejects.toMatchObject({ kind: 'permanent', message: 'bad' });
});

it('getFileState reads state from the file resource', async () => {
  const f = fakeFetch(() => Response.json({ name: 'files/a', state: 'ACTIVE' }));
  expect(await g(f).getFileState({ fileName: 'files/a' })).toBe('ACTIVE');
  expect(f.calls[0].url).toBe('https://gem.test/v1beta/files/a');
  expect(f.calls[0].method).toBe('GET');
});

it('deleteFile treats 404 as success', async () => {
  const f = fakeFetch(() => Response.json({ error: { message: 'Requested entity was gone' } }, { status: 404 }));
  await expect(g(f).deleteFile({ fileName: 'files/a' })).resolves.toBeUndefined();
  expect(f.calls[0].method).toBe('DELETE');
  await expect(g(fakeFetch(() => new Response('', { status: 500 }))).deleteFile({ fileName: 'files/a' })).rejects.toMatchObject({ kind: 'temporary' });
});

it('queryUploadOffset reads size-received', async () => {
  const f = fakeFetch(() => new Response('', { headers: { 'x-goog-upload-size-received': '8388608' } }));
  expect(await g(f).queryUploadOffset({ uploadUrl: 'https://up.test/s1' })).toBe(8388608);
  expect(f.calls[0].headers.get('x-goog-upload-command')).toBe('query');
});

it('uploadFile does start then upload+finalize and returns state', async () => {
  const f = fakeFetch((req, n) => n === 1
    ? new Response('{}', { headers: { 'x-goog-upload-url': 'https://up.test/s2' } })
    : Response.json({ file: { name: 'files/p', uri: 'u/p', state: 'ACTIVE', expirationTime: '2026-10-30T00:00:00Z' } }));
  const out = await g(f).uploadFile({ body: new Uint8Array(3), mime: 'application/pdf', size: 3, displayName: 'att1' });
  expect(out).toEqual({ fileName: 'files/p', fileUri: 'u/p', expiresAt: Date.parse('2026-10-30T00:00:00Z'), state: 'ACTIVE' });
  expect(f.calls[0].headers.get('x-goog-upload-header-content-type')).toBe('application/pdf');
  expect(f.calls[1].url).toBe('https://up.test/s2');
  expect(f.calls[1].headers.get('x-goog-upload-command')).toBe('upload, finalize');
  expect(f.calls[1].headers.get('x-goog-upload-offset')).toBe('0');
});

it('chunk uploads get a long timeout while other calls keep the short one', async () => {
  const slow = (ms) => async (url, init = {}) => new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(new Response('', { headers: { 'x-goog-upload-status': 'active' } })), ms);
    init.signal?.addEventListener('abort', () => { clearTimeout(t); reject(init.signal.reason); });
  });
  const gem = createGemini({ apiKey: 'KEY', model: 'm', baseUrl: 'https://gem.test', fetch: slow(150), timeouts: { file: 100 } });
  await expect(gem.getFileState({ fileName: 'files/a' })).rejects.toMatchObject({ kind: 'temporary' });
  await expect(gem.uploadAudioChunk({ uploadUrl: 'https://up.test/s', offset: 0, body: new Uint8Array(1), size: 1, isLast: false })).resolves.toBeNull();
  expect(CHUNK_TIMEOUT_MS).toBe(900000);
});
