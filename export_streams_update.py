import sqlite3
from pathlib import Path

conn = sqlite3.connect("chama_archive.db")
conn.row_factory = sqlite3.Row
rows = conn.execute(
    """SELECT stream_key, video_id, title, game, streamer_name, streamer_login,
              streamer_id, created_at, length_seconds, view_count,
              source_chat_file, source_transcript_file, youtube_video_id, youtube_url
       FROM streams"""
).fetchall()
conn.close()


def esc(v):
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return str(v)
    v = str(v).replace("'", "''")
    return f"'{v}'"


cols = ["video_id", "title", "game", "streamer_name", "streamer_login", "streamer_id",
        "created_at", "length_seconds", "view_count", "source_chat_file",
        "source_transcript_file", "youtube_video_id", "youtube_url"]

lines = []
for r in rows:
    set_clause = ", ".join(f"{c} = {esc(r[c])}" for c in cols)
    stmt = f"UPDATE streams SET {set_clause} WHERE stream_key = {esc(r['stream_key'])};"
    lines.append(stmt)

out_path = Path("d1_export/data_streams_update.sql")
out_path.write_text("\n".join(lines), encoding="utf-8")
print(f"{len(lines)}件を書き出しました → {out_path}")