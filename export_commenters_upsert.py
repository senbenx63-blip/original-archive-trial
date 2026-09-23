import sqlite3
from pathlib import Path

conn = sqlite3.connect("chama_archive.db")
conn.row_factory = sqlite3.Row
rows = conn.execute(
    "SELECT user_id, login_name, display_name, bio, logo_url FROM commenters"
).fetchall()
conn.close()


def esc(v):
    """SQL文の中に安全に埋め込める形に変換する"""
    if v is None:
        return "NULL"
    v = str(v).replace("'", "''")  # シングルクォートは2つ重ねてエスケープ
    return f"'{v}'"


lines = []
for r in rows:
    values = ", ".join(esc(r[c]) for c in ["user_id", "login_name", "display_name", "bio", "logo_url"])
    stmt = (
        "INSERT INTO commenters (user_id, login_name, display_name, bio, logo_url) "
        f"VALUES ({values}) "
        "ON CONFLICT(user_id) DO UPDATE SET "
        "login_name=excluded.login_name, display_name=excluded.display_name, "
        "bio=excluded.bio, logo_url=excluded.logo_url;"
    )
    lines.append(stmt)

out_path = Path("d1_export/data_commenters_upsert.sql")
out_path.write_text("\n".join(lines), encoding="utf-8")
print(f"{len(lines)}件を書き出しました → {out_path}")