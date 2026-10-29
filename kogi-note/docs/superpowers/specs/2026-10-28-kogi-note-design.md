# 講義ノート（kogi-note）設計書

- 日付：2026-10-28
- 置き場所：`iris-newtab` リポジトリの `kogi-note/` フォルダ（ほかのファイルとは独立）

## 1. 何を作るか

大学の講義の録音を入れると、全文の文字起こしと要約を作ってくれる、自分専用の Web アプリ。
要約は、録音・その授業で取ったメモ・レジュメをまとめて読んで作る。

### 1.1 使う人と目的（本人と決めたこと）

- 使うのは自分だけ。
- 目的は 2 つ。
  - 毎回の授業のあとに、その日の内容をさっと復習する。
  - 先生の話が速くてメモが追いつかなかったところを埋める。
- 録音の方法は問わない。スマホのボイスメモでも PC でもよく、音声ファイルを入れる。
- メモ：紙に手書きして写真に撮ったもの、または打った文字。
- レジュメ：PDF、または紙を写真に撮ったもの。
- スマホと PC の両方から使う（スマホで入れて PC で見る、など）。
- お金は 0 円。そのぶん待ち時間や手間が増えるのはかまわない。
- Cloudflare にクレジットカードや PayPal を登録しない（R2 は使わない）。
- ほしいもの：授業の要約と、全文の文字起こし。

### 1.2 作る側で決めたこと（本人が確認済み）

- アプリストアのアプリではなく Web アプリにする。スマホはホーム画面に追加して使える。
- 「科目 → 第◯回」の順に並べる。
- メモの穴埋めのための欄は別に作らない。要約の「大事なポイント」で、メモになかったものに印をつける。
- 処理に数分〜十数分かかってもよい。
- パスワードをかけて、自分しか開けないようにする。

### 1.3 うまくいったと言える状態

- スマホで 90 分の授業の音声・メモの写真・レジュメ PDF を入れて画面を閉じても、10 分ほどで PC から要約と全文の文字起こしを読める。
- 要約の「大事なポイント」の時刻をタップすると、文字起こしのその場所に飛べる。
- メモになかった大事な話に「📝メモになし」の印がついている。
- 1 円も払わずに、1 日に数コマぶん使える。

### 1.4 作らないもの

- アプリの中での録音（音声ファイルを入れる形だけ。必要になったら後で足す）
- 確認クイズ・用語集
- 音声の保存と再生（音声は文字起こしが終わったら残さない）
- 複数人での利用・共有
- オフラインでの利用
- 宿題アプリとの連携

## 2. 全体のしくみ

```
スマホ / PC（ブラウザ）
   │  音声（かけらに分けて送る）・写真・PDF・打ったメモ
   ▼
Cloudflare Worker（kogi-note）
   ├ 画面（静的ファイル）とパスワード
   ├ D1 … 科目・授業・文字起こし・要約・処理の進み具合
   ├ KV … メモの写真・レジュメの PDF や写真
   └ 見回り（Cron、1 分ごと）… 処理を 1 段ずつ進める
   │
   ▼
Gemini API（個人の Google アカウントの無料枠）
   ├ Files API … 音声・写真・PDF を一時的に置く（48 時間で自動的に消える）
   └ generateContent … 文字起こし（30 分ずつ）と要約
```

### 2.1 この形にした理由

- **文字起こしも Gemini にする。** 最初は Cloudflare の Whisper で文字起こしする案だった。でも Whisper に渡すには音声を細かく切る必要があり、iPhone のボイスメモ（m4a）を切るには、ブラウザの中で 90 分の音声をまるごと展開しなければならない。スマホだとメモリが足りずに落ちやすい。Gemini なら 90 分の音声をそのまま受け取れる。
- **大学アカウントの Gemini は使えない。** 大学の有料契約は Gemini アプリと NotebookLM のためのもので、自作アプリから呼ぶ API は含まれない。そのため、個人の Google アカウントで AI Studio の API キーを作る。
- **無料枠では、送ったデータが Google のサービス改善に使われることがある（人が読むこともある）。** 本人はこれを承知している。使い終わったファイルは Gemini からすぐ消す（6.4）。
- **AI に頼む部分は差し替えられるようにする**（4.4）。将来お金を払って Claude などに変えたくなったとき、見回りの処理を書き直さずに済む。

