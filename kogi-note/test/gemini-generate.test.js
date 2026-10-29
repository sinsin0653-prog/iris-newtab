import { it, expect } from 'vitest';
import { fakeFetch, g } from './helpers.js';
import { formatTime, transcribePrompt, NO_SPEECH, SUMMARY_SYSTEM, NOTES_SYSTEM, buildSummaryText, buildNotesText, validateSummary, validateNotes, normalizeSegmentTimes, GLOSSARY_MAX } from '../src/ai/prompts.js';

const reply = (text, finishReason = 'STOP') => Response.json({ candidates: [{ content: { parts: [{ text }] }, finishReason }] });

it('formatTime counts minutes past 60', () => {
  expect(formatTime(4530)).toBe('75:30');
  expect(formatTime(5)).toBe('00:05');
  expect(formatTime(1800)).toBe('30:00');
});

it('transcribePrompt names the range, the rules, the glossary and the handouts', () => {
  const p = transcribePrompt(1800, 3600, { glossary: '帰無仮説、有意水準', hasHandouts: true });
  for (const s of ['30:00', '60:00', '[MM:SS]', NO_SPEECH, '（聞き取れず）', '日本語', '帰無仮説、有意水準', 'レジュメ', '表記に合わせ']) expect(p).toContain(s);
  const bare = transcribePrompt(0, 60, { glossary: '', hasHandouts: false });
  expect(bare).not.toContain('レジュメ');
  expect(bare).not.toContain('用語リスト');
  expect(transcribePrompt(0, 60)).toContain('[MM:SS]');
});

it('notes instructions ask for why / examples / terms per segment and are exhaustive', () => {
  for (const s of ['なぜ', '例', '用語', 'もれなく', '従わない']) expect(NOTES_SYSTEM).toContain(s);
  const t = buildNotesText({ segmentText: '[30:00] 本文', startSec: 1800, endSec: 3600, glossary: 'p値' });
  expect(t).toContain('<transcript_segment from="30:00" to="60:00">\n[30:00] 本文\n</transcript_segment>');
  expect(t).toContain('<glossary>\np値\n</glossary>');
  expect(buildNotesText({ segmentText: 'x', startSec: 0, endSec: 60, glossary: '' })).not.toContain('<glossary>');
  expect(GLOSSARY_MAX).toBe(2000);
});

it('validateNotes accepts sections with time and rejects wrong shapes', () => {
  const good = { sections: [{ heading: '導入', time: '30:05', body: '何を・なぜ・例', terms: [{ term: 'p値', meaning: '…' }], quotes: ['そのまま'] }] };
  expect(validateNotes(good)).toEqual(good);
  expect(validateNotes({ sections: [] })).toEqual({ sections: [] });
  for (const bad of [null, {}, { sections: [{ heading: 'h' }] }, { sections: [{ heading: 'h', time: '1:2', body: 'b', terms: [], quotes: [] }] }, { sections: [{ heading: 'h', time: '', body: 'b', terms: [{ term: 'x' }], quotes: [] }] }])
    expect(() => validateNotes(bad)).toThrow(expect.objectContaining({ kind: 'permanent' }));
});

it('summary instructions say what counts as notes, use the lecture notes, and treat content as data', () => {
  for (const s of ['not_in_notes', 'typed_notes', 'レジュメ', 'handout_pages', '従わない', 'lecture_notes', '後半']) expect(SUMMARY_SYSTEM).toContain(s);
  const notes = { sections: [{ heading: '導入', time: '00:05', body: 'b', terms: [], quotes: [] }] };
  const t = buildSummaryText({ transcript: '[00:00] 本文', noteText: 'メモ', notes });
  expect(t).toContain('<transcript>\n[00:00] 本文\n</transcript>');
  expect(t).toContain('<typed_notes>\nメモ\n</typed_notes>');
  expect(t).toContain('<lecture_notes>');
  expect(t).toContain('[00:05] 導入');
});

