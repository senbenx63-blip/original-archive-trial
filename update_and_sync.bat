@echo off
chcp 65001 > nul
cd /d "%~dp0"
cd /d "%~dp0"

echo ==============================
echo  1. json/txtをローカルdbに取り込み中...
echo ==============================
python chamagame_archive.py
if errorlevel 1 (
    echo エラーが発生しました。ここで停止します。
    pause
    exit /b 1
)

if exist dictionary_final.xlsx (
    echo ==============================
    echo  2. 辞書エクセルを反映中...
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
echo  3. 新しいデータを抽出中...
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
echo  4. D1に送信中(streams)...
echo ==============================
call npx wrangler d1 execute chamagame-archive --remote --file=./d1_export/new_streams.sql -y
if errorlevel 1 (
    echo streamsの送信でエラーが発生しました。ここで停止します。
    pause
    exit /b 1
)

echo ==============================
echo  5. D1に送信中(commenters)...
echo ==============================
call npx wrangler d1 execute chamagame-archive --remote --file=./d1_export/commenters_upsert.sql -y
if errorlevel 1 (
    echo commentersの送信でエラーが発生しました。ここで停止します。
    pause
    exit /b 1
)

echo ==============================
echo  6. D1に送信中(chat_messages)...
echo ==============================
call npx wrangler d1 execute chamagame-archive --remote --file=./d1_export/new_chat_messages.sql -y
if errorlevel 1 (
    echo chat_messagesの送信でエラーが発生しました。ここで停止します。
    pause
    exit /b 1
)

echo ==============================
echo  7. D1に送信中(transcript_segments)...
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