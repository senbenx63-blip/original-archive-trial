import os
import subprocess
from datetime import datetime, timedelta
import requests

# ================= 設定エリア =================
TWITCH_DOWNLOADER_PATH = r"C:\Users\掛布一世\Documents\yt-dlp\TwitchDownloaderGUI-1.56.2-Windows-x64\TwitchDownloaderCLI.exe"
TWITCH_CLIENT_ID = "lzy7q8tj4a98tflgfhjllo9zes6uez"
TWITCH_CLIENT_SECRET = "enrmys7fdtrg490peflrz8y6xdtwdx"
STREAMER_ID = "650695446"
# ベース出力ディレクトリ（この下の json/年号 フォルダに保存されます）
BASE_OUTPUT_DIRECTORY = r"C:\Users\掛布一世\Desktop\original archive trial"
JSON_OUTPUT_DIRECTORY = os.path.join(BASE_OUTPUT_DIRECTORY, "json")
# ============================================

def get_twitch_access_token(client_id, client_secret):
    url = "https://id.twitch.tv/oauth2/token"
    params = {
        "client_id": client_id,
        "client_secret": client_secret,
        "grant_type": "client_credentials",
    }
    response = requests.post(url, params=params)
    response.raise_for_status()
    return response.json()["access_token"]


def get_all_vods(user_id, headers):
    vods = []
    url = "https://api.twitch.tv/helix/videos"
    params = {"user_id": user_id, "first": 100}

    while True:
        response = requests.get(url, headers=headers, params=params)
        response.raise_for_status()
        res_data = response.json()

        vods.extend(res_data["data"])

        if "pagination" in res_data and "cursor" in res_data["pagination"]:
            params["after"] = res_data["pagination"]["cursor"]
        else:
            break

    return vods


def download_chat(vod_id, output_filename):
    command = [
        TWITCH_DOWNLOADER_PATH,
        "chatdownload",
        "-u",
        str(vod_id),
        "-o",
        output_filename,
    ]

    print(f"ダウンロード中: {os.path.basename(output_filename)} (VOD ID: {vod_id})...")
    try:
        subprocess.run(command, capture_output=True, text=True, check=True, timeout=180)
        
        # ダウンロード直後に0バイトチェック
        if os.path.exists(output_filename) and os.path.getsize(output_filename) == 0:
            print(f"警告: 取得したファイルが0バイトのため削除します: {os.path.basename(output_filename)}")
            os.remove(output_filename)
        else:
            print(f"完了: {os.path.basename(output_filename)}")
            
    except subprocess.TimeoutExpired:
        print(f"タイムアウト: 応答がないため処理をスキップしました (VOD ID: {vod_id})")
        if os.path.exists(output_filename) and os.path.getsize(output_filename) == 0:
            os.remove(output_filename)
    except subprocess.CalledProcessError as e:
        print(f"エラーが発生しました (VOD ID: {vod_id}): {e.stderr}")
        if os.path.exists(output_filename) and os.path.getsize(output_filename) == 0:
            os.remove(output_filename)


def remove_empty_files_recursive(directory):
    """指定ディレクトリおよびそのサブディレクトリ内の0バイトファイルをすべて削除する関数"""
    if not os.path.exists(directory):
        return
    
    deleted_count = 0
    for root, _, files in os.walk(directory):
        for filename in files:
            file_path = os.path.join(root, filename)
            if os.path.isfile(file_path) and os.path.getsize(file_path) == 0:
                os.remove(file_path)
                print(f"事前チェック: 不完全な0バイトファイルを削除しました -> {filename}")
                deleted_count += 1
            
    if deleted_count > 0:
        print(f"合計 {deleted_count} 件の0バイトファイルをクリーンアップしました。\n")


def find_file_in_subdirectories(base_dir, target_filename):
    """
    base_dir 配下（下層含む）に target_filename が存在するか検索する。
    存在し、かつサイズが0より大きければそのフルパスを返す。なければ None を返す。
    """
    if not os.path.exists(base_dir):
        return None

    for root, _, files in os.walk(base_dir):
        if target_filename in files:
            full_path = os.path.join(root, target_filename)
            if os.path.getsize(full_path) > 0:
                return full_path
    return None


