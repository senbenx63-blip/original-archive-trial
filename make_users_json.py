"""
chama_archive.db から、ユーザー名の候補ファイル users.json を作る。

使い方:
    python make_users_json.py
      → 同じフォルダに users.json ができる(chama_archive.db と同じフォルダで実行)
    できた users.json を word_search.html と同じフォルダ(GitHubリポジトリ)に置いて公開する。

- 名前は「表示名(空ならログイン名)」。チャットの発言数が多い人が先頭に来る(候補の並び順に使う)
- 同じ名前は1つにまとめる
- チャットのデータを追加した時は、もう一度実行して users.json を入れ替える
"""
import json
import sqlite3
import sys

DB_PATH = "chama_archive.db"
OUT_PATH = "users.json"

conn = sqlite3.connect(DB_PATH)
rows = conn.execute(
    """
    SELECT COALESCE(NULLIF(TRIM(cm.display_name), ''), NULLIF(TRIM(cm.login_name), '')) AS name,
           COUNT(*) AS n
    FROM chat_messages c
    JOIN commenters cm ON cm.user_id = c.user_id
    GROUP BY cm.user_id
    ORDER BY n DESC
    """
).fetchall()
conn.close()

names, seen = [], set()
for name, _n in rows:
    if not name or name in seen:
        continue
    seen.add(name)
    names.append(name)

with open(OUT_PATH, "w", encoding="utf-8") as f:
    json.dump(names, f, ensure_ascii=False, separators=(",", ":"))

size_kb = len(json.dumps(names, ensure_ascii=False).encode("utf-8")) / 1024
print(f"{len(names)}人分を {OUT_PATH} に書き出しました(約{size_kb:.0f}KB)", file=sys.stderr)