// 音声をかけらに分けて送る計画と、送り直し

export function planChunks(size, chunkSize, from = 0) {
  const out = [];
  for (let offset = from; offset < size; offset += chunkSize) out.push({ offset, end: Math.min(offset + chunkSize, size) });
  return out;
}

export function normalizeDuration(d) {
  return typeof d === 'number' && Number.isFinite(d) && d > 0 ? Math.round(d) : null;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function uploadChunks({ size, chunkSize, sendChunk, onProgress, retries = 3, sleep = wait }) {
  let offset = 0;
  let failures = 0;
  while (offset < size) {
    const end = Math.min(offset + chunkSize, size);
    try {
      const res = await sendChunk(offset, end);
      offset = res.next_offset;
      failures = 0;
      onProgress?.(offset);
      if (res.done) return;
    } catch (err) {
      if (err?.code === 'offset_mismatch') {
        const expected = err.expected_offset ?? err.data?.expected_offset;
        if (Number.isInteger(expected)) {
          offset = expected;
          continue;
        }
      }
      failures += 1;
      if (failures > retries) throw err;
      // 電波の切りかわりなどが落ち着くまで待つ（2・4・8 秒）
      await sleep(2000 * 2 ** (failures - 1));
    }
  }
  throw new Error('音声の送信が最後まで終わりませんでした');
}