### 2.2 使うもの

| 部品 | 使うもの | 無料枠（調べた目安。作るときに確認する） |
|---|---|---|
| サーバー | Cloudflare Workers（JavaScript、ES modules） | 1 日 10 万リクエスト。1 回の CPU 時間 10ms。リクエスト本文 100MB まで |
| 画面 | Workers の静的ファイル配信（`public/`） | 静的ファイルはリクエスト数に数えない |
| データベース | D1 | 5GB |
| ファイル置き場 | Workers KV | 1GB。1 日 1,000 回の書き込み。1 つ 25MB まで |
| 見回り | Cron Trigger（`* * * * *`） | — |
| AI | Gemini API（Files API・generateContent） | 回数とトークン数に上限あり（モデルごとに違う） |
| 反映 | Cloudflare Workers Builds（GitHub とつなぐ） | — |

画面はフレームワークを使わない素の JavaScript にする（iris-newtab と同じ書き方）。

## 3. 画面

URL の `#` 以降で画面を切り替える。画面は 5 つ。

| 画面 | URL | 内容 |
|---|---|---|
| ログイン | `#/login` | パスワードを入れる。成功したら 30 日間はそのまま入れる |
| ホーム | `#/` | 科目の一覧と「＋科目を追加」。上に検索窓。置き場が 8 割を超えたら注意を出す |
| 科目 | `#/s/<科目ID>` | 第◯回の一覧（日付・状態）。「＋授業を追加」。科目名の変更と削除 |
| 授業を追加 | `#/s/<科目ID>/new` | 第◯回と日付（次の回・今日が最初から入っている）、音声（1 つ、必須）、メモ（写真を何枚でも・打った文字）、レジュメ（PDF・写真を何枚でも）。送っている間は進み具合のバーを出す |
| 授業 | `#/l/<授業ID>` | タブ「要約」「文字起こし」「メモ・レジュメ」。メモやレジュメはここから後で足せる。ボタン「要約を作り直す」「やり直す」（エラーのときだけ）「削除」 |

- 処理中の授業は「文字起こし中（2/3）」「要約を作っています」「混んでいるので待っています」のように表示し、10 秒ごとに状態を読み直す。
- スマホ（幅 390px）と PC（幅 1280px）の両方で見やすくする。
- `manifest.webmanifest` を置いて、ホーム画面に追加できるようにする。Service Worker は使わない。
- 画面に出す文字はすべて `textContent` で入れる（HTML として扱わない）。

### 3.1 要約の中身

| 項目 | 内容 |
|---|---|
| 📌 今日のテーマ | 1〜2 行 |
| 🗺 授業の流れ | 見出しと説明。レジュメのどのページの話かわかれば「p.3」のように書く |
| ⭐ 大事なポイント | 先生が強調したこと・くり返したこと・「テストに出る」と言ったこと。それぞれに時刻をつける。メモになかったものには「📝メモになし」の印 |
| 📢 連絡事項 | 課題・テスト・休講など。時刻つき |

時刻（例：`[23:10]`）はリンクにして、タップすると文字起こしタブのその場所に飛ぶ。

### 3.2 文字起こしの形

段落ごとに、音声の最初からの時刻をつける。60 分を超えても分で数える。

```
[00:00] では、始めます。今日は前回の続きで…
[01:45] ここで大事なのは…
[75:30] 最後に、来週までの課題ですが…
```

## 4. データの流れ

### 4.1 授業の追加とアップロード

