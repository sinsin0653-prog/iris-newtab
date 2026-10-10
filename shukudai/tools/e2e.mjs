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

  // 履修科目（架空の時間割）：リンクで取り込む → 授業の直後に聞く → 次の授業が期限・教室が出すところ
  const uni = { courses: [
    { name: '統計学 I', short: '統計学', day: 1, period: 1, room: 'A-101' },
    { name: 'フランス語(a)', short: 'フランス語(a)', day: 1, period: 2, room: 'B-201' },
    { name: '英語演習 II', short: '英語演習', day: 2, period: 4, room: 'C-301' },
    { name: '英語演習 II', short: '英語演習', day: 4, period: 2, room: 'C-302' },
    { name: 'ゼミ', short: 'ゼミ', day: 5, period: 5, room: 'D-401' },
    { name: '集中講義 A', short: '集中講義', day: null, period: null }
  ], commuteMinutes: 60 };
  await page.clock.setFixedTime(new Date('2026-10-12T10:36:00+09:00')); // 月曜、1限が終わって 6 分
  await page.goto(`http://127.0.0.1:${PORT}/#import=` + Buffer.from(JSON.stringify(uni), 'utf8').toString('base64url'), { waitUntil: 'load' });
  await page.waitForSelector('.panel__title:has-text("時間割を入れる？")');
  check((await page.textContent('.courses')).includes('1限 統計学 A-101'), '取り込む前に中身を見せる');
  await page.click('.panel .sk-btn--primary');
  await page.waitForSelector('.panel', { state: 'detached' });
  check(!(await page.evaluate(() => location.hash)), '取り込んだらリンクの中身を URL から消す');
  check((await page.textContent('.brand__date')).includes('出る 08:00'), '月曜の出る時間は 1限 − 通学 60 分');
  check((await page.textContent('.brand__next')).includes('つぎ 2限 フランス語(a) B-201（10:40〜）'), 'つぎの授業と教室が出る');
  check(await page.$('.sk-nudge') === null, '授業が始まったあとは「出る時間すぎた」を出さない');
  await page.waitForSelector('.sk-capture');
  check((await page.textContent('.sk-capture__eyebrow')) === '授業のあと', '授業が終わったら、その場で聞く');
  check((await page.textContent('.sk-capture__title')).includes('統計学、おわった。課題出た？'), '終わった授業の名前で聞く');
  const askNow = await page.$$eval('.sk-capture__rows .sk-capture__name', (b) => b.map((x) => x.textContent));
  check(askNow.join(',') === '統計学', 'まだ終わっていない授業は聞かない');
  await page.screenshot({ path: path.join(shots, '12-courses-home.png') });
  await page.click('.sk-capture__row:has-text("統計学") .sk-choice--yes');
  await page.waitForSelector('.sk-quick');
  const dueChips = await page.$$eval('.sk-quick .sk-choices[aria-label="いつまで"] .sk-choice', (b) => b.map((x) => x.textContent));
  check(dueChips[0] === '次の統計学（10/19 月）', '期限の既定は次の授業（' + dueChips[0] + '）');
  const subjChips = await page.$$eval('.sk-quick .sk-choices[aria-label="科目"] .sk-choice', (b) => b.filter((x) => x.getBoundingClientRect().width > 0).map((x) => x.textContent));
  check(subjChips.join(',') === '統計学,フランス語(a)', 'きょうの授業が先頭（' + subjChips.join(',') + '）');
  check((await page.textContent('.sk-more')).includes('ほかの授業'), 'ほかの授業は畳んである');
  await page.click('.sk-more');
  const allChips = await page.$$eval('.sk-quick .sk-choices[aria-label="科目"] .sk-choice', (b) => b.filter((x) => x.getBoundingClientRect().width > 0).map((x) => x.textContent));
  check(allChips.includes('英語演習') && allChips.includes('集中講義') && await page.$('.sk-more') === null, '「ほかの授業」を押すと全部出る');
  check((await page.textContent('.sk-quick')).includes('LMS'), '大学向けの「どこにある」');
  await page.fill('#sk-range', '演習問題 3-1〜3-5');
  await page.click('.sk-quick button[type="submit"]');
  await page.waitForSelector('.sk-quick', { state: 'detached' });
  const added = await page.evaluate(() => JSON.parse(localStorage.getItem('shukudai.state.v1')).items.find((i) => i.range === '演習問題 3-1〜3-5'));
  check(added && added.due === '2026-10-19' && added.submitTo === '10/19（月） 1限 A-101', '出すところが授業の教室になる（' + (added && added.submitTo) + '）');
  check(await page.$('.sk-capture__rows') === null, '答えたら科目の問いは引っこむ（次の授業のあとにまた出る。持っていったぶんの「出した？」は残る）');
  await page.click('.sk-pill:has-text("設定")');
  await page.waitForSelector('.courses__leave');
  const leaveLine = await page.textContent('.courses__leave');
  check(leaveLine.includes('月 08:00') && leaveLine.includes('金 15:20') && !leaveLine.includes('水'), '曜日ごとの出る時間（' + leaveLine + '）');
  check(await page.$('input[aria-label="月曜の時間割"]') === null, '手で入れる時間割は隠す');
  await page.screenshot({ path: path.join(shots, '13-courses-settings.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await page.click('.sk-pill:has-text("こんしゅう")');
  await page.waitForSelector('.week__classes');
  check((await page.textContent('.week__day.is-today .week__classes')).includes('1限 統計学 A-101'), 'こんしゅうに授業も出る');
  await page.keyboard.press('Escape');
  // 金曜（5限だけ）の朝 7:30：期限が金曜でも、まだ焦らせない
  await page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('shukudai.state.v1'));
    st.items.push({ id: 'fri', subject: 'ゼミ', range: 'レジュメ', where: 'プリント', due: '2026-10-16', done: false, packed: false, createdAt: '2026-10-09T01:00:00Z', createdOn: '2026-10-09', updatedAt: '2026-10-09T01:00:00Z' });
    localStorage.setItem('shukudai.state.v1', JSON.stringify(st));
  });
  await page.clock.setFixedTime(new Date('2026-10-16T07:30:00+09:00'));
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.brand__date');
  check((await page.textContent('.brand__date')).includes('出る 15:20'), '金曜は 15:20 に出る');
  check(await page.$('.sk-nudge') === null, '金曜の朝 7:30 はバーを出さない');
  await page.clock.setFixedTime(new Date('2026-10-16T14:50:00+09:00'));
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.sk-nudge');
  check((await page.textContent('.sk-nudge__count')).includes('あと30分'), '金曜は 14:50 に「あと30分」');

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
