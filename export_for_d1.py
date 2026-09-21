import sqlite3
from pathlib import Path

DB_PATH = "chama_archive.db"
OUT_DIR = Path("d1_export")
OUT_DIR.mkdir(exist_ok=True)

EXCLUDE_KEYWORDS = ("fts", "sqlite_sequence")
TABLES = ["streams", "commenters", "chat_messages", "transcript_segments"]

conn = sqlite3.connect(DB_PATH)

schema_lines = []
data_lines = {table: [] for table in TABLES}

for line in conn.iterdump():
    stripped = line.strip()

    # トランザクション行・PRAGMA行はD1では使えないので除外
    if stripped in ("BEGIN TRANSACTION;", "COMMIT;"):
        continue
    if stripped.startswith("PRAGMA"):
        continue
    # FTS関連のテーブル・トリガーは除外(後でD1側に作り直す)
    if any(k in stripped.lower() for k in EXCLUDE_KEYWORDS):
        continue

    matched = False
    if stripped.startswith("INSERT INTO"):
        for table in TABLES:
            if f'INSERT INTO "{table}"' in stripped or f"INSERT INTO {table} " in stripped:
                data_lines[table].append(line)
                matched = True
                break
    if not matched:
        schema_lines.append(line)

conn.close()

(OUT_DIR / "schema.sql").write_text("\n".join(schema_lines), encoding="utf-8")
for table, lines in data_lines.items():
    (OUT_DIR / f"data_{table}.sql").write_text("\n".join(lines), encoding="utf-8")

print("書き出し完了:")
for f in sorted(OUT_DIR.glob("*.sql")):
    size_mb = f.stat().st_size / 1024 / 1024
    print(f"  {f.name}: {size_mb:.1f} MB")