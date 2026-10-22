import csv
import datetime
import glob
import io
import os
import random
import re
import shutil
import subprocess
import time
import urllib.parse
import urllib.request
import json

# === 設定項目 ===
YTDLP_PATH = r"C:\Users\掛布一世\Documents\yt-dlp\yt-dlp.exe"
BATCH_FILE_PATH = "clean_vtt.bat"
SHEET_ID = "1yubpjM0sqNAjwRMCoiWDgdTeTrB8zZ2YyomA-z2fvVg"
# 処理対象シートは実行時の年とその前年を自動で決定（get_sheet_names参照）
G_COLUMN_INDEX = 6  # G列
L_COLUMN_INDEX = 11  # L列（完了マーク〇が入る列）

# GAS連携
GAS_URL = "https://script.google.com/macros/s/AKfycbw-hijdTiMoex-EbR6SYk6lPXIngthFinYhx0Dj0iWx_rlXEK-fNA_Wz4Sv9N3ra2-w/exec"  # コピーしたURL
GAS_SECRET = "チャマゲーム配信字幕"  # GASと同じ値

# 出力先ルートフォルダ
OUTPUT_BASE_DIR = r"C:\Users\掛布一世\Desktop\original archive trial\txt"

# 同期済みGoogleドライブの出力先ルートフォルダ
DRIVE_OUTPUT_BASE_DIR = r"H:\マイドライブ\original archive trial\transcribe_out"

# --- 安全設定（バランス調整版） ---
WAIT_MIN_SECONDS = 5  # 最小待機時間: 5秒
WAIT_MAX_SECONDS = 10  # 最大待機時間: 10秒

BATCH_SIZE_LIMIT = 10  # 10件ごとに休憩
COOLDOWN_SECONDS = 60  # 休憩時間: 60秒（1分）


def get_sheet_csv(sheet_name):
    url = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/gviz/tq?tqx=out:csv&sheet={urllib.parse.quote(sheet_name)}&range=A:L"
    print(f"[通信中] スプレッドシート「{sheet_name}」からデータを取得しています...")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as response:
        content = response.read().decode("utf-8")
    return csv.reader(io.StringIO(content))

def get_sheet_names():
    """現在の年と、その1年前の年をシート名として返す（例: 2026年なら ["2026", "2025"]）"""
    this_year = datetime.date.today().year
    names = [str(this_year), str(this_year - 1)]
    print(f"[対象シート] {', '.join(names)}")
    return names


