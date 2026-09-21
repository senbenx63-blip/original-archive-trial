import json
import re
import sqlite3
from pathlib import Path

DB_PATH = "chama_archive.db"
DATA_DIR = Path(__file__).parent

SCHEMA = """
CREATE TABLE IF NOT EXISTS streams (
    stream_key TEXT PRIMARY KEY,      -- ファイル名(例: '010226') これが配信の共通キー
    video_id TEXT UNIQUE,             -- Twitchの動画ID。jsonがない場合はNULL
    stream_date TEXT GENERATED ALWAYS AS (
        CASE
          WHEN stream_key GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]'
          THEN '20' || substr(stream_key,5,2) || '-' || substr(stream_key,1,2) || '-' || substr(stream_key,3,2)
          ELSE NULL
        END
    ) STORED,                         -- stream_keyから自動計算されるので手動でセット不要・不可
    title TEXT,
    game TEXT,
    streamer_name TEXT,
    streamer_login TEXT,
    streamer_id TEXT,
    created_at TEXT,
    length_seconds INTEGER,
    view_count INTEGER,
    source_chat_file TEXT,
    source_transcript_file TEXT
);

CREATE TABLE IF NOT EXISTS commenters (
    user_id TEXT PRIMARY KEY,
    login_name TEXT,
    display_name TEXT,
    bio TEXT,
    logo_url TEXT
);

CREATE TABLE IF NOT EXISTS chat_messages (
    comment_id TEXT PRIMARY KEY,
    stream_key TEXT NOT NULL REFERENCES streams(stream_key),
    user_id TEXT REFERENCES commenters(user_id),
    created_at TEXT,
    offset_seconds INTEGER,
    body TEXT,
    bits_spent INTEGER,
    user_color TEXT,
    badges TEXT
);

CREATE TABLE IF NOT EXISTS transcript_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_key TEXT NOT NULL REFERENCES streams(stream_key),
    start_seconds REAL,
    text TEXT
);

CREATE INDEX IF NOT EXISTS idx_streams_date ON streams(stream_date);
CREATE INDEX IF NOT EXISTS idx_chat_stream ON chat_messages(stream_key, offset_seconds);
CREATE INDEX IF NOT EXISTS idx_chat_user ON chat_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_transcript_stream ON transcript_segments(stream_key, start_seconds);

CREATE VIRTUAL TABLE IF NOT EXISTS chat_fts USING fts5(
    body, content='chat_messages', content_rowid='rowid', tokenize='trigram'
);
CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
    text, content='transcript_segments', content_rowid='id', tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS chat_ai AFTER INSERT ON chat_messages BEGIN
    INSERT INTO chat_fts(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER IF NOT EXISTS transcript_ai AFTER INSERT ON transcript_segments BEGIN
    INSERT INTO transcript_fts(rowid, text) VALUES (new.id, new.text);
END;
"""

TIMESTAMP_RE = re.compile(r"^\[(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)\]\s?(.*)$")


def ensure_stream_stub(conn: sqlite3.Connection, stem: str):
    """txtしか無い配信のために、streamsに行だけ作っておく(stream_dateは自動計算)"""
    conn.execute(
        "INSERT INTO streams (stream_key) VALUES (?) ON CONFLICT(stream_key) DO NOTHING",
        (stem,),
    )


