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
  await page.clock.setFixedTime(new Date('2026-10-09T07:30:00+09:00'));
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
  const toastText = await page.textContent('.toast');
  check(toastText.includes('できた') && toastText.includes('もどす'), '完了すると 5 秒の「もどす」が出る（' + toastText.trim() + '）');
  check(await page.$('.sk-hero.is-done') !== null, '主役が打ち消し線になってから次へ（手応え）');
  await page.waitForFunction(() => (document.querySelector('.sk-hero__range') || {}).textContent?.includes('ワーク p.12'));
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
  await page.click('.sk-pill:has-text("設定")');
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
    st.settings.leaveAt = '07:50'; // いまは 07:30 固定 → 20 分前
    st.settings.schoolDays = [d.getDay()];
    localStorage.setItem('shukudai.state.v1', JSON.stringify(st));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.sk-nudge');
  check((await page.getAttribute('.sk-nudge', 'class')).includes('sk-nudge--soon'), '出発 20 分前は NudgeBar が soon');
  check((await page.getAttribute('.fab .sk-btn', 'class')).includes('sk-btn--secondary'), 'バーがピンクのあいだ「追加」は脇役');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(shots, '07-nudge.png') });
  // 10分あとで → 1 行にたたまれる → いまやる で戻る
  await page.click('.sk-nudge .sk-btn--ghost');
  await page.waitForSelector('.sk-nudge--snoozed');
  check((await page.textContent('.sk-nudge--snoozed')).includes('07:40 にもう一度言う'), '「あとで」はバーを消さず、いつ戻るかを言う');
  await page.click('.sk-nudge--snoozed .sk-btn');
  await page.waitForSelector('.sk-nudge--soon');
  await page.click('.sk-nudge .sk-btn--primary');
  await page.waitForSelector('.sk-nudge--clear');
  check(true, '「かばんに入れた」で clear になる');
  await page.screenshot({ path: path.join(shots, '08-nudge-clear.png') });

  // 捕まえる：放課後を 06:30 にして（いまは 07:30 固定 → 60 分経過 = 3 回目）、きょうを学校のある日にする
  await page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('shukudai.state.v1'));
    const d = new Date();
    st.settings.afterSchoolAt = '06:30';
    st.settings.quietFrom = '23:59';
    st.settings.schoolDays = [d.getDay()];
    st.settings.timetable = { [d.getDay()]: ['数学', '英語', '理科'] };
    st.capture = {};
    st.items = st.items.map((i) => ({ ...i, createdAt: '2020-01-01T00:00:00Z', createdOn: '2020-01-01' }));
    localStorage.setItem('shukudai.state.v1', JSON.stringify(st));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.sk-capture');
  check((await page.textContent('.sk-capture__eyebrow')).includes('3 回目'), '放課後から 60 分で 3 回目の聞き方になる');
  check((await page.textContent('.sk-capture__title')).includes('Classroom と連絡帳'), '3 回目は文言が変わる');
  const subj = await page.$$eval('.sk-capture__rows .sk-capture__row .sk-capture__name', (b) => b.map((x) => x.textContent));
  check((await page.textContent('.sk-capture__handin')).includes('出した？'), '持っていったぶんの「出した？」が出る');
  check(subj.join(',') === '数学,英語,理科', '時間割の科目だけを、科目ごとに聞く');
  await page.screenshot({ path: path.join(shots, '09-capture.png') });
  await page.click('.sk-capture__row:has-text("英語") .sk-choice--yes');
  await page.waitForSelector('.sk-quick');
  check(await page.getAttribute('.sk-quick .sk-choice:has-text("英語")', 'aria-checked') === 'true', '「出た」を押すと登録シートに科目が入っている');
  check((await page.textContent('.sk-quick')).includes('範囲はあとで'), '放課後からの登録は範囲が空でもいい');
  check((await page.textContent('.sk-quick .sk-choices[aria-label="いつまで"]')).includes('次の'), '期限の既定が「次の○○」');
  await page.click('.sk-quick .sk-btn--ghost:has-text("範囲はあとで")');
  await page.waitForSelector('.sk-quick', { state: 'detached' });
  check((await page.textContent('.sk-capture')).includes('英語（入れた）'), '登録した科目は「入れた」になり、ほかの科目はまだ聞く');
  check((await page.textContent('#app')).includes('範囲？まだ書いてない'), '範囲が空の宿題はそう出る');
  await page.click('.sk-capture__row:has-text("数学") .sk-choice:not(.sk-choice--yes)');
  await page.waitForFunction(() => document.querySelector('.sk-capture')?.textContent.includes('数学（なし）'));
  check(true, '「なし」は科目ごと');
  await page.click('.sk-capture__row:has-text("理科") .sk-choice:not(.sk-choice--yes)');
  await page.waitForSelector('.sk-capture--done');
  check((await page.textContent('.sk-capture--done')).includes('入れた'), '全部答えると小さくなる');
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.sk-capture--done');
  check(true, 'リロードしても聞き直さない');
  await page.click('.sk-capture--done .sk-choice:has-text("やっぱりあった")');
  await page.waitForSelector('.sk-capture__row');
  check(true, '「やっぱりあった」で聞き直せる');

  // 書きかけをとっておく
  await page.click('.fab .sk-btn');
  await page.waitForSelector('.sk-quick');
  await page.fill('#sk-range', 'かきかけ');
  await page.click('.sk-quick .sk-btn--ghost:has-text("あとで")');
  await page.waitForSelector('.draft');
  check((await page.textContent('.draft')).includes('かきかけ'), '「あとで」は書きかけを捨てない');
  await page.click('.draft');
  await page.waitForSelector('.sk-quick');
  check(await page.inputValue('#sk-range') === 'かきかけ', '書きかけが復元される');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.sk-quick', { state: 'detached' });

  // こんしゅう と ?board=1
  await page.click('.sk-pill:has-text("こんしゅう")');
  await page.waitForSelector('.week');
  check((await page.$$('.week__day')).length === 7, 'こんしゅうは 7 日');
  await page.screenshot({ path: path.join(shots, '10-week.png') });
  await page.keyboard.press('Escape');
  await page.goto(`http://127.0.0.1:${PORT}/?board=1`, { waitUntil: 'load' });
  await page.waitForSelector('.week--big');
  check(await page.$('.fab') === null, 'board 表示は操作ボタンなし');
  await page.screenshot({ path: path.join(shots, '11-board.png') });

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
