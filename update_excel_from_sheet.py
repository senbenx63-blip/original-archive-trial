"""
Googleスプレッドシート(年別シート、例: "2026")を読み込み、
対応する年のExcelシートのB・D・F列を更新するスクリプト。

対応関係:
    スプレッドシートの行(1始まり、1行目はヘッダー)
    = エクセルの行(1始まり、ヘッダー無し) + 1

    例: スプレッドシート2行目(ヘッダーの次、最初のデータ行)
        -> エクセル1行目(ヘッダーが無いので、これが最初のデータ行)

更新ルール:
    - 更新するのはB列・D列・F列のみ。他の列には一切触れない
    - エクセル側のB・D・F列のいずれかに、既に何か値が入っている行は
      その行ごとノータッチ(スキップ)
    - つまり、既に何か書いてある行は実行前後で完全に変化しない

使い方:
    1. 下の XLSX_PATH を実際のファイルパスに変更する
    2. pip install openpyxl pandas requests
    3. python update_excel_from_sheet.py を実行
"""

import io
import sys
from datetime import datetime
from pathlib import Path

import openpyxl
import pandas as pd
import requests

SHEET_ID = "1yubpjM0sqNAjwRMCoiWDgdTeTrB8zZ2YyomA-z2fvVg"
XLSX_PATH = Path(__file__).parent / "dictionary_final.xlsx"

# 更新対象の列(0始まりのインデックス: B=1, D=3, F=5)
TARGET_COLUMN_INDICES = [1, 3, 5]


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


def find_year_sheet(wb, year):
    """A1セルの値が指定年と一致するシートを探す"""
    for name in wb.sheetnames:
        ws = wb[name]
        cell_value = ws.cell(row=1, column=1).value
        try:
            if int(cell_value) == year:
                return ws
        except (TypeError, ValueError):
            continue
    return None


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


def main():
    current_year = datetime.now().year
    sheet_name = str(current_year)

    print(f"スプレッドシート(シート「{sheet_name}」)を読み込み中...")
    raw_rows = fetch_sheet_rows(SHEET_ID, sheet_name)
    data_rows = raw_rows[1:]  # 1行目(ヘッダー)を除いたデータ行
    print(f"データ行数: {len(data_rows)}")

    wb = openpyxl.load_workbook(XLSX_PATH)
    ws = find_year_sheet(wb, current_year)
    if ws is None:
        print(f"エラー: {current_year}年に対応するエクセルのシートが見つかりません。")
        sys.exit(1)
    print(f"更新対象のエクセルシート: 「{ws.title}」")

    updated_count = 0
    skipped_count = 0

    for i, row in enumerate(data_rows):
        excel_row = i + 1  # スプレッドシート行(ヘッダー込み) = エクセル行 + 1 の関係

        if not is_row_untouched(ws, excel_row):
            skipped_count += 1
            continue

        for col_idx in TARGET_COLUMN_INDICES:  # 0始まり: 1=B, 3=D, 5=F
            value = row[col_idx] if len(row) > col_idx else None
            if is_blank(value):
                continue
            excel_col = col_idx + 1  # openpyxlの1始まり列番号に変換
            ws.cell(row=excel_row, column=excel_col).value = value

        updated_count += 1

    wb.save(XLSX_PATH)

    spreadsheet_row_count = len(raw_rows)  # ヘッダー込みの総行数
    excel_row_count = ws.max_row

    print(f"\n更新した行数: {updated_count}")
    print(f"スキップした行数(既に何か入っていた行): {skipped_count}")
    print(
        f"スプレッドシート行数(ヘッダー込み): {spreadsheet_row_count} / "
        f"エクセル行数+1: {excel_row_count + 1}"
    )
    if spreadsheet_row_count != excel_row_count + 1:
        print("警告: 行数が一致していません。ズレがないか確認してください。")
    else:
        print("行数の整合性: OK")


if __name__ == "__main__":
    main()