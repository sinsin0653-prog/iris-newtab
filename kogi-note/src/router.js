// URL と処理の対応。/api/* 以外は静的ファイル
import { HttpError, errorResponse, json } from './http.js';
import { login, logout, isLoggedIn, checkMutation } from './auth.js';
import * as subjects from './api/subjects.js';
import * as lectures from './api/lectures.js';

// [メソッド, パス, 処理]。後のタスクはここに足す
const ROUTES = [
  ['GET', '/api/subjects', subjects.list],
  ['POST', '/api/subjects', subjects.create],
  ['PATCH', '/api/subjects/:id', subjects.rename],
  ['DELETE', '/api/subjects/:id', subjects.remove],
  ['GET', '/api/subjects/:id/lectures', subjects.lectures],
  ['POST', '/api/lectures', lectures.create],
  ['GET', '/api/lectures/:id', lectures.get],
  ['PATCH', '/api/lectures/:id', lectures.patch],
  ['DELETE', '/api/lectures/:id', lectures.remove],
  ['POST', '/api/lectures/:id/retry', lectures.retry],
  ['POST', '/api/lectures/:id/resummarize', lectures.resummarize],
];

const compiled = ROUTES.map(([method, path, handler]) => ({
  method,
  handler,
  names: [...path.matchAll(/:(\w+)/g)].map((m) => m[1]),
  re: new RegExp(`^${path.replace(/:\w+/g, '([^/]+)')}$`),
}));

function match(method, pathname) {
  let pathFound = false;
  for (const r of compiled) {
    const m = r.re.exec(pathname);
    if (!m) continue;
    pathFound = true;
    if (r.method !== method) continue;
    const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
    return { handler: r.handler, params };
  }
  return { pathFound };
}

export async function handleRequest(request, env, { ai, now }) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
  try {
    if (url.pathname === '/api/login' && request.method === 'POST') {
      checkMutation(request);
      return await login(request, env, now);
    }
    if (url.pathname === '/api/logout' && request.method === 'POST') return logout();
    if (url.pathname === '/api/me' && request.method === 'GET') {
      return json({ logged_in: await isLoggedIn(request, env, now) });
    }
    if (!(await isLoggedIn(request, env, now))) throw new HttpError(401, 'unauthorized', 'ログインしてね');
    checkMutation(request);
    const found = match(request.method, url.pathname);
    if (!found.handler) {
      if (found.pathFound) throw new HttpError(405, 'method_not_allowed', 'この操作はできません');
      throw new HttpError(404, 'not_found', '見つかりません');
    }
    return await found.handler({ request, env, ai, now, params: found.params, url });
  } catch (err) {
    return errorResponse(err);
  }
}
