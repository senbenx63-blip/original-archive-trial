r"""
チャットJSONを「サイト表示に必要な情報だけ」に絞って、別フォルダに年号別で保存するスクリプト。

使い方:
  1. このファイルを「original archive trial」フォルダ(jsonフォルダと同じ場所)に置く
  2. ダブルクリック、または  python slim_json.py  で実行

  元:   original archive trial\json\2021 ～ 2026      ← 変更しません(読み込むだけ)
  新:   original archive trial\json_slim\2021 ～ 2026  ← 軽量版をここに作ります

別の場所のフォルダを使いたい時:
  python slim_json.py "元のjsonフォルダ" "出力先フォルダ"

軽量版の形式(script.js が読む形):
  {
    "v": 1,
    "title": "配信タイトル",
    "comments": [
      {"t": 23,                     # 動画内の秒数 (content_offset_seconds)
       "d": "こめ",                 # 表示名 (display_name)
       "u": "come706",              # ログイン名 (name)。表示名と同じなら省略
       "c": "#BFBA4D",              # 名前の色 (user_color)。無ければ省略
       "b": "chamadPiisu ...",      # 本文 (body)
       "f": ["文字", ["エモート名","emotesv2_xxx"], " "]   # エモートがある時だけ。文字列=ただの文字
      },
      ...
    ]
  }
"""
import json
import sys
from pathlib import Path


def slim_one(data):
    """元のJSON(dict)から、表示に必要な部分だけを取り出す"""
    video = data.get("video") or {}
    out = {"v": 1, "title": video.get("title") or "", "comments": []}

    for c in data.get("comments") or []:
        commenter = c.get("commenter") or {}
        message = c.get("message") or {}

        display_name = commenter.get("display_name") or ""
        login_name = commenter.get("name") or ""
        body = message.get("body") or ""

        item = {"t": c.get("content_offset_seconds", 0), "d": display_name}
        if login_name != display_name:
            item["u"] = login_name
        if message.get("user_color"):
            item["c"] = message["user_color"]
        item["b"] = body

        # エモートが含まれる時だけ fragments を残す(それ以外は body で同じ表示になる)
        frags = message.get("fragments")
        if frags:
            has_emote = any(f.get("emoticon") for f in frags)
            same_as_body = "".join(f.get("text", "") for f in frags) == body
            if has_emote or not same_as_body:
                item["f"] = [
                    [f.get("text", ""), f["emoticon"].get("emoticon_id", "")]
                    if f.get("emoticon") else f.get("text", "")
                    for f in frags
                ]
        out["comments"].append(item)

    return out


def main():
    base = Path(__file__).resolve().parent
    src_root = Path(sys.argv[1]) if len(sys.argv) > 1 else base / "json"
    dst_root = Path(sys.argv[2]) if len(sys.argv) > 2 else base / "json_slim"

    if not src_root.is_dir():
        print(f"元のjsonフォルダが見つかりません: {src_root}")
        return
    if dst_root.resolve() == src_root.resolve():
        print("出力先と元フォルダが同じです。別のフォルダを指定してください。")
        return

    files = sorted(src_root.rglob("*.json"))
    total_before = total_after = done = failed = 0

    for src in files:
        rel = src.relative_to(src_root)          # 例: 2021\021521.json (年号フォルダ構成をそのまま引き継ぐ)
        dst = dst_root / rel
        try:
            # utf-8-sig: 先頭にBOMが付いていても読めるようにする
            data = json.loads(src.read_text(encoding="utf-8-sig"))
            slim = slim_one(data)
            dst.parent.mkdir(parents=True, exist_ok=True)
            text = json.dumps(slim, ensure_ascii=False, separators=(",", ":"))
            dst.write_text(text, encoding="utf-8")
        except Exception as e:
            failed += 1
            print(f"[失敗] {rel}: {e}")
            continue

        done += 1
        before, after = src.stat().st_size, dst.stat().st_size
        total_before += before
        total_after += after
        print(f"[OK] {rel}  {before/1024:,.0f}KB → {after/1024:,.0f}KB")

    print("-" * 40)
    print(f"変換: {done}件 / 失敗: {failed}件")
    if total_before:
        print(f"合計: {total_before/1024/1024:,.1f}MB → {total_after/1024/1024:,.1f}MB "
              f"({total_after/total_before:.0%})")
    print(f"出力先: {dst_root}")


if __name__ == "__main__":
    main()
