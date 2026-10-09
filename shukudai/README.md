# 宿題忘れゼロ（アプリ）

メモらなくても、忘れない。当日の朝でも、持っていける。ADHD で脳が疲れている日の自分を基準に作った宿題管理 PWA。

- **そもそも登録し忘れない。** 放課後になるとアプリと Discord が「きょう、宿題出た？」と科目ボタン付きで聞きに来る。答える（科目を押して登録するか「なし」）まで 30 分おきに 3 回。時間割を入れておくと、その日の科目だけ聞く。
- 入力は 4 つだけ（科目・範囲・どこにある・いつまで）。10 秒で登録。ホーム画面のアイコン長押し「宿題を追加」で登録シートが直接開く。
- ホームは「いま、いちばん近い宿題」1 件だけを大きく。
- 出発時刻の 60 分前から、カウントダウンのバーが白 → ピンク → 黒と強くなる。止める方法は「かばんに入れた」を押すことだけ。
- Discord でも同じはしごで催促（`../worker/` を動かしたとき）。
- 端末の中に保存。ネットがなくても開けるし、登録できる。

デザインの決まりごとは [デザインシステム](https://claude.ai/artifact/J6saSAc81gNTekmuwEUrTX)（README と「画面の流れ」）にある。`ds/` はそこから持ってきた部品で、`bundle.js` と `bundle.css` はそのまま、`tokens.css` は `tokens.json` から `node shukudai/tools/build-tokens.mjs` で作る。

## 動かす

静的ファイルだけなので、どこに置いても動く。

- **手元で**：`npx http-server shukudai -p 8080` → http://localhost:8080/
- **GitHub Pages**：リポジトリの Settings → Pages → Branch をこのブランチの `/ (root)` にすると `https://<user>.github.io/iris-newtab/shukudai/` で開ける。スマホの Safari / Chrome で「ホーム画面に追加」するとアプリとして入る。

## Discord で焦らせるには

1. `../worker/README.md` の手順でサーバーを立てる（Cloudflare Workers、無料枠で足りる）。
2. アプリの設定（右上の時計ボタン）で：
   - **出る時間**（焦らせる軸）と**起きる時間**、**放課後の時刻**（聞きに行く軸）、学校がある日と時間割
   - **Discord ユーザー ID**（Discord の設定 → 詳細設定 → 開発者モード ON → 自分の名前を右クリック →「ユーザー ID をコピー」）
   - **サーバーの URL** と **合言葉**（`SYNC_TOKEN`）
3. 「Discord にテスト送信」を押して、DM が届けば完成。

## ファイル

| パス | なに |
| --- | --- |
| `index.html` `app.js` `app.css` | 画面。部品は `window.Shukudai`（`ds/bundle.js`） |
| `sync.js` | サーバーとの同期（端末が正。失敗しても消さない） |
| `sw.js` `manifest.webmanifest` `icons/` | オフラインとホーム画面への追加 |
| `ds/` | デザインシステムの部品・色・文字 |
| `tools/build-tokens.mjs` | `tokens.json` → `tokens.css` |
| `tools/make-icons.mjs` | `icons/icon.svg` → PNG |
| `tools/e2e.mjs` | ブラウザで一通り触るテスト（`node shukudai/tools/e2e.mjs`） |

## データ

`localStorage` の `shukudai.state.v1` に 1 つの JSON。形は デザインシステムの「画面の流れ → データの形」のとおり。消すときは `deleted: true` の墓標を残す（同期で蘇らないように）。
