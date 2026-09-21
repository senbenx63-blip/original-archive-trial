export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const q = url.searchParams.get("q");

  if (!q || q.trim().length === 0) {
    return new Response(JSON.stringify({ error: "検索ワードを指定してください" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const trimmedQ = q.trim();
  const isShort = trimmedQ.length < 3; // 3文字未満はtrigramでは検索できない
  const limit = 30;

  let chatSql, transcriptSql, bindValue;

  if (isShort) {
    // 短い単語: 通常のLIKE検索(少し遅いが確実にヒットする)
    bindValue = `%${trimmedQ}%`;
    chatSql = `
      SELECT c.body AS text, c.offset_seconds, c.stream_key, s.title, s.youtube_video_id
      FROM chat_messages c
      JOIN streams s ON s.stream_key = c.stream_key
      WHERE c.body LIKE ?
      ORDER BY s.stream_date DESC, c.offset_seconds
      LIMIT ?
    `;
    transcriptSql = `
      SELECT t.text AS text, t.start_seconds AS offset_seconds, t.stream_key, s.title, s.youtube_video_id
      FROM transcript_segments t
      JOIN streams s ON s.stream_key = t.stream_key
      WHERE t.text LIKE ?
      ORDER BY t.start_seconds
      LIMIT ?
    `;
  } else {
    // 3文字以上: 高速なFTS(trigram)検索
    bindValue = `"${trimmedQ.replace(/"/g, '""')}"`;
    chatSql = `
      SELECT c.body AS text, c.offset_seconds, c.stream_key, s.title, s.youtube_video_id
      FROM chat_fts f
      JOIN chat_messages c ON c.rowid = f.rowid
      JOIN streams s ON s.stream_key = c.stream_key
      WHERE chat_fts MATCH ?
      ORDER BY s.stream_date DESC, t.start_seconds
      LIMIT ?
    `;
    transcriptSql = `
      SELECT t.text AS text, t.start_seconds AS offset_seconds, t.stream_key, s.title, s.youtube_video_id
      FROM transcript_fts f
      JOIN transcript_segments t ON t.id = f.rowid
      JOIN streams s ON s.stream_key = t.stream_key
      WHERE transcript_fts MATCH ?
      ORDER BY t.start_seconds
      LIMIT ?
    `;
  }

  try {
    const [chatResult, transcriptResult] = await Promise.all([
      env.DB.prepare(chatSql).bind(bindValue, limit).all(),
      env.DB.prepare(transcriptSql).bind(bindValue, limit).all(),
    ]);

    const format = (rows, source) =>
      rows.results.map((row) => {
        const seconds = Math.floor(row.offset_seconds || 0);
        return {
          source,
          text: row.text,
          offset_seconds: seconds,
          stream_key: row.stream_key,
          title: row.title,
          youtube_url: row.youtube_video_id
            ? `https://youtu.be/${row.youtube_video_id}?t=${seconds}`
            : null,
        };
      });

    const results = [...format(chatResult, "chat"), ...format(transcriptResult, "transcript")];

    return new Response(JSON.stringify({ query: q, count: results.length, results }), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}