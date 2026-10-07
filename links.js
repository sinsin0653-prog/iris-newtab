// ショートカット：links.json の検証と描画（textContent と DOM API のみ）
import { makeIcon } from './icons.js';

export const LINK_ICONS = ['search', 'video', 'mail', 'calendar', 'folder', 'map'];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function safeUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

export function validateLinks(data) {
  if (!isPlainObject(data) || !Array.isArray(data.links)) return { links: [], dropped: 0 };
  const links = [];
  let dropped = 0;
  for (const item of data.links) {
    const title = isPlainObject(item) && typeof item.title === 'string' ? item.title.trim() : '';
    const url = isPlainObject(item) ? safeUrl(item.url) : null;
    if (!title || !url) {
      dropped += 1;
      continue;
    }
    const icon = LINK_ICONS.includes(item.icon) ? item.icon : 'link';
    links.push({ title, url, icon });
  }
  return { links, dropped };
}

function note(container, message) {
  const p = document.createElement('p');
  p.className = 'empty-note';
  p.textContent = message;
  container.replaceChildren(p);
}

function tile(link) {
  const a = document.createElement('a');
  a.className = 'tile';
  a.href = link.url;
  a.rel = 'noopener noreferrer';

  const card = document.createElement('div');
  card.className = 'tile-card';
  card.appendChild(makeIcon(link.icon));

  const title = document.createElement('span');
  title.className = 'tile-title';
  title.textContent = link.title;
  title.title = link.title;

  a.append(card, title);
  return a;
}

export async function renderLinks(container, url = 'links.json') {
  let result;
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    result = validateLinks(await res.json());
  } catch (err) {
    console.warn('links.json を読み込めません', err);
    note(container, 'リンクを読み込めません');
    return;
  }
  if (result.dropped > 0) console.warn(`links.json の ${result.dropped} 件を除外しました（タイトルなし、または http/https 以外のURL）`);
  if (result.links.length === 0) {
    note(container, 'リンクがまだありません');
    return;
  }
  container.replaceChildren(...result.links.map(tile));
}
