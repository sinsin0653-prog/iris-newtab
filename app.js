// 起動：設定を読み、各部品を独立に組み立てる（1つ失敗しても他は表示する）
import { loadConfig, lookVars, lookClasses } from './config.js';
import { loadFonts } from './fonts.js';
import { startClock } from './clock.js';
import { renderLinks } from './links.js';
import { showWeather } from './weather.js';
import { showCalendar } from './calendar.js';

const $ = (id) => document.getElementById(id);

function run(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.catch === 'function') {
      result.catch((err) => console.error(`[${name}]`, err));
    }
  } catch (err) {
    console.error(`[${name}]`, err);
  }
}

function applyLook(config) {
  for (const el of [$('org-name'), $('org-footer')]) {
    if (el) el.textContent = config.orgName;
  }
  for (const [name, value] of Object.entries(lookVars(config))) {
    document.documentElement.style.setProperty(name, value);
  }
  if (config.wallpaper) document.body.style.backgroundImage = `url("${config.wallpaper}")`;
  document.body.classList.add(...lookClasses(config));
}

async function main() {
  run('fonts', () => loadFonts());
  run('clock', () =>
    startClock({ time: $('time'), date: $('date'), greeting: $('greeting'), greetingEn: $('greeting-en') })
  );
  run('links', () => renderLinks($('links')));
  const config = await loadConfig();
  run('look', () => applyLook(config));
  run('weather', () => showWeather($('weather'), config));
  run('calendar', () => showCalendar($('calendar'), config.calendarEmbedUrl));
}

main();
