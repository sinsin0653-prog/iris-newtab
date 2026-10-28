// 待ち時間の計算

export const MAX_ATTEMPTS = 3;
export const MAX_RATE_LIMITS = 12;

// 無料枠の上限（429）：Gemini が言った時間、なければ 2・4・8…分（最大 30 分）
export function rateLimitDelayMs(retryAfterMs, count) {
  if (retryAfterMs !== undefined) return retryAfterMs;
  return Math.min(120000 * 2 ** count, 1800000);
}

// 一時的なエラー：1 回目 2 分、2 回目 4 分（3 回目でエラー）
export function temporaryDelayMs(attempts) {
  return 120000 * 2 ** (attempts - 1);
}
