// /setup で出すページ。ブラウザだけで「つながっているか」を確かめ、コマンド登録とテスト DM を押すだけでできるようにする。
export const SETUP_HTML = String.raw`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>宿題忘れゼロ サーバーの準備</title>
<style>
  :root { --ink: #111111; --ground: #ffffff; --soft: #f2f2f2; --pink: #ff8fc5; --pink-ink: #c81e6a; --muted: #5f5f5f; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --ink: #f5f5f5; --ground: #0f0f0f; --soft: #2a2a2a; --pink-ink: #ff8fc5; --muted: #b0b0b0; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--ground); color: var(--ink); font-family: "Hiragino Kaku Gothic ProN", "BIZ UDPGothic", system-ui, sans-serif; font-size: 16px; line-height: 1.6; }
  main { max-width: 560px; margin: 0 auto; padding: 24px 16px 64px; display: flex; flex-direction: column; gap: 20px; }
  h1 { margin: 0; font-size: 24px; line-height: 1.3; }
  h2 { margin: 0 0 8px; font-size: 18px; }
  section { border: 2px solid var(--ink); border-radius: 24px; padding: 16px 20px; }
  ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
  li { display: flex; gap: 8px; align-items: baseline; }
  .tag { flex: none; min-width: 3.5em; text-align: center; font-family: ui-monospace, monospace; font-size: 13px; font-weight: 700; border-radius: 999px; padding: 0 8px; }
  .ok { background: var(--soft); }
  .ng { background: var(--pink); color: #111111; }
  .mono { font-family: ui-monospace, monospace; font-size: 14px; overflow-wrap: anywhere; background: var(--soft); border-radius: 12px; padding: 8px 12px; }
  .note { margin: 4px 0 0; color: var(--muted); font-size: 14px; }
  label { display: block; font-weight: 700; margin-top: 12px; }
  input { width: 100%; min-height: 48px; margin-top: 4px; padding: 8px 14px; font-size: 16px; border: 2px solid var(--muted); border-radius: 12px; background: var(--soft); color: var(--ink); }
  button { min-height: 48px; padding: 0 20px; border: 2px solid var(--ink); border-radius: 999px; background: var(--ground); color: var(--ink); font-size: 16px; font-weight: 700; cursor: pointer; }
  button.primary { width: 100%; min-height: 60px; margin-top: 16px; background: var(--pink); color: #111111; }
  button:focus-visible, input:focus-visible { outline: 3px solid var(--pink-ink); outline-offset: 3px; }
  #result { margin-top: 12px; }
  #result li { align-items: flex-start; }
</style>
</head>
<body>
<main>
  <h1>宿題忘れゼロ<br>サーバーの準備</h1>

  <section aria-labelledby="h-checks">
    <h2 id="h-checks">1. 入れたものの確認</h2>
    <ul id="checks"><li>確認中…</li></ul>
    <p class="note">「まだ」があれば、Cloudflare の Worker の「Settings」→「Variables and Secrets」で入れる（KV は「Bindings」）。入れたらこのページを読み直す。</p>
  </section>

  <section aria-labelledby="h-url">
    <h2 id="h-url">2. Discord に貼る URL</h2>
    <p class="mono" id="iurl">…</p>
    <button type="button" id="copy">コピー</button>
    <p class="note">Discord Developer Portal → 自分のアプリ → General Information → 「Interactions Endpoint URL」に貼って「Save Changes」。</p>
  </section>

  <section aria-labelledby="h-go">
    <h2 id="h-go">3. コマンド登録とテスト DM</h2>
    <label for="token">合言葉（SYNC_TOKEN に入れたもの）</label>
    <input id="token" type="password" autocomplete="off">
    <label for="uid">自分の Discord ユーザー ID</label>
    <input id="uid" inputmode="numeric" autocomplete="off" placeholder="18 桁くらいの数字">
    <p class="note">Discord の設定 → 詳細設定 → 開発者モードを ON。自分のアイコンを右クリック（スマホは長押し）→「ユーザー ID をコピー」。</p>
    <button type="button" class="primary" id="go">コマンドを登録して、テスト DM を送る</button>
    <ul id="result" aria-live="polite"></ul>
  </section>

  <section aria-labelledby="h-cron">
    <h2 id="h-cron">4. 5 分おきの見回り</h2>
    <p id="cron">…</p>
    <p class="note">GitHub の見回り係が 5 分おきに起こしに来るので、何もしなくていい。Cloudflare の Worker の「Settings」→「Triggers」→「Cron Triggers」に */5 * * * * を入れると、もっと正確になる（入れなくても動く）。5 分たってこのページを読み直すと、時刻が出る。</p>
  </section>
</main>
<script>
(function () {
  function $(id) { return document.getElementById(id); }
  function row(ok, text) {
    var li = document.createElement('li');
    var t = document.createElement('span'); t.className = 'tag ' + (ok ? 'ok' : 'ng'); t.textContent = ok ? 'OK' : 'まだ';
    var s = document.createElement('span'); s.textContent = text;
    li.appendChild(t); li.appendChild(s); return li;
  }
  var labels = [['DISCORD_TOKEN', 'Bot のトークン（DISCORD_TOKEN）'], ['DISCORD_PUBLIC_KEY', 'Public Key（DISCORD_PUBLIC_KEY）'], ['DISCORD_APP_ID', 'Application ID（DISCORD_APP_ID）'], ['SYNC_TOKEN', '合言葉（SYNC_TOKEN）'], ['KV', '保存場所（KV の名前 SHUKUDAI）']];
  fetch('/api/health').then(function (r) { return r.json(); }).then(function (h) {
    var ul = $('checks'); ul.textContent = '';
    labels.forEach(function (l) { ul.appendChild(row(!!h.checks[l[0]], l[1])); });
    ul.appendChild(row(!!h.userIdSaved, '自分の Discord ユーザー ID（下の 3 で入る）'));
    $('iurl').textContent = h.interactionsUrl;
    $('cron').textContent = h.lastRunAt ? '最後に見回った：' + new Date(h.lastRunAt).toLocaleString('ja-JP') + (h.lastRunVia === 'tick' ? '（GitHub の見回り係）' : h.lastRunVia === 'cron' ? '（Cloudflare の Cron）' : '') : 'まだ一度も見回っていない。';
  }).catch(function () { $('checks').textContent = '確認できなかった。Worker のコードが貼れているか見て。'; });
  $('copy').addEventListener('click', function () {
    var text = $('iurl').textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { $('copy').textContent = 'コピーした'; });
  });
  $('go').addEventListener('click', function () {
    var res = $('result'); res.textContent = '';
    res.appendChild(row(true, '送っている…'));
    fetch('/api/setup', { method: 'POST', headers: { 'Authorization': 'Bearer ' + $('token').value.trim(), 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: $('uid').value.trim() }) })
      .then(function (r) { return r.json(); })
      .then(function (o) {
        res.textContent = '';
        if (o.error) { res.appendChild(row(false, o.error)); return; }
        if (o.saved) res.appendChild(row(true, 'ユーザー ID を覚えた'));
        if (o.registered) res.appendChild(row(true, 'コマンドを登録した：' + o.registered.join(' ')));
        if (o.dm) res.appendChild(row(true, 'テスト DM を送った。Discord を見て！'));
        (o.errors || []).forEach(function (e) { res.appendChild(row(false, e)); });
      })
      .catch(function () { res.textContent = ''; res.appendChild(row(false, '送れなかった。ネットか URL を見て。')); });
  });
})();
</script>
</body>
</html>`;
