// 消した授業の後片づけ。1 回に limit 件ずつ（サブリクエスト上限のため）

export async function sweepTrash(env, { ai, limit = 20 }) {
  const { results } = await env.DB.prepare('SELECT id, kind, ref FROM trash ORDER BY id LIMIT ?').bind(limit).all();
  for (const item of results) {
    try {
      if (item.kind === 'kv') await env.FILES.delete(item.ref);
      else await ai.deleteFile({ fileName: item.ref });
    } catch {
      // Gemini のファイルは 48 時間で消える。KV は次の回にもう一度
      if (item.kind === 'kv') continue;
    }
    await env.DB.prepare('DELETE FROM trash WHERE id = ?').bind(item.id).run();
  }
  return results.length;
}
