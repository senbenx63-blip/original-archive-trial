@echo off
chcp 65001 > nul
cd /d "%~dp0"
cd /d "%~dp0"

echo ==============================
echo  0. スプレッドシートからエクセルのB/D/F/G列を更新中...
echo ==============================
python update_excel_from_sheet.py
if errorlevel 1 (
    echo エラーが発生しました。ここで停止します。
    pause
    exit /b 1
)

echo ==============================
echo  1. エクセルのK列に6桁コードを付与中...
echo ==============================
python K-row_6code_add.py
if errorlevel 1 (
    echo エラーが発生しました。ここで停止します。
    pause
    exit /b 1
)

echo ==============================
echo  2. jsonを取得中...
echo ==============================
python twitchdownload2.py
if errorlevel 1 (
    echo エラーが発生しました。ここで停止します。
    pause
    exit /b 1
)

echo ==============================
echo  3. Youtube公式のtxtを取得中...
echo ==============================
python main.py
if errorlevel 1 (
    echo エラーが発生しました。ここで停止します。
    pause
    exit /b 1
)

echo ==============================
echo  4. Youtube動画とクリップの字幕を作成中...
echo ==============================
python colab_autorun.py
if errorlevel 1 (
    echo エラーが発生しました。ここで停止します。
    pause
    exit /b 1
)

echo ==============================
echo  5. フォルダをローカルに移動中...
echo ==============================
python move_transcripts.py
if errorlevel 1 (
    echo エラーが発生しました。ここで停止します。
    pause
    exit /b 1
)

echo ==============================
echo  6. 要約作成とクリップのタグを付与中...
echo ==============================
python colab_autorun_summary.py
if errorlevel 1 (
    echo エラーが発生しました。ここで停止します。
    pause
    exit /b 1
)

echo ==============================
echo  7. フォルダをローカルに移動中...
echo ==============================
python move_summaries.py
if errorlevel 1 (
    echo エラーが発生しました。ここで停止します。
    pause
    exit /b 1
)

echo ==============================
echo  8. jsonを軽量化中...
echo ==============================
python slim_json.py
if errorlevel 1 (
    echo エラーが発生しました。ここで停止します。
    pause
    exit /b 1
)

echo ==============================
echo  9. jsonデータからユーザー名簿を作成＆txt形式のチャットからjson形式のチャットへ変換中...
echo ==============================
python txt_to_slim.py
if errorlevel 1 (
    echo エラーが発生しました。ここで停止します。
    pause
    exit /b 1
)

echo ==============================
echo  10. json/txtをローカルdbに取り込み中...
echo ==============================
python chamagame_archive.py
if errorlevel 1 (
    echo エラーが発生しました。ここで停止します。
    pause
    exit /b 1
)

if exist dictionary_final.xlsx (
    echo ==============================
    echo  11. 辞書エクセルを反映中...
    echo ==============================
    python import_dictionary.py
    if errorlevel 1 (
        echo エラーが発生しました。ここで停止します。
        pause
        exit /b 1
    )
) else (
    echo dictionary_final.xlsx が見つからないためスキップします。
)

echo ==============================
echo  12. 新しいデータを抽出中...
echo ==============================
python export_new_for_d1.py
if errorlevel 1 (
    echo エラーが発生しました。ここで停止します。
    pause
    exit /b 1
)

if not exist d1_export\new_streams.sql (
    echo 新しいデータはありませんでした。処理を終了します。
    pause
    exit /b 0
)

echo ==============================
echo  13. D1に送信中(streams)...
echo ==============================
call npx --yes wrangler d1 execute chamagame-archive --remote --file=./d1_export/new_streams.sql -y
if errorlevel 1 (
    echo streamsの送信でエラーが発生しました。ここで停止します。
    pause
    exit /b 1
)

echo ==============================
echo  14. D1に送信中(commenters)...
echo ==============================
call npx wrangler d1 execute chamagame-archive --remote --file=./d1_export/commenters_upsert.sql -y
if errorlevel 1 (
    echo commentersの送信でエラーが発生しました。ここで停止します。
    pause
    exit /b 1
)

echo ==============================
echo  15. D1に送信中(chat_messages)...
echo ==============================
call npx wrangler d1 execute chamagame-archive --remote --file=./d1_export/new_chat_messages.sql -y
if errorlevel 1 (
    echo chat_messagesの送信でエラーが発生しました。ここで停止します。
    pause
    exit /b 1
)

echo ==============================
echo  16. D1に送信中(transcript_segments)...
echo ==============================
call npx wrangler d1 execute chamagame-archive --remote --file=./d1_export/new_transcript_segments.sql -y
if errorlevel 1 (
    echo transcript_segmentsの送信でエラーが発生しました。ここで停止します。
    pause
    exit /b 1
)

echo ==============================
echo  すべて完了しました！
echo ==============================
pause