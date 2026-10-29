-- 科目ごとの用語リスト（文字起こしの聞き間違いを減らす）と、区間ごとの授業ノート
ALTER TABLE subjects ADD COLUMN glossary TEXT NOT NULL DEFAULT '';
ALTER TABLE lectures ADD COLUMN notes_json TEXT;
