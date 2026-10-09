// icons/icon.svg → PNG（192, 512, maskable 512）。`node shukudai/tools/make-icons.mjs`
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const svg = path.join(here, '..', 'icons', 'icon.svg');
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, pad] of [['icon-192.png', 192, 0], ['icon-512.png', 512, 0], ['icon-512-maskable.png', 512, 1]]) {
  await page.setViewportSize({ width: size, height: size });
  // maskable: 黒い地を全面に広げ、マークを 80% に収める
  const html = pad
    ? `<body style="margin:0;background:#111111;display:flex;align-items:center;justify-content:center;width:${size}px;height:${size}px"><img src="file://${svg}" style="width:${Math.round(size * 0.8)}px;height:${Math.round(size * 0.8)}px"></body>`
    : `<body style="margin:0"><img src="file://${svg}" style="display:block;width:${size}px;height:${size}px"></body>`;
  await page.setContent(html);
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(here, '..', 'icons', name), omitBackground: !pad });
  console.log('wrote', name);
}
await browser.close();
