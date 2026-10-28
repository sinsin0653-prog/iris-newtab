// 見回り：1 回につき「1 つの授業の、1 つの段階」だけ進める
import { config } from '../config.js';
import { AiError } from '../ai/errors.js';
import { STEPS, STEP_NAMES } from './steps.js';
import { MAX_ATTEMPTS, MAX_RATE_LIMITS, rateLimitDelayMs, temporaryDelayMs } from './backoff.js';

const LEASE_MS = 600_000;
const EXPIRY_MARGIN_MS = 600_000;
const AUDIO_STEPS = new Set(['wait_file', 'transcribe']);

async function save(env, id, set, now) {
  const cols = Object.keys(set);
  await env.DB.prepare(`UPDATE lectures SET ${cols.map((c) => `${c} = ?`).join(', ')}, lease_until = 0, updated_at = ? WHERE id = ?`)
    .bind(...cols.map((c) => set[c]), now, id)
    .run();
}

const fail = (step, message) => ({ status: 'error', waiting_reason: null, lease_count: 0, error_message: `${STEP_NAMES[step] ?? step}に失敗しました：${message}` });

export async function runOnce(env, { ai, now }) {
  const due = await env.DB.prepare(
    `SELECT id FROM lectures WHERE status = 'processing' AND next_run_at <= ? AND lease_until < ?
     ORDER BY next_run_at, updated_at LIMIT 1`,
  ).bind(now, now).first();
  if (!due) return null;
  const taken = await env.DB.prepare(
    'UPDATE lectures SET lease_until = ?, lease_count = lease_count + 1 WHERE id = ? AND lease_until < ?',
  ).bind(now + LEASE_MS, due.id, now).run();
  if (taken.meta.changes !== 1) return null;

  const lecture = await env.DB.prepare('SELECT * FROM lectures WHERE id = ?').bind(due.id).first();
  const step = lecture.step;
  const result = { id: lecture.id, step };

  if (lecture.lease_count > MAX_ATTEMPTS) {
    await save(env, lecture.id, fail(step, '処理が途中で止まりました'), now);
    return result;
  }
  if (AUDIO_STEPS.has(step) && !(lecture.audio_expires_at - now >= EXPIRY_MARGIN_MS)) {
    await save(env, lecture.id, { status: 'error', waiting_reason: null, lease_count: 0, error_message: '音声の期限が切れました。もう一回入れてね' }, now);
    return result;
  }

  try {
    const run = STEPS[step];
    if (!run) throw new AiError('permanent', `知らない段階です（${step}）`);
    const { set = {}, waitMs = 0 } = await run({ env, ai, now, lecture, cfg: config(env) });
    await save(env, lecture.id, { ...set, attempts: 0, rate_limit_count: 0, lease_count: 0, waiting_reason: null, next_run_at: now + waitMs }, now);
  } catch (err) {
    await save(env, lecture.id, outcomeOf(err, lecture, step, now), now);
  }
  return result;
}

function outcomeOf(err, lecture, step, now) {
  if (err instanceof AiError && err.kind === 'rate_limited') {
    if (lecture.rate_limit_count + 1 >= MAX_RATE_LIMITS) {
      return fail(step, '無料枠の上限に何度もかかりました（音声が長すぎるか、今日の上限に達しました）');
    }
    return {
      rate_limit_count: lecture.rate_limit_count + 1,
      waiting_reason: 'rate_limited',
      lease_count: 0,
      next_run_at: now + rateLimitDelayMs(err.retryAfterMs, lecture.rate_limit_count),
    };
  }
  if (err instanceof AiError && err.kind === 'temporary') {
    const attempts = lecture.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) return { ...fail(step, err.message), attempts };
    return { attempts, lease_count: 0, next_run_at: now + temporaryDelayMs(attempts) };
  }
  if (!(err instanceof AiError)) console.error(err);
  return fail(step, err instanceof AiError ? err.message : 'サーバーでエラーが起きました');
}
