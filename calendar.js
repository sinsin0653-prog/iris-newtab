// 共有Googleカレンダーの埋め込み（任意）。認証コードは書かない。
// config.json の calendarEmbedUrl が https://calendar.google.com/calendar/embed の埋め込みURLのときだけ表示する。
// （iCal の非公開URLなど、埋め込み以外のURLは表示しない）

export function isAllowedCalendarUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    return (
      url.protocol === 'https:' &&
      url.hostname === 'calendar.google.com' &&
      url.port === '' &&
      url.pathname === '/calendar/embed' &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function showCalendar(section, value) {
  if (!isAllowedCalendarUrl(value)) {
    section.hidden = true;
    return;
  }
  const iframe = document.createElement('iframe');
  iframe.src = new URL(value.trim()).href;
  iframe.title = '共有カレンダー';
  iframe.loading = 'lazy';
  iframe.referrerPolicy = 'no-referrer';
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
  (section.querySelector('.cal-frame') || section).replaceChildren(iframe);
  section.hidden = false;
}
