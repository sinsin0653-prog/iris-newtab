// src/ のファイルを 1 つにまとめて dist/worker.js を作る。
// Cloudflare のダッシュボード（ブラウザ）の「コードを編集」に、そのまま貼り付けられる形。
//   node scripts/build-single.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src');
const ORDER = ['core.js', 'state.js', 'setup-page.js', 'app-assets.js', 'scheduler.js', 'discord.js', 'index.js'];

const seen = new Map();
let body = '';
for (const file of ORDER) {
  let code = fs.readFileSync(path.join(src, file), 'utf8');
  // ほかのファイルからの import は消す（同じファイルの中にまとめるので要らない）
  code = code.replace(/^import \{[^}]*\} from '\.\/[a-z-]+\.js';\n/gm, '');
  if (/^import /m.test(code)) throw new Error(`${file}: まとめられない import が残っている`);
  // export を外す（export default だけ残す）
  code = code.replace(/^export (?=(async function|function|const|let|class) )/gm, '');
  // いちばん外の名前がぶつかっていないか
  for (const m of code.matchAll(/^(?:async function|function|const|let|class) ([A-Za-z_$][\w$]*)/gm)) {
    if (seen.has(m[1])) throw new Error(`名前がぶつかる：${m[1]}（${seen.get(m[1])} と ${file}）`);
    seen.set(m[1], file);
  }
  body += `\n// ===== ${file} =====\n` + code;
}
if ((body.match(/^export default /gm) || []).length !== 1) throw new Error('export default がちょうど 1 つでない');

const header = `// 宿題忘れゼロ — Cloudflare Worker（1 ファイル版）
// このファイルは worker/scripts/build-single.mjs が src/ から作る。直すときは src/ を直して作り直す。
//
// 使い方（ブラウザだけ）：Cloudflare → Workers & Pages → 自分の Worker →「コードを編集」→
// 中身を全部消して、このファイルの中身を全部貼る →「デプロイ」。
// 要るもの：KV のバインディング SHUKUDAI、シークレット DISCORD_TOKEN / DISCORD_PUBLIC_KEY / DISCORD_APP_ID / SYNC_TOKEN、
// Cron トリガー */5 * * * *（なければ GitHub Actions が /api/tick を 5 分おきに叩く）。
// 準備ができたか、つながったかは https://<Worker の URL>/setup で見る。アプリは https://<Worker の URL>/app/
`;
fs.mkdirSync(path.join(here, '..', 'dist'), { recursive: true });
fs.writeFileSync(path.join(here, '..', 'dist', 'worker.js'), header + body);
console.log(`dist/worker.js: ${(header + body).length} 文字、名前 ${seen.size} 個`);
