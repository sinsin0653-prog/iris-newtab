// 写真を縮める・音声をかけらで送る
import { apiFetch, ApiError } from './api.js';
import { normalizeDuration, uploadChunks } from './lib/chunks.js';

export const MAX_AUDIO_BYTES = 2147483648;
export const MAX_PDF_BYTES = 20971520;
const MAX_EDGE = 2000;

// サーバーの src/mime.js と同じ表
const ALIASES = {
  'audio/x-m4a': 'audio/mp4', 'audio/m4a': 'audio/mp4', 'audio/mp4a-latm': 'audio/mp4',
  'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/vnd.wave': 'audio/wav',
  'audio/mp3': 'audio/mpeg', 'audio/x-mp3': 'audio/mpeg', 'audio/mpeg3': 'audio/mpeg',
  'audio/x-aac': 'audio/aac', 'audio/x-flac': 'audio/flac',
};
const BY_EXT = { m4a: 'audio/mp4', mp4: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac' };

export function audioMime(file) {
  const base = String(file.type ?? '').split(';')[0].trim().toLowerCase();
  const mime = ALIASES[base] ?? base;
  if (mime && mime !== 'application/octet-stream') return mime;
  const ext = (file.name.split('.').pop() ?? '').toLowerCase();
  return BY_EXT[ext] ?? 'audio/mpeg';
}

export function readDuration(file) {
  return new Promise((resolve) => {
    const audio = document.createElement('audio');
    const url = URL.createObjectURL(file);
    const done = (value) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(normalizeDuration(value));
    };
    const timer = setTimeout(() => done(null), 5000);
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => done(audio.duration);
    audio.onerror = () => done(null);
    audio.src = url;
  });
}

export function compressImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    const fail = () => {
      URL.revokeObjectURL(url);
      reject(new Error('この写真は読めません（HEIC などは JPEG にしてから入れてね）'));
    };
    img.onerror = fail;
    img.onload = () => {
      const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (!blob) return fail();
        URL.revokeObjectURL(url);
        resolve(blob);
      }, 'image/jpeg', 0.85);
    };
    img.src = url;
  });
}

export async function uploadAudio({ lectureId, file, onProgress }) {
  if (file.size > MAX_AUDIO_BYTES) throw new Error('音声は2GBまでです');
  const duration = await readDuration(file);
  const { chunk_size: chunkSize } = await apiFetch(`/api/lectures/${lectureId}/audio/start`, {
    method: 'POST',
    json: { mime: audioMime(file), size: file.size, duration_sec: duration },
  });
  await uploadChunks({
    size: file.size,
    chunkSize,
    onProgress: (sent) => onProgress?.(sent / file.size),
    sendChunk: (offset, end) => apiFetch(`/api/lectures/${lectureId}/audio/chunk?offset=${offset}`, {
      method: 'PUT',
      body: file.slice(offset, end),
      headers: { 'Content-Type': 'application/octet-stream' },
    }),
  });
}

export async function uploadAttachment({ lectureId, kind, file }) {
  let body = file;
  let type = file.type;
  if (kind === 'handout_pdf') {
    if (file.size > MAX_PDF_BYTES) throw new Error('PDF は20MBまでです');
    type = 'application/pdf';
  } else {
    body = await compressImage(file);
    type = 'image/jpeg';
  }
  return apiFetch(`/api/lectures/${lectureId}/attachments?kind=${kind}`, { method: 'POST', body, headers: { 'Content-Type': type } });
}

export const kindOf = (file, role) => (role === 'note' ? 'note_image' : file.type === 'application/pdf' || /\.pdf$/i.test(file.name) ? 'handout_pdf' : 'handout_image');

export { ApiError };
