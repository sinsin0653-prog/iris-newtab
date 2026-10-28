// 見回りの段階ごとの作業。どれも (ctx) => { set, waitMs } を返す
import { AiError } from '../ai/errors.js';

const UNKNOWN_DURATION_SEC = 7200;

async function waitFile({ ai, lecture, cfg }) {
  const state = await ai.getFileState({ fileName: lecture.audio_file_name });
  if (state === 'PROCESSING') return { set: {}, waitMs: 60000 };
  if (state !== 'ACTIVE') throw new AiError('permanent', 'Gemini が音声を読めませんでした');
  const total = Math.max(1, Math.ceil((lecture.audio_duration_sec ?? UNKNOWN_DURATION_SEC) / cfg.segmentSec));
  return { set: { segments_total: total, step: 'transcribe' } };
}

async function transcribe({ env, ai, lecture, cfg }) {
  const { n: idx } = await env.DB.prepare('SELECT count(*) AS n FROM segments WHERE lecture_id = ?').bind(lecture.id).first();
  const startSec = idx * cfg.segmentSec;
  let endSec = startSec + cfg.segmentSec;
  if (lecture.audio_duration_sec) endSec = Math.min(endSec, lecture.audio_duration_sec);
  const text = await ai.transcribeSegment({ fileUri: lecture.audio_file_uri, mime: lecture.audio_mime, startSec, endSec });
  await env.DB.prepare('INSERT OR REPLACE INTO segments (lecture_id, idx, text) VALUES (?, ?, ?)').bind(lecture.id, idx, text).run();
  if (idx + 1 < lecture.segments_total) return { set: {}, waitMs: cfg.segmentIntervalMs };
  try {
    await ai.deleteFile({ fileName: lecture.audio_file_name });
  } catch {
    // 消せなくても 48 時間で消える
  }
  return { set: { audio_file_name: null, audio_file_uri: null, step: 'attach' } };
}

const notYet = async () => {
  throw new AiError('permanent', '未実装');
};

export const STEPS = { wait_file: waitFile, transcribe, attach: notYet, summarize: notYet };

export const STEP_NAMES = { wait_file: '準備', transcribe: '文字起こし', attach: 'ファイルの準備', summarize: '要約' };
