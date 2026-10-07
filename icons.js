// イラスト風アイコン（黒い線＋平らな色）。DOM API だけで組み立てる（innerHTML は使わない）

const SVG_NS = 'http://www.w3.org/2000/svg';
const INK = '#2F2B28';
const S = { stroke: INK, 'stroke-width': '3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };

const CLOUD = 'M14 34 H34 A8 8 0 0 0 34 18 A11 11 0 0 0 13 21 A7 7 0 0 0 14 34 Z';
const cloud = ['path', { d: CLOUD, fill: '#FFFFFF', ...S, 'stroke-width': '2.5' }];

export const ICONS = {
  // ショートカット（viewBox 80）
  search: { box: 80, parts: [
    ['circle', { cx: 34, cy: 34, r: 18, fill: '#FFF1B8', ...S }],
    ['path', { d: 'M26 28 Q29 22 36 22', fill: 'none', ...S, 'stroke-width': '2.5' }],
    ['path', { d: 'M47 47 L64 64', ...S, 'stroke-width': '7' }],
  ] },
  video: { box: 80, parts: [
    ['rect', { x: 12, y: 20, width: 56, height: 40, rx: 13, fill: '#EE7468', ...S }],
    ['path', { d: 'M34 30 L51 40 L34 50 Z', fill: '#FFFFFF', ...S, 'stroke-width': '2.5' }],
  ] },
  mail: { box: 80, parts: [
    ['rect', { x: 12, y: 22, width: 56, height: 38, rx: 7, fill: '#FDE3DF', ...S }],
    ['path', { d: 'M15 26 L40 45 L65 26', fill: 'none', ...S }],
    ['path', { d: 'M57 12 C57 8 63 8 63 12 C63 8 69 8 69 12 C69 16 63 19 63 19 C63 19 57 16 57 12 Z', fill: '#EE7468', ...S, 'stroke-width': '2' }],
  ] },
  calendar: { box: 80, parts: [
    ['rect', { x: 14, y: 18, width: 52, height: 46, rx: 9, fill: '#FFFFFF', ...S }],
    ['path', { d: 'M14 27 A9 9 0 0 1 23 18 H57 A9 9 0 0 1 66 27 V33 H14 Z', fill: '#7FB3E6', ...S }],
    ['path', { d: 'M28 12 V22 M52 12 V22', ...S }],
    ['circle', { cx: 28, cy: 43, r: 3, fill: INK }],
    ['circle', { cx: 40, cy: 43, r: 3, fill: INK }],
    ['circle', { cx: 52, cy: 43, r: 3, fill: '#EE7468' }],
    ['circle', { cx: 28, cy: 54, r: 3, fill: INK }],
    ['circle', { cx: 40, cy: 54, r: 3, fill: INK }],
  ] },
  folder: { box: 80, parts: [
    ['path', { d: 'M12 26 A6 6 0 0 1 18 20 H33 L39 26 H62 A6 6 0 0 1 68 32 V56 A6 6 0 0 1 62 62 H18 A6 6 0 0 1 12 56 Z', fill: '#FBD763', ...S }],
    ['path', { d: 'M12 34 H68', ...S }],
  ] },
  map: { box: 80, parts: [
    ['ellipse', { cx: 40, cy: 66, rx: 16, ry: 4, fill: '#EFE4D2' }],
    ['path', { d: 'M40 64 C40 64 20 44 20 32 A20 20 0 0 1 60 32 C60 44 40 64 40 64 Z', fill: '#7CC36E', ...S }],
    ['circle', { cx: 40, cy: 32, r: 7, fill: '#FFFFFF', ...S }],
  ] },
  link: { box: 80, parts: [
    ['circle', { cx: 40, cy: 40, r: 24, fill: '#DDF0EA', ...S }],
    ['path', { d: 'M16 40 H64 M40 16 C30 26 30 54 40 64 M40 16 C50 26 50 54 40 64', fill: 'none', ...S, 'stroke-width': '2.5' }],
  ] },

  // 天気（viewBox 48）
  sun: { box: 48, parts: [
    ['circle', { cx: 24, cy: 24, r: 10, fill: '#FBD763', ...S, 'stroke-width': '2.5' }],
    ['path', { d: 'M24 5 V9 M24 39 V43 M5 24 H9 M39 24 H43 M10.6 10.6 L13.4 13.4 M34.6 34.6 L37.4 37.4 M10.6 37.4 L13.4 34.6 M34.6 13.4 L37.4 10.6', ...S, 'stroke-width': '2.5' }],
  ] },
  partly: { box: 48, parts: [
    ['circle', { cx: 17, cy: 16, r: 8, fill: '#FBD763', ...S, 'stroke-width': '2.5' }],
    ['path', { d: 'M17 3 V5 M4 16 H6 M7.8 6.8 L9.2 8.2 M26.2 6.8 L24.8 8.2', ...S, 'stroke-width': '2.5' }],
    ['path', { d: 'M18 38 H36 A7 7 0 0 0 36 24 A10 10 0 0 0 17 26 A6 6 0 0 0 18 38 Z', fill: '#FFFFFF', ...S, 'stroke-width': '2.5' }],
  ] },
  cloud: { box: 48, parts: [cloud] },
  rain: { box: 48, parts: [
    cloud,
    ['path', { d: 'M18 38 L16 43 M25 38 L23 43 M32 38 L30 43', ...S, stroke: '#3E88D0' }],
  ] },
  snow: { box: 48, parts: [
    cloud,
    ['circle', { cx: 18, cy: 40, r: 2.2, fill: '#7FB3E6', stroke: INK, 'stroke-width': '1.5' }],
    ['circle', { cx: 25, cy: 43, r: 2.2, fill: '#7FB3E6', stroke: INK, 'stroke-width': '1.5' }],
    ['circle', { cx: 32, cy: 40, r: 2.2, fill: '#7FB3E6', stroke: INK, 'stroke-width': '1.5' }],
  ] },
  thunder: { box: 48, parts: [
    cloud,
    ['path', { d: 'M25 30 L20 39 H25 L22 46 L31 36 H26 L29 30 Z', fill: '#FBD763', ...S, 'stroke-width': '2' }],
  ] },
  fog: { box: 48, parts: [
    ['path', { d: 'M10 18 H38 M6 26 H34 M14 34 H42', ...S }],
  ] },
};

export function makeIcon(name, className = 'icon') {
  const def = ICONS[name] || ICONS.link;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${def.box} ${def.box}`);
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const [tag, attrs] of def.parts) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.appendChild(el);
  }
  return svg;
}
