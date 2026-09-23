import sqlite3
from pathlib import Path

DB_PATH = "chama_archive.db"
SYNCED_PATH = Path("d1_synced.txt")
OUT_DIR = Path("d1_export")
OUT_DIR.mkdir(exist_ok=True)


def esc(v):
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return str(v)
    v = str(v).replace("'", "''")
    return f"'{v}'"


def load_synced():
    if not SYNCED_PATH.exists():
        return set()
    return set(line.strip() for line in SYNCED_PATH.read_text(encoding="utf-8").splitlines() if line.strip())


def save_synced(keys):
    SYNCED_PATH.write_text("\n".join(sorted(keys)), encoding="utf-8")


def main():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    synced = load_synced()
    all_keys = {r["stream_key"] for r in conn.execute("SELECT stream_key FROM streams")}
    new_keys = all_keys - synced

    if not new_keys:
        # 前回分の古いファイルが残っていると誤って再送信される恐れがあるので削除しておく
        for name in ["new_streams.sql", "new_chat_messages.sql", "new_transcript_segments.sql", "commenters_upsert.sql"]:
            p = OUT_DIR / name
            if p.exists():
                p.unlink()
        print("新しく送るべき配信はありません。")
        return

    print(f"{len(new_keys)}件の新しい配信を書き出します。")
    new_keys_list = list(new_keys)
    placeholders = ",".join("?" for _ in new_keys_list)

    # streams(新しい配信のみ)
    stream_cols = ["stream_key", "video_id", "title", "game", "streamer_name", "streamer_login",
                   "streamer_id", "created_at", "length_seconds", "view_count",
                   "source_chat_file", "source_transcript_file", "youtube_video_id", "youtube_url"]
    rows = conn.execute(
        f"SELECT {', '.join(stream_cols)} FROM streams WHERE stream_key IN ({placeholders})",
        new_keys_list,
    ).fetchall()
    lines = [
        f"INSERT INTO streams ({', '.join(stream_cols)}) VALUES ({', '.join(esc(r[c]) for c in stream_cols)});"
        for r in rows
    ]
    (OUT_DIR / "new_streams.sql").write_text("\n".join(lines), encoding="utf-8")

    # chat_messages(新しい配信の分のみ)
    cols = ["comment_id", "stream_key", "user_id", "created_at", "offset_seconds", "body", "bits_spent", "user_color", "badges"]
    rows = conn.execute(
        f"SELECT {', '.join(cols)} FROM chat_messages WHERE stream_key IN ({placeholders})",
        new_keys_list,
    ).fetchall()
    lines = [
        f"INSERT INTO chat_messages ({', '.join(cols)}) VALUES ({', '.join(esc(r[c]) for c in cols)});"
        for r in rows
    ]
    (OUT_DIR / "new_chat_messages.sql").write_text("\n".join(lines), encoding="utf-8")

    # transcript_segments(新しい配信の分のみ)
    cols = ["stream_key", "start_seconds", "text"]
    rows = conn.execute(
        f"SELECT {', '.join(cols)} FROM transcript_segments WHERE stream_key IN ({placeholders})",
        new_keys_list,
    ).fetchall()
    lines = [
        f"INSERT INTO transcript_segments ({', '.join(cols)}) VALUES ({', '.join(esc(r[c]) for c in cols)});"
        for r in rows
    ]
    (OUT_DIR / "new_transcript_segments.sql").write_text("\n".join(lines), encoding="utf-8")

    # commenters(全件、上書き更新形式。件数が少ないので毎回まるごと送って問題なし)
    cols = ["user_id", "login_name", "display_name", "bio", "logo_url"]
    rows = conn.execute(f"SELECT {', '.join(cols)} FROM commenters").fetchall()
    lines = []
    for r in rows:
        values = ", ".join(esc(r[c]) for c in cols)
        lines.append(
            f"INSERT INTO commenters ({', '.join(cols)}) VALUES ({values}) "
            "ON CONFLICT(user_id) DO UPDATE SET "
            "login_name=excluded.login_name, display_name=excluded.display_name, "
            "bio=excluded.bio, logo_url=excluded.logo_url;"
        )
    (OUT_DIR / "commenters_upsert.sql").write_text("\n".join(lines), encoding="utf-8")

    conn.close()
    save_synced(all_keys)
    print("書き出し完了。d1_exportフォルダの以下のファイルを、この順番でD1に送ってください:")
    print("  new_streams.sql → commenters_upsert.sql → new_chat_messages.sql → new_transcript_segments.sql")


if __name__ == "__main__":
    main()