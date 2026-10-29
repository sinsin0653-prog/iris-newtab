// 時刻の道具（画面用。サーバーの src/ai/prompts.js と同じ規則）

export function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function parseTime(s) {
  if (typeof s !== 'string') return null;
  let m = /^(\d{1,3}):([0-5]\d)$/.exec(s);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^(\d{1,2}):([0-5]\d):([0-5]\d)$/.exec(s);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return null;
}

const LINE_TIME = /^\[([0-9:]+)\]\s*/;

export function parseTranscript(text) {
  const lines = [];
  for (const raw of String(text ?? '').split('\n')) {
    if (!raw.trim()) continue;
    const m = LINE_TIME.exec(raw);
    const sec = m ? parseTime(m[1]) : null;
    lines.push(sec === null ? { sec: null, text: raw } : { sec, text: raw.slice(m[0].length) });
  }
  return lines;
}

export function nearestLineIndex(lines, sec) {
  let best = 0;
  let bestSec = -1;
  lines.forEach((line, i) => {
    if (line.sec !== null && line.sec <= sec && line.sec >= bestSec) {
      best = i;
      bestSec = line.sec;
    }
  });
  return best;
}

// 端末の時刻での今日（toISOString は UTC なので、日本の朝 9 時前が前の日になる）
export function todayLocal(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
