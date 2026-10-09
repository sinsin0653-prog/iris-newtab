// アプリを本物のブラウザで動かして確かめる。`node shukudai/tools/e2e.mjs`（http-server と Playwright が要る）
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node-tools/node_modules/playwright/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, '..');
const PORT = 8797;
const server = spawn('http-server', [appDir, '-p', String(PORT), '-s', '-c-1'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const shots = path.join(here, 'shots');
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failed++; };

try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.waitForSelector('.brand__name');
  await page.evaluate(() => document.fonts.ready);
  check(await page.textContent('.brand__name') === '宿題忘れゼロ', 'ヘッダーに名前が出る');
  check(await page.$('.sk-alldone') !== null, '空のときは AllDone が出る');
  await page.screenshot({ path: path.join(shots, '01-empty.png') });

  // 追加
  await page.click('.fab .sk-btn--primary');
  await page.waitForSelector('.sk-quick');
  await page.click('.sk-quick .sk-choice:has-text("数学")');
  await page.fill('#sk-range', 'p.24〜27 の奇数番号');
  await page.click('.sk-quick .sk-choice:has-text("教科書")');
  await page.click('.sk-quick .sk-choice:has-text("きょう")').catch(() => {});
  await page.click('.sk-quick .sk-choice:has-text("あした")');
  await page.screenshot({ path: path.join(shots, '02-quickadd.png') });
  await page.click('.sk-quick button[type="submit"]');
  await page.waitForSelector('.sk-hero');
  check((await page.textContent('.sk-hero__range')).includes('p.24〜27'), 'TodayHero に登録した宿題が出る');
  check((await page.textContent('.sk-hero .sk-chip')).includes('あした'), '期限チップが「あした」');

  // 2 件目：場所なし → 「どこにある？」が出る
  await page.click('.fab .sk-btn--primary');
  await page.waitForSelector('.sk-quick');
  await page.click('.sk-quick .sk-choice:has-text("英語")');
  await page.fill('#sk-range', 'ワーク p.12');
  await page.click('.sk-quick .sk-choice:has-text("日付をえらぶ")');
  const far = new Date(Date.now() + 5 * 86400000);
  await page.fill('.sk-quick input[type="date"]', far.toISOString().slice(0, 10));
  await page.click('.sk-quick button[type="submit"]');
  await page.waitForSelector('.sk-card');
  check((await page.textContent('.sk-card .sk-card__where')).includes('どこにある？'), '場所が空だとカードに「どこにある？」が出る');
  await page.screenshot({ path: path.join(shots, '03-home.png') });

  // 範囲が空だと止まる
  await page.click('.fab .sk-btn--primary');
  await page.waitForSelector('.sk-quick');
  await page.click('.sk-quick button[type="submit"]');
  check((await page.textContent('.sk-hint')).includes('範囲だけは書いて'), '範囲が空だと「範囲だけは書いて！」');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.sk-quick', { state: 'detached' });

  // 完了 → もどす
  await page.click('.sk-hero .sk-btn--primary');
  await page.waitForSelector('.toast');
  check((await page.textContent('.toast')).includes('できた'), '完了すると 5 秒の「もどす」が出る');
  check((await page.textContent('.sk-hero__range')).includes('ワーク p.12'), '次の宿題が主役になる');
  await page.click('.toast .sk-btn');
  await page.waitForSelector('.toast', { state: 'detached' });
  check((await page.textContent('.sk-hero__range')).includes('p.24〜27'), 'もどすと主役が戻る');

  // カードのチェックで完了 → できた一覧へ
  await page.click('.sk-card .sk-card__check');
  await page.waitForSelector('.sk-card.is-done');
  check((await page.textContent('.section-label:last-of-type')) !== null, 'できた一覧が出る');

  // 編集：場所を足す
  await page.click('.sk-card:not(.is-done) .sk-card__body, .sk-card.is-done .sk-card__body');
  await page.waitForSelector('.panel');
  await page.fill('.panel input[name="where"]', 'ロッカー');
  await page.click('.panel button[type="submit"]');
  await page.waitForSelector('.panel', { state: 'detached' });
  check((await page.textContent('#app')).includes('ロッカー'), '編集した場所が反映される');

  // 設定：出る時間を変える
  await page.click('button[aria-label="設定"]');
  await page.waitForSelector('.panel');
  await page.fill('.panel input[type="time"]', '08:10');
  await page.screenshot({ path: path.join(shots, '04-settings.png') });
  await page.click('.panel button[type="submit"]');
  await page.waitForSelector('.panel', { state: 'detached' });
  check((await page.textContent('.brand__date')).includes('08:10'), '出る時間の設定がヘッダーに出る');

  // リロードしても残る
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.sk-hero');
  check((await page.textContent('#app')).includes('p.24〜27'), 'リロード後もデータが残る');

  // あさのチェック
  await page.click('button[aria-label="あさのチェック"]');
  await page.waitForSelector('.sk-bring');
  check((await page.textContent('.sk-bring__title')) === 'あさのチェック', 'あさのチェックが開く');
  await page.screenshot({ path: path.join(shots, '05-bring.png') });
  await page.keyboard.press('Escape');

  // ダーク
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(shots, '06-home-dark.png') });
  check(await page.getAttribute('html', 'data-theme') === 'dark', 'ダークモードに追従する');

  // NudgeBar：きょう期限 + 出発 20 分前の状態を作って確認
  await page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('shukudai.state.v1'));
    const d = new Date(); const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    st.items.push({ id: 'e2e', subject: '社会', range: 'プリント 1 枚', where: 'プリント', due: iso, done: false, packed: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const soon = new Date(Date.now() + 20 * 60000);
    st.settings.leaveAt = `${String(soon.getHours()).padStart(2, '0')}:${String(soon.getMinutes()).padStart(2, '0')}`;
    localStorage.setItem('shukudai.state.v1', JSON.stringify(st));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.sk-nudge');
  check((await page.getAttribute('.sk-nudge', 'class')).includes('sk-nudge--soon'), '出発 20 分前は NudgeBar が soon');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(shots, '07-nudge.png') });
  await page.click('.sk-nudge .sk-btn--primary');
  await page.waitForSelector('.sk-nudge--clear');
  check(true, '「かばんに入れた」で clear になる');
  await page.screenshot({ path: path.join(shots, '08-nudge-clear.png') });

  // 捕まえる：放課後の時刻を 1 時間前にして、きょうを学校のある日にする
  await page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('shukudai.state.v1'));
    const d = new Date();
    st.settings.afterSchoolAt = '00:00'; // 何時に走っても「放課後のあと」になるように
    st.settings.quietFrom = '23:59';
    st.settings.schoolDays = [d.getDay()];
    st.settings.timetable = { [d.getDay()]: ['数学', '英語', '理科'] };
    st.capture = {};
    st.items = st.items.map((i) => ({ ...i, createdAt: '2020-01-01T00:00:00Z' }));
    localStorage.setItem('shukudai.state.v1', JSON.stringify(st));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.sk-capture');
  const expectAsked = await page.evaluate(() => Math.min(3, Math.floor((new Date().getHours() * 60 + new Date().getMinutes()) / 30) + 1));
  const eyebrow = await page.textContent('.sk-capture__eyebrow');
  check(eyebrow.includes('放課後のチェック') && (expectAsked === 1 ? !eyebrow.includes('回目') : eyebrow.includes(expectAsked + ' 回目')), '経過時間に応じた回数で聞く（' + expectAsked + ' 回目）');
  const subj = await page.$$eval('.sk-capture .sk-choice', (b) => b.map((x) => x.textContent));
  check(subj.join(',') === '数学,英語,理科', '時間割の科目だけを聞く');
  await page.screenshot({ path: path.join(shots, '09-capture.png') });
  await page.click('.sk-capture .sk-choice:has-text("英語")');
  await page.waitForSelector('.sk-quick');
  check(await page.getAttribute('.sk-quick .sk-choice:has-text("英語")', 'aria-checked') === 'true', '科目を押すと登録シートに科目が入っている');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.sk-quick', { state: 'detached' });
  await page.click('.sk-capture .sk-btn--secondary');
  await page.waitForSelector('.sk-capture--done');
  check((await page.textContent('.sk-capture--done')).includes('なし'), '「なし」で答えた扱いになる');
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.sk-capture--done');
  check(true, 'リロードしても聞き直さない');

  // ?add=1 で登録シートが開く（ホーム画面のショートカット用）
  await page.goto(`http://127.0.0.1:${PORT}/?add=1`, { waitUntil: 'load' });
  await page.waitForSelector('.sk-quick');
  check(true, '?add=1 で登録シートが開く');
  await page.keyboard.press('Escape');

  check(errors.length === 0, 'コンソールエラーなし' + (errors.length ? ' → ' + errors.join(' | ') : ''));
} catch (e) {
  failed++;
  console.log('FAIL exception:', e.message.split('\n')[0]);
  if (errors.length) console.log('errors:', errors.join(' | '));
} finally {
  await browser.close();
  server.kill();
}
console.log(failed ? `\n${failed} 件だめ` : '\nぜんぶ OK');
process.exit(failed ? 1 : 0);
