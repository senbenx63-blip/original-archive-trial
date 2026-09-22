import sqlite3
from flask import Flask, jsonify, request, Response

DB_PATH = "chama_archive.db"
app = Flask(__name__)


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def fmt_rows(rows, source_label):
    results = []
    for row in rows:
        seconds = int(row["offset_seconds"] or 0)
        keys = row.keys()
        results.append({
            "source": source_label,
            "text": row["text"],
            "offset_seconds": seconds,
            "stream_key": row["stream_key"],
            "title": row["title"] if "title" in keys else None,
            "stream_date": row["stream_date"] if "stream_date" in keys else None,
            "commenter_name": row["commenter_name"] if "commenter_name" in keys else None,
            "youtube_url": (
                f'https://youtu.be/{row["youtube_video_id"]}?t={seconds}'
                if "youtube_video_id" in keys and row["youtube_video_id"] else None
            ),
        })
    return results


def browse_recent(conn, source, commenter, start_date, end_date, limit):
    """単語なしの時: 新しい配信から順に見ていき、limit件集まったら打ち切る"""
    date_condition = ""
    date_params = []
    if start_date:
        date_condition += " AND stream_date >= ?"
        date_params.append(start_date)
    if end_date:
        date_condition += " AND stream_date <= ?"
        date_params.append(end_date)

    streams = conn.execute(
        f"""
        SELECT stream_key, stream_date, title, youtube_video_id
        FROM streams
        WHERE stream_date IS NOT NULL {date_condition}
        ORDER BY stream_date DESC
        """,
        date_params,
    ).fetchall()

    commenter_condition = ""
    commenter_params = []
    if commenter:
        commenter_condition = " AND (com.display_name LIKE ? OR com.login_name LIKE ?)"
        commenter_params = [f"%{commenter}%", f"%{commenter}%"]

    want_chat = source in ("all", "chat")
    want_transcript = source in ("all", "transcript") and not commenter

    results = []

    for s in streams:
        if len(results) >= limit:
            break  # 十分な件数が集まったので、これ以上古い配信は見に行かない

        if want_chat:
            remaining = limit - len(results)
            rows = conn.execute(
                f"""
                SELECT c.body AS text, c.offset_seconds, c.stream_key, com.display_name AS commenter_name
                FROM chat_messages c
                LEFT JOIN commenters com ON com.user_id = c.user_id
                WHERE c.stream_key = ? {commenter_condition}
                ORDER BY c.offset_seconds DESC
                LIMIT ?
                """,
                (s["stream_key"], *commenter_params, remaining),
            ).fetchall()
            for row in rows:
                results.append({
                    "source": "chat",
                    "text": row["text"],
                    "offset_seconds": int(row["offset_seconds"] or 0),
                    "stream_key": s["stream_key"],
                    "title": s["title"],
                    "stream_date": s["stream_date"],
                    "commenter_name": row["commenter_name"],
                    "youtube_url": (
                        f'https://youtu.be/{s["youtube_video_id"]}?t={int(row["offset_seconds"] or 0)}'
                        if s["youtube_video_id"] else None
                    ),
                })

        if want_transcript and len(results) < limit:
            remaining = limit - len(results)
            rows = conn.execute(
                """
                SELECT t.text AS text, t.start_seconds AS offset_seconds
                FROM transcript_segments t
                WHERE t.stream_key = ?
                ORDER BY t.start_seconds DESC
                LIMIT ?
                """,
                (s["stream_key"], remaining),
            ).fetchall()
            for row in rows:
                results.append({
                    "source": "transcript",
                    "text": row["text"],
                    "offset_seconds": int(row["offset_seconds"] or 0),
                    "stream_key": s["stream_key"],
                    "title": s["title"],
                    "stream_date": s["stream_date"],
                    "commenter_name": None,
                    "youtube_url": (
                        f'https://youtu.be/{s["youtube_video_id"]}?t={int(row["offset_seconds"] or 0)}'
                        if s["youtube_video_id"] else None
                    ),
                })

    return results


