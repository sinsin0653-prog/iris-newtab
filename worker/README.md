# 宿題忘れゼロ — Discord で焦らせるサーバー

Cloudflare Workers で動く小さなサーバー。やることは 3 つ。

1. **5 分おきに「はしご」を見る**（cron）。まず**捕まえる**：学校のある日の放課後に「きょう、宿題出た？」を科目ボタン付きで DM し、答えるまで 30 分おきに 3 回。科目ボタン → Discord のフォーム（範囲・どこ・いつまで）でそのまま登録できる。次に**焦らせる**：出発時刻を軸に、前日 20:00 → 起床 → 出発 30 分前 → 15 分前（@メンション）→ 出発後 10 分ごと最大 6 回、期限を過ぎたものは 16:00 / 19:00 / 21:00 に Discord の DM を送る。22:00〜6:30 は静か。
2. **Discord のボタンとコマンドに答える**（`/interactions`）。科目ボタン → 登録フォーム、「きょうは なし」、「かばんに入れた」「やった」「10分あとで」、`/shukudai` で登録、`/kyou` できょうの一覧。
3. **アプリと同期する**（`/api/state`）。端末が正、ここは Discord のための写し。

ロジックは `src/core.js`（アプリの `shukudai/ds/bundle.js` と同じ判定。`test/parity.test.js` で一致を確かめる）、はしごは `src/scheduler.js`。

## テスト

```
cd worker
npm test
```

依存なし（Node 22 の `node:test`）。

## 立てる（15 分くらい）

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

- `curl -H "Authorization: Bearer <SYNC_TOKEN>" https://.../api/state` で保存されている中身が見える。
- `npx wrangler dev --test-scheduled` で手元で動かし、`curl "http://localhost:8787/__scheduled"` で cron を手で叩ける。
- 本番のログは `npx wrangler tail`。

## 設定（アプリの設定画面から同期される）

| キー | 既定 | 意味 |
| --- | --- | --- |
| `afterSchoolAt` | 15:45 | 放課後。「宿題出た？」を聞き始める時刻 |
| `captureRepeatMinutes` / `captureMax` | 30 / 3 | 聞き直す間隔と回数 |
| `schoolDays` | 1〜5（月〜金） | 聞く曜日（0=日） |
| `timetable` | – | 曜日 → 科目。あればその日の科目だけ聞く |
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
- 「10分あとで」は calm / soon の段だけ効く。urgent と late は止まらない。
- ボタンが押されたら、元のメッセージを**編集**して「入れた（07:42）」と書き足す。消さない。
- 失敗（Discord の 5xx など）はログに出して次の 5 分で続きをやる。
