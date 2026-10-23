"""
Colab(要約・Gemini API)のノートブックを開いて実行し、認証ダイアログを自動で進める。
※ colab_autorun.py(文字起こし用)とは別ファイル。同じChromeプロファイルを使うので、2つを同時には実行しないこと。

事前準備:
    pip install playwright
    （Chrome本体を使うので playwright install は不要）

初回だけ手動ログイン:
    python colab_autorun.py --login
通常実行:
    python colab_autorun.py
"""
import os
import re
import sys
import time
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout, Error as PWError

# ===== 設定 =====
NOTEBOOK_URL = "https://colab.research.google.com/drive/1GkgAUXeCxcoovwabWJAO6WeV_u1dEC9p"
CHROME_EXE = r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"

# 自動化専用のユーザーデータフォルダ（普段使いの "User Data" とは別にする）
USER_DATA_DIR = r"C:\colab_chrome_data"
PROFILE_DIRECTORY = "Profile 3"  # 上のフォルダ内に作られるプロファイル名

# 特定のセルだけ実行したい場合はセルIDを入れる。空なら全セル実行(Ctrl+F9)
CELL_ID = ""

# 日本語と英語の両方を候補にする
DRIVE_BTN = re.compile(r"^(Google\s*ドライブに接続|Connect to Google Drive)$")
AUTH_BTN = re.compile(r"^(認証|Authorize)$")
NEXT_BTN = re.compile(r"^(次へ|Next)$")
SELECT_ALL = re.compile(r"(すべてを?選択|Select all)")


# 完了検知: Colab側が最後に「COLAB_ALL_」+「DONE または FAILED」+ 時刻 を出力する
DONE_PATTERN = re.compile(r"COLAB_ALL_(DONE|FAILED) (\d+)")
MAX_WAIT_SEC = 6 * 3600  # 最大待ち時間(秒)。超えたらエラー終了
POLL_SEC = 10
# 合図を検知してからブラウザを閉じるまでの猶予(秒)。
# Colab側のランタイム解放(UNASSIGN_WAIT_SEC + 解放処理)が終わるまで待つため、それより長くする
CLOSE_DELAY_SEC = 60
# 失敗・タイムアウト時に、Colabの出力をこのフォルダに保存する(ブラウザが閉じても原因を確認できるように)
LOG_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_PREFIX = "colab_last_output_summary"


def wait_for_done(page, start_epoch):
    """実行開始以降に出力された合図を待つ。
    戻り値: "DONE" / "FAILED" / None(タイムアウト)
    保存済みの前回出力に含まれる古い合図は、時刻で弾く。"""
    deadline = time.time() + MAX_WAIT_SEC
    while time.time() < deadline:
        for frame in page.frames:  # Colabの出力欄はiframeの中にある
            try:
                text = frame.locator("body").inner_text(timeout=2000)
            except Exception:
                continue
            for m in DONE_PATTERN.finditer(text):
                if int(m.group(2)) >= start_epoch - 60:
                    return m.group(1)
        time.sleep(POLL_SEC)
    return None


def dump_output(page):
    """Colabの出力(エラー内容を含む)をテキストとスクリーンショットで保存し、末尾を画面にも表示する。
    ブラウザを閉じたあとでも、失敗の原因を確認できるようにするため。"""
    main_frame = page.main_frame
    out_chunks, all_chunks = [], []
    for frame in page.frames:
        try:
            text = frame.locator("body").inner_text(timeout=3000)
        except Exception:
            continue
        all_chunks.append(text)
        if frame != main_frame:
            out_chunks.append(text)  # 出力欄(iframe)の中身

    txt_path = os.path.join(LOG_DIR, LOG_PREFIX + ".txt")
    png_path = os.path.join(LOG_DIR, LOG_PREFIX + ".png")
    try:
        with open(txt_path, "w", encoding="utf-8") as f:
            f.write("===== 出力欄 =====\n" + "\n\n".join(out_chunks))
            f.write("\n\n===== ページ全体 =====\n" + "\n\n".join(all_chunks))
        print(f"Colabの出力を保存しました: {txt_path}")
    except Exception as e:
        print(f"出力の保存に失敗しました: {e}")
    try:
        page.screenshot(path=png_path)
        print(f"スクリーンショットを保存しました: {png_path}")
    except Exception as e:
        print(f"スクリーンショットの保存に失敗しました: {e}")

    tail = [l for l in "\n".join(out_chunks).splitlines() if l.strip()][-30:]
    if tail:
        print("----- Colab出力の末尾 -----")
        print("\n".join(tail))
        print("---------------------------")


