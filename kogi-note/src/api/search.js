// 文字起こしと要約から探す
import { HttpError, json } from '../http.js';
import { all } from '../db.js';

const MAX_RESULTS = 50;

export async function search({ env, url }) {
  const q = (url.searchParams.get('q') ?? '').trim();
  if (q.length < 1 || q.length > 100) throw new HttpError(400, 'bad_request', '探す言葉は1〜100文字で入れてね');
  // LIKE に渡すほうだけエスケープする。instr には q そのもの
  const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const rows = await all(
    env.DB,
    `SELECT * FROM (
       SELECT l.id AS lecture_id, s.name AS subject_name, l.number, l.date, l.created_at, 'transcript' AS "where",
              (SELECT substr(g.text, max(1, instr(lower(g.text), lower(?1)) - 40), 120)
                 FROM segments g WHERE g.lecture_id = l.id AND g.text LIKE ?2 ESCAPE '\\' ORDER BY g.idx LIMIT 1) AS snippet
       FROM lectures l JOIN subjects s ON s.id = l.subject_id
       WHERE EXISTS (SELECT 1 FROM segments g WHERE g.lecture_id = l.id AND g.text LIKE ?2 ESCAPE '\\')
       UNION ALL
       SELECT l.id, s.name, l.number, l.date, l.created_at, 'summary', ''
       FROM lectures l JOIN subjects s ON s.id = l.subject_id
       WHERE l.summary_json LIKE ?2 ESCAPE '\\'
     ) ORDER BY date DESC, created_at DESC, "where" DESC LIMIT ?3`,
    q, pattern, MAX_RESULTS,
  );
  return json({ results: rows.map(({ created_at, ...r }) => r) });
}
