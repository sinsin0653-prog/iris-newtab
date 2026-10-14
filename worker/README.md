# 宿題忘れゼロ — Discord で焦らせるサーバー

Cloudflare Workers で動く小さなサーバー。やることは 3 つ。

1. **5 分おきに「はしご」を見る**（cron）。まず**捕まえる**：学校のある日の放課後に「きょう、宿題出た？」を科目ボタン付きで DM し、答えるまで 30 分おきに 3 回。科目ボタン → Discord のフォーム（範囲・どこ・いつまで）でそのまま登録できる。次に**焦らせる**：出発時刻を軸に、前日 20:00 → 起床 → 出発 30 分前 → 15 分前（@メンション）→ 出発後 10 分ごと最大 6 回、期限を過ぎたものは 16:00 / 19:00 / 21:00 に Discord の DM を送る。22:00〜6:30 は静か。
2. **Discord のボタンとコマンドに答える**（`/interactions`）。「数学：出た」→ 登録フォーム（範囲は空でもいい）、「数学：なし」、「入れた：英語」（宿題ごと）、「やった」「10分あとで」、「出した：数学」「先生に言った：数学」、「範囲を書く」、`/shukudai` で登録、`/kyou` できょうの一覧。
3. **アプリと同期する**（`/api/state`）。端末が正、ここは Discord のための写し。

ロジックは `src/core.js`（アプリの `shukudai/ds/bundle.js` と同じ判定。`test/parity.test.js` で一致を確かめる）、はしごは `src/scheduler.js`。

## テスト

```
cd worker
npm test
```

依存なし（Node 22 の `node:test`）。

## ブラウザだけで立てる（おすすめ。パソコンに何も入れない）

コードは `dist/worker.js` の 1 ファイルにまとめてある。Cloudflare の画面に貼るだけで動く。Discord の Bot は先に作って、自分用サーバーに招待しておく。

