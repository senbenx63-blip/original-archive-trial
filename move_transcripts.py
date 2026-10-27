"""
Googleドライブ(Google Drive for desktop のストリーミング)の transcribe_out から、
「直近1時間に保存されたtxt」だけを、ローカルの保存先の年別フォルダ(2023 など)へ移動するスクリプト。
年は、ファイル名のコード(例: 081324-2 なら - より前の 081324)の下2桁から判定する。

使い方: このファイルをローカルPCで実行する(例: python move_transcripts.py)
"""
import re
import shutil
import time
from datetime import datetime
from pathlib import Path

# === 設定項目 ===
# 移動元: Google Drive for desktop で同期されている transcribe_out フォルダ
# (ドライブレターは環境によって違います。エクスプローラーで実際のパスを確認してください)
SOURCE_DIR = Path(r"H:\マイドライブ\original archive trial\transcribe_out")

# 移動先: ローカルの保存先(前の main.py の OUTPUT_BASE_DIR と同じ場所)
DEST_BASE_DIR = Path(r"C:\Users\掛布一世\Desktop\original archive trial\txt")

# 対象にするファイル: 実行した時点から、直近何時間以内に保存されたファイルか(ファイルの更新日時で判定)
#   1    : 直近1時間以内
#   0.5  : 直近30分以内
#   None : 時間で絞らず、すべてのファイルが対象
WITHIN_HOURS = 1

# True: コードの下2桁から年を判定して、2023 のような年別フォルダに振り分ける
# False: 年別に分けず、DEST_BASE_DIR 直下にそのまま置く
SORT_BY_YEAR = True

# 移動先に同名のファイルが既にある場合
#   "skip"      : 上書きせず、移動元のファイルもそのまま残す(YouTube字幕から作ったtxtを守りたい場合など)
#   "overwrite" : 上書きする
ON_CONFLICT = "skip"

# True にすると、移動ではなくコピーだけ行う(移動元のファイルは消さない)
COPY_ONLY = False

CODE_PATTERN = re.compile(r"^(\d{6})(-\d+)?$")


def is_recent(path: Path, cutoff) -> bool:
    """ファイルの更新日時が、cutoff(この時刻以降)に入っているかどうか"""
    if cutoff is None:
        return True
    return path.stat().st_mtime >= cutoff


def main():
    if not SOURCE_DIR.is_dir():
        print(f"[エラー] 移動元のフォルダが見つかりません: {SOURCE_DIR}")
        print("        Google Drive for desktop が起動していて、パスが合っているか確認してください。")
        return

    # transcribe_out 直下の .txt だけが対象
    # (json_cache の中や、書き込み途中の .tmp ファイルは対象外)
    files = sorted(SOURCE_DIR.glob("*.txt"))
    if not files:
        print("[完了] 移動するtxtファイルはありませんでした。")
        return

    cutoff = None if WITHIN_HOURS is None else time.time() - WITHIN_HOURS * 3600
    all_count = len(files)
    files = [f for f in files if is_recent(f, cutoff)]
    not_target = all_count - len(files)

    print(f"[開始] txtは全部で {all_count} 件。うち対象(直近に保存されたもの): {len(files)} 件")
    if cutoff is not None:
        since = datetime.fromtimestamp(cutoff).strftime("%Y-%m-%d %H:%M")
        print(f"        対象: 直近{WITHIN_HOURS}時間以内({since} 以降)に保存されたもの(対象外 {not_target} 件は触りません)")
    print(f"        移動元: {SOURCE_DIR}")
    print(f"        移動先: {DEST_BASE_DIR}\n")

    if not files:
        print("[完了] 対象の期間内に保存されたtxtファイルはありませんでした。")
        return

    moved = skipped = failed = unknown = 0

    for src in files:
        match = CODE_PATTERN.match(src.stem)

        if SORT_BY_YEAR:
            if not match:
                print(f"[スキップ] コードの形式が不明で年を判定できません(移動元に残します): {src.name}")
                unknown += 1
                continue
            year = "20" + match.group(1)[4:6]   # 下2桁を年として扱う
            dest_dir = DEST_BASE_DIR / year
        else:
            dest_dir = DEST_BASE_DIR

        dest = dest_dir / src.name

        try:
            if dest.exists() and ON_CONFLICT == "skip":
                print(f"[スキップ] 移動先に既に存在します: {dest}")
                skipped += 1
                continue

            dest_dir.mkdir(parents=True, exist_ok=True)

            # コピー → サイズ確認 → (移動の場合のみ)元ファイルを削除
            tmp_dest = dest.with_name(dest.name + ".part")
            shutil.copy2(src, tmp_dest)
            if tmp_dest.stat().st_size != src.stat().st_size:
                tmp_dest.unlink()
                raise OSError("コピー後のファイルサイズが一致しませんでした")
            tmp_dest.replace(dest)

            if COPY_ONLY:
                print(f"[コピー] {src.name} -> {dest}")
            else:
                src.unlink()
                print(f"[移動] {src.name} -> {dest}")
            moved += 1

        except Exception as e:
            print(f"[エラー] {src.name}: {e}")
            failed += 1

    print("\n==================================================")
    label = "コピー" if COPY_ONLY else "移動"
    print(f"[全行程完了] {label} {moved} 件 / スキップ {skipped} 件 / 年判定不能 {unknown} 件 / エラー {failed} 件")
    print("==================================================")


if __name__ == "__main__":
    main()