1. ブラウザが `POST /api/lectures` で授業を作る（状態は `uploading`）。
2. メモの写真・レジュメの写真は、ブラウザで長い辺 2000px・JPEG（品質 0.85）に縮めてから `POST /api/lectures/:id/attachments?kind=…` で送る。PDF はそのまま送る（20MB まで）。Worker は KV に入れ、D1 に記録する。
3. 音声は、ブラウザが `<audio>` で長さ（秒）を読んでから `POST /api/lectures/:id/audio/start` を呼ぶ。Worker が Gemini Files API の「再開可能アップロード」を始め、その送り先 URL を D1 に保存する。この URL はブラウザには返さない。
4. ブラウザは音声を 16MiB ずつに分けて `PUT /api/lectures/:id/audio/chunk?offset=N` で送る。Worker は本文をそのまま Gemini に流す（ためこまない）。最後のかけらで「確定」し、返ってきたファイル情報（URI・期限）を保存して、状態を `processing`（段階 `wait_file`）にする。
5. かけらの送信に失敗したら、ブラウザは同じかけらを 3 回まで送り直す。ずれたときは、Worker が Gemini に「どこまで届いたか」を問い合わせて合わせる。
6. ブラウザで音声の長さが読めなかったときは 120 分とみなす（余った区間は空になるだけ）。

### 4.2 見回り（1 分ごと）

見回りは 1 回につき「1 つの授業の、1 つの段階」だけ進める。

1. `processing` で、`next_run_at` を過ぎていて、だれも作業中でない授業を 1 つ選ぶ。
2. `lease_until` を「今から 10 分後」に書き換えて、作業中の印にする。条件つきの UPDATE で、ほかの見回りと取り合わないようにする。
3. 段階ごとの作業をする。

| 段階 | やること | 次 |
|---|---|---|
| `wait_file` | Gemini に音声ファイルの状態を聞く。`PROCESSING` なら 1 分後にもう一度。`ACTIVE` なら区間の数（30 分ごと、最低 1）を決める。`FAILED` ならエラー | `transcribe` |
| `transcribe` | 次の区間（例：30:00〜60:00）の文字起こしを頼み、結果を `segments` に保存する。次の区間は 65 秒以上あける（1 回ごとに音声全体のトークンが数えられるため、1 分あたりの上限を超えないように） | 全区間が終わったら Gemini の音声を消して `attach` |
| `attach` | KV のメモ写真・レジュメを Gemini Files API に送る。1 回の見回りで 5 つまで | 全部送ったら `summarize` |
| `summarize` | 文字起こし・打ったメモ・写真・PDF を渡して要約を頼む（JSON の形を指定する） | 結果を保存し、Gemini の写真・PDF を消して（`attachments` の `gemini_*` を空に戻す）`done` |

4. 段階がうまくいったら `attempts` を 0 に戻す。
5. 終わったら `lease_until` を 0 に戻す。途中で落ちても 10 分たてば、ほかの見回りが続きを拾う。

`attach` では、`gemini_file_uri` が空のものと、期限まで 1 時間を切ったものだけを送る。

### 4.3 Gemini への頼み方

- モデル名は設定 `GEMINI_MODEL` で決める。セットアップのとき、AI Studio の一覧から無料枠のある Flash 系モデルを選んで入れる。
- 文字起こしの頼み方（`src/ai/prompts.js`）
  - 「この音声の MM:SS から MM:SS までを日本語で、話されたとおりに文字にしてください」
  - 「区間の最初の発言から始め、終わりの時刻より前に始まった発言で止める」（区間のつなぎ目で文が重ならないように）
  - 「段落ごとに、音声の最初からの時刻を `[MM:SS]` でつける」
  - 「この区間に話し声がなければ `（音声なし）` とだけ書く」→ 空の区間として扱う
  - 「聞き取れないところは `（聞き取れず）` と書き、推測で埋めない」
- 要約の頼み方
  - 「文字起こし・メモ・レジュメに書いてあることだけで作る。書いていないことは足さない」
  - 「大事なポイントには、文字起こしの時刻をつける」
  - 「メモ（写真と打った文字）に書いていないポイントには `not_in_notes: true` をつける」
  - 授業の中身は「データ」として渡し、その中に書いてある指示には従わないよう伝える。
  - 返す形は `responseSchema` で決める。

