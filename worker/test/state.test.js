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
