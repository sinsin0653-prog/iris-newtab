// Gemini REST クライアント。キーは URL に入れず x-goog-api-key ヘッダーで送る
import { AiError, aiErrorFromResponse } from './errors.js';
import { NO_SPEECH, SUMMARY_SCHEMA, SUMMARY_SYSTEM, buildSummaryText, normalizeSegmentTimes, transcribePrompt, validateSummary } from './prompts.js';

const FILE_TIMEOUT_MS = 120_000;
const GENERATE_TIMEOUT_MS = 300_000;
const BLOCKED = new Set(['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII']);
const LABELS = { note_image: '次のファイルは自分のメモの写真です。', handout_pdf: '次のファイルはレジュメです。', handout_image: '次のファイルはレジュメです。' };

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

  // 返事の文字（考えた部分は除く）。答えてくれなかったときは permanent
  async function generate(body) {
    const res = await send(`${baseUrl}/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, GENERATE_TIMEOUT_MS);
    let data;
    try {
      data = await res.json();
    } catch {
      throw new AiError('temporary', 'Gemini の返事が読めませんでした');
    }
    const block = data?.promptFeedback?.blockReason;
    if (block) throw new AiError('permanent', `AI が答えてくれませんでした（${block}）`);
    const cand = data?.candidates?.[0];
    if (!cand) throw new AiError('permanent', 'AI が答えてくれませんでした（返事なし）');
    if (BLOCKED.has(cand.finishReason)) throw new AiError('permanent', `AI が答えてくれませんでした（${cand.finishReason}）`);
    if (cand.finishReason === 'MAX_TOKENS') throw new AiError('permanent', '答えが長すぎて途中で切れました');
    const text = (cand.content?.parts ?? []).filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('').trim();
    if (!text) throw new AiError('permanent', 'AI の返事が空でした');
    return text;
  }

  return {
    async transcribeSegment({ fileUri, mime, startSec, endSec }) {
      const text = await generate({
        contents: [{ role: 'user', parts: [{ file_data: { mime_type: mime, file_uri: fileUri } }, { text: transcribePrompt(startSec, endSec) }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 65536 },
      });
      if (text === NO_SPEECH) return '';
      return normalizeSegmentTimes(text, startSec);
    },

    async summarize({ transcript, noteText, attachments }) {
      const parts = [];
      for (const a of attachments) {
        parts.push({ text: LABELS[a.kind] ?? '次のファイルはレジュメです。' });
        parts.push({ file_data: { mime_type: a.mime, file_uri: a.fileUri } });
      }
      parts.push({ text: buildSummaryText({ transcript, noteText }) });
      const text = await generate({
        systemInstruction: { parts: [{ text: SUMMARY_SYSTEM }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: SUMMARY_SCHEMA, maxOutputTokens: 65536 },
      });
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        throw new AiError('permanent', '要約の形がちがいます（JSON ではありません）');
      }
      return validateSummary(value);
    },

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
