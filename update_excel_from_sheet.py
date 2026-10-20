"""
Googleスプレッドシートの年別シート(名前が20で始まる4桁の数字、例: "2025", "2026")を
すべて読み込み、対応する年のExcelシートを更新するスクリプト。

対象シートの決め方:
    スプレッドシート側の、名前が「20で始まる4桁の数字」のシートすべてが対象。
    エクセル側で対応するシートは、次のどちらかで見つける。
      - シート名が「2026年」または「2026」
      - A1セルの値が 2026
    新しい年のシートがスプレッドシートにできたときは、エクセルに
    「<シート名>年」(例: 2027年)という名前のシートを新しく作る。

対応関係:
    スプレッドシートの行(1始まり、1行目はヘッダー)
    = エクセルの行(1始まり、ヘッダー無し) + 1

    例: スプレッドシート2行目(ヘッダーの次、最初のデータ行)
        -> エクセル1行目(ヘッダーが無いので、これが最初のデータ行)
    ※新しく作るシートも同じ対応(エクセルの1行目 = スプレッドシートの2行目)

更新ルール(既存のエクセルシート):
    [B列・D列・F列]
    - エクセル側のB・D・F列のいずれかに、既に何か値が入っている行は
      B・D・Fについてはその行ごとノータッチ(スキップ)
    - スプレッドシート側が空欄のセルは書き込まない

    [G列]  ※B・D・Fとは別ルール
    - 全行を更新する(エクセル側に既に値が入っていても上書きする)
    - B・D・Fのスキップ判定とは無関係に、G列だけ独立して更新する
    - スプレッドシート側のG列が空欄の場合は書き込まない(既存の値を消さない)

更新ルール(新しく作るシート):
    - A〜G列をすべて書き込む(スプレッドシート側が空欄のセルは書き込まない)

使い方:
    1. 下の XLSX_PATH を実際のファイルパスに変更する
    2. pip install openpyxl pandas requests
    3. python update_excel_from_sheet.py を実行
"""

import io
import re
import sys
from pathlib import Path

import openpyxl
import pandas as pd
import requests

SHEET_ID = "1yubpjM0sqNAjwRMCoiWDgdTeTrB8zZ2YyomA-z2fvVg"
XLSX_PATH = Path(__file__).parent / "dictionary_final.xlsx"

# 更新対象の列(0始まりのインデックス: B=1, D=3, F=5)
TARGET_COLUMN_INDICES = [1, 3, 5]

# G列(0始まり: G=6)。全行を上書き更新する
G_COLUMN_INDEX = 6

# 新しく作るシートに書き込む列数(A〜G = 7列)
NEW_SHEET_COLUMN_COUNT = 7

# 新しく作るシートの名前: 「<スプレッドシートのシート名>」+ この文字列
NEW_SHEET_TITLE_SUFFIX = "年"

# 対象シート名のパターン: 20で始まる4桁の数字
YEAR_SHEET_PATTERN = re.compile(r"20\d{2}")
# エクセル側のシート名から年を読み取るパターン(「2026年」「2026」)
EXCEL_TITLE_PATTERN = re.compile(r"(20\d{2})年?")


def fetch_sheet_rows(sheet_id, sheet_name):
    """指定シートの全行を、ヘッダー込みでリストのリストとして取得する"""
    url = (
        f"https://docs.google.com/spreadsheets/d/{sheet_id}/gviz/tq"
        f"?tqx=out:csv&sheet={sheet_name}"
    )
    res = requests.get(url)
    res.raise_for_status()
    df = pd.read_csv(io.StringIO(res.text), header=None)
    return df.values.tolist()


def fetch_spreadsheet_sheet_names(sheet_id):
    """スプレッドシートの全シート名を取得する。

    スプレッドシート全体をxlsx形式でダウンロードし、シート名だけを読み取る。
    取得できなかった場合は例外が発生する(呼び出し側で処理する)。
    """
    url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=xlsx"
    res = requests.get(url)
    res.raise_for_status()
    wb = openpyxl.load_workbook(io.BytesIO(res.content), read_only=True)
    try:
        return list(wb.sheetnames)
    finally:
        wb.close()


def year_label(cell_value):
    """A1セルの値を「20XX」形式の文字列にする。該当しなければ None"""
    if cell_value is None:
        return None
    try:
        text = str(int(cell_value))  # 2026 / 2026.0 / "2026" いずれも "2026" に揃える
    except (TypeError, ValueError):
        return None
    return text if YEAR_SHEET_PATTERN.fullmatch(text) else None


def find_excel_year_sheets(wb):
    """エクセルの年シートを {年: シート} の辞書で返す。
    シート名(「2026年」「2026」)かA1セルの値のどちらかで年を判定する。"""
    result = {}
    for name in wb.sheetnames:
        ws = wb[name]
        label = None
        m = EXCEL_TITLE_PATTERN.fullmatch(name.strip())
        if m:
            label = m.group(1)
        else:
            label = year_label(ws.cell(row=1, column=1).value)
        if label is not None and label not in result:
            result[label] = ws
    return result


def is_row_untouched(ws, excel_row):
    """B・D・F列のいずれかに値が入っていれば、その行はノータッチ対象と判定する"""
    for col_idx in (2, 4, 6):  # openpyxlは1始まり: B=2, D=4, F=6
        value = ws.cell(row=excel_row, column=col_idx).value
        if value not in (None, ""):
            return False
    return True


def is_blank(value):
    if value is None:
        return True
    if isinstance(value, float) and pd.isna(value):
        return True
    if isinstance(value, str) and value.strip() == "":
        return True
    return False


