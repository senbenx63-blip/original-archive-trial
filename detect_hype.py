import sqlite3

DB_PATH = "chama_archive.db"
BUCKET_SECONDS = 60   # 何秒ごとに区切るか
MULTIPLIER = 2.5       # 平均の何倍を「盛り上がり」とするか
MIN_COUNT = 5          # これ未満の発言数は、倍率を満たしても対象外


def main():
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS hype_segments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            stream_key TEXT NOT NULL REFERENCES streams(stream_key),
            start_seconds INTEGER,
            end_seconds INTEGER,
            message_count INTEGER
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_hype_stream ON hype_segments(stream_key, start_seconds)")
    conn.execute("DELETE FROM hype_segments")  # 毎回作り直す(古い判定結果は消してやり直す)

    stream_keys = [r[0] for r in conn.execute("SELECT stream_key FROM streams")]
    total_segments = 0

    for stream_key in stream_keys:
        offsets = [
            r[0] for r in conn.execute(
                "SELECT offset_seconds FROM chat_messages WHERE stream_key = ?", (stream_key,)
            ).fetchall()
            if r[0] is not None
        ]
        if len(offsets) < MIN_COUNT:
            continue

        max_offset = max(offsets)
        num_buckets = int(max_offset // BUCKET_SECONDS) + 1
        counts = [0] * num_buckets
        for o in offsets:
            counts[int(o // BUCKET_SECONDS)] += 1

        avg = sum(counts) / num_buckets
        threshold = max(MIN_COUNT, avg * MULTIPLIER)
        is_hype = [c >= threshold for c in counts]

        i = 0
        while i < num_buckets:
            if is_hype[i]:
                start_bucket = i
                total_count = counts[i]
                j = i + 1
                while j < num_buckets and is_hype[j]:
                    total_count += counts[j]
                    j += 1
                conn.execute(
                    "INSERT INTO hype_segments (stream_key, start_seconds, end_seconds, message_count) VALUES (?, ?, ?, ?)",
                    (stream_key, start_bucket * BUCKET_SECONDS, j * BUCKET_SECONDS, total_count),
                )
                total_segments += 1
                i = j
            else:
                i += 1

    conn.commit()
    conn.close()
    print(f"{total_segments}件の盛り上がり区間を検出しました。")


if __name__ == "__main__":
    main()