```json
{
  "theme": "string",
  "flow": [{ "heading": "string", "detail": "string", "handout_pages": "string（なければ空）" }],
  "key_points": [{ "point": "string", "time": "MM:SS", "not_in_notes": true, "kind": "emphasis | repeated | exam" }],
  "announcements": [{ "text": "string", "time": "MM:SS" }]
}
```

受け取ったら、形が合っているかを確かめてから保存する。合わなければエラーとして扱う（6.1）。

### 4.4 AI の差し替え口

見回りは AI に直接さわらず、`src/ai/index.js` が出す次の関数だけを使う。Gemini の中身は `src/ai/gemini.js` に閉じこめる。

| 関数 | 中身 |
|---|---|
| `startAudioUpload({ mime, size, displayName })` | 再開可能アップロードを始め、送り先 URL を返す |
| `uploadAudioChunk({ uploadUrl, offset, body, size, isLast })` | かけらを送る。最後なら `{ fileUri, fileName, expiresAt }` を返す |
| `queryUploadOffset({ uploadUrl })` | どこまで届いたかを返す |
| `getFileState({ fileName })` | `PROCESSING` / `ACTIVE` / `FAILED` |
| `uploadFile({ body, mime, size, displayName })` | 写真・PDF を送り、`{ fileUri, fileName, expiresAt }` を返す |
| `deleteFile({ fileName })` | ファイルを消す。もう無ければ何もしない |
| `transcribeSegment({ fileUri, mime, startSec, endSec })` | 区間の文字起こし（文字列） |
| `summarize({ transcript, noteText, attachments })` | 要約（3.1 の JSON） |

どの関数も、失敗したら `AiError` を投げる。`AiError.kind` は `rate_limited`（`retryAfterMs` つき）、`temporary`、`permanent` のどれか。

## 5. データの形

### 5.1 D1（`migrations/0001_init.sql`）

```sql
CREATE TABLE subjects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE lectures (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  date TEXT NOT NULL,                      -- YYYY-MM-DD
  note_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,                    -- uploading | processing | done | error
  step TEXT,                               -- wait_file | transcribe | attach | summarize
  waiting_reason TEXT,                     -- rate_limited など（画面の表示用）
  audio_mime TEXT,
  audio_size INTEGER,
  audio_duration_sec INTEGER,
  audio_upload_url TEXT,                   -- 確定したら消す
  audio_upload_offset INTEGER NOT NULL DEFAULT 0,
  audio_file_name TEXT,                    -- files/xxxx
  audio_file_uri TEXT,
  audio_expires_at INTEGER,                -- ミリ秒
  segments_total INTEGER,
  summary_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (subject_id, number)
);

CREATE TABLE segments (
  lecture_id TEXT NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (lecture_id, idx)
);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  lecture_id TEXT NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                      -- note_image | handout_pdf | handout_image
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  kv_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  gemini_file_name TEXT,
  gemini_file_uri TEXT,
  gemini_expires_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE login_failures (ts INTEGER NOT NULL);

CREATE INDEX lectures_by_subject ON lectures(subject_id, number);
CREATE INDEX lectures_due ON lectures(status, next_run_at);
CREATE INDEX attachments_by_lecture ON attachments(lecture_id, position);
```

- 全文の文字起こしは、`segments` を `idx` の順につないで作る。区間ごとに保存するので、同じ区間を 2 回頼んでも上書きされるだけ。
- ID は `crypto.randomUUID()`。

### 5.2 KV

- キー：`att/<授業ID>/<添付ID>`。値は写真や PDF そのもの。
- 置き場の使用量は `attachments.size` の合計で数え、1GB の 8 割を超えたらホームに注意を出す。

## 6. うまくいかなかったとき

### 6.1 見回り中のエラー

