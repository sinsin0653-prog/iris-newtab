// D1 の小さな道具

export const first = (db, sql, ...params) => db.prepare(sql).bind(...params).first();

export async function all(db, sql, ...params) {
  const { results } = await db.prepare(sql).bind(...params).all();
  return results;
}

export const run = (db, sql, ...params) => db.prepare(sql).bind(...params).run();

// 全文の文字起こし：区間を順につなぐ（空の区間は飛ばす）
export async function transcriptOf(env, lectureId) {
  const rows = await all(env.DB, 'SELECT text FROM segments WHERE lecture_id = ? ORDER BY idx', lectureId);
  return rows.map((r) => r.text).filter((t) => t !== '').join('\n');
}
