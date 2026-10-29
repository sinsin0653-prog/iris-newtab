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
  rate_limit_count INTEGER NOT NULL DEFAULT 0,
  lease_count INTEGER NOT NULL DEFAULT 0,
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