| 何が起きたか | どうするか | 画面の表示 |
|---|---|---|
| 無料枠の上限（429） | `retryAfterMs` があればそのぶん、なければ 2 分・4 分・8 分…（最大 30 分）待つ。`attempts` は増やさない | 混んでいるので待っています |
| 一時的なエラー（5xx・通信の失敗・時間切れ） | `attempts` を増やし、2 分・4 分・8 分待って同じ段階をやり直す。3 回失敗したら `error` | 3 回目まで：処理中。そのあと：エラー＋「やり直す」 |
| もう直らないエラー（400 など・中身がブロックされた・空の返事・要約の形が違う） | すぐに `error` | エラーの理由＋「やり直す」 |
| 音声の期限（48 時間）まで 10 分を切ったのに、まだ文字起こしが終わっていない | `error` にする | 「音声の期限が切れました。もう一回入れてね」 |
| 見回りが途中で落ちた | `lease_until` が過ぎたら、次の見回りが同じ段階から続ける | 処理中 |

- 「やり直す」（`POST /api/lectures/:id/retry`）：`attempts` を 0 にして、エラーになった段階からもう一度始める。音声の期限が切れていたら、音声を入れ直す画面を出す。
- 「要約を作り直す」（`POST /api/lectures/:id/resummarize`）：文字起こしが終わっている授業だけで使える。段階 `attach` から始める（メモやレジュメを後で足したとき用）。
- 音声の入れ直し（`POST /api/lectures/:id/audio/start` をもう一度）：`segments` を消して、文字起こしを最初からやる。

### 6.2 アップロード中のエラー

- かけらの送信失敗：3 回まで送り直し、だめなら画面に「アップロードに失敗しました。もう一回試してね」と出す。
- 送っている途中で画面を閉じたら、その授業は `uploading` のまま残る。授業の画面に「音声を入れ直す」を出す。
- PDF が 20MB を超えた・音声が 2GB を超えた：送る前にブラウザで止めて、理由を出す。
- KV の書き込みに失敗した（1 日 1,000 回の上限など）：「今日はこれ以上ファイルを入れられません」と出す。

### 6.3 ログイン

- パスワードは Worker の秘密の設定 `APP_PASSWORD` に入れる。比べるときは、両方を `SESSION_SECRET` で HMAC してから比べる（文字の長さや一致した位置で時間が変わらないように）。
- 成功したら `session=<期限>.<HMAC>` を `HttpOnly; Secure; SameSite=Strict` のクッキーで渡す。期限は 30 日。HMAC には期限とパスワードの両方を入れる（パスワードを変えると、それまでのクッキーは全部使えなくなる）。
- 15 分以内に 5 回まちがえたら、15 分間ログインできなくする（`login_failures` で数える）。
- `/api/login` 以外の `/api/*` はクッキーが必要。データを変えるリクエストには、ヘッダー `X-Kogi: 1` も必要にする（よそのサイトから勝手に送られないように）。

### 6.4 プライバシー

- 音声は KV にも D1 にも保存しない。Gemini には一時的に置き、文字起こしが終わったらすぐ消す。
- 写真・PDF も、要約ができたら Gemini から消す（KV には残る）。
- 授業を消すと、D1・KV・Gemini に残っているファイルをすべて消す。

## 7. API

すべて JSON。認証が必要なもの（ログイン以外の全部）は 401 を返すことがある。

