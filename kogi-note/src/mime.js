// ブラウザが返す音声の種類の名前を、Gemini が知っている名前にそろえる
const ALIASES = {
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/mp4a-latm': 'audio/mp4',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
  'audio/mp3': 'audio/mpeg',
  'audio/x-mp3': 'audio/mpeg',
  'audio/mpeg3': 'audio/mpeg',
  'audio/x-aac': 'audio/aac',
  'audio/x-flac': 'audio/flac',
};

export function normalizeAudioMime(mime) {
  const base = String(mime ?? '').split(';')[0].trim().toLowerCase();
  return ALIASES[base] ?? base;
}
