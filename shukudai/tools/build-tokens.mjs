// tokens.json → tokens.css（デザインシステムのページが作るものと同じ形）。`node shukudai/tools/build-tokens.mjs`
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dsDir = path.join(here, '..', 'ds');
const tokens = JSON.parse(fs.readFileSync(path.join(dsDir, 'tokens.json'), 'utf8'));
const themes = tokens.color.themes.map((t) => t.id);
const val = (t, th) => (typeof t.value === 'string' ? t.value : (t.value[th] ?? t.value[themes[0]]));
const css = (v) => (/^\{.+\}$/.test(v) ? `var(--${v.slice(1, -1)})` : v);

let out = `/* ${tokens.name} — generated from tokens.json */\n`;
themes.forEach((th, i) => {
  out += (i === 0 ? `:root, [data-theme="${th}"]` : `[data-theme="${th}"]`) + ' {\n';
  for (const t of tokens.color.tokens) out += `  --${t.name}: ${css(val(t, th))};\n`;
  for (const t of tokens.shadow?.tokens ?? []) out += `  --${t.name}: ${css(val(t, th))};\n`;
  out += '}\n';
});
out += ':root {\n';
for (const fam of Object.keys(tokens)) {
  if (['name', 'version', 'meta', 'color', 'type', 'shadow'].includes(fam)) continue;
  for (const t of tokens[fam]?.tokens ?? []) out += `  --${t.name}: ${t.value};\n`;
}
for (const [k, v] of Object.entries(tokens.type.families)) out += `  --font-${k}: ${v};\n`;
out += '}\n';
for (const g of tokens.type.groups) {
  for (const s of g.styles) {
    out += `.${s.name} { font-family: var(--font-${s.family ?? g.family}); font-size: ${s.fontSize}; line-height: ${s.lineHeight}; font-weight: ${s.fontWeight};${s.letterSpacing ? ` letter-spacing: ${s.letterSpacing};` : ''} }\n`;
  }
}
fs.writeFileSync(path.join(dsDir, 'tokens.css'), out);
console.log(`tokens.css: ${out.split('\n').length} lines`);
