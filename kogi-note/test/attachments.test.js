import { env } from 'cloudflare:test';
import { beforeEach, it, expect, vi } from 'vitest';
import { resetDb, call, rawCall, newLecture, addAttachment } from './helpers.js';

beforeEach(() => resetDb(env));
const upload = (id, kind, bytes, type, extra = {}) =>
  call(`/api/lectures/${id}/attachments?kind=${kind}`, { method: 'POST', body: bytes, headers: { 'Content-Type': type, ...extra.headers }, env: extra.env });

it('stores an image in KV and serves it back', async () => {
  const id = await newLecture();
  const up = await upload(id, 'note_image', new Uint8Array([1, 2, 3]), 'image/jpeg');
  expect(up.status).toBe(201);
  expect(up.body).toMatchObject({ kind: 'note_image', mime: 'image/jpeg', size: 3, position: 0 });
  const res = await rawCall(`/api/attachments/${up.body.id}`);
  expect(res.headers.get('content-type')).toBe('image/jpeg');
  expect(res.headers.get('cache-control')).toBe('private, max-age=3600');
  expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3]);
  expect((await call('/api/usage')).body).toEqual({ used_bytes: 3, limit_bytes: 1073741824, warn: false });
  expect(await env.FILES.get(`att/${id}/${up.body.id}`)).not.toBeNull();
  const second = await upload(id, 'handout_pdf', new Uint8Array([9]), 'application/pdf');
  expect(second.body.position).toBe(1);
});

it('rejects kind/type mismatch, unknown kind, missing length and oversize', async () => {
  const id = await newLecture();
  expect((await upload(id, 'handout_pdf', new Uint8Array(1), 'image/jpeg')).status).toBe(400);
  expect((await upload(id, 'note_image', new Uint8Array(1), 'application/pdf')).status).toBe(400);
  expect((await upload(id, 'other', new Uint8Array(1), 'image/jpeg')).status).toBe(400);
  expect((await upload(id, 'note_image', new Uint8Array(1), 'image/jpeg', { headers: { 'Content-Length': null } })).status).toBe(400);
  const big = await upload(id, 'note_image', new Uint8Array(5242881), 'image/png');
  expect(big.status).toBe(413);
  expect(big.body.error.code).toBe('too_large');
  expect((await upload('nope', 'note_image', new Uint8Array(1), 'image/jpeg')).status).toBe(404);
});

it('the 21st file is refused', async () => {
  const id = await newLecture();
  for (let i = 0; i < 20; i++) await addAttachment(id, { position: i });
  const r = await upload(id, 'note_image', new Uint8Array(1), 'image/webp');
  expect(r.status).toBe(409);
  expect(r.body.error.code).toBe('too_many');
});

it('full storage is refused', async () => {
  const id = await newLecture();
  await env.DB.prepare("INSERT INTO attachments (id, lecture_id, kind, mime, size, kv_key, position, created_at) VALUES ('big', ?, 'handout_pdf', 'application/pdf', 1073741823, 'att/x/big', 0, 1)").bind(id).run();
  const r = await upload(id, 'note_image', new Uint8Array(2), 'image/jpeg');
  expect(r.status).toBe(507);
  expect(r.body.error.code).toBe('storage_full');
  expect((await call('/api/usage')).body.warn).toBe(true);
});

it('a failing KV write is reported', async () => {
  const id = await newLecture();
  const FILES = { put: async () => { throw new Error('limit'); } };
  const r = await upload(id, 'note_image', new Uint8Array(1), 'image/jpeg', { env: { ...env, FILES } });
  expect(r.status).toBe(503);
  expect(r.body.error.code).toBe('kv_write_failed');
  expect((await env.DB.prepare('SELECT count(*) n FROM attachments').first()).n).toBe(0);
});

it('delete removes KV value, row and Gemini copy', async () => {
  const id = await newLecture();
  const a = await addAttachment(id, { gemini: { name: 'files/g', uri: 'u', expiresAt: 1 } });
  const deleteFile = vi.fn(async () => { throw new Error('gone'); });
  expect((await call(`/api/attachments/${a.id}`, { method: 'DELETE', ai: { deleteFile } })).body).toEqual({ ok: true });
  expect(deleteFile).toHaveBeenCalledWith({ fileName: 'files/g' });
  expect(await env.FILES.get(a.kv_key)).toBeNull();
  expect((await call(`/api/attachments/${a.id}`)).status).toBe(404);
});
