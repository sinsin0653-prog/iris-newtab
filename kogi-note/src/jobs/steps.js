// 見回りの段階ごとの作業。どれも (ctx) => { set, waitMs } を返す
import { AiError } from '../ai/errors.js';
import { transcriptOf } from '../db.js';

const UNKNOWN_DURATION_SEC = 7200;

async function waitFile({ ai, lecture, cfg }) {
  const state = await ai.getFileState({ fileName: lecture.audio_file_name });
  if (state === 'PROCESSING') return { set: {}, waitMs: 60000 };
  if (state !== 'ACTIVE') throw new AiError('permanent', 'Gemini が音声を読めませんでした');
  const total = Math.max(1, Math.ceil((lecture.audio_duration_sec ?? UNKNOWN_DURATION_SEC) / cfg.segmentSec));
  // レジュメを先に Gemini に置いてから文字起こしする（用語の聞き間違いを減らす）
  return { set: { segments_total: total, step: 'attach' } };
}

const glossaryOf = async (env, lecture) =>
  (await env.DB.prepare('SELECT glossary FROM subjects WHERE id = ?').bind(lecture.subject_id).first())?.glossary ?? '';

// Gemini に置いてあるレジュメ（写真・PDF）
const handoutsOf = async (env, lecture) =>
  (await env.DB.prepare(
    "SELECT gemini_file_uri AS fileUri, mime FROM attachments WHERE lecture_id = ? AND kind != 'note_image' AND gemini_file_uri IS NOT NULL ORDER BY position",
  ).bind(lecture.id).all()).results;

async function transcribe({ env, ai, lecture, cfg }) {
  const { n: idx } = await env.DB.prepare('SELECT count(*) AS n FROM segments WHERE lecture_id = ?').bind(lecture.id).first();
  const startSec = idx * cfg.segmentSec;
  let endSec = startSec + cfg.segmentSec;
  if (lecture.audio_duration_sec) endSec = Math.min(endSec, lecture.audio_duration_sec);
  const text = await ai.transcribeSegment({
    fileUri: lecture.audio_file_uri, mime: lecture.audio_mime, startSec, endSec,
    glossary: await glossaryOf(env, lecture), handouts: await handoutsOf(env, lecture),
  });
  await env.DB.prepare('INSERT OR REPLACE INTO segments (lecture_id, idx, text) VALUES (?, ?, ?)').bind(lecture.id, idx, text).run();
  if (idx + 1 < lecture.segments_total) return { set: {}, waitMs: cfg.segmentIntervalMs };
  try {
    await ai.deleteFile({ fileName: lecture.audio_file_name });
  } catch {
    // 消せなくても 48 時間で消える
  }
  return { set: { audio_file_name: null, audio_file_uri: null, step: 'notes' } };
}

// 区間ごとの授業ノート。notes_json に { sections, done } を貯めていく
async function notes({ env, ai, lecture, cfg }) {
  const transcript = await transcriptOf(env, lecture.id);
  if (transcript === '') throw new AiError('permanent', '音声から話し声が見つかりませんでした。音声を入れ直してください');
  const saved = lecture.notes_json ? JSON.parse(lecture.notes_json) : { sections: [], done: 0 };
  if (saved.done >= lecture.segments_total) return { set: { step: 'summarize' } };
  const idx = saved.done;
  const seg = await env.DB.prepare('SELECT text FROM segments WHERE lecture_id = ? AND idx = ?').bind(lecture.id, idx).first();
  const segmentText = seg?.text ?? '';
  const startSec = idx * cfg.segmentSec;
  let endSec = startSec + cfg.segmentSec;
  if (lecture.audio_duration_sec) endSec = Math.min(endSec, lecture.audio_duration_sec);
  let sections = [];
  if (segmentText !== '') {
    ({ sections } = await ai.writeNotes({ segmentText, startSec, endSec, glossary: await glossaryOf(env, lecture), handouts: await handoutsOf(env, lecture) }));
  }
  const next = { sections: [...saved.sections, ...sections], done: idx + 1 };
  const done = next.done >= lecture.segments_total;
  return { set: { notes_json: JSON.stringify(next), ...(done ? { step: 'summarize' } : {}) } };
}