| メソッド・パス | 内容 |
|---|---|
| `POST /api/login` | `{ password }` → クッキー |
| `POST /api/logout` | クッキーを消す |
| `GET /api/me` | ログインしているか |
| `GET /api/subjects` | 科目の一覧（授業の数・最後に更新した日つき） |
| `POST /api/subjects` | `{ name }` |
| `PATCH /api/subjects/:id` | `{ name }` |
| `DELETE /api/subjects/:id` | 科目とその授業をすべて消す |
| `GET /api/subjects/:id/lectures` | 授業の一覧（状態つき） |
| `POST /api/lectures` | `{ subject_id, number, date, note_text }` |
| `GET /api/lectures/:id` | 授業の全部（文字起こし・要約・添付の一覧・状態） |
| `PATCH /api/lectures/:id` | `{ number?, date?, note_text? }` |
| `DELETE /api/lectures/:id` | 授業を消す |
| `POST /api/lectures/:id/audio/start` | `{ mime, size, duration_sec }` → `{ chunk_size }` |
| `PUT /api/lectures/:id/audio/chunk?offset=N` | 音声のかけら（本文は生のバイト列）→ `{ next_offset, done }` |
| `POST /api/lectures/:id/attachments?kind=…` | 写真・PDF（本文は生のバイト列）→ 添付の情報 |
| `GET /api/attachments/:id` | 写真・PDF を返す |
| `DELETE /api/attachments/:id` | 添付を消す |
| `POST /api/lectures/:id/retry` | やり直す |
| `POST /api/lectures/:id/resummarize` | 要約を作り直す |
| `GET /api/search?q=…` | 文字起こしと要約から探す（最大 50 件、前後の文つき） |
| `GET /api/usage` | 置き場の使用量 |

- 検索は D1 の `LIKE` を使う。`%` と `_` はエスケープする。前後の文は SQL の `instr` と `substr` で切り出す（Worker の CPU 時間を節約するため）。

## 8. ファイルの構成

```
kogi-note/
  README.md                  セットアップのしかた
  package.json
  wrangler.jsonc             D1・KV・Cron・静的ファイルの設定
  migrations/0001_init.sql
  src/
    index.js                 入口（fetch と scheduled）
    router.js                URL と処理の対応
    auth.js                  パスワード・クッキー・ログインのロック
    db.js                    D1 の読み書き
    http.js                  JSON の返し方・エラーの形
    api/subjects.js
    api/lectures.js
    api/upload.js            音声のかけらの中継・添付
    api/search.js
    jobs/runner.js           見回り（1 件を選んで 1 段進める）
    jobs/steps.js            段階ごとの作業
    jobs/backoff.js          待ち時間の計算
    ai/index.js              差し替え口
    ai/gemini.js             Gemini REST クライアント
    ai/prompts.js            頼み方と要約の形
    ai/errors.js             AiError
  public/
    index.html
    style.css
    manifest.webmanifest
    icon.svg
    app.js                   入口
    router.js                # で画面を切り替える
    api.js                   サーバーとのやりとり
    upload.js                写真を縮める・音声をかけらで送る
    views/login.js
    views/home.js
    views/subject.js
    views/new-lecture.js
    views/lecture.js
  test/                      Vitest（Workers のテスト環境）
  e2e/                       Playwright と Gemini のニセモノ
```

## 9. テスト

- **サーバーの自動テスト**：Vitest と `@cloudflare/vitest-pool-workers` で、本物に近い D1・KV の中で動かす。AI は `src/ai/index.js` をニセモノに差し替える。
  - ログイン：正しいパスワード・まちがい・5 回まちがえたあとのロック・クッキーの期限と改ざん
  - API：科目と授業の追加・変更・削除、権限のないアクセス、`X-Kogi` ヘッダーがないとき
  - アップロード：かけらの中継、offset がずれたとき、最後のかけらで状態が変わること
  - 見回り：`wait_file → transcribe（3 区間）→ attach → summarize → done` の流れ、429 のときの待ち、一時的なエラー 3 回で `error`、もう直らないエラー、音声の期限切れ、作業中の印（lease）の取り合いと期限切れ、やり直し、要約の作り直し
  - 要約の形の確認：正しい形・項目が足りない・形がちがう
  - 検索：`%` や `_` を含む言葉
- **Gemini クライアントのテスト**：`fetch` をニセモノにして、送るリクエストの形と、返事・エラーの読み取りを確かめる。
- **画面のテスト**：Playwright で、`wrangler dev` と Gemini のニセモノのサーバーを動かして試す。スマホ（390×844）と PC（1280×800）の両方で、ログイン → 科目の追加 → 短い音声・写真・PDF で授業を追加 → 見回りを動かす → 要約が出る → 時刻をタップして文字起こしに飛ぶ → 検索、までを通す。
- **本物の Gemini での確認**：本人の API キーで、5 分くらいの音声を使って試す。このセッションからは Google の API につながらないため、本人にやってもらう。

