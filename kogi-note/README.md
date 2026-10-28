# 講義ノート（kogi-note）

講義の録音・メモ・レジュメを入れると、**全文の文字起こし**と**要約**を作ってくれる、自分専用の Web アプリです。
スマホでもPCでも開けます。お金はかかりません（Cloudflare と Gemini の無料枠で動きます）。

- 設計書：[`docs/superpowers/specs/2026-10-28-kogi-note-design.md`](docs/superpowers/specs/2026-10-28-kogi-note-design.md)
- 作業計画：[`docs/superpowers/plans/2026-10-28-kogi-note.md`](docs/superpowers/plans/2026-10-28-kogi-note.md)

> 🙏 授業を録音するときは、先生に一言 OK をもらっておくと安心です。大学によってはルールがあります。

---

## セットアップ（はじめの 1 回だけ）

### 1. Gemini の API キーを作る

1. **個人の** Google アカウントで [Google AI Studio](https://aistudio.google.com/) を開きます（大学のアカウントだと API が使えないことがあります）。
2. 「Get API key」から API キーを作り、どこかに控えます。
3. モデルの一覧で、**無料枠のある Flash 系のモデル**の名前（例：`gemini-…-flash`）を控えます。

> ⚠️ 無料枠で送ったデータ（音声・メモの写真・レジュメ）は、Google のサービス改善に使われることがあります（人が読むこともあります）。
> このアプリは、使い終わったファイルを Gemini からすぐ消します。

### 2. Cloudflare でデータの置き場を作る

[Cloudflare のダッシュボード](https://dash.cloudflare.com/)で：

1. **Storage & Databases → D1** で、データベース `kogi_note` を作ります。表示された **Database ID** を控えます。
2. **Storage & Databases → KV** で、ネームスペース `kogi_note_files` を作ります。表示された **ID** を控えます。
3. `kogi-note/wrangler.jsonc` の仮の ID を書き換えて、GitHub に push します。
   - `"database_id": "00000000-…"` → 1 の Database ID
   - `"id": "0000…"`（`kv_namespaces` の中）→ 2 の ID

R2 は使わないので、カードや PayPal の登録はいりません。

### 3. GitHub とつないで、自動で反映されるようにする

1. **Workers & Pages → Create → Import a repository** で `iris-newtab` を選びます。
2. 設定：
   - **Root directory（ルートフォルダ）**：`kogi-note`
   - **Deploy command（反映のコマンド）**：`npx wrangler d1 migrations apply kogi_note --remote && npx wrangler deploy`
   - **Production branch（ブランチ）**：`main`
3. これで、`main` に push するたびに自動で反映されます。

### 4. 秘密の設定を入れる

作った Worker（`kogi-note`）の **Settings → Variables and Secrets** で：

| 名前 | 種類 | 入れるもの |
|---|---|---|
| `APP_PASSWORD` | Secret | アプリに入るためのパスワード（長めに） |
| `SESSION_SECRET` | Secret | ランダムな長い文字列（例：パスワード生成ツールで 40 文字くらい） |
| `GEMINI_API_KEY` | Secret | 1 で作った API キー |
| `GEMINI_MODEL` | Text | 1 で控えたモデル名 |

> `SESSION_SECRET` か `APP_PASSWORD` を変えると、ログインし直しになります。

### 5. 短い音声で試す

1. Worker の URL（`https://kogi-note.<あなたの名前>.workers.dev`）を開いて、パスワードでログインします。
2. 科目を作り、**5 分くらいの音声**とメモの写真 1 枚で「授業を追加」します。
3. 10 分くらい待つと「完成」になります（1 分ごとに裏方の係が少しずつ進めます）。

ここで確かめたいこと（設計書 11 章）：

- iPhone のボイスメモ（m4a）が通るか → だめなら、エラーの画面に出た理由を見て、mp3 に変えて「音声を入れ直す」
- 文字起こしの時刻（`[12:30]` など）が、音声の最初からの時刻になっているか
- 要約の「⭐大事なポイント」の時刻を押すと、文字起こしのその場所に飛ぶか

うまくいかないとき：

- **授業の画面**に、エラーの理由が日本語で出ます。「やり直す」か「音声を入れ直す」を押してください。
- **Cloudflare のログ**：Worker の **Logs**（または **Observability**）で、エラーの詳しい内容が見られます。
- 「混んでいるので待っています」は、Gemini の無料枠の上限に当たっているだけです。待てば自動で続きます。

### 6. スマホのホーム画面に追加する

- **iPhone**：Safari で開く → 共有ボタン → 「ホーム画面に追加」
- **Android**：Chrome で開く → メニュー（︙）→ 「ホーム画面に追加」

---

## 使い方のメモ

- 1 回の授業につき、音声 1 つ（2GB まで）、メモの写真とレジュメを合わせて 20 個まで（PDF は 20MB まで、写真は自動で小さくします）。
- メモやレジュメはあとから足せます。足したら「要約を作り直す」を押してください。
- 音声は文字起こしが終わったら残しません（文字起こしと要約は残ります）。
- 写真と PDF の置き場は 1GB まで。8 割を超えるとホームに注意が出るので、いらない授業を消してください。
- iPhone の写真が HEIC で読めないと出たら、JPEG にしてから入れてください（iPhone の「設定 → カメラ → フォーマット → 互換性優先」でも直せます）。

---

## 開発のしかた

```bash
cd kogi-note
npm install          # .npmrc で legacy-peer-deps を有効にしています
npm test             # サーバーと画面の道具のテスト（Vitest + Workers の環境）
npm run e2e          # 画面の通しテスト（Gemini のニセモノ + wrangler dev + Playwright、スマホと PC の幅）
npm run migrate:local && npx wrangler dev --var APP_PASSWORD:dev --var SESSION_SECRET:dev --var GEMINI_API_KEY:x --var GEMINI_MODEL:m
```

`npm run e2e` は Playwright（chromium）が入っている環境で動きます。画面写真は `e2e/screenshots/` にできます。

### しくみ（ざっくり）

```
ブラウザ ──音声（16MiB ずつ）・写真・PDF──▶ Cloudflare Worker ──▶ Gemini Files API（48 時間で消える）
                                            │  D1：科目・授業・文字起こし・要約
                                            │  KV：写真・PDF
                                            └ 見回り（1 分ごと）：準備 → 文字起こし（30 分ずつ）→ ファイルの準備 → 要約
```

- `src/` … サーバー（API・見回り・Gemini とのやりとり）。AI への依頼は `src/ai/index.js` だけを通すので、将来ほかの AI に差し替えられます。
- `public/` … 画面（フレームワークなし）
- `test/` … 自動テスト、`e2e/` … 画面の通しテスト
