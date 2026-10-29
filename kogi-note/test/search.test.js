import { env } from 'cloudflare:test';
import { beforeEach, it, expect } from 'vitest';
import { resetDb, call, newSubject, newLecture, addSegment } from './helpers.js';

beforeEach(() => resetDb(env));

it('search finds transcript text with a snippet and escapes % and _', async () => {
  const s = await newSubject('統計学');
  const a = await newLecture({ subject_id: s, number: 1, date: '2026-10-01' });
  const b = await newLecture({ subject_id: s, number: 2, date: '2026-10-08' });
  const c = await newLecture({ subject_id: s, number: 3, date: '2026-10-15' });
  await addSegment(a, 0, '[00:00] 100%の確率で出ます');
  await addSegment(a, 1, '[30:00] 100%の確率でもう一度');
  await addSegment(b, 0, '[00:00] 50の確率');
  await addSegment(c, 0, 'あ'.repeat(5000) + '100%の確率' + 'い'.repeat(5000));
  const r = (await call(`/api/search?q=${encodeURIComponent('100%')}`)).body.results;
  expect(r.map((x) => x.lecture_id)).toEqual([c, a]);
  expect(r[1]).toMatchObject({ subject_name: '統計学', number: 1, date: '2026-10-01', where: 'transcript' });
  expect(r[1].snippet).toContain('100%の確率');
  expect(r[0].snippet).toContain('100%の確率');
  expect(r[0].snippet.length).toBeLessThanOrEqual(120);
  expect(r[0].snippet.startsWith('あああ')).toBe(true);
  expect(r[0].snippet.indexOf('100%')).toBeLessThanOrEqual(40);
  expect((await call('/api/search?q=_')).body.results).toEqual([]);
  expect((await call(`/api/search?q=${encodeURIComponent('50%')}`)).body.results).toEqual([]);
});

it('search ignores ASCII case', async () => {
  const a = await newLecture();
  await addSegment(a, 0, 'これは ANOVA です');
  const r = (await call('/api/search?q=anova')).body.results;
  expect(r).toHaveLength(1);
  expect(r[0].snippet).toContain('ANOVA');
});

it('search matches summaries and rejects empty or over-100-char queries', async () => {
  const a = await newLecture({ summary_json: JSON.stringify({ theme: '回帰分析の考え方', flow: [], key_points: [], announcements: [] }) });
  expect((await call(`/api/search?q=${encodeURIComponent('回帰')}`)).body.results).toEqual([
    expect.objectContaining({ lecture_id: a, where: 'summary', snippet: '' }),
  ]);
  expect((await call('/api/search?q=%20%20')).status).toBe(400);
  expect((await call(`/api/search?q=${'a'.repeat(101)}`)).status).toBe(400);
  expect((await call('/api/search')).status).toBe(400);
});
