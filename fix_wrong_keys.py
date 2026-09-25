import sqlite3

DB_PATH = "chama_archive.db"

WRONG_KEYS = [
    "070922", "071022", "071122", "071322",
    "071522", "072222", "072422", "072422-2", "072922",
]

conn = sqlite3.connect(DB_PATH)
for key in WRONG_KEYS:
    c1 = conn.execute("DELETE FROM chat_messages WHERE stream_key = ?", (key,)).rowcount
    c2 = conn.execute("DELETE FROM transcript_segments WHERE stream_key = ?", (key,)).rowcount
    c3 = conn.execute("DELETE FROM streams WHERE stream_key = ?", (key,)).rowcount
    print(f"{key}: chat_messages {c1}件、transcript_segments {c2}件、streams {c3}件を削除")
conn.commit()
conn.close()
print("完了")