1. **Cloudflare のアカウントを作る**：https://dash.cloudflare.com/sign-up （無料プランでいい）
2. **Worker を作る**：左の「Workers & Pages」→「Create」→「Start with Hello World!」→ 名前を `shukudai-worker` にして「Deploy」。
3. **コードを貼る**：「Edit code」→ 左の `worker.js` の中身を全部消す → [dist/worker.js の Raw](https://raw.githubusercontent.com/sinsin0653-prog/iris-newtab/claude/clever-mendel-hesdm6/worker/dist/worker.js) を開いて全部コピー（Ctrl+A → Ctrl+C）→ 貼る → 右上の「Deploy」。
4. **保存場所（KV）を作ってつなぐ**：左の「Storage & Databases」→「KV」→「Create」→ 名前 `SHUKUDAI`。Worker に戻って「Settings」→「Bindings」→「Add」→「KV namespace」→ Variable name も `SHUKUDAI`、namespace は今作ったもの →「Deploy」。
5. **シークレットを 4 つ入れる**：「Settings」→「Variables and Secrets」→「Add」→ Type を「Secret」にして、1 つずつ。
   | 名前 | 中身 | どこにある |
   | --- | --- | --- |
   | `DISCORD_TOKEN` | Bot のトークン | Developer Portal →「Bot」→「Reset Token」 |
   | `DISCORD_PUBLIC_KEY` | Public Key | Developer Portal →「General Information」 |
   | `DISCORD_APP_ID` | Application ID | Developer Portal →「General Information」 |
   | `SYNC_TOKEN` | 合言葉（自分で決める、20 文字以上のでたらめな英数字） | 自分で決めて、メモしておく |
6. **5 分おきの見回り**：このリポジトリの GitHub Actions（`.github/workflows/shukudai-patrol.yml`）が 5 分おきに `/api/tick` を叩くので、何もしなくていい（main ブランチに置いてあるときだけ動く。別の Worker の URL ならファイルの `URL` を書き換える）。もっと正確にしたいときは、Cloudflare の Worker の「Settings」→「Triggers」→「Cron Triggers」に `*/5 * * * *` も入れる（両方あっても、4 分以内の重複はサーバーが無視する）。
7. **準備ページを開く**：`https://shukudai-worker.<あなたの名前>.workers.dev/setup`。ここで、
   - 1〜6 が全部「OK」になっているか見る。
   - 「Discord に貼る URL」をコピーして、Developer Portal →「General Information」→「Interactions Endpoint URL」に貼って「Save Changes」。
   - 合言葉と自分の Discord ユーザー ID を入れて「コマンドを登録して、テスト DM を送る」。DM が来たら完成。
   - 5 分後に読み直して「最後に見回った」時刻が出れば、催促も動いている。
8. **アプリを開く**：`https://shukudai-worker.<あなたの名前>.workers.dev/app/`（トップを開いても飛ぶ）。アプリもこの Worker が配っているので、GitHub Pages などは要らない。サーバーの URL は自動で入るので、設定で合言葉だけ入れる。スマホで「ホーム画面に追加」。

`src/` かアプリ（`shukudai/`）を変えたら `npm run build` で `src/app-assets.js` と `dist/worker.js` を作り直す（古いままだとテストが落とす）。

## ターミナルで立てる（wrangler を使う人向け）

### 1. Discord のアプリを作る

1. https://discord.com/developers/applications → **New Application**（名前は「宿題忘れゼロ」など）。
2. **Bot** タブ → **Reset Token** → トークンを控える（`DISCORD_TOKEN`）。
3. **General Information** の **Application ID**（`DISCORD_APP_ID`）と **Public Key**（`DISCORD_PUBLIC_KEY`）を控える。
4. **OAuth2 → URL Generator** で scope に `bot` と `applications.commands`、Bot Permissions に `Send Messages` を付けて、出た URL で**自分用のサーバー**に招待する（DM は、同じサーバーにいる Bot からしか届かない）。

### 2. Worker を出す

```
cd worker
npm install                      # wrangler
npx wrangler login
npx wrangler kv namespace create SHUKUDAI
#   → 出た id を wrangler.toml の PUT_YOUR_KV_NAMESPACE_ID に貼る
npx wrangler secret put DISCORD_TOKEN
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_APP_ID
npx wrangler secret put SYNC_TOKEN        # 長いランダム文字列を自分で決める（アプリの設定にも貼る）
npx wrangler deploy
#   → https://shukudai-worker.<あなた>.workers.dev
```

### 3. Discord とつなぐ

1. Developer Portal の **General Information → Interactions Endpoint URL** に `https://shukudai-worker.<あなた>.workers.dev/interactions` を入れて保存（署名の確認に通れば保存できる）。
2. スラッシュコマンドを登録：
   ```
   DISCORD_TOKEN=... DISCORD_APP_ID=... npm run register
   ```
3. アプリ（`shukudai/`）の設定で **サーバーの URL**・**合言葉**・**Discord ユーザー ID**・**出る時間** を入れて保存 → 「Discord にテスト送信」。DM が来たら完成。

### 4. 確かめ方

- `https://.../setup` を開くと、入れたもの・Discord に貼る URL・見回りの時刻が見える。コマンド登録とテスト DM もここから押せる。
- `curl -H "Authorization: Bearer <SYNC_TOKEN>" https://.../api/state` で保存されている中身が見える。
- `npx wrangler dev --test-scheduled` で手元で動かし、`curl "http://localhost:8787/__scheduled"` で cron を手で叩ける。
- 本番のログは `npx wrangler tail`。

## 設定（アプリの設定画面から同期される）

| キー | 既定 | 意味 |
| --- | --- | --- |
| `courses` | [] | 履修科目（大学の時間割）。あると、下の時刻の多くは時間割から自動で決まる（`dayPlan`） |
| `periods` | 1 限 9:00–10:30 … | 時限の時刻 |
| `commuteMinutes` | 60 | 通学時間。出る時間 = 最初の授業 − これ |
| `leaveByDay` | – | 曜日ごとの出る時間の上書き `{ "1": "07:45" }` |
| `afterSchoolAt` | 15:45 | 放課後。「宿題出た？」を聞き始める時刻（履修科目があれば最後の授業 + 30 分） |
| `captureRepeatMinutes` / `captureMax` | 30 / 3 | 聞き直す間隔と回数 |
| `schoolDays` | 1〜5（月〜金） | 聞く曜日（0=日） |
| `afterSchoolByDay` | – | 曜日ごとの放課後（部活の日など）。`{ "5": "18:30" }` |
| `leaveSchoolAt` | 16:30 | 学校（ロッカー・机）にあるものを「帰る前にかばんへ」と言う時刻 |
| `timetable` | – | 曜日 → 科目。あればその日の科目だけ聞き、期限の既定が「次の○○」になる |
| `watch` | good のみ | 見守りチャンネルに流すもの：`good`（ぜんぶ入れた・出した）/ `evening` / `late` |
| `classroomUrl` | – | 全部「なし」の夜に出す「Classroom を見る」リンク |
| `leaveAt` | 07:50 | 出る時間。はしごの軸 |
| `wakeAt` | 06:30 | 朝の 1 通目 |
| `quietFrom` / `quietTo` | 22:00 / 06:30 | 送らない時間 |
| `eveningAt` / `evening2At` | 20:00 / 21:30 | 前日の夜 |
| `overdueAt` | 16:00, 19:00, 21:00 | 期限を過ぎたものの催促 |
| `escalation` | full | `calm` にすると Discord には送らない |
| `snoozeMax` | 3 | 「10分あとで」の 1 日の上限 |
| `discord.userId` | – | DM の相手 |
| `discord.watchChannelId` | – | 見守りチャンネル。出発後 3 回目からここにも投稿（任意） |
| `appUrl` | – | Discord の「アプリで見る」ボタンのリンク |
| `tz` | Asia/Tokyo | 時刻の基準 |

## 仕組みの決まり

- 同じ段は 1 日に 1 回。止まっていた分をまとめて送らない（最後の 1 段だけ）。
- 「10分あとで」は calm / soon の段だけ効く（アプリと共有、1 日 3 回）。10 分後に同じ段をもう一度送る。urgent と late は止まらない。
- 朝のはしごは `schoolDays` の日だけ。`packed` はその日限り（`packedOn`）。ネット提出（Classroom）は朝のかばん確認から外す。
- 履修科目があれば、授業が終わって 5 分後にその授業だけを聞く（`class<時限>` の段）。出る時間は曜日ごと、最初の授業が始まったら出発後の催促は止める。
- 捕まえるのは科目ごと（`capture[日付][科目]`）。30 分おきに 3 回、そのあと 1 時間おきに静かな時間まで。聞き方は回ごとに変わる。
- 期限切れ：`@メンション` は初日だけ、4 日目からは 19:00 の 1 回だけ。「出した」「先生に言った」で閉じる。
- 見守りチャンネルには既定で良い知らせだけ（「ぜんぶ入れた 07:41」「出した：数学」）。3 日ボタンが押されなければ「ミュートしてない？」を 1 回。
- ボタンが押されたら、元のメッセージを**編集**して「入れた（07:42）」と書き足す。消さない。
- 失敗（Discord の 5xx など）はログに出して次の 5 分で続きをやる。
