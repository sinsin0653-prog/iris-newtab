// 時計・日付・時間帯のあいさつ

const WEEKDAYS = '日月火水木金土';

export function greetingFor(hour) {
  if (hour >= 4 && hour < 11) return { ja: 'おはようございます', en: 'Good morning' };
  if (hour >= 11 && hour < 17) return { ja: 'こんにちは', en: 'Good afternoon' };
  return { ja: 'こんばんは', en: 'Good evening' };
}

export function formatTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDate(date) {
  const weekday = WEEKDAYS[date.getDay()];
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日（${weekday}）`;
}

// els: { time, date, greeting, greetingEn }（どれも省略可）
export function startClock(els) {
  const tick = () => {
    const now = new Date();
    const greeting = greetingFor(now.getHours());
    if (els.time) {
      els.time.textContent = formatTime(now);
      els.time.setAttribute('datetime', now.toISOString());
    }
    if (els.date) els.date.textContent = formatDate(now);
    if (els.greeting) els.greeting.textContent = greeting.ja;
    if (els.greetingEn) els.greetingEn.textContent = greeting.en;
  };
  tick();
  // 分の切り替わりに遅れないよう、次の秒の頭に合わせて1秒ごとに更新
  setTimeout(() => {
    tick();
    setInterval(tick, 1000);
  }, 1000 - (Date.now() % 1000));
}
