// 天気（Open-Meteo、キー不要）。送るのは座標だけ。30分キャッシュ。
import { makeIcon } from './icons.js';

const CACHE_KEY = 'weather-cache';
const MAX_AGE_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 8000;

const CODES = [
  [[0], '快晴', 'sun'],
  [[1], '晴れ', 'sun'],
  [[2], '晴れ時々くもり', 'partly'],
  [[3], 'くもり', 'cloud'],
  [[45, 48], '霧', 'fog'],
  [[51, 53, 55, 56, 57], '霧雨', 'rain'],
  [[61, 63, 65, 66, 67], '雨', 'rain'],
  [[80, 81, 82], 'にわか雨', 'rain'],
  [[71, 73, 75, 77], '雪', 'snow'],
  [[85, 86], 'にわか雪', 'snow'],
  [[95, 96, 99], '雷雨', 'thunder'],
];

export function describeWeather(code) {
  const hit = CODES.find(([codes]) => codes.includes(code));
  return hit ? { label: hit[1], icon: hit[2] } : { label: '—', icon: 'cloud' };
}

export function parseWeather(json) {
  const current = json && typeof json === 'object' ? json.current : null;
  if (!current || typeof current !== 'object') return null;
  const { temperature_2m: temp, weather_code: code } = current;
  if (typeof temp !== 'number' || !Number.isFinite(temp) || typeof code !== 'number') return null;
  return { temp: Math.round(temp), code };
}

// 30分以内なら新しいとみなす。未来の日時（端末の時計ずれ）は新しいとみなさない
export function isFresh(savedAt, now = Date.now()) {
  const age = now - savedAt;
  return Number.isFinite(age) && age >= 0 && age < MAX_AGE_MS;
}

export function weatherUrl({ latitude, longitude }) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(latitude));
  url.searchParams.set('longitude', String(longitude));
  url.searchParams.set('current', 'temperature_2m,weather_code');
  url.searchParams.set('timezone', 'auto');
  return url.href;
}

function readCache(config) {
  try {
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (!cache || cache.latitude !== config.latitude || cache.longitude !== config.longitude) return null;
    const data = parseWeather({ current: cache.current });
    return data ? { data, savedAt: Number(cache.savedAt) || 0 } : null;
  } catch {
    return null;
  }
}

function writeCache(config, data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      savedAt: Date.now(),
      latitude: config.latitude,
      longitude: config.longitude,
      current: { temperature_2m: data.temp, weather_code: data.code },
    }));
  } catch {
    // 保存できなくても表示は続ける
  }
}

function span(className, text) {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

function paint(container, city, data, note) {
  const textBox = span('weather-text', '');
  textBox.append(span('weather-city', city));
  if (data) {
    const { label, icon } = describeWeather(data.code);
    const main = span('weather-main', `${data.temp}℃`);
    main.append(span('weather-label', label));
    textBox.append(main);
    if (note) textBox.append(span('weather-note', note));
    container.replaceChildren(makeIcon(icon), textBox);
  } else {
    textBox.append(span('weather-main', '取得できません'));
    container.replaceChildren(makeIcon('cloud'), textBox);
  }
}

export async function showWeather(container, config) {
  const cached = readCache(config);
  if (cached && isFresh(cached.savedAt)) {
    paint(container, config.city, cached.data);
    return;
  }
  // 取得を待つ間も、前回の情報があれば先に出しておく
  if (cached) paint(container, config.city, cached.data, '前回の情報');
  try {
    const res = await fetch(weatherUrl(config), {
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = parseWeather(await res.json());
    if (!data) throw new Error('unexpected response');
    writeCache(config, data);
    paint(container, config.city, data);
  } catch (err) {
    console.warn('天気を取得できません', err);
    paint(container, config.city, cached ? cached.data : null, cached ? '前回の情報' : '');
  }
}
