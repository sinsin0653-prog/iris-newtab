// Gemini REST クライアント。キーは URL に入れず x-goog-api-key ヘッダーで送る
import { AiError, aiErrorFromResponse } from './errors.js';
import { NO_SPEECH, NOTES_SCHEMA, NOTES_SYSTEM, SUMMARY_SCHEMA, SUMMARY_SYSTEM, buildNotesText, buildSummaryText, normalizeSegmentTimes, transcribePrompt, validateNotes, validateSummary } from './prompts.js';

const FILE_TIMEOUT_MS = 120_000;
const GENERATE_TIMEOUT_MS = 300_000;
// かけらはブラウザの回線の速さで流れてくるので、ゆっくりなスマホの回線でも切らない
export const CHUNK_TIMEOUT_MS = 900_000;
const BLOCKED = new Set(['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII']);
// 考える量：文字起こしは軽め、ノートと要約は多め
const THINK_TRANSCRIBE = 4096;
const THINK_WRITE = 8192;
const HANDOUT_LABEL = '次のファイルは、この講義のレジュメです。';
const LABELS = { note_image: '次のファイルは自分のメモの写真です。', handout_pdf: '次のファイルはレジュメです。', handout_image: '次のファイルはレジュメです。' };

export function createGemini({ apiKey, model, baseUrl, fetch, timeouts = {} }) {
  const limits = { file: FILE_TIMEOUT_MS, chunk: CHUNK_TIMEOUT_MS, generate: GENERATE_TIMEOUT_MS, ...timeouts };
  async function send(url, init = {}, timeoutMs = limits.file) {
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
    }, limits.chunk);
  }

  // 返事の文字（考えた部分は除く）。答えてくれなかったときは permanent
  async function generate(body) {
    const res = await send(`${baseUrl}/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, limits.generate);
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

  const handoutParts = (handouts) => handouts.flatMap((f) => [{ text: HANDOUT_LABEL }, { file_data: { mime_type: f.mime, file_uri: f.fileUri } }]);
  const parseJson = (text, what) => {
    try {
      return JSON.parse(text);
    } catch {
      throw new AiError('permanent', `${what}の形がちがいます（JSON ではありません）`);
    }
  };

  return {
    async transcribeSegment({ fileUri, mime, startSec, endSec, glossary = '', handouts = [] }) {
      const parts = handoutParts(handouts);
      parts.push({ file_data: { mime_type: mime, file_uri: fileUri } });
      parts.push({ text: transcribePrompt(startSec, endSec, { glossary, hasHandouts: handouts.length > 0 }) });
      const text = await generate({
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0, maxOutputTokens: 65536, thinkingConfig: { thinkingBudget: THINK_TRANSCRIBE } },
      });
      if (text === NO_SPEECH) return '';
      return normalizeSegmentTimes(text, startSec);
    },

    async writeNotes({ segmentText, startSec, endSec, glossary = '', handouts = [] }) {
      const parts = handoutParts(handouts);
      parts.push({ text: buildNotesText({ segmentText, startSec, endSec, glossary }) });
      const text = await generate({
        systemInstruction: { parts: [{ text: NOTES_SYSTEM }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: NOTES_SCHEMA, maxOutputTokens: 65536, thinkingConfig: { thinkingBudget: THINK_WRITE } },
      });
      return validateNotes(parseJson(text, '授業ノート'));
    },

    async summarize({ transcript, noteText, notes, attachments }) {
      const parts = [];
      for (const a of attachments) {
        parts.push({ text: LABELS[a.kind] ?? '次のファイルはレジュメです。' });
        parts.push({ file_data: { mime_type: a.mime, file_uri: a.fileUri } });
      }
      parts.push({ text: buildSummaryText({ transcript, noteText, notes }) });
      const text = await generate({
        systemInstruction: { parts: [{ text: SUMMARY_SYSTEM }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: SUMMARY_SCHEMA, maxOutputTokens: 65536, thinkingConfig: { thinkingBudget: THINK_WRITE } },
      });
      return validateSummary(parseJson(text, '要約'));
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
