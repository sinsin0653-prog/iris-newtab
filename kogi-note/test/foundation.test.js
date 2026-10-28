import { env } from 'cloudflare:test';
import { beforeEach, it, expect } from 'vitest';
import { resetDb, makeRequest } from './helpers.js';
import { json, HttpError, errorResponse, readJson } from '../src/http.js';
import { config } from '../src/config.js';

beforeEach(() => resetDb(env));

it('migration creates all tables', async () => {
  const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  const names = results.map((r) => r.name);
  for (const t of ['subjects', 'lectures', 'segments', 'attachments', 'login_failures']) expect(names).toContain(t);
});

it('lectures has the counters defaulting to 0', async () => {
  await env.DB.prepare("INSERT INTO subjects VALUES ('s1','心理学',1)").run();
  await env.DB.prepare("INSERT INTO lectures (id,subject_id,number,date,status,created_at,updated_at) VALUES ('l1','s1',1,'2026-10-28','uploading',1,1)").run();
  const row = await env.DB.prepare("SELECT rate_limit_count, lease_count, attempts, next_run_at, lease_until FROM lectures WHERE id='l1'").first();
  expect(row).toEqual({ rate_limit_count: 0, lease_count: 0, attempts: 0, next_run_at: 0, lease_until: 0 });
});

it('makeRequest sets Content-Length for bodies and lets headers remove it', () => {
  expect(makeRequest('/x', { method: 'PUT', body: new Uint8Array(6) }).headers.get('content-length')).toBe('6');
  expect(makeRequest('/x', { method: 'POST', json: { a: 'あ' } }).headers.get('content-length')).toBe(String(new TextEncoder().encode('{"a":"あ"}').byteLength));
  expect(makeRequest('/x', { method: 'PUT', body: new Uint8Array(6), headers: { 'Content-Length': null } }).headers.get('content-length')).toBeNull();
  expect(makeRequest('/x', { method: 'POST', json: {} }).headers.get('x-kogi')).toBe('1');
});

it('errorResponse formats HttpError and hides other errors', async () => {
  const a = errorResponse(new HttpError(409, 'conflict', 'もうあります', { expected_offset: 5 }));
  expect(a.status).toBe(409);
  expect(await a.json()).toEqual({ error: { code: 'conflict', message: 'もうあります', expected_offset: 5 } });
  const b = errorResponse(new Error('secret detail'));
  expect(b.status).toBe(500);
  expect((await b.json()).error.code).toBe('internal');
});

it('readJson rejects non-JSON', async () => {
  await expect(readJson(new Request('http://x', { method: 'POST', body: 'nope' }))).rejects.toMatchObject({ status: 400, code: 'bad_request' });
});

it('json sets content type', async () => {
  const r = json({ ok: true }, 201);
  expect(r.status).toBe(201);
  expect(r.headers.get('content-type')).toContain('application/json');
});

it('config applies defaults', () => {
  expect(config({ GEMINI_MODEL: 'm' })).toEqual({ geminiModel: 'm', geminiBaseUrl: 'https://generativelanguage.googleapis.com', segmentSec: 1800, segmentIntervalMs: 65000 });
  expect(config({ GEMINI_MODEL: 'm', SEGMENT_SEC: '60', SEGMENT_INTERVAL_MS: '0' }).segmentIntervalMs).toBe(0);
});
