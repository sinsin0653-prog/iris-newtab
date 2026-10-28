// AI の失敗の種類：rate_limited（待てば直る）・temporary（やり直せば直るかも）・permanent（直らない）

export class AiError extends Error {
  constructor(kind, message, retryAfterMs) {
    super(message);
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

const TEMPORARY = new Set([408, 500, 502, 503, 504]);

function parseRetryDelay(body) {
  for (const d of body?.error?.details ?? []) {
    if (d?.['@type'] === 'type.googleapis.com/google.rpc.RetryInfo' && typeof d.retryDelay === 'string') {
      const m = /^(\d+(?:\.\d+)?)s$/.exec(d.retryDelay);
      if (m) return Math.round(Number(m[1]) * 1000);
    }
  }
  return undefined;
}

export async function aiErrorFromResponse(res) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    // 本文が JSON でないこともある
  }
  const message = body?.error?.message || `HTTP ${res.status}`;
  if (res.status === 429) {
    let retryAfterMs = parseRetryDelay(body);
    const header = Number(res.headers.get('retry-after'));
    if (retryAfterMs === undefined && res.headers.has('retry-after') && Number.isFinite(header)) retryAfterMs = header * 1000;
    return Object.assign(new AiError('rate_limited', message, retryAfterMs), { status: 429 });
  }
  return Object.assign(new AiError(TEMPORARY.has(res.status) ? 'temporary' : 'permanent', message), { status: res.status });
}