## 10. セットアップ（README に詳しく書く）

1. 個人の Google アカウントで AI Studio を開き、API キーを作る。無料枠のある Flash 系のモデル名を控える。
2. Cloudflare のダッシュボードで D1 データベース `kogi_note` と KV `kogi_note_files` を作り、ID を `wrangler.jsonc` に書く。
3. Workers Builds で iris-newtab リポジトリとつなぐ。ルートフォルダは `kogi-note`。反映のコマンドは `npx wrangler d1 migrations apply kogi_note --remote && npx wrangler deploy`。
4. 秘密の設定 `APP_PASSWORD`・`SESSION_SECRET`・`GEMINI_API_KEY` と、ふつうの設定 `GEMINI_MODEL` を入れる。
5. スマホで開いてホーム画面に追加する。

iris-newtab のほかのファイルには影響しない。もし iris-newtab のルートが GitHub Pages などで公開されていると、`kogi-note/public/` の画面のファイルも見えるようになる。ただし画面のファイルにはデータも秘密の設定も入っていないので、問題はない。

## 10.5 質を上げるための追加（2026-10-29）

本物の Gemini で試して「聞き取りミスが多い」「要約が浅い（説明が足りない＋拾いもれ）」とわかったので、次を足した。

- 段階の順を「準備 → **ファイルの準備** → 文字起こし → **授業ノート** → 要約」に変えた。レジュメを先に Gemini に置き、文字起こしのときに一緒に渡す（用語の表記をそろえる）。
- 科目に **用語リスト**（`subjects.glossary`、2000 文字まで）を足した。文字起こしと授業ノートの依頼に渡す。
- **授業ノート**（`lectures.notes_json`）：30 分の区間ごとに、話題ごとの見出し・本文（何を・なぜ・例、5〜10 行）・用語と意味・先生の言い回しを JSON で作る。空の区間は飛ばす。区間ごとに保存するので、途中で失敗しても続きから。
- 要約は、文字起こしと授業ノートの両方を材料にする。「流れ」と「大事なポイント」は授業ノートをもとに、後半も同じ厚さで。
- Gemini の「考える量」を指定する（文字起こし 4096、ノート・要約 8192）。
- 1 コマあたりの Gemini の呼び出しは 4 回 → 約 8 回。

## 11. 作る前に確かめること

このセッションからは Google と Cloudflare の公式ドキュメントを開けなかったため、検索で調べた情報をもとにしている。作り始めるときに次のことを確かめ、合わなければ右の代わりの方法にする。

| 確かめること | 合わなかったときの代わり |
|---|---|
| Gemini Files API の再開可能アップロードで、かけらに分けて送れるか。かけらの大きさの単位（`X-Goog-Upload-Chunk-Granularity`） | 単位に合わせてかけらの大きさを変える。かけらに分けられない場合は、100MB 以下の音声だけ 1 回で送る |
| m4a（`audio/mp4`）を Gemini が受け取れるか | `audio/aac` や `video/mp4` として送ってみる。だめなら、mp3 に変えて入れるよう画面で案内する |
| 音声の区間を `MM:SS`（60 分を超える分も含む）で指定できるか | 区間を指定せず全体を 1 回で文字起こしし、返事が途中で切れたら、最後の時刻から続きを頼む |
| `responseSchema` で 3.1 の形を指定できるか | 指示文で JSON の形を伝え、受け取ってから形を確かめる |
| 無料枠の上限（1 分あたりのトークン・1 日の回数） | 区間の間隔と区間の長さを設定で変えられるようにしておく |
| 無料プランの Cron で、Gemini の返事を数分待てるか | 1 回の作業をもっと短く分ける（区間を 15 分にするなど） |
| 無料プランの KV の上限（1GB・1 日 1,000 回の書き込み・1 つ 25MB） | 写真をもっと小さく縮める。PDF の上限を下げる |