def main():
    if not os.path.exists(TWITCH_DOWNLOADER_PATH):
        print(f"エラー: TwitchDownloaderCLI.exe が指定されたパスに見つかりません。\nパス: {TWITCH_DOWNLOADER_PATH}")
        return

    os.makedirs(JSON_OUTPUT_DIRECTORY, exist_ok=True)

    # 1. 処理開始前に既存の0バイトファイルを全自動削除（下層含めて探索）
    remove_empty_files_recursive(BASE_OUTPUT_DIRECTORY)

    print("Twitchから配信一覧を取得しています...")
    token = get_twitch_access_token(TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET)
    headers = {"Client-ID": TWITCH_CLIENT_ID, "Authorization": f"Bearer {token}"}

    vods = get_all_vods(STREAMER_ID, headers)
    
    # 2か月（60日）前の基準日時（UTC）を設定
    two_months_ago_utc = datetime.utcnow() - timedelta(days=60)
    
    # 直近2ヶ月以内のVODのみにフィルタリング
    recent_vods = []
    for vod in vods:
        created_at_dt = datetime.strptime(vod["created_at"], "%Y-%m-%dT%H:%M:%SZ")
        if created_at_dt >= two_months_ago_utc:
            recent_vods.append(vod)

    recent_vods.reverse()  # 古い順に並び替え

    print(f"全 {len(vods)} 件中、過去2ヶ月以内のアーカイブ {len(recent_vods)} 件が見つかりました。処理を開始します。")

    date_counter = {}

    for vod in recent_vods:
        vod_id = vod["id"]
        created_at_str = vod["created_at"]
        vod_status = vod.get("status", "completed")

        dt_utc = datetime.strptime(created_at_str, "%Y-%m-%dT%H:%M:%SZ")
        dt_jst = dt_utc + timedelta(hours=9)
        
        # MMDDYY 形式
        formatted_date = dt_jst.strftime("%m%d%y")

        # 年号（下2桁）を取得して「20XX」形式のフォルダパスを作成
        year_str = f"20{formatted_date[-2:]}"
        target_year_directory = os.path.join(JSON_OUTPUT_DIRECTORY, year_str)
        os.makedirs(target_year_directory, exist_ok=True)

        if formatted_date not in date_counter:
            date_counter[formatted_date] = 1
            suffix = ""
        else:
            date_counter[formatted_date] += 1
            suffix = f"-{date_counter[formatted_date]}"

        base_filename = f"{formatted_date}{suffix}"

        # 配信中の場合
        if vod_status != "completed":
            live_filename = f"{base_filename}_LIVE.json"
            output_path_live = os.path.join(target_year_directory, live_filename)
            
            # 下層含めて既存ファイルをチェック
            existing_live_path = find_file_in_subdirectories(BASE_OUTPUT_DIRECTORY, live_filename)
            if existing_live_path:
                print(f"スキップ (既にLIVE版が存在します): {live_filename}")
                continue

            print(f"配信中の動画を検出しました（末尾に _LIVE を付けて保存します）: {live_filename}")
            download_chat(vod_id, output_path_live)
            continue

        # 配信終了の場合
        final_filename = f"{base_filename}.json"
        output_path_final = os.path.join(target_year_directory, final_filename)
        
        # 下層含めて古い _LIVE ファイルを探して削除
        old_live_filename = f"{base_filename}_LIVE.json"
        existing_live_path = find_file_in_subdirectories(BASE_OUTPUT_DIRECTORY, old_live_filename)
        if existing_live_path and os.path.exists(existing_live_path):
            print("配信終了を確認したため、古い途中経過ファイル(_LIVE)を削除します。")
            os.remove(existing_live_path)

        # 下層フォルダ含めて正常な完全版が存在する場合はスキップ
        existing_final_path = find_file_in_subdirectories(BASE_OUTPUT_DIRECTORY, final_filename)
        if existing_final_path:
            print(f"スキップ (既に完全版が存在します: {existing_final_path}): {final_filename}")
            continue

        print(f"配信終了版（完全版）を保存します [{year_str}年]: {final_filename}")
        download_chat(vod_id, output_path_final)

    print("\nすべての処理が終了しました！")


if __name__ == "__main__":
    main()