@app.route("/api/search")
def search():
    q = (request.args.get("q") or "").strip()
    start_date = (request.args.get("start") or "").strip()
    end_date = (request.args.get("end") or "").strip()
    source = (request.args.get("source") or "all").strip()      # all / chat / transcript
    commenter = (request.args.get("commenter") or "").strip()   # 発言者名の部分一致

    limit = 300
    conn = get_conn()

    if not q:
        # 単語なし: 配信を新しい順に見ていき、該当件数が集まった時点で打ち切る(早期終了)
        results = browse_recent(conn, source, commenter, start_date, end_date, limit)
        conn.close()
        return jsonify({"query": q, "count": len(results), "results": results})

    is_short = len(q) < 3

    date_condition = ""
    date_params = []
    if start_date:
        date_condition += " AND s.stream_date >= ?"
        date_params.append(start_date)
    if end_date:
        date_condition += " AND s.stream_date <= ?"
        date_params.append(end_date)

    commenter_condition = ""
    commenter_params = []
    if commenter:
        commenter_condition = " AND (com.display_name LIKE ? OR com.login_name LIKE ?)"
        commenter_params = [f"%{commenter}%", f"%{commenter}%"]

    chat_rows = []
    transcript_rows = []

    want_chat = source in ("all", "chat")
    want_transcript = source in ("all", "transcript") and not commenter

    if want_chat:
        if is_short:
            like_query = f"%{q}%"
            chat_rows = conn.execute(
                f"""
                SELECT c.body AS text, c.offset_seconds, c.stream_key, s.title, s.youtube_video_id,
                       s.stream_date, com.display_name AS commenter_name
                FROM chat_messages c
                JOIN streams s ON s.stream_key = c.stream_key
                LEFT JOIN commenters com ON com.user_id = c.user_id
                WHERE c.body LIKE ? {date_condition} {commenter_condition}
                ORDER BY s.stream_date DESC, c.offset_seconds
                LIMIT ?
                """,
                (like_query, *date_params, *commenter_params, limit),
            ).fetchall()
        else:
            match_query = '"' + q.replace('"', '""') + '"'
            chat_rows = conn.execute(
                f"""
                SELECT c.body AS text, c.offset_seconds, c.stream_key, s.title, s.youtube_video_id,
                       s.stream_date, com.display_name AS commenter_name
                FROM chat_fts f
                JOIN chat_messages c ON c.rowid = f.rowid
                JOIN streams s ON s.stream_key = c.stream_key
                LEFT JOIN commenters com ON com.user_id = c.user_id
                WHERE chat_fts MATCH ? {date_condition} {commenter_condition}
                ORDER BY s.stream_date DESC, c.offset_seconds
                LIMIT ?
                """,
                (match_query, *date_params, *commenter_params, limit),
            ).fetchall()

    if want_transcript:
        if is_short:
            like_query = f"%{q}%"
            transcript_rows = conn.execute(
                f"""
                SELECT t.text AS text, t.start_seconds AS offset_seconds, t.stream_key, s.title, s.youtube_video_id,
                       s.stream_date
                FROM transcript_segments t
                JOIN streams s ON s.stream_key = t.stream_key
                WHERE t.text LIKE ? {date_condition}
                ORDER BY s.stream_date DESC, t.start_seconds
                LIMIT ?
                """,
                (like_query, *date_params, limit),
            ).fetchall()
        else:
            match_query = '"' + q.replace('"', '""') + '"'
            transcript_rows = conn.execute(
                f"""
                SELECT t.text AS text, t.start_seconds AS offset_seconds, t.stream_key, s.title, s.youtube_video_id,
                       s.stream_date
                FROM transcript_fts f
                JOIN transcript_segments t ON t.id = f.rowid
                JOIN streams s ON s.stream_key = t.stream_key
                WHERE transcript_fts MATCH ? {date_condition}
                ORDER BY s.stream_date DESC, t.start_seconds
                LIMIT ?
                """,
                (match_query, *date_params, limit),
            ).fetchall()

    conn.close()

    results = fmt_rows(chat_rows, "chat") + fmt_rows(transcript_rows, "transcript")
    return jsonify({"query": q, "count": len(results), "results": results})


