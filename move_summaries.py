"""
要約コードが Googleドライブの summaries フォルダに出力した要約txt(コード_summary.txt)を、
ローカルの保存先の年別フォルダ(2026 など)へコピー(または移動)するスクリプト。

年は、ファイル名のコード(例: 081324-2_summary.txt なら 081324-2 → - より前の 081324)の下2桁から判定する。

使い方: ローカルPCで実行する(例: python move_summaries.py)
"""
import re
import shutil
import time
from datetime import datetime
from pathlib import Path

# === 設定項目 ===
# 元の場所: Google Drive for desktop(ストリーミング)の summaries フォルダ
# (要約コードの OUT_DIR = /content/drive/MyDrive/summaries に対応する場所)
# ドライブレターは環境によって違います。エクスプローラーで実際のパスを確認してください
SOURCE_DIR = Path(r"G:\マイドライブ\summaries")

# 保存先: ローカルの要約の保存先(この下に 2026 のような年別フォルダができます)
DEST_BASE_DIR = Path(r"C:\Users\掛布一世\Desktop\original archive trial\summary")

# True : コピーだけ行う(Drive側のファイルは残す)  ← 初期設定
# False: 移動する(コピー後にDrive側のファイルを削除する)
#
# 【注意】要約コードは「OUT_DIR に コード_summary.txt があるか」だけで完了済みかを判断しています。
#        Drive側のファイルを削除(移動)すると、要約コードを全ファイル対象で実行したときに
#        未処理と判断して、同じファイルをもう一度要約してしまい、APIの無料枠を無駄に使います。
#        移動に切り替える場合は、要約コード側に完了の記録を持たせる修正をしてからにしてください。
COPY_ONLY = True

# 対象にするファイル: 実行した時点から、直近何時間以内に保存されたファイルか
#   None : 時間で絞らない(すべてが対象。コピー済みのものは下の ON_CONFLICT で飛ばされる)
#   1    : 直近1時間以内
WITHIN_HOURS = None

# 保存から何秒以内のファイルは、書き込み中の可能性があるので飛ばすか
MIN_AGE_SECONDS = 60

# 保存先に同名のファイルが既にある場合
#   "skip"      : 上書きしない(コピー済みのものを飛ばす)
#   "overwrite" : 上書きする(要約をやり直して更新した場合など)
ON_CONFLICT = "skip"

FILE_PATTERN = re.compile(r"^(\d{6})(-\d+)?_summary$")


def main():
    if not SOURCE_DIR.is_dir():
        print(f"[エラー] 元のフォルダが見つかりません: {SOURCE_DIR}")
        print("        Google Drive for desktop が起動していて、パスが合っているか確認してください。")
        return

    # summaries の中(年フォルダの中も含む)の「〜_summary.txt」だけが対象
    # (書き込み途中の .progress.json などは対象外)
    files = sorted(SOURCE_DIR.rglob("*_summary.txt"))
    if not files:
        print("[完了] 対象の要約txtはありませんでした。")
        return

    now = time.time()
    cutoff = None if WITHIN_HOURS is None else now - WITHIN_HOURS * 3600

    targets = []
    too_old = too_new = 0
    for f in files:
        mtime = f.stat().st_mtime
        if cutoff is not None and mtime < cutoff:
            too_old += 1
        elif now - mtime < MIN_AGE_SECONDS:
            too_new += 1   # 書き込み中の可能性があるので、次回に回す
        else:
            targets.append(f)

    label = "コピー" if COPY_ONLY else "移動"
    print(f"[開始] 要約txtは全部で {len(files)} 件。うち{label}の対象: {len(targets)} 件")
    if cutoff is not None:
        since = datetime.fromtimestamp(cutoff).strftime("%Y-%m-%d %H:%M")
        print(f"        直近{WITHIN_HOURS}時間以内({since} 以降)のもの(対象外 {too_old} 件)")
    if too_new:
        print(f"        保存から{MIN_AGE_SECONDS}秒以内のため今回は飛ばすもの: {too_new} 件")
    print(f"        元の場所: {SOURCE_DIR}")
    print(f"        保存先  : {DEST_BASE_DIR}")
    if not COPY_ONLY:
        print("        [注意] 移動モードです。Drive側から削除すると、要約コードが同じファイルを再要約する場合があります。")
    print()

    done = skipped = failed = unknown = 0

    for src in targets:
        match = FILE_PATTERN.match(src.stem)
        if not match:
            print(f"[スキップ] コードの形式が不明で年を判定できません: {src.name}")
            unknown += 1
            continue

        year = "20" + match.group(1)[4:6]   # 下2桁を年として扱う
        dest_dir = DEST_BASE_DIR / year
        dest = dest_dir / src.name

        try:
            if dest.exists() and ON_CONFLICT == "skip":
                skipped += 1   # コピー済み(静かにカウントだけ)
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
            done += 1

        except Exception as e:
            print(f"[エラー] {src.name}: {e}")
            failed += 1

    print("\n==================================================")
    print(f"[全行程完了] {label} {done} 件 / コピー済みでスキップ {skipped} 件 / 年判定不能 {unknown} 件 / エラー {failed} 件")
    print("==================================================")


if __name__ == "__main__":
    main()
