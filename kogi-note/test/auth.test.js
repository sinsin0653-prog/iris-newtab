import { env } from 'cloudflare:test';
import { beforeEach, it, expect } from 'vitest';
import { resetDb, makeRequest, T0 } from './helpers.js';
import { login, logout, isLoggedIn, checkMutation } from '../src/auth.js';

const cookieOf = (res) => res.headers.get('set-cookie').split(';')[0];
beforeEach(() => resetDb(env));

it('correct password sets a 30-day session cookie', async () => {
  const res = await login(makeRequest('/api/login', { method: 'POST', json: { password: 'test-pass' } }), env, T0);
  expect(res.status).toBe(200);
  const sc = res.headers.get('set-cookie');
  expect(sc).toMatch(/^kogi_session=\d+\.[0-9a-f]+;/);
  for (const part of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) expect(sc).toContain(part);
  expect(await isLoggedIn(makeRequest('/api/me', { cookie: cookieOf(res) }), env, T0 + 29 * 86400_000)).toBe(true);
  expect(await isLoggedIn(makeRequest('/api/me', { cookie: cookieOf(res) }), env, T0 + 31 * 86400_000)).toBe(false);
});

it('wrong password is 401 and is recorded', async () => {
  const res = await login(makeRequest('/api/login', { method: 'POST', json: { password: 'nope' } }), env, T0);
  expect(res.status).toBe(401);
  expect((await res.json()).error.code).toBe('wrong_password');
  expect((await env.DB.prepare('SELECT count(*) n FROM login_failures').first()).n).toBe(1);
});

it('locks after 5 failures within 15 minutes, even for the right password', async () => {
  for (let i = 0; i < 5; i++) await login(makeRequest('/api/login', { method: 'POST', json: { password: 'x' } }), env, T0 + i);
  const locked = await login(makeRequest('/api/login', { method: 'POST', json: { password: 'test-pass' } }), env, T0 + 10);
  expect(locked.status).toBe(429);
  expect((await locked.json()).error.code).toBe('locked');
  const later = await login(makeRequest('/api/login', { method: 'POST', json: { password: 'test-pass' } }), env, T0 + 15 * 60_000 + 10);
  expect(later.status).toBe(200);
});

it('tampered cookie and cookie from an old password are rejected', async () => {
  const res = await login(makeRequest('/api/login', { method: 'POST', json: { password: 'test-pass' } }), env, T0);
  const c = cookieOf(res);
  expect(await isLoggedIn(makeRequest('/', { cookie: c.slice(0, -1) + (c.endsWith('0') ? '1' : '0') }), env, T0)).toBe(false);
  expect(await isLoggedIn(makeRequest('/', { cookie: c }), { ...env, APP_PASSWORD: 'changed' }, T0)).toBe(false);
  expect(await isLoggedIn(makeRequest('/'), env, T0)).toBe(false);
  expect(await isLoggedIn(makeRequest('/', { cookie: 'kogi_session=garbage' }), env, T0)).toBe(false);
});

it('logout clears the cookie', () => {
  expect(logout().headers.get('set-cookie')).toContain('Max-Age=0');
});

it('mutations need X-Kogi', () => {
  expect(() => checkMutation(makeRequest('/api/subjects', { method: 'POST', json: {}, headers: { 'X-Kogi': '' } }))).toThrow(expect.objectContaining({ status: 403 }));
  expect(() => checkMutation(makeRequest('/api/subjects', { method: 'POST', json: {} }))).not.toThrow();
  expect(() => checkMutation(makeRequest('/api/subjects', { headers: { 'X-Kogi': '' } }))).not.toThrow();
});
