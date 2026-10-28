// Gemini REST クライアント。キーは URL に入れず x-goog-api-key ヘッダーで送る
import { AiError, aiErrorFromResponse } from './errors.js';

const FILE_TIMEOUT_MS = 120_000;

export function createGemini({ apiKey, model, baseUrl, fetch }) {
  async function send(url, init = {}, timeoutMs = FILE_TIMEOUT_MS) {
    let res;
    try {
      res = await fetch(url, {
        ...init,
        headers: { 'x-goog-api-key': apiKey, ...init.headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new AiError('temporary', `Gemini につながりませんでした（${err?.name ?? 'Error'}）`);
    }
    if (!res.ok) throw await aiErrorFromResponse(res);
    return res;
  }

  const fileInfo = (file) => ({ fileName: file.name, fileUri: file.uri, expiresAt: Date.parse(file.expirationTime) });

  async function readFile(res) {
    const body = await res.json().catch(() => null);
    if (!body?.file?.name) throw new AiError('temporary', 'Gemini からファイルの情報が返りませんでした');
    return body.file;
  }

  async function startUpload({ mime, size, displayName }) {
    const res = await send(`${baseUrl}/upload/v1beta/files`, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(size),
        'X-Goog-Upload-Header-Content-Type': mime,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: displayName } }),
    });
    const uploadUrl = res.headers.get('x-goog-upload-url');
    if (!uploadUrl) throw new AiError('temporary', 'Gemini から送り先が返りませんでした');
    const g = Number(res.headers.get('x-goog-upload-chunk-granularity'));
    return { uploadUrl, granularity: Number.isFinite(g) && g > 0 ? g : null };
  }

  function putChunk({ uploadUrl, offset, body, size, isLast }) {
    return send(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Length': String(size),
        'X-Goog-Upload-Offset': String(offset),
        'X-Goog-Upload-Command': isLast ? 'upload, finalize' : 'upload',
      },
      body,
    });
  }

  return {
    startAudioUpload: startUpload,

    async uploadAudioChunk(args) {
      const res = await putChunk(args);
      if (!args.isLast) return null;
      return fileInfo(await readFile(res));
    },

    async queryUploadOffset({ uploadUrl }) {
      const res = await send(uploadUrl, { method: 'POST', headers: { 'X-Goog-Upload-Command': 'query' } });
      const n = Number(res.headers.get('x-goog-upload-size-received'));
      if (!Number.isFinite(n)) throw new AiError('temporary', 'Gemini から届いた量が返りませんでした');
      return n;
    },

    async getFileState({ fileName }) {
      const res = await send(`${baseUrl}/v1beta/${fileName}`, { method: 'GET' });
      return (await res.json()).state;
    },

    async uploadFile({ body, mime, size, displayName }) {
      const { uploadUrl } = await startUpload({ mime, size, displayName });
      const file = await readFile(await putChunk({ uploadUrl, offset: 0, body, size, isLast: true }));
      return { ...fileInfo(file), state: file.state };
    },

    async deleteFile({ fileName }) {
      try {
        await send(`${baseUrl}/v1beta/${fileName}`, { method: 'DELETE' });
      } catch (err) {
        if (err instanceof AiError && err.status === 404) return;
        throw err;
      }
    },
  };
}
