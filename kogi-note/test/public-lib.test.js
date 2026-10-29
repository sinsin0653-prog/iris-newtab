import { it, expect } from 'vitest';
import { formatTime, parseTime, parseTranscript, nearestLineIndex, todayLocal } from '../public/lib/time.js';
import { statusLabel, isWorking, reuploadWarning } from '../public/lib/status.js';
import { planChunks, normalizeDuration, uploadChunks } from '../public/lib/chunks.js';

it('formatTime matches the server rule', () => {
  expect(formatTime(4530)).toBe('75:30');
  expect(formatTime(5)).toBe('00:05');
});

it('parseTime handles long lectures', () => {
  expect(parseTime('23:10')).toBe(1390);
  expect(parseTime('75:30')).toBe(4530);
  expect(parseTime('1:15:30')).toBe(4530);
  for (const bad of ['', 'abc', '1:2', '12:60', null]) expect(parseTime(bad)).toBeNull();
});

it('parseTranscript keeps lines without times', () => {
  expect(parseTranscript('[00:00] はじめ\n\n時刻なしの行\n[1:15:30] おわり')).toEqual([{ sec: 0, text: 'はじめ' }, { sec: null, text: '時刻なしの行' }, { sec: 4530, text: 'おわり' }]);
  expect(parseTranscript('')).toEqual([]);
});

it('nearestLineIndex picks the last line at or before the time', () => {
  const lines = [{ sec: 0 }, { sec: null }, { sec: 600 }, { sec: 1200 }];
  expect(nearestLineIndex(lines, 900)).toBe(2);
  expect(nearestLineIndex(lines, 5000)).toBe(3);
  expect(nearestLineIndex(lines, 600)).toBe(2);
  expect(nearestLineIndex([{ sec: null }], 10)).toBe(0);
  expect(nearestLineIndex([], 10)).toBe(0);
  expect(nearestLineIndex([{ sec: 100 }, { sec: 200 }], 10)).toBe(0);
});

it('todayLocal pads', () => {
  expect(todayLocal(new Date(2026, 0, 5, 8))).toBe('2026-01-05');
  expect(todayLocal(new Date(2026, 10, 25, 23))).toBe('2026-11-25');
});

it('statusLabel', () => {
  expect(statusLabel({ status: 'uploading' })).toBe('音声を入れてね');
  expect(statusLabel({ status: 'processing', step: 'wait_file' })).toBe('準備中');
  expect(statusLabel({ status: 'processing', step: 'transcribe', segments_done: 1, segments_total: 3 })).toBe('文字起こし中（2/3）');
  expect(statusLabel({ status: 'processing', step: 'transcribe', segments_done: 3, segments_total: 3 })).toBe('文字起こし中（3/3）');
  expect(statusLabel({ status: 'processing', step: 'transcribe', waiting_reason: 'rate_limited' })).toBe('混んでいるので待っています');
  expect(statusLabel({ status: 'processing', step: 'attach' })).toBe('準備中');
  expect(statusLabel({ status: 'processing', step: 'notes', segments_done: 3, segments_total: 3, notes_done: 1 })).toBe('授業ノートを書いています（2/3）');
  expect(statusLabel({ status: 'processing', step: 'summarize' })).toBe('要約を作っています');
  expect(statusLabel({ status: 'done' })).toBe('完成');
  expect(statusLabel({ status: 'error' })).toBe('エラー');
  expect(isWorking({ status: 'processing' })).toBe(true);
  expect(isWorking({ status: 'done' })).toBe(false);
});

it('planChunks and normalizeDuration', () => {
  expect(planChunks(10, 4)).toEqual([{ offset: 0, end: 4 }, { offset: 4, end: 8 }, { offset: 8, end: 10 }]);
  expect(planChunks(8, 4, 4)).toEqual([{ offset: 4, end: 8 }]);
  expect([Infinity, NaN, 0, -3, undefined, null].map(normalizeDuration)).toEqual([null, null, null, null, null, null]);
  expect(normalizeDuration(5399.6)).toBe(5400);
});

it('uploadChunks retries a failing chunk and resyncs on offset_mismatch', async () => {
  const seen = []; let failOnce = true; const progress = [];
  await uploadChunks({ size: 10, chunkSize: 4, sleep: async () => {}, onProgress: (n) => progress.push(n), sendChunk: async (o, e) => {
    seen.push(o);
    if (o === 4 && failOnce) { failOnce = false; throw new Error('net'); }
    if (o === 8 && seen.filter((x) => x === 8).length === 1) throw Object.assign(new Error('m'), { code: 'offset_mismatch', expected_offset: 6 });
    return { next_offset: e, done: e === 10 };
  } });
  expect(seen).toEqual([0, 4, 4, 8, 6]);
  expect(progress.at(-1)).toBe(10);
});

it('uploadChunks gives up after 3 retries', async () => {
  let n = 0;
  await expect(uploadChunks({ size: 4, chunkSize: 4, sleep: async () => {}, sendChunk: async () => { n++; throw new Error('down'); } })).rejects.toThrow('down');
  expect(n).toBe(4);
});

it('uploadChunks reads expected_offset from ApiError.data too', async () => {
  const seen = []; let first = true;
  await uploadChunks({ size: 8, chunkSize: 8, sendChunk: async (o, e) => {
    seen.push([o, e]);
    if (first) { first = false; throw Object.assign(new Error('m'), { code: 'offset_mismatch', data: { expected_offset: 4 } }); }
    return { next_offset: e, done: e === 8 };
  } });
  expect(seen).toEqual([[0, 8], [4, 8]]);
});

it('uploadChunks waits 2, 4, 8 seconds before retries but not on offset_mismatch', async () => {
  const waits = []; let n = 0;
  await expect(uploadChunks({ size: 4, chunkSize: 4, sleep: async (ms) => { waits.push(ms); }, sendChunk: async () => { n++; throw new Error('down'); } })).rejects.toThrow('down');
  expect(waits).toEqual([2000, 4000, 8000]);
  const waits2 = []; let first = true;
  await uploadChunks({ size: 8, chunkSize: 8, sleep: async (ms) => { waits2.push(ms); }, sendChunk: async (o, e) => {
    if (first) { first = false; throw Object.assign(new Error('m'), { code: 'offset_mismatch', expected_offset: 4 }); }
    return { next_offset: e, done: true };
  } });
  expect(waits2).toEqual([]);
});

it('uploadChunks fails if the server never says done', async () => {
  await expect(uploadChunks({ size: 8, chunkSize: 8, sleep: async () => {}, sendChunk: async () => { throw Object.assign(new Error('m'), { code: 'offset_mismatch', expected_offset: 8 }); } })).rejects.toThrow();
  await expect(uploadChunks({ size: 8, chunkSize: 8, sleep: async () => {}, sendChunk: async (o, e) => ({ next_offset: e, done: false }) })).rejects.toThrow();
});

it('reuploadWarning warns only when a transcript would be thrown away', () => {
  expect(reuploadWarning({ status: 'error', step: 'summarize', segments_done: 3 })).toContain('文字起こし');
  expect(reuploadWarning({ status: 'done', segments_done: 3 })).toContain('文字起こし');
  expect(reuploadWarning({ status: 'error', step: 'transcribe', segments_done: 0, needs_audio: true })).toBeNull();
  expect(reuploadWarning({ status: 'uploading', segments_done: 0, needs_audio: true })).toBeNull();
});
