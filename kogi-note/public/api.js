// サーバーとのやりとり
export class ApiError extends Error {
  constructor(status, code, message, data = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export async function apiFetch(path, { method = 'GET', json, body, headers = {} } = {}) {
  const init = { method, credentials: 'same-origin', headers: { 'X-Kogi': '1', ...headers } };
  if (json !== undefined) {
    init.body = JSON.stringify(json);
    init.headers['Content-Type'] = 'application/json';
  } else if (body !== undefined) {
    init.body = body;
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'network', 'インターネットにつながりませんでした');
  }
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  const data = isJson ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    const { code = 'error', message = 'うまくいきませんでした', ...rest } = data?.error ?? {};
    if (res.status === 401 && path !== '/api/login') location.hash = '#/login';
    throw new ApiError(res.status, code, message, rest);
  }
  return data;
}