def is_visible(locator):
    try:
        return locator.is_visible()
    except Exception:
        return False


def advance_popup(popup, max_steps=5):
    """ポップアップ内で「すべて選択(あれば)→次へ」を、閉じるか押せなくなるまで繰り返す。"""
    try:
        popup.wait_for_load_state()
    except PWError:
        return  # すでに閉じている
    for step in range(max_steps):
        if popup.is_closed():
            return
        time.sleep(1.5)  # popup.wait_for_timeout は閉じた後に呼ぶと例外になるので使わない
        if popup.is_closed():
            return

        # 「すべて選択」は短時間の再認証だと出ないので、あれば押す
        try:
            cb = popup.get_by_role("checkbox", name=SELECT_ALL).first
            if is_visible(cb) and not cb.is_checked():
                cb.check()
                print("すべて選択")
        except Exception:
            pass

        try:
            btn = popup.get_by_role("button", name=NEXT_BTN).first
            btn.wait_for(state="visible", timeout=10_000)
            btn.click()
            print(f"次へ ({step + 1}回目)")
        except PWTimeout:
            print("次へが見つからないので、このポップアップは終了とみなします")
            return
        except Exception:
            return  # クリック直後にポップアップが閉じた場合など


def run_notebook(page):
    page.wait_for_load_state("domcontentloaded")
    if CELL_ID:
        cell = page.locator(f"#cell-{CELL_ID}")
        cell.wait_for(state="visible", timeout=60_000)
        cell.locator(".monaco-editor").first.click()
        page.keyboard.press("Control+Enter")
    else:
        page.wait_for_timeout(8000)  # ノートブックの読み込み待ち
        page.keyboard.press("Control+F9")  # すべてのセルを実行


def handle_dialogs(context, page, idle_seconds=25):
    """Colab側のダイアログ(ドライブ接続 / 認証情報の許可)が出たら順に処理する。
    順番はドライブ→認証情報の想定だが、出た順に対応する。"""
    last_activity = time.time()
    while time.time() - last_activity < idle_seconds:
        handled = False
        for name, pattern in (("ドライブ接続", DRIVE_BTN), ("認証情報の許可", AUTH_BTN)):
            btn = page.get_by_role("button", name=pattern).first
            if is_visible(btn):
                print(f"{name}ダイアログを検出")
                try:
                    with context.expect_page(timeout=30_000) as info:
                        btn.click()
                    advance_popup(info.value)
                    try:
                        page.bring_to_front()  # ポップアップが閉じたあと、Colabのタブを前面に戻す
                    except PWError:
                        pass
                except PWTimeout:
                    print("ポップアップが開きませんでした")
                except PWError:
                    pass  # 処理中にポップアップが閉じた(認証完了時の正常な動作)
                handled = True
                last_activity = time.time()
        if not handled:
            time.sleep(1)


def main():
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            USER_DATA_DIR,
            executable_path=CHROME_EXE,
            headless=False,
            no_viewport=True,
            ignore_default_args=["--enable-automation"],
            args=[
                f"--profile-directory={PROFILE_DIRECTORY}",
                "--disable-blink-features=AutomationControlled",
            ],
        )
        page = context.pages[0] if context.pages else context.new_page()
        page.goto(NOTEBOOK_URL)

        if "--login" in sys.argv:
            input("Googleにログインして、Colabが開けたらEnterを押してください: ")
            context.close()
            return

        start_epoch = time.time()
        run_notebook(page)
        handle_dialogs(context, page)

        print("Colabの完了を待っています...")
        result = wait_for_done(page, start_epoch)
        if result != "DONE":
            dump_output(page)  # 失敗・タイムアウト時は原因確認用に出力を保存
        if result:
            print(f"合図({result})を検知しました。ランタイム解放の猶予として{CLOSE_DELAY_SEC}秒待ちます")
            time.sleep(CLOSE_DELAY_SEC)
        context.close()
        # 終了コード: 0=完了 / 1=Colab側が失敗を通知 / 2=タイムアウト
        # (バッチ側の errorlevel で止められる)
        if result == "DONE":
            print("完了を検知したのでブラウザを閉じました")
            sys.exit(0)
        if result == "FAILED":
            print("Colab側が失敗を通知しました。Colabの出力を確認してください")
            sys.exit(1)
        print("タイムアウトしました（合図が出力されませんでした）")
        sys.exit(2)


if __name__ == "__main__":
    main()