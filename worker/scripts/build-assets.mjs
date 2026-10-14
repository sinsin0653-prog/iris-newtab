// アプリ本体（../shukudai/）を、Worker から配れる形 src/app-assets.js にまとめる。
// これで Worker の URL の /app/ がそのままアプリになる（GitHub Pages などを別に用意しなくていい）。
//   node scripts/build-assets.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.join(here, '..', '..', 'shukudai');
const FILES = [
  'index.html', 'app.js', 'app.css', 'sync.js', 'sw.js', 'manifest.webmanifest',
  'ds/tokens.css', 'ds/bundle.css', 'ds/bundle.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-512-maskable.png'
];
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png'
};

const assets = {};
for (const file of FILES) {
  let buf = fs.readFileSync(path.join(app, file));
  const ext = path.extname(file);
  if (file === 'index.html') {
    // 「サーバーは自分と同じ場所」の印。アプリはこれを見て、サーバーの URL を自分で埋める
    const html = buf.toString('utf8');
    if (!html.includes('<meta charset="utf-8">')) throw new Error('index.html に <meta charset="utf-8"> がない');
    buf = Buffer.from(html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="shukudai-server" content="same-origin">'), 'utf8');
  }
  const binary = ext === '.png';
  assets['/app/' + file] = {
    type: TYPES[ext],
    etag: '"' + crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16) + '"',
    ...(binary ? { b64: buf.toString('base64') } : { body: buf.toString('utf8') })
  };
  if (!TYPES[ext]) throw new Error(`${file}: 種類がわからない`);
}
assets['/app/'] = assets['/app/index.html'];

const out = `// このファイルは scripts/build-assets.mjs が ../shukudai/ から作る。手で直さない。
export const APP_ASSETS = ${JSON.stringify(assets, null, 0)};
`;
fs.writeFileSync(path.join(here, '..', 'src', 'app-assets.js'), out);
console.log(`src/app-assets.js: ${FILES.length} ファイル、${out.length} 文字`);
