// config.json の読み込みと検証（不正な値は既定値に戻す）

export const DEFAULT_CONFIG = Object.freeze({
  orgName: '[団体名]',
  city: '東京',
  latitude: 35.68,
  longitude: 139.76,
  accent: '',
  wallpaper: '',
  calendarEmbedUrl: '',
});

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, fallback) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
const coord = (v, limit) => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
};

export function normalizeConfig(raw) {
  if (!isPlainObject(raw)) return { ...DEFAULT_CONFIG };
  // 地名と座標は組で扱う（座標が不正なら、別の地点の天気を違う地名で出さないよう3つとも既定に戻す）
  const latitude = coord(raw.latitude, 90);
  const longitude = coord(raw.longitude, 180);
  const place = latitude !== null && longitude !== null
    ? { city: text(raw.city, DEFAULT_CONFIG.city), latitude, longitude }
    : { city: DEFAULT_CONFIG.city, latitude: DEFAULT_CONFIG.latitude, longitude: DEFAULT_CONFIG.longitude };
  if ((latitude === null || longitude === null) && (raw.latitude !== undefined || raw.longitude !== undefined)) console.warn('config.json の座標が不正なため、既定の地点（東京）を使います');
  return {
    orgName: text(raw.orgName, DEFAULT_CONFIG.orgName),
    ...place,
    accent: typeof raw.accent === 'string' && /^#[0-9A-Fa-f]{6}$/.test(raw.accent) ? raw.accent : '',
    wallpaper:
      typeof raw.wallpaper === 'string' && /^wallpaper\/[A-Za-z0-9._-]+$/.test(raw.wallpaper) && !raw.wallpaper.includes('..')
        ? raw.wallpaper
        : '',
    calendarEmbedUrl: typeof raw.calendarEmbedUrl === 'string' ? raw.calendarEmbedUrl.trim() : '',
  };
}

export async function loadConfig(url = 'config.json') {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return normalizeConfig(await res.json());
  } catch (err) {
    console.warn('config.json を読み込めないため既定値を使います', err);
    return { ...DEFAULT_CONFIG };
  }
}

// 管理者の色は明るいテーマ用（--accent-light）にだけ使う。ダークは style.css の色のまま。
export function lookVars(config) {
  return config.accent ? { '--accent-light': config.accent } : {};
}

// 壁紙があるときは、文字の後ろにうすい台を敷く
export function lookClasses(config) {
  return config.wallpaper ? ['has-wallpaper'] : [];
}