def mark_done(sheet_name, g_cell_value):
    """スプレッドシートのL列に〇を記入"""
    payload = json.dumps({
        "secret": GAS_SECRET,
        "sheet": sheet_name,
        "g_value": g_cell_value,
    }).encode("utf-8")
    req = urllib.request.Request(
        GAS_URL, data=payload, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            result = res.read().decode("utf-8")
        print(f"[シート更新] L列に〇を記入: {result}")
    except Exception as e:
        print(f"[警告] L列の書き込みに失敗しました: {e}")


def extract_params(url_text):
    v_match = re.search(r"[?&]v=([^&]+)", url_text)
    d_match = re.search(r"[?&]d=([^&]+)", url_text)
    video_id = v_match.group(1) if v_match else None
    file_name = d_match.group(1) if d_match else None
    return video_id, file_name


def parse_code_and_year(code_str):
    """
    コード文字列を検証し、(整形後のコード文字列, 保存先年号フォルダパス) を返す
    例1: '092223' -> ('092223', '.../2023')
    例2: '092223-2' -> ('092223-2', '.../2023')
    """
    if not code_str:
        return None, None

    code_str = str(code_str).strip()

    match = re.match(r"^(\d{6})(-\d+)?$", code_str)
    if not match:
        if "-" in code_str:
            parts = code_str.split("-", 1)
            main_code = parts[0].zfill(6)
            code_str = f"{main_code}-{parts[1]}"
        elif code_str.isdigit() and len(code_str) < 6:
            code_str = code_str.zfill(6)

        match = re.match(r"^(\d{6})(-\d+)?$", code_str)

    if match:
        main_6digits = match.group(1)
        yy = main_6digits[4:6]  # 下2桁
        full_year = f"20{yy}"

        folder_path = os.path.join(OUTPUT_BASE_DIR, full_year)
        if not os.path.exists(folder_path):
            os.makedirs(folder_path, exist_ok=True)

        return code_str, folder_path

    return None, None


def get_drive_folder(target_folder):
    """
    デスクトップ側の年号フォルダパス（例: .../txt/2023）から年号を取り出し、
    Googleドライブ側の同じ年号フォルダを返す。なければ作成する。
    """
    year_name = os.path.basename(target_folder)  # 例: '2023'
    drive_folder = os.path.join(DRIVE_OUTPUT_BASE_DIR, year_name)
    os.makedirs(drive_folder, exist_ok=True)
    return drive_folder


def copy_to_drive(src_txt_path, code_str, target_folder):
    """txtファイルをGoogleドライブの年号フォルダへコピー（既存なら上書き）"""
    try:
        drive_folder = get_drive_folder(target_folder)
        drive_txt_path = os.path.join(drive_folder, f"{code_str}.txt")
        shutil.copy2(src_txt_path, drive_txt_path)
        print(f"[ドライブ] コピーしました: {drive_txt_path}")
        return True
    except Exception as e:
        print(f"[警告] Googleドライブへのコピーに失敗しました: {e}")
        return False


def download_transcript(video_id, output_prefix):
    youtube_url = f"https://www.youtube.com/watch?v={video_id}"

    cmd = [
        YTDLP_PATH,
        "--skip-download",
        "--write-auto-sub",
        "--sub-lang",
        "ja",
        "-o",
        output_prefix,
        "--user-agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        youtube_url,
    ]

    print(f"\n----------------------------------------")
    print(f"[DL開始] 動画ID: {video_id} | コード: {output_prefix}")
    result = subprocess.run(cmd, capture_output=True, text=True)

    if result.returncode != 0:
        print(f"[エラー] yt-dlp の取得に失敗しました (動画ID: {video_id})")
        return None

    downloaded_files = glob.glob(f"{output_prefix}*.vtt")

    if downloaded_files:
        original_file = downloaded_files[0]
        target_file = f"{output_prefix}.vtt"

        if original_file != target_file:
            if os.path.exists(target_file):
                os.remove(target_file)
            os.rename(original_file, target_file)

        print(f"[成功] vtt字幕取得完了: {target_file}")
        return target_file
    else:
        print(
            f"[警告] 字幕データが存在しませんでした (動画ID: {video_id})"
        )
        return None


def run_batch_and_move_txt(vtt_file, code_str, target_folder):
    """バッチファイルを実行し、生成された txt を指定フォルダへ移動後、vttを削除"""
    print(f'[バッチ実行] {BATCH_FILE_PATH} "{vtt_file}"')

    # input=b"\n" を渡すことで pause によるキー待ちを自動突破する
    subprocess.run(
        [BATCH_FILE_PATH, vtt_file],
        shell=True,
        input=b"\n",
        capture_output=True,
    )

    expected_txt = f"{code_str}.txt"

    if os.path.exists(expected_txt):
        dest_txt_path = os.path.join(target_folder, expected_txt)

        if os.path.exists(dest_txt_path):
            os.remove(dest_txt_path)

        # 指定年号フォルダへ移動
        os.rename(expected_txt, dest_txt_path)
        print(f"[完了] txtファイルを保存しました: {dest_txt_path}")

        # Googleドライブの年号フォルダへもコピー
        copy_to_drive(dest_txt_path, code_str, target_folder)

        # vttファイルの削除
        if os.path.exists(vtt_file):
            os.remove(vtt_file)
            print(f"[削除] 不要なvttファイルを削除しました: {vtt_file}")

        return True
    else:
        print(
            f"[エラー] バッチ処理後に {expected_txt} が出力されませんでした。"
        )
        return False


def main():
    if not os.path.exists(YTDLP_PATH) and not os.path.exists(
        YTDLP_PATH + ".exe"
    ):
        print(
            f"[エラー] yt-dlp が指定のパスに見つかりませんでした: {YTDLP_PATH}"
        )
        return

    if not os.path.exists(BATCH_FILE_PATH):
        print(
            f"[エラー] バッチファイルが見つかりません。同じフォルダーに {BATCH_FILE_PATH} を配置してください。"
        )
        return

    # Googleドライブ(Hドライブ)が接続されているか確認
    drive_root = os.path.splitdrive(DRIVE_OUTPUT_BASE_DIR)[0] + "\\"
    if not os.path.exists(drive_root):
        print(
            "[エラー] Googleドライブ(Hドライブ)が見つかりません。同期アプリを確認してください。"
        )
        return

    download_count = 0

    for sheet_name in get_sheet_names():
        try:
            csv_reader = get_sheet_csv(sheet_name)
        except Exception as e:
            print(f"[エラー] シート「{sheet_name}」の読み込みに失敗しました: {e}")
            continue

        skipped_done = 0  # L列に〇があって即スキップした連続件数

        for row_idx, row in enumerate(csv_reader, start=1):
            if len(row) <= G_COLUMN_INDEX or not row[G_COLUMN_INDEX].strip():
                continue

            # L列に何か書いてある（〇）行は、ファイル確認もGAS通信もせず即スキップ
            if len(row) > L_COLUMN_INDEX and row[L_COLUMN_INDEX].strip():
                skipped_done += 1
                continue

            # ここまで連続スキップした分をまとめて表示
            if skipped_done:
                print(f"[スキップ] L列〇済み {skipped_done} 件をまとめて飛ばしました")
                skipped_done = 0

            g_cell_value = row[G_COLUMN_INDEX].strip()
            video_id, raw_file_name = extract_params(g_cell_value)

            if not video_id or not raw_file_name:
                continue

            code_str, target_folder = parse_code_and_year(raw_file_name)
            if not code_str or not target_folder:
                print(
                    f"[スキップ] 年号判定不能なコードです: {raw_file_name}"
                )
                continue

            final_txt_path = os.path.join(target_folder, f"{code_str}.txt")

            # 既に保存先の年号フォルダに存在する場合はスキップ
            if os.path.exists(final_txt_path):
                print(f"[スキップ] 既に保存済みです: {final_txt_path}")

                # ドライブ側に無ければ補完コピー
                drive_txt_path = os.path.join(
                    DRIVE_OUTPUT_BASE_DIR,
                    os.path.basename(target_folder),
                    f"{code_str}.txt",
                )
                if not os.path.exists(drive_txt_path):
                    copy_to_drive(final_txt_path, code_str, target_folder)

                mark_done(sheet_name, g_cell_value)
                continue

            vtt_file = download_transcript(video_id, code_str)

            if vtt_file:
                success = run_batch_and_move_txt(vtt_file, code_str, target_folder)

                if success:
                    mark_done(sheet_name, g_cell_value)
                    download_count += 1

                    # 10件ごとのクールダウン
                    if (
                        download_count > 0
                        and download_count % BATCH_SIZE_LIMIT == 0
                    ):
                        print(
                            f"\n[安全装置] {download_count} 件取得したため、{COOLDOWN_SECONDS} 秒（1分）休憩します..."
                        )
                        time.sleep(COOLDOWN_SECONDS)
                    else:
                        # 通常のランダム待機（5〜10秒）
                        sleep_time = random.uniform(
                            WAIT_MIN_SECONDS, WAIT_MAX_SECONDS
                        )
                        print(
                            f"[待機] 次の動画まで {sleep_time:.1f} 秒待機中..."
                        )
                        time.sleep(sleep_time)

        # シート末尾まで連続でスキップした分を表示
        if skipped_done:
            print(f"[スキップ] L列〇済み {skipped_done} 件をまとめて飛ばしました")

    print("\n==================================================")
    print(
        f"[全行程完了] 新たに {download_count} 件の文字おこしテキストを保存しました。"
    )
    print("==================================================")


if __name__ == "__main__":
    main()