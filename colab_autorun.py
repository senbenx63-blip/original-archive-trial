"""
Colabのノートブックを開いて実行し、認証ダイアログを自動で進める。

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
NOTEBOOK_URL = "https://colab.research.google.com/drive/1b8agjCdfvRqh2S67ArxC8iivG1RwmFzb"
CHROME_EXE = r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"

# 自動化専用のユーザーデータフォルダ（普段使いの "User Data" とは別にする）
USER_DATA_DIR = r"C:\colab_chrome_data"
PROFILE_DIRECTORY = "Profile 3"  # 上のフォルダ内に作られるプロファイル名

# 特定のセルだけ実行したい場合はセルIDを入れる。空なら全セル実行(Ctrl+F9)
CELL_ID = ""

# 起動時に、前回のセッション(ランタイム)が残っていれば切断して削除する
# (「ランタイムに接続中」のまま進まなくなる問題の予防)。不要なら False
DISCONNECT_STALE_RUNTIME = True

# 日本語と英語の両方を候補にする
DRIVE_BTN = re.compile(r"^(Google\s*ドライブに接続|Connect to Google Drive)$")
AUTH_BTN = re.compile(r"^(認証|Authorize)$")
NEXT_BTN = re.compile(r"^(次へ|Next)$")
SELECT_ALL = re.compile(r"(すべてを?選択|Select all)")
# 認証情報ダイアログのタイトル(これが見えているときだけ、ボタンを広めの条件で探す)
CRED_TITLE = re.compile(r"認証情報へのアクセス|access your Google credentials", re.I)
AUTH_BTN_LOOSE = re.compile(r"^\s*(認証|Authorize|許可|Allow)\s*$")

# ランタイムの事前切断で使うメニュー・ボタンの文言
RUNTIME_MENU = re.compile(r"^(ランタイム|Runtime)$")
DISCONNECT_ITEM = re.compile(r"ランタイムを接続解除して削除|Disconnect and delete runtime")
CONFIRM_BTN = re.compile(r"^(はい|Yes|OK)$")


# 完了検知: Colab側が最後に「COLAB_ALL_」+「DONE または FAILED」+ 時刻 を出力する
DONE_PATTERN = re.compile(r"COLAB_ALL_(DONE|FAILED) (\d+)")
MAX_WAIT_SEC = 6 * 3600  # 最大待ち時間(秒)。超えたらエラー終了
POLL_SEC = 10
# 合図を検知してからブラウザを閉じるまでの猶予(秒)。
# Colab側のランタイム解放(UNASSIGN_WAIT_SEC + 解放処理)が終わるまで待つため、それより長くする
CLOSE_DELAY_SEC = 60
# 失敗・タイムアウト時に、Colabの出力をこのフォルダに保存する(ブラウザが閉じても原因を確認できるように)
LOG_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_PREFIX = "colab_last_output"

# Colab側が最初に出す「実行開始」の合図を待つ最大時間(秒)。
# 超えたらページを開き直してやり直す(「接続中」のまま進まない問題への対策)
CONNECT_TIMEOUT_SEC = 300
CONNECT_MAX_ATTEMPTS = 3   # やり直しを含めた最大試行回数
STARTED_PATTERN = re.compile(r"COLAB_ALL_STARTED (\d+)")
WAIT_SHOT_INTERVAL = 60    # 待機中、この間隔(秒)で画面を保存する
WAIT_SHOT_MAX = 10         # 待機中のスクリーンショットの最大枚数


def wait_for_start(page, start_epoch, context):
    """Colab側の「実行開始」の合図を待つ。待っている間も、ダイアログが出たら処理する。
    戻り値: True(開始を確認) / False(時間切れ)
    保存済みの前回出力に含まれる古い合図は、時刻で弾く。"""
    deadline = time.time() + CONNECT_TIMEOUT_SEC
    last_poll = 0.0
    while time.time() < deadline:
        check_dialogs(context, page)
        report_dialogs(page)

        if time.time() - last_poll >= 5:
            last_poll = time.time()
            for frame in page.frames:
                try:
                    text = frame.locator("body").inner_text(timeout=2000)
                except Exception:
                    continue
                for m in STARTED_PATTERN.finditer(text):
                    if int(m.group(1)) >= start_epoch - 60:
                        return True
        time.sleep(2)
    return False


def wait_for_done(page, start_epoch, context):
    """実行開始以降に出力された合図を待つ。待っている間も、認証ダイアログが出たら処理し続ける。
    戻り値: "DONE" / "FAILED" / None(タイムアウト)
    保存済みの前回出力に含まれる古い合図は、時刻で弾く。"""
    deadline = time.time() + MAX_WAIT_SEC
    last_poll = 0.0
    last_shot = 0.0
    shot_count = 0
    while time.time() < deadline:
        check_dialogs(context, page)
        report_dialogs(page)

        # 止まったときに原因を確認できるよう、一定間隔で画面を保存する(枚数に上限あり)
        if time.time() - last_shot >= WAIT_SHOT_INTERVAL and shot_count < WAIT_SHOT_MAX:
            last_shot = time.time()
            shot_count += 1
            try:
                name = f"colab_wait_{shot_count}.png"
                page.screenshot(path=os.path.join(LOG_DIR, name))
                print(f"[デバッグ] 待機中の画面を保存しました: {name}")
            except Exception:
                pass

        if time.time() - last_poll >= POLL_SEC:
            last_poll = time.time()
            for frame in page.frames:  # Colabの出力欄はiframeの中にある
                try:
                    text = frame.locator("body").inner_text(timeout=2000)
                except Exception:
                    continue
                for m in DONE_PATTERN.finditer(text):
                    if int(m.group(2)) >= start_epoch - 60:
                        return m.group(1)
        time.sleep(2)
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


_reported = set()


def report_buttons(page, reason):
    """ボタンが見つからないとき、画面上のボタンの名前とスクリーンショットを出して原因調査の手がかりにする。"""
    if reason in _reported:
        return
    _reported.add(reason)
    names = []
    try:
        for b in page.get_by_role("button").all():
            if is_visible(b):
                t = " ".join(b.inner_text().split())
                if t:
                    names.append(t[:30])
    except Exception:
        pass
    print(f"⚠️ {reason}。画面上のボタン: {names[:20]}")
    try:
        png = os.path.join(LOG_DIR, LOG_PREFIX + "_dialog.png")
        page.screenshot(path=png)
        print(f"   スクリーンショットを保存しました: {png}")
    except Exception:
        pass


def report_dialogs(page):
    """画面上のダイアログの文面を1回だけ出力する(未知のダイアログの調査用)"""
    try:
        for d in page.get_by_role("dialog").all():
            if is_visible(d):
                text = " ".join(d.inner_text().split())[:200]
                if text:
                    report_buttons(page, f"ダイアログ表示中: {text}")
    except Exception:
        pass


def find_drive_button(page):
    btn = page.get_by_role("button", name=DRIVE_BTN).first
    return btn if is_visible(btn) else None


def find_auth_button(page):
    """認証ダイアログの「認証」ボタンを探す。
    通常は role=button の完全一致で探す。見つからないが、ダイアログのタイトルは見えている場合は、
    リンクや単なるテキストの可能性も含めて広めに探す。"""
    btn = page.get_by_role("button", name=AUTH_BTN).first
    if is_visible(btn):
        return btn
    if is_visible(page.get_by_text(CRED_TITLE).first):
        for cand in (
            page.get_by_role("button", name=AUTH_BTN_LOOSE).first,
            page.get_by_role("link", name=AUTH_BTN_LOOSE).first,
            page.get_by_text(AUTH_BTN_LOOSE).first,
        ):
            if is_visible(cand):
                return cand
        report_buttons(page, "認証情報のダイアログは見えているが、「認証」ボタンが見つかりません")
    return None


def check_dialogs(context, page):
    """Colab側のダイアログ(ドライブ接続 / 認証情報の許可)が出ていれば、1回分だけ処理する。
    ダイアログは、実行を始めてから何十秒〜何分もあとに出ることがある
    (先頭でpip installなどが走るため)ので、完了待ちのループの中で繰り返し呼ぶ。"""
    for name, finder in (("ドライブ接続", find_drive_button), ("認証情報の許可", find_auth_button)):
        btn = finder(page)
        if btn is None:
            continue
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


def disconnect_stale_runtime(page):
    """前回のセッションが残っていれば、メニューから切断して削除する。
    Colabのメニュー構成に依存するため、見つからなければ何もせず先へ進む(失敗しても止まらない)。"""
    page.wait_for_timeout(6000)  # 画面の読み込み待ち
    try:
        menu = page.get_by_role("menuitem", name=RUNTIME_MENU).first
        if not is_visible(menu):
            menu = page.get_by_text(RUNTIME_MENU).first
        menu.click(timeout=5000)

        item = page.get_by_role("menuitem", name=DISCONNECT_ITEM).first
        if not is_visible(item):
            item = page.get_by_text(DISCONNECT_ITEM).first
        item.wait_for(state="visible", timeout=5000)
        if not item.is_enabled():
            print("切断するランタイムは残っていませんでした")
            page.keyboard.press("Escape")
            return

        item.click()
        confirm = page.get_by_role("button", name=CONFIRM_BTN).first
        confirm.wait_for(state="visible", timeout=5000)
        confirm.click()
        print("残っていたランタイムを切断・削除しました")
        page.wait_for_timeout(5000)
    except PWError as e:
        print(f"ランタイムの事前切断をスキップしました(対象がない、またはメニューが見つからない): {type(e).__name__}")
        try:
            page.keyboard.press("Escape")
        except PWError:
            pass


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
        page.on("dialog", lambda d: d.accept())   # 「サイトを離れますか?」などで止まらないように
        page.goto(NOTEBOOK_URL)

        if "--login" in sys.argv:
            input("Googleにログインして、Colabが開けたらEnterを押してください: ")
            context.close()
            return

        if DISCONNECT_STALE_RUNTIME:
            disconnect_stale_runtime(page)

        for attempt in range(1, CONNECT_MAX_ATTEMPTS + 1):
            start_epoch = time.time()
            run_notebook(page)
            print(f"Colabの実行開始を待っています... ({attempt}/{CONNECT_MAX_ATTEMPTS})")
            if wait_for_start(page, start_epoch, context):
                print("Colab側の実行開始を確認しました")
                break

            print(f"⚠️ {CONNECT_TIMEOUT_SEC}秒待っても開始しませんでした")
            try:
                page.screenshot(path=os.path.join(LOG_DIR, f"colab_connect_fail_{attempt}.png"))
            except Exception:
                pass
            if attempt < CONNECT_MAX_ATTEMPTS:
                print("ページを開き直してやり直します")
                page.goto(NOTEBOOK_URL)
                if DISCONNECT_STALE_RUNTIME:
                    disconnect_stale_runtime(page)   # 接続中で止まったランタイムを切断
        else:
            print("接続に失敗しました(上限回数に達しました)")
            context.close()
            sys.exit(3)

        print("Colabの完了を待っています...(認証ダイアログが出たら自動で処理します)")
        result = wait_for_done(page, start_epoch, context)
        if result != "DONE":
            dump_output(page)  # 失敗・タイムアウト時は原因確認用に出力を保存
        if result:
            print(f"合図({result})を検知しました。ランタイム解放の猶予として{CLOSE_DELAY_SEC}秒待ちます")
            time.sleep(CLOSE_DELAY_SEC)
        context.close()
        # 終了コード: 0=完了 / 1=Colab側が失敗を通知 / 2=タイムアウト / 3=接続できず(開始の合図なし)
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