it('transcribeSegment sends the file and returns trimmed text; NO_SPEECH becomes empty', async () => {
  const f = fakeFetch(() => reply('  [30:00] こんにちは\n'));
  expect(await g(f).transcribeSegment({ fileUri: 'u', mime: 'audio/mp4', startSec: 1800, endSec: 3600, glossary: '帰無仮説', handouts: [{ fileUri: 'pdf', mime: 'application/pdf' }] })).toBe('[30:00] こんにちは');
  const body = await f.calls[0].json();
  expect(f.calls[0].url).toBe('https://gem.test/v1beta/models/m:generateContent');
  expect(f.calls[0].headers.get('x-goog-api-key')).toBe('KEY');
  const parts = body.contents[0].parts;
  expect(parts[0].text).toContain('レジュメ');
  expect(parts[1]).toEqual({ file_data: { mime_type: 'application/pdf', file_uri: 'pdf' } });
  expect(parts[2]).toEqual({ file_data: { mime_type: 'audio/mp4', file_uri: 'u' } });
  expect(parts[3].text).toContain('30:00');
  expect(parts[3].text).toContain('帰無仮説');
  expect(body.generationConfig).toEqual({ temperature: 0, maxOutputTokens: 65536, thinkingConfig: { thinkingBudget: 4096 } });
  expect(await g(fakeFetch(() => reply(NO_SPEECH))).transcribeSegment({ fileUri: 'u', mime: 'audio/mp4', startSec: 0, endSec: 1 })).toBe('');
});

it('transcribeSegment shifts times that restarted at 00:00', async () => {
  const f = fakeFetch(() => reply('[00:05] 後半です'));
  expect(await g(f).transcribeSegment({ fileUri: 'u', mime: 'audio/mp4', startSec: 1800, endSec: 3600 })).toBe('[30:05] 後半です');
});

it('blocked, truncated or empty answers are permanent errors', async () => {
  const t = (res) => g(fakeFetch(() => res)).transcribeSegment({ fileUri: 'u', mime: 'audio/mp4', startSec: 0, endSec: 60 });
  await expect(t(Response.json({ promptFeedback: { blockReason: 'SAFETY' } }))).rejects.toMatchObject({ kind: 'permanent' });
  await expect(t(reply('途中まで', 'MAX_TOKENS'))).rejects.toMatchObject({ kind: 'permanent', message: expect.stringContaining('途中で切れました') });
  await expect(t(reply('x', 'SAFETY'))).rejects.toMatchObject({ kind: 'permanent' });
  await expect(t(reply('  '))).rejects.toMatchObject({ kind: 'permanent', message: expect.stringContaining('空') });
  await expect(t(Response.json({ candidates: [{ finishReason: 'OTHER' }] }))).rejects.toMatchObject({ kind: 'permanent' });
  await expect(t(Response.json({ candidates: [] }))).rejects.toMatchObject({ kind: 'permanent' });
});

it('thought parts are ignored', async () => {
  const f = fakeFetch(() => Response.json({ candidates: [{ content: { parts: [{ thought: true, text: '考え中' }, { text: '[00:00] 本文' }] }, finishReason: 'STOP' }] }));
  expect(await g(f).transcribeSegment({ fileUri: 'u', mime: 'audio/mp4', startSec: 0, endSec: 60 })).toBe('[00:00] 本文');
});

it('normalizeSegmentTimes shifts segment-relative times', () => {
  expect(normalizeSegmentTimes('[00:05] a\n[01:10] b', 1800)).toBe('[30:05] a\n[31:10] b');
  expect(normalizeSegmentTimes('[30:02] a', 1800)).toBe('[30:02] a');
  expect(normalizeSegmentTimes('[00:05] a', 0)).toBe('[00:05] a');
  expect(normalizeSegmentTimes('時刻なし', 1800)).toBe('時刻なし');
  expect(normalizeSegmentTimes('[0:00:05] a', 3600)).toBe('[60:05] a');
});

