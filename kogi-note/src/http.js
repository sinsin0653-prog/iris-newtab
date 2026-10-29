// JSON の返し方とエラーの形（全 API で共通）

export class HttpError extends Error {
  constructor(status, code, message, data = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function errorResponse(err) {
  if (err instanceof HttpError) {
    return json({ error: { code: err.code, message: err.message, ...err.data } }, err.status);
  }
  console.error(err);
  return json({ error: { code: 'internal', message: 'サーバーでエラーが起きました' } }, 500);
}

export async function readJson(request) {
  try {
    const value = await request.json();
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new HttpError(400, 'bad_request', '送られた内容が読めません');
  }
}