def update_existing_sheet(ws, raw_rows):
    """既存の年シートを更新し、結果の件数を辞書で返す"""
    data_rows = raw_rows[1:]  # 1行目(ヘッダー)を除いたデータ行
    g_excel_col = G_COLUMN_INDEX + 1  # openpyxlの1始まり列番号

    updated_count = 0
    skipped_count = 0
    g_updated_count = 0

    for i, row in enumerate(data_rows):
        excel_row = i + 1  # スプレッドシート行(ヘッダー込み) = エクセル行 + 1 の関係

        # --- B・D・F列: 既に何か入っている行はスキップ ---
        if is_row_untouched(ws, excel_row):
            for col_idx in TARGET_COLUMN_INDICES:  # 0始まり: 1=B, 3=D, 5=F
                value = row[col_idx] if len(row) > col_idx else None
                if is_blank(value):
                    continue
                excel_col = col_idx + 1  # openpyxlの1始まり列番号に変換
                ws.cell(row=excel_row, column=excel_col).value = value
            updated_count += 1
        else:
            skipped_count += 1

        # --- G列: 全行を上書き(スプレッドシート側が空欄なら書かない) ---
        g_value = row[G_COLUMN_INDEX] if len(row) > G_COLUMN_INDEX else None
        if not is_blank(g_value):
            ws.cell(row=excel_row, column=g_excel_col).value = g_value
            g_updated_count += 1

    return {
        "new": False,
        "updated": updated_count,
        "skipped": skipped_count,
        "g_updated": g_updated_count,
        "spreadsheet_rows": len(raw_rows),  # ヘッダー込みの総行数
        "excel_rows": ws.max_row,
    }


def fill_new_sheet(ws, raw_rows):
    """新しく作ったシートにA〜G列をすべて書き込む。
    エクセルの1行目 = スプレッドシートの2行目(ヘッダー行は書き込まない)。"""
    data_rows = raw_rows[1:]
    written_rows = 0

    for i, row in enumerate(data_rows):
        excel_row = i + 1
        wrote_any = False
        for col_idx in range(NEW_SHEET_COLUMN_COUNT):  # 0始まり: 0=A 〜 6=G
            value = row[col_idx] if len(row) > col_idx else None
            if is_blank(value):
                continue
            ws.cell(row=excel_row, column=col_idx + 1).value = value
            wrote_any = True
        if wrote_any:
            written_rows += 1

    return {
        "new": True,
        "written": written_rows,
        "spreadsheet_rows": len(raw_rows),
        "excel_rows": ws.max_row,
    }


def main():
    wb = openpyxl.load_workbook(XLSX_PATH)
    excel_sheets = find_excel_year_sheets(wb)

    # スプレッドシート側の年シートの一覧を取得する
    can_create_new = True
    try:
        names = fetch_spreadsheet_sheet_names(SHEET_ID)
        target_years = sorted(n for n in names if YEAR_SHEET_PATTERN.fullmatch(n))
    except Exception as e:
        # 取得できない場合は、エクセルに既にある年シートだけを対象にする
        can_create_new = False
        target_years = sorted(excel_sheets)
        print(
            "警告: スプレッドシートのシート名一覧を取得できませんでした"
            f"({type(e).__name__})。\n"
            "      エクセルに既にある年シートだけを更新します"
            "(新しい年のシートは作成されません)。"
        )

    if not target_years:
        print("エラー: 対象の年シート(20で始まる4桁)が見つかりません。")
        sys.exit(1)

    print(f"対象の年: {', '.join(target_years)}")
    if can_create_new:
        not_in_spreadsheet = sorted(set(excel_sheets) - set(target_years))
        if not_in_spreadsheet:
            print(
                "注意: エクセルにあるがスプレッドシートに無いため"
                f"更新しない年: {', '.join(not_in_spreadsheet)}"
            )

    results = {}
    for label in target_years:
        is_new = label not in excel_sheets
        print(f"\n[{label}] スプレッドシートを読み込み中...")
        try:
            raw_rows = fetch_sheet_rows(SHEET_ID, label)
        except requests.RequestException as e:
            print(f"[{label}] 読み込みに失敗したためスキップします: {e}")
            continue

        if is_new:
            title = f"{label}{NEW_SHEET_TITLE_SUFFIX}"
            ws = wb.create_sheet(title=title)  # ブックの末尾に追加
            print(f"[{label}] エクセルに新しいシート「{title}」を作成します")
            results[label] = fill_new_sheet(ws, raw_rows)
        else:
            results[label] = update_existing_sheet(excel_sheets[label], raw_rows)

    if not results:
        print("\nどのシートも更新できなかったため、保存せずに終了します。")
        sys.exit(1)

    wb.save(XLSX_PATH)

    print("\n===== 結果 =====")
    for label, r in results.items():
        if r["new"]:
            print(f"\n[{label}] 新規作成")
            print(f"  書き込んだ行数(A〜G): {r['written']}")
        else:
            print(f"\n[{label}]")
            print(f"  更新した行数(B・D・F): {r['updated']}")
            print(f"  スキップした行数(B・D・Fに既に何か入っていた行): {r['skipped']}")
            print(f"  G列を更新した行数: {r['g_updated']}")
        print(
            f"  スプレッドシート行数(ヘッダー込み): {r['spreadsheet_rows']} / "
            f"エクセル行数+1: {r['excel_rows'] + 1}"
        )
        if r["spreadsheet_rows"] != r["excel_rows"] + 1:
            print("  警告: 行数が一致していません。ズレがないか確認してください。")
        else:
            print("  行数の整合性: OK")


if __name__ == "__main__":
    main()