const ATTACH_BATCH = 5;
const REUPLOAD_MARGIN_MS = 3600_000;

const quietly = async (p) => {
  try {
    await p;
  } catch {
    // Gemini のファイルは 48 時間で消えるので、消せなくても先に進む
  }
};

// Gemini に写真・PDF を置く（1 回に 5 つまで）
async function attach({ env, ai, now, lecture }) {
  const pending = async () =>
    (await env.DB.prepare(
      `SELECT * FROM attachments WHERE lecture_id = ? AND (gemini_file_uri IS NULL OR gemini_expires_at - ? < ?)
       ORDER BY position`,
    ).bind(lecture.id, now, REUPLOAD_MARGIN_MS).all()).results;
  for (const att of (await pending()).slice(0, ATTACH_BATCH)) {
    // 20MB の PDF が 5 つでもメモリ（128MB）に乗せないよう、KV から流したまま送る
    const body = await env.FILES.get(att.kv_key, 'stream');
    if (body === null) {
      if (att.gemini_file_name) await quietly(ai.deleteFile({ fileName: att.gemini_file_name }));
      await env.DB.prepare('DELETE FROM attachments WHERE id = ?').bind(att.id).run();
      continue;
    }
    const file = await ai.uploadFile({ body, mime: att.mime, size: att.size, displayName: att.id });
    const saved = await env.DB.prepare(
      'UPDATE attachments SET gemini_file_name = ?, gemini_file_uri = ?, gemini_expires_at = ? WHERE id = ?',
    ).bind(file.fileName, file.fileUri, file.expiresAt, att.id).run();
    if (saved.meta.changes === 0) await quietly(ai.deleteFile({ fileName: file.fileName }));
  }
  if ((await pending()).length > 0) return { set: {}, waitMs: 0 };
  // 音声がまだあれば文字起こしへ。もう無ければ（作り直し）ノートへ
  return { set: { step: lecture.audio_file_name ? 'transcribe' : 'notes' } };
}

async function summarize({ env, ai, lecture }) {
  const transcript = await transcriptOf(env, lecture.id);
  if (transcript === '') throw new AiError('permanent', '音声から話し声が見つかりませんでした。音声を入れ直してください');
  const atts = (await env.DB.prepare(
    'SELECT * FROM attachments WHERE lecture_id = ? AND gemini_file_name IS NOT NULL ORDER BY position',
  ).bind(lecture.id).all()).results;
  const states = await Promise.all(atts.map((a) => ai.getFileState({ fileName: a.gemini_file_name })));
  if (states.some((s) => s === 'FAILED')) throw new AiError('permanent', 'Gemini がメモかレジュメのファイルを読めませんでした');
  if (states.some((s) => s !== 'ACTIVE')) return { set: {}, waitMs: 60000 };
  const notesValue = lecture.notes_json ? JSON.parse(lecture.notes_json) : { sections: [] };
  const summary = await ai.summarize({
    transcript,
    notes: { sections: notesValue.sections ?? [] },
    noteText: lecture.note_text,
    attachments: atts.map((a) => ({ fileUri: a.gemini_file_uri, mime: a.mime, kind: a.kind })),
  });
  await Promise.all(atts.map((a) => quietly(ai.deleteFile({ fileName: a.gemini_file_name }))));
  await env.DB.prepare(
    'UPDATE attachments SET gemini_file_name = NULL, gemini_file_uri = NULL, gemini_expires_at = NULL WHERE lecture_id = ?',
  ).bind(lecture.id).run();
  return { set: { summary_json: JSON.stringify(summary), status: 'done', step: null } };
}

export const STEPS = { wait_file: waitFile, attach, transcribe, notes, summarize };

export const STEP_NAMES = { wait_file: '準備', attach: 'ファイルの準備', transcribe: '文字起こし', notes: '授業ノート', summarize: '要約' };
