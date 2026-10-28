import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeItems, mergeState, withDefaults } from '../src/state.js';

test('newer updatedAt wins per item and tombstones survive', () => {
  const server = [{ id: 'a', range: 'old', updatedAt: '2026-10-09T01:00:00Z', createdAt: '1' }, { id: 'b', range: 'b', updatedAt: '2026-10-09T01:00:00Z', createdAt: '2' }];
  const client = [{ id: 'a', range: 'new', updatedAt: '2026-10-09T02:00:00Z', createdAt: '1' }, { id: 'b', deleted: true, updatedAt: '2026-10-09T03:00:00Z', createdAt: '2' }, { id: 'c', range: 'c', updatedAt: '2026-10-09T00:00:00Z', createdAt: '3' }];
  const m = mergeItems(server, client);
  assert.deepEqual(m.map((i) => i.id), ['a', 'b', 'c']);
  assert.equal(m[0].range, 'new');
  assert.equal(m[1].deleted, true);
});

test('settings take the newer copy and nudge stays server-side', () => {
  const server = withDefaults({ settings: { leaveAt: '07:50', updatedAt: '2026-10-09T01:00:00Z' }, nudge: { sent: { x: 1 } } });
  const incoming = { settings: { leaveAt: '08:10', updatedAt: '2026-10-09T02:00:00Z' }, nudge: { sent: {} } };
  const m = mergeState(server, incoming);
  assert.equal(m.settings.leaveAt, '08:10');
  assert.equal(m.settings.tz, 'Asia/Tokyo');
  assert.deepEqual(m.nudge.sent, { x: 1 });
});

test('capture merges per subject and upgrades old string entries; client snooze is merged', async () => {
  const { mergeCapture, mergeNudge } = await import('../src/state.js');
  const m = mergeCapture({ '2026-10-09': 'none', '2026-10-08': { '数学': 'added' } }, { '2026-10-09': { '英語': 'added' }, '2026-10-08': { '数学': 'none', '英語': 'none' } });
  assert.deepEqual(m['2026-10-09'], { '*': 'none', '英語': 'added' });
  assert.deepEqual(m['2026-10-08'], { '数学': 'added', '英語': 'none' });
  const n = mergeNudge({ sent: { a: 1 }, snoozeUntil: '2026-10-09T00:00:00Z', snoozeCount: { '2026-10-09': 1 } }, { snoozeUntil: '2026-10-09T00:10:00Z', snoozeCount: { '2026-10-09': 2 }, sent: {} });
  assert.deepEqual(n.sent, { a: 1 });
  assert.equal(n.snoozeUntil, '2026-10-09T00:10:00Z');
  assert.equal(n.snoozeCount['2026-10-09'], 2);
});

// ---- 毎週くりかえす宿題 ----
import { materializeRepeats } from '../src/state.js';
import { materializeRepeats as appMaterialize } from '../../shukudai/sync.js';

const wk = (over = {}) => ({ id: 'hw_a', subject: '統計学', range: '課題', where: 'manaba', due: '2026-10-26', repeat: 'weekly', done: false, packed: false, createdAt: '2026-10-19T00:00:00Z', updatedAt: '2026-10-19T00:00:00Z', ...over });
const NOW = '2026-10-28T09:00:00Z';

test('毎週：終わったら（できた）来週の分が出る。決まった id なので何回呼んでも 1 つだけ', () => {
  const items = [wk({ due: '2026-11-02', done: true })];
  const a = materializeRepeats(items, '2026-10-28', NOW);
  assert.equal(a.length, 2);
  const next = a.find((i) => i.id !== 'hw_a');
  assert.equal(next.due, '2026-11-09');
  assert.equal(next.id, 'hw_a_2026-11-09');
  assert.equal(next.seriesId, 'hw_a');
  assert.equal(next.done, false);
  assert.equal(next.repeat, 'weekly');
  assert.equal(next.subject, '統計学');
  assert.equal(materializeRepeats(a, '2026-10-28', NOW).length, 2, '2 回目は増えない');
});

test('毎週：まだ終わっていなくて期限前なら、来週の分は出ない', () => {
  assert.equal(materializeRepeats([wk({ due: '2026-11-02' })], '2026-10-28', NOW).length, 1);
});

test('毎週：期限を過ぎたら、終わっていなくても今週以降の分が出る（過ぎた週は飛ばす）', () => {
  const a = materializeRepeats([wk({ due: '2026-10-12' })], '2026-10-28', NOW);
  assert.equal(a.length, 2);
  assert.equal(a.find((i) => i.id !== 'hw_a').due, '2026-11-02', '飛ばして、いまから先のいちばん近い同じ曜日');
});

test('毎週：やめる（repeat を外す）と増えない。消したものも生き返らない', () => {
  assert.equal(materializeRepeats([wk({ due: '2026-11-02', done: true, repeat: null })], '2026-10-28', NOW).length, 1);
  const gone = { ...wk({ due: '2026-11-09' }), id: 'hw_a_2026-11-09', seriesId: 'hw_a', deleted: true };
  assert.equal(materializeRepeats([wk({ due: '2026-11-02', done: true }), gone], '2026-10-28', NOW).length, 2);
});

test('毎週：アプリ（sync.js）とサーバーで同じ結果になる', () => {
  const items = [wk({ due: '2026-11-02', done: true }), wk({ id: 'hw_b', due: '2026-10-12', subject: '倫理学' })];
  assert.deepEqual(appMaterialize(items, '2026-10-28', NOW), materializeRepeats(items, '2026-10-28', NOW));
});
