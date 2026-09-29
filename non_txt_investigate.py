import os
import glob
import openpyxl

# ===== 設定 =====
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))  # このスクリプトがある場所
EXCEL_PATH = os.path.join(SCRIPT_DIR, "dictionary_final.xlsx")
SEARCH_ROOT = SCRIPT_DIR  # このスクリプトの場所から下層を探索
# =================

wb = openpyxl.load_workbook(EXCEL_PATH, data_only=True)

# このスクリプトの場所から下層にある .txt ファイルを、あらかじめ全部集めておく
existing_txt_names = set()
for path in glob.glob(os.path.join(SEARCH_ROOT, "**", "*.txt"), recursive=True):
    existing_txt_names.add(os.path.basename(path))

missing = []

for ws in wb.worksheets:  # 全シートを対象にする
    for row in ws.iter_rows(min_row=2):  # 1行目はヘッダー想定
        g_cell = row[6]   # G列
        k_cell = row[10]  # K列

        if g_cell.value is None or str(g_cell.value).strip() == "":
            continue  # G列が空ならスキップ

        if k_cell.value is None:
            continue  # K列が空ならスキップ

        name = str(k_cell.value).strip()
        filename = name if name.endswith(".txt") else f"{name}.txt"

        if filename not in existing_txt_names:
            missing.append({"sheet": ws.title, "row": g_cell.row, "name": name})

# 結果表示
print(f"見つからなかった件数: {len(missing)}")
for m in missing:
    print(f"[{m['sheet']}] 行{m['row']}: {m['name']}")