PAGE_HTML = """
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>データベース検索(ローカル版)</title>
<style>
    :root { --primary-color: #6441a5; --bg-color: #f8f9fa; }
    body { margin: 0; font-family: sans-serif; background-color: var(--bg-color); }
    header { background-color: var(--primary-color); color: white; padding: 15px 25px; font-weight: bold; font-size: 1.1rem; }
    main { max-width: 900px; margin: 0 auto; padding: 25px; }
    .search-area { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); margin-bottom: 8px; display: flex; gap: 15px; flex-wrap: wrap; align-items: flex-end; }
    .search-area input, .search-area select { padding: 10px 12px; border: 2px solid transparent; outline: 1px solid #ccc; border-radius: 6px; font-size: 15px; font-family: inherit; box-sizing: border-box; }
    .search-area input:focus, .search-area select:focus { outline: none; border: 2px solid var(--primary-color); }
    #query { flex: 1; min-width: 200px; }
    .field-group { display: flex; flex-direction: column; gap: 3px; }
    .field-group label { font-size: 12px; color: #666; }
    .search-btn { background-color: var(--primary-color); color: white; border: none; padding: 0 24px; height: 42px; border-radius: 6px; font-weight: bold; cursor: pointer; }
    .search-btn:hover { background-color: #7b59c0; }
    .search-hint { font-size: 12.5px; color: #999; margin: 0 0 15px 2px; }
    #status { font-size: 14px; color: #666; margin-bottom: 15px; }
    .result-card { background: white; border-radius: 8px; padding: 15px 18px; margin-bottom: 12px; box-shadow: 0 2px 6px rgba(0,0,0,0.06); }
    .result-meta { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 6px; flex-wrap: wrap; }
    .result-meta-left { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .badge { display: inline-block; font-size: 11px; font-weight: bold; padding: 3px 8px; border-radius: 10px; color: white; }
    .badge-chat { background-color: #6441a5; }
    .badge-transcript { background-color: #2a9d8f; }
    .result-title { font-weight: bold; color: #333; font-size: 14px; }
    .result-side { font-size: 12.5px; color: #888; text-align: right; white-space: nowrap; }
    .result-body { font-size: 15px; color: #222; line-height: 1.5; margin-bottom: 8px; word-break: break-word; }
    .result-link { display: inline-block; font-size: 13px; font-weight: bold; color: var(--primary-color); text-decoration: none; }
    .result-link:hover { text-decoration: underline; }
</style>
</head>
<body>
<header>🗄️ データベース検索(ローカル版)</header>
<main>
    <div class="search-area">
        <div class="field-group" style="flex:1; min-width:200px;">
            <label>検索ワード(空欄可)</label>
            <input type="text" id="query" placeholder="発言・字幕を検索(例: おつかれ)">
        </div>
        <button class="search-btn" id="search-btn">検索</button>
    </div>
    <div class="search-area" style="margin-top: 0;">
        <div class="field-group">
            <label>開始日(空欄可)</label>
            <input type="date" id="startDate">
        </div>
        <div class="field-group">
            <label>終了日(空欄可)</label>
            <input type="date" id="endDate">
        </div>
        <div class="field-group">
            <label>対象</label>
            <select id="sourceFilter">
                <option value="all">すべて</option>
                <option value="chat">チャットのみ</option>
                <option value="transcript">字幕のみ</option>
            </select>
        </div>
        <div class="field-group">
            <label>発言者名(部分一致)</label>
            <input type="text" id="commenterFilter" placeholder="例: たろう">
        </div>
    </div>
    <p class="search-hint">※検索ワードが空欄の場合、新しい配信から順に一覧表示します(発言者名だけで絞り込む時などに便利です)。3文字未満のワードはLIKE検索になり少し時間がかかります。発言者名を指定すると字幕は検索対象から外れます。</p>
    <p id="status">単語を入力するか、期間・発言者などで絞り込んで検索してください。</p>
    <div id="results"></div>
</main>
<script>
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str ?? '';
        return div.innerHTML;
    }
    function formatTime(seconds) {
        seconds = Math.floor(seconds || 0);
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        const pad = (n) => String(n).padStart(2, '0');
        return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
    }
    async function runSearch() {
        const q = document.getElementById('query').value.trim();
        const startDate = document.getElementById('startDate').value;
        const endDate = document.getElementById('endDate').value;
        const source = document.getElementById('sourceFilter').value;
        const commenter = document.getElementById('commenterFilter').value.trim();
        const statusEl = document.getElementById('status');
        const resultsEl = document.getElementById('results');
        resultsEl.innerHTML = '';
        statusEl.textContent = '検索中...';
        try {
            const params = new URLSearchParams({ q, source });
            if (startDate) params.set('start', startDate);
            if (endDate) params.set('end', endDate);
            if (commenter) params.set('commenter', commenter);
            const res = await fetch(`/api/search?${params.toString()}`);
            const data = await res.json();
            if (data.error) { statusEl.textContent = data.error; return; }
            statusEl.textContent = q ? `「${q}」の検索結果: ${data.count}件` : `一覧: ${data.count}件`;
            if (data.count === 0) { resultsEl.innerHTML = '<p>該当する発言・字幕は見つかりませんでした。</p>'; return; }
            resultsEl.innerHTML = data.results.map(r => {
                const badgeClass = r.source === 'chat' ? 'badge-chat' : 'badge-transcript';
                const badgeText = r.source === 'chat' ? 'チャット' : '字幕';
                const linkHtml = r.youtube_url
                    ? `<a href="${escapeHtml(r.youtube_url)}" class="result-link" target="_blank" rel="noopener">▶ ${formatTime(r.offset_seconds)}から見る</a>`
                    : `<span>${formatTime(r.offset_seconds)}</span>`;
                const nameHtml = r.commenter_name ? escapeHtml(r.commenter_name) : (r.source === 'chat' ? '(名前不明)' : '');
                return `<div class="result-card">
                    <div class="result-meta">
                        <div class="result-meta-left">
                            <span class="badge ${badgeClass}">${badgeText}</span>
                            <span class="result-title">${escapeHtml(r.title || r.stream_key)}</span>
                        </div>
                        <div class="result-side">
                            ${r.stream_date ? escapeHtml(r.stream_date) : ''}${nameHtml ? ' ・ ' + nameHtml : ''}
                        </div>
                    </div>
                    <div class="result-body">${escapeHtml(r.text)}</div>
                    ${linkHtml}
                </div>`;
            }).join('');
        } catch (err) {
            statusEl.textContent = '検索に失敗しました。';
        }
    }
    document.getElementById('search-btn').addEventListener('click', runSearch);
    document.getElementById('query').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
</script>
</body>
</html>
"""


@app.route("/")
def index():
    return Response(PAGE_HTML, mimetype="text/html")


if __name__ == "__main__":
    print("起動しました。ブラウザで http://127.0.0.1:5000 を開いてください。")
    print("終了するには、このウィンドウで Ctrl+C を押してください。")
    app.run(port=5000, debug=False)