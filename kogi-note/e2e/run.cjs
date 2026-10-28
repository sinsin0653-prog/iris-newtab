// 画面の通しテスト：Gemini のニセモノ + wrangler dev + Playwright（スマホと PC の幅）
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { startMockGemini } = require('./mock-gemini.cjs');
const { wavBytes, pngBytes, pdfBytes } = require('./fixtures.cjs');

const ROOT = path.join(__dirname, '..');
const PERSIST = path.join(ROOT, '.wrangler/e2e');
const SHOTS = path.join(__dirname, 'screenshots');
const PORT = 8790;
const BASE = `http://localhost:${PORT}`;
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
const wrangler = path.join(ROOT, 'node_modules/.bin/wrangler');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(BASE)).ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error('wrangler dev が起動しませんでした');
}

async function flow(browser, viewport) {
  const tag = `${viewport.width}`;
  const page = await browser.newPage({ viewport });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${tag}-${name}.png`), fullPage: true });

  await page.goto(`${BASE}/`);
  await page.waitForSelector('#password');
  await page.fill('#password', 'nope');
  await page.click('button[type=submit]');
  await page.waitForSelector('text=パスワードがちがいます');
  await page.fill('#password', 'e2e-pass');
  await page.click('button[type=submit]');
  await page.waitForSelector('#new-subject');

  const subject = `心理学-${tag}`;
  await page.fill('#new-subject', subject);
  await page.click('text=＋科目を追加');
  await page.click(`a.card:has-text("${subject}")`);
  await page.waitForSelector(`h1:has-text("${subject}")`);
  const subjectUrl = page.url();
  await page.click('text=＋授業を追加');
  await page.waitForSelector('#audio');
  await page.setInputFiles('#audio', { name: 'lecture.wav', mimeType: 'audio/wav', buffer: wavBytes(2) });
  await page.setInputFiles('#note-photos', { name: 'note.png', mimeType: 'image/png', buffer: pngBytes() });
  await page.fill('#note-text', '自分のメモ');
  await page.setInputFiles('#handouts', { name: 'handout.pdf', mimeType: 'application/pdf', buffer: pdfBytes() });
  await shot('new');
  await page.click('text=アップロードする');
  await page.waitForURL(/#\/l\//, { timeout: 30000 });

  // 見回りを何度か動かして、完成まで待つ（画面は 10 秒ごとに読み直すので、ここでは再読み込みする）
  let status = '';
  for (let i = 0; i < 60 && status !== '完成'; i++) {
    await fetch(`${BASE}/__scheduled?cron=*+*+*+*+*`);
    await sleep(500);
    if (i % 4 === 3) {
      await page.reload();
      await page.waitForSelector('#status');
    }
    status = (await page.textContent('#status').catch(() => '')) ?? '';
  }
  assert(status === '完成', `完成になりませんでした（${status}）`);
  await page.click('[data-tab=summary]');
  const summary = await page.textContent('[role=tabpanel]');
  for (const s of ['テストのテーマ', '導入', 'p.1', '📝メモになし', 'テストに出る', '来週は小テスト']) assert(summary.includes(s), `要約に「${s}」がありません`);
  await shot('summary');

  await page.click('button.time:has-text("[00:10]")');
  await page.waitForSelector('.transcript p.hit');
  const hit = await page.textContent('.transcript p.hit');
  assert(hit.includes('ここが大事なポイントです。'), `印のついた行がちがいます（${hit}）`);
  assert((await page.getAttribute('[data-tab=transcript]', 'aria-selected')) === 'true', '文字起こしタブが開いていません');
  await shot('transcript');

  await page.click('[data-tab=notes]');
  assert((await page.inputValue('#edit-note')) === '自分のメモ', 'メモが残っていません');
  assert((await page.locator('.thumbs figure').count()) === 2, '写真と PDF の数がちがいます');
  await shot('notes');

  await page.goto(subjectUrl);
  await page.waitForSelector('.badge.done');
  assert((await page.textContent('.badge.done')) === '完成', '科目の画面で完成になっていません');

  await page.goto(`${BASE}/#/`);
  await page.waitForSelector('#search');
  await page.fill('#search', '大事');
  await page.press('#search', 'Enter');
  await page.waitForSelector(`a.card:has-text("${subject} 第1回")`);
  await shot('search');

  const noScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  assert(noScroll, '横にはみ出しています');
  assert(pageErrors.length === 0, `画面のエラー：${pageErrors.join(' / ')}`);
  await page.close();
  console.log(`OK ${tag}px`);
}

async function main() {
  fs.rmSync(PERSIST, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const mock = await startMockGemini();
  execFileSync(wrangler, ['d1', 'migrations', 'apply', 'kogi_note', '--local', '--persist-to', PERSIST], { cwd: ROOT, env, stdio: 'ignore' });
  const vars = ['APP_PASSWORD:e2e-pass', 'SESSION_SECRET:e2e', 'GEMINI_API_KEY:x', 'GEMINI_MODEL:mock', `GEMINI_BASE_URL:${mock.url}`, 'SEGMENT_INTERVAL_MS:0'];
  const dev = spawn(wrangler, ['dev', '--port', String(PORT), '--persist-to', PERSIST, '--test-scheduled', ...vars.flatMap((v) => ['--var', v])], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = '';
  dev.stdout.on('data', (d) => { log += d; });
  dev.stderr.on('data', (d) => { log += d; });
  let browser;
  let failed = false;
  try {
    await waitForServer();
    browser = await chromium.launch();
    for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) await flow(browser, viewport);
  } catch (err) {
    failed = true;
    console.error('FAIL', err.message);
    console.error(log.split('\n').slice(-30).join('\n'));
  } finally {
    await browser?.close();
    try {
      process.kill(-dev.pid);
    } catch {}
    await mock.close();
  }
  process.exit(failed ? 1 : 0);
}

main();
