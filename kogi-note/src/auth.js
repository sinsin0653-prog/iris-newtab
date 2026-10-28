// ログイン・クッキー・ロック・X-Kogi の確認
import { HttpError, errorResponse, json, readJson } from './http.js';

const COOKIE = 'kogi_session';
const SESSION_MS = 30 * 86400_000;
const LOCK_WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 5;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const enc = new TextEncoder();

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

// 長さのちがう文字列も、HMAC にそろえてから比べる（一致した位置で時間が変わらないように）
async function sameSecret(env, a, b) {
  const [x, y] = await Promise.all([hmac(env.SESSION_SECRET, a), hmac(env.SESSION_SECRET, b)]);
  return crypto.subtle.timingSafeEqual(x, y);
}

const sessionSig = async (env, exp) => hex(await hmac(env.SESSION_SECRET, `session:${exp}:${env.APP_PASSWORD}`));

function readCookie(request) {
  const header = request.headers.get('Cookie') ?? '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return null;
}

export async function login(request, env, now) {
  try {
    return await tryLogin(request, env, now);
  } catch (err) {
    return errorResponse(err);
  }
}

const configured = (env) => typeof env.APP_PASSWORD === 'string' && env.APP_PASSWORD !== '' && typeof env.SESSION_SECRET === 'string' && env.SESSION_SECRET !== '';

async function tryLogin(request, env, now) {
  if (!configured(env)) throw new HttpError(500, 'not_configured', '設定が足りません（APP_PASSWORD と SESSION_SECRET を入れてね）');
  const db = env.DB;
  await db.prepare('DELETE FROM login_failures WHERE ts <= ?').bind(now - LOCK_WINDOW_MS).run();
  const { n } = await db.prepare('SELECT count(*) AS n FROM login_failures').first();
  if (n >= MAX_FAILURES) {
    throw new HttpError(429, 'locked', '何回もまちがえたので、15分たってからもう一度試してね');
  }
  const { password } = await readJson(request);
  const ok = typeof password === 'string' && (await sameSecret(env, `pw:${password}`, `pw:${env.APP_PASSWORD}`));
  if (!ok) {
    await db.prepare('INSERT INTO login_failures (ts) VALUES (?)').bind(now).run();
    throw new HttpError(401, 'wrong_password', 'パスワードがちがいます');
  }
  await db.prepare('DELETE FROM login_failures').run();
  const exp = now + SESSION_MS;
  const value = `${exp}.${await sessionSig(env, exp)}`;
  return json({ ok: true }, 200, {
    'set-cookie': `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`,
  });
}

export function logout() {
  return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0` });
}

export async function isLoggedIn(request, env, now) {
  if (!configured(env)) return false;
  const value = readCookie(request);
  const m = value && /^(\d+)\.([0-9a-f]{64})$/.exec(value);
  if (!m) return false;
  const exp = Number(m[1]);
  if (!(exp > now)) return false;
  return sameSecret(env, m[2], await sessionSig(env, exp));
}

export function checkMutation(request) {
  if (MUTATING.has(request.method) && request.headers.get('X-Kogi') !== '1') {
    throw new HttpError(403, 'forbidden', 'この操作はできません');
  }
}
