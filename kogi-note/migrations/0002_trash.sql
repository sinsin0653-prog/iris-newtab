-- 消した授業の後片づけ（KV と Gemini のファイル）を、見回りが少しずつやる
-- 1 回のリクエストのサブリクエスト上限（50）を超えないように
CREATE TABLE trash (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                      -- kv | gemini
  ref TEXT NOT NULL,                       -- KV のキー、または files/xxxx
  created_at INTEGER NOT NULL
);