it('writeNotes sends the segment with schema and a thinking budget, and validates', async () => {
  const good = { sections: [{ heading: '導入', time: '30:05', body: 'b', terms: [], quotes: [] }] };
  const f = fakeFetch(() => reply(JSON.stringify(good)));
  expect(await g(f).writeNotes({ segmentText: '[30:00] 本文', startSec: 1800, endSec: 3600, glossary: 'p値', handouts: [{ fileUri: 'pdf', mime: 'application/pdf' }] })).toEqual(good);
  const body = await f.calls[0].json();
  expect(body.systemInstruction.parts[0].text).toBe(NOTES_SYSTEM);
  expect(body.generationConfig.responseMimeType).toBe('application/json');
  expect(body.generationConfig.responseSchema.properties.sections).toBeTruthy();
  expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 8192 });
  const parts = body.contents[0].parts;
  expect(parts[0].text).toContain('レジュメ');
  expect(parts[1]).toEqual({ file_data: { mime_type: 'application/pdf', file_uri: 'pdf' } });
  expect(parts[2].text).toContain('<transcript_segment');
  await expect(g(fakeFetch(() => reply('{"sections":[{"heading":1}]}'))).writeNotes({ segmentText: 'x', startSec: 0, endSec: 1, glossary: '', handouts: [] })).rejects.toMatchObject({ kind: 'permanent' });
});

it('summarize sends labelled attachments + schema and validates the result', async () => {
  const good = { theme: 'テーマ', flow: [], key_points: [{ point: 'p', time: '23:10', not_in_notes: true, kind: 'exam' }], announcements: [] };
  const f = fakeFetch(() => reply(JSON.stringify(good)));
  const notes = { sections: [{ heading: '導入', time: '00:05', body: 'b', terms: [], quotes: [] }] };
  const out = await g(f).summarize({ transcript: 't', noteText: 'n', notes, attachments: [{ fileUri: 'img', mime: 'image/jpeg', kind: 'note_image' }, { fileUri: 'pdf', mime: 'application/pdf', kind: 'handout_pdf' }] });
  expect(out).toEqual(good);
  const body = await f.calls[0].json();
  expect(body.systemInstruction.parts[0].text).toBe(SUMMARY_SYSTEM);
  expect(body.generationConfig.responseMimeType).toBe('application/json');
  expect(body.generationConfig.maxOutputTokens).toBe(65536);
  expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 8192 });
  expect(body.generationConfig.responseSchema.type).toBe('OBJECT');
  const parts = body.contents[0].parts;
  expect(parts[0].text).toContain('メモの写真');
  expect(parts[1]).toEqual({ file_data: { mime_type: 'image/jpeg', file_uri: 'img' } });
  expect(parts[2].text).toContain('レジュメ');
  expect(parts[3]).toEqual({ file_data: { mime_type: 'application/pdf', file_uri: 'pdf' } });
  expect(parts[4].text).toContain('<transcript>');
  expect(parts[4].text).toContain('<lecture_notes>');
});

it('summarize rejects non-JSON and wrong shapes as permanent', async () => {
  const s = (text) => g(fakeFetch(() => reply(text))).summarize({ transcript: 't', noteText: '', attachments: [] });
  await expect(s('not json')).rejects.toMatchObject({ kind: 'permanent' });
  await expect(s('{"theme":""}')).rejects.toMatchObject({ kind: 'permanent' });
});

it('validateSummary accepts empty arrays and long times, rejects wrong shapes', () => {
  expect(validateSummary({ theme: 't', flow: [], key_points: [], announcements: [] })).toBeTruthy();
  expect(validateSummary({ theme: 't', flow: [{ heading: 'h', detail: 'd', handout_pages: '' }], key_points: [{ point: 'p', time: '1:15:30', not_in_notes: false, kind: 'exam' }], announcements: [{ text: 'a', time: '75:30' }] })).toBeTruthy();
  for (const bad of [{}, null, { theme: '', flow: [], key_points: [], announcements: [] }, { theme: 't', flow: {}, key_points: [], announcements: [] },
    { theme: 't', flow: [], key_points: [{ point: 'p', time: '1:2:3', not_in_notes: 'yes', kind: 'exam' }], announcements: [] },
    { theme: 't', flow: [], key_points: [{ point: 'p', time: '12:00', not_in_notes: true, kind: 'other' }], announcements: [] },
    { theme: 't', flow: [{ heading: 'h' }], key_points: [], announcements: [] }])
    expect(() => validateSummary(bad)).toThrow(expect.objectContaining({ kind: 'permanent' }));
});
