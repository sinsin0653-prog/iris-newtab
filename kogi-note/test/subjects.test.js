import { env } from 'cloudflare:test';
import { beforeEach, it, expect } from 'vitest';
import { resetDb, makeRequest, call, newSubject, newLecture, T0 } from './helpers.js';
import { handleRequest } from '../src/router.js';

beforeEach(() => resetDb(env));

it('rejects API calls without login', async () => {
  const res = await handleRequest(makeRequest('/api/subjects'), env, { ai: {}, now: T0 });
  expect(res.status).toBe(401);
  expect((await res.json()).error.code).toBe('unauthorized');
});

it('/api/me works without login and with login', async () => {
  expect((await call('/api/me', { cookie: null })).body).toEqual({ logged_in: false });
  expect((await call('/api/me')).body).toEqual({ logged_in: true });
});

it('login and logout go through the router', async () => {
  const r = await call('/api/login', { method: 'POST', json: { password: 'test-pass' }, cookie: null });
  expect(r.status).toBe(200);
  expect((await call('/api/logout', { method: 'POST' })).status).toBe(200);
});

it('creates, lists, renames and deletes subjects', async () => {
  const a = await call('/api/subjects', { method: 'POST', json: { name: '  心理学 ' } });
  expect(a.status).toBe(201);
  expect(a.body.name).toBe('心理学');
  expect((await call('/api/subjects')).body.subjects).toEqual([{ id: a.body.id, name: '心理学', lecture_count: 0, last_updated: T0 }]);
  expect((await call(`/api/subjects/${a.body.id}`, { method: 'PATCH', json: { name: '社会心理学' } })).body.name).toBe('社会心理学');
  expect((await call(`/api/subjects/${a.body.id}`, { method: 'DELETE' })).body).toEqual({ ok: true });
  expect((await call('/api/subjects')).body.subjects).toEqual([]);
});

it('lists subjects in creation order with lecture counts and last update', async () => {
  const a = await call('/api/subjects', { method: 'POST', json: { name: 'A' }, now: T0 + 1 });
  const b = await call('/api/subjects', { method: 'POST', json: { name: 'B' }, now: T0 + 2 });
  await newLecture({ subject_id: b.body.id, updated_at: T0 + 500 });
  await newLecture({ subject_id: b.body.id, number: 2, updated_at: T0 + 900 });
  expect((await call('/api/subjects')).body.subjects).toEqual([
    { id: a.body.id, name: 'A', lecture_count: 0, last_updated: T0 + 1 },
    { id: b.body.id, name: 'B', lecture_count: 2, last_updated: T0 + 900 },
  ]);
});

it('rejects empty and over-100-char names', async () => {
  expect((await call('/api/subjects', { method: 'POST', json: { name: ' ' } })).status).toBe(400);
  expect((await call('/api/subjects', { method: 'POST', json: { name: 'あ'.repeat(101) } })).status).toBe(400);
  expect((await call('/api/subjects', { method: 'POST', json: { name: 3 } })).status).toBe(400);
});

it('404 for unknown subject and unknown path', async () => {
  expect((await call('/api/subjects/nope/lectures')).status).toBe(404);
  expect((await call('/api/subjects/nope', { method: 'PATCH', json: { name: 'x' } })).status).toBe(404);
  expect((await call('/api/nothing')).status).toBe(404);
});

it('mutation without X-Kogi is 403', async () => {
  expect((await call('/api/subjects', { method: 'POST', json: { name: 'a' }, headers: { 'X-Kogi': null } })).status).toBe(403);
});

it('lecture list counts finished segments and sorts by number', async () => {
  const s = await newSubject('心理学');
  const l2 = await newLecture({ subject_id: s, number: 2 });
  const l1 = await newLecture({ subject_id: s, number: 1, status: 'processing', step: 'transcribe', segments_total: 3 });
  await env.DB.batch([0, 1].map((i) => env.DB.prepare('INSERT INTO segments VALUES (?,?,?)').bind(l1, i, 't')));
  const { body } = await call(`/api/subjects/${s}/lectures`);
  expect(body.subject).toEqual({ id: s, name: '心理学' });
  expect(body.lectures.map((l) => l.id)).toEqual([l1, l2]);
  expect(body.lectures[0]).toEqual({ id: l1, number: 1, date: '2026-10-28', status: 'processing', step: 'transcribe', waiting_reason: null, segments_total: 3, segments_done: 2, error_message: null });
});

it('non-API paths go to static assets', async () => {
  const res = await handleRequest(new Request('http://kogi.test/'), { ...env, ASSETS: { fetch: async () => new Response('asset') } }, { ai: {}, now: T0 });
  expect(await res.text()).toBe('asset');
});
