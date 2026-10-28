// env から設定値を読む（未設定なら既定値）

const num = (v, fallback) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : fallback;
};

export function config(env) {
  return {
    geminiModel: env.GEMINI_MODEL ?? '',
    geminiBaseUrl: env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com',
    segmentSec: num(env.SEGMENT_SEC, 1800),
    segmentIntervalMs: num(env.SEGMENT_INTERVAL_MS, 65000),
  };
}
