// D1 の小さな道具

export const first = (db, sql, ...params) => db.prepare(sql).bind(...params).first();

export async function all(db, sql, ...params) {
  const { results } = await db.prepare(sql).bind(...params).all();
  return results;
}

export const run = (db, sql, ...params) => db.prepare(sql).bind(...params).run();