def ingest_chat_json(conn: sqlite3.Connection, json_path: Path) -> str:
    stem = json_path.stem
    with open(json_path, encoding="utf-8") as f:
        data = json.load(f)

    video = data.get("video", {})
    streamer = data.get("streamer", {})
    video_id = str(video.get("id")) if video.get("id") else None

    conn.execute(
        """INSERT INTO streams
           (stream_key, video_id, title, game,
            streamer_name, streamer_login, streamer_id,
            created_at, length_seconds, view_count, source_chat_file)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(stream_key) DO UPDATE SET
             video_id = excluded.video_id,
             title = excluded.title,
             game = excluded.game,
             streamer_name = excluded.streamer_name,
             streamer_login = excluded.streamer_login,
             streamer_id = excluded.streamer_id,
             created_at = excluded.created_at,
             length_seconds = excluded.length_seconds,
             view_count = excluded.view_count,
             source_chat_file = excluded.source_chat_file""",
        (
            stem, video_id,
            video.get("title"), video.get("game"),
            streamer.get("name"), streamer.get("login"),
            str(streamer.get("id")) if streamer.get("id") else None,
            video.get("created_at"), video.get("length"), video.get("viewCount"),
            json_path.name,
        ),
    )

    for c in data.get("comments", []):
        commenter = c.get("commenter") or {}
        user_id = str(commenter.get("_id")) if commenter.get("_id") else None
        if user_id:
            conn.execute(
                """INSERT INTO commenters (user_id, login_name, display_name, bio, logo_url)
                   VALUES (?,?,?,?,?)
                   ON CONFLICT(user_id) DO UPDATE SET
                     login_name = excluded.login_name,
                     display_name = excluded.display_name,
                     bio = excluded.bio,
                     logo_url = excluded.logo_url""",
                (user_id, commenter.get("name"), commenter.get("display_name"),
                 commenter.get("bio"), commenter.get("logo")),
            )

        message = c.get("message") or {}
        badges = [b.get("_id") for b in message.get("user_badges", []) if b.get("_id")]

        conn.execute(
            """INSERT OR IGNORE INTO chat_messages
               (comment_id, stream_key, user_id, created_at, offset_seconds,
                body, bits_spent, user_color, badges)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (
                c.get("_id"), stem, user_id, c.get("created_at"),
                c.get("content_offset_seconds"), message.get("body"),
                message.get("bits_spent", 0), message.get("user_color"),
                json.dumps(badges, ensure_ascii=False) if badges else None,
            ),
        )

    return stem


def ingest_transcript_txt(conn: sqlite3.Connection, txt_path: Path, stem: str):
    ensure_stream_stub(conn, stem)  # jsonが無い場合、streams側の器をここで作る

    with open(txt_path, encoding="utf-8-sig") as f:
        lines = f.readlines()

    rows = []
    for line in lines:
        m = TIMESTAMP_RE.match(line.rstrip("\n"))
        if not m:
            continue
        h, mi, s, text = m.groups()
        seconds = int(h) * 3600 + int(mi) * 60 + float(s)
        text = text.strip()
        if text:
            rows.append((stem, seconds, text))

    conn.execute("DELETE FROM transcript_segments WHERE stream_key = ?", (stem,))
    conn.executemany(
        "INSERT INTO transcript_segments (stream_key, start_seconds, text) VALUES (?,?,?)",
        rows,
    )
    conn.execute(
        "UPDATE streams SET source_transcript_file = ? WHERE stream_key = ?",
        (txt_path.name, stem),
    )


def main():
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)

    json_files = {p.stem: p for p in DATA_DIR.rglob("*.json")}
    txt_files = {p.stem: p for p in DATA_DIR.rglob("*.txt")}
    all_stems = sorted(set(json_files) | set(txt_files))

    print(f"{len(all_stems)} 件のファイル(json/txt合計)を処理します")

    for i, stem in enumerate(all_stems, 1):
        json_path = json_files.get(stem)
        txt_path = txt_files.get(stem)

        if json_path:
            try:
                ingest_chat_json(conn, json_path)
            except Exception as e:
                conn.rollback()
                print(f"[ERROR] {json_path.name} のチャット処理に失敗: {e}")
        else:
            ensure_stream_stub(conn, stem)
            print(f"[INFO] {stem}.json が見つかりません(文字起こしのみ登録)")

        if txt_path:
            try:
                ingest_transcript_txt(conn, txt_path, stem)
            except Exception as e:
                conn.rollback()
                print(f"[ERROR] {txt_path.name} の文字起こし処理に失敗: {e}")
        else:
            print(f"[WARN] {stem}.txt が見つかりません(チャットのみ登録)")

        conn.commit()
        if i % 20 == 0:
            print(f"  {i}/{len(all_stems)} 完了")

    conn.close()
    print("完了しました。")


if __name__ == "__main__":
    main()