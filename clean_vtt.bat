@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

if "%~1"=="" (
    echo VTTファイルをこのバッチファイルにドラッグ＆ドロップしてください。
    pause
    exit /b
)

set "INPUT_FILE=%~1"
set "OUTPUT_FILE=%~dpn1.txt"

echo 処理を開始します...

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$lines = Get-Content -Path '%INPUT_FILE%' -Encoding UTF8;" ^
    "$result = [System.Collections.Generic.List[string]]::new();" ^
    "$lastText = '';" ^
    "$lastTime = '';" ^
    "foreach ($line in $lines) {" ^
    "    $cleanLine = $line -replace '<[^>]+>', '' -replace '^\s+', '' -replace '\s+$', '';" ^
    "    if ($cleanLine -match '^\d{2}:\d{2}:\d{2}\.\d{3}\s+--\>') {" ^
    "        $lastTime = $cleanLine.Split(' ')[0];" ^
    "    } elseif ($cleanLine -ne '' -and -not ($cleanLine -match '^(WEBVTT|Kind:|Language:|NOTE)')) {" ^
    "        if ($cleanLine -ne $lastText) {" ^
    "            if ($lastTime -ne '') {" ^
    "                $result.Add('[' + $lastTime + '] ' + $cleanLine);" ^
    "                $lastTime = '';" ^
    "            } else {" ^
    "                $result.Add($cleanLine);" ^
    "            }" ^
    "            $lastText = $cleanLine;" ^
    "        }" ^
    "    }" ^
    "}" ^
    "[System.IO.File]::WriteAllLines('%OUTPUT_FILE%', $result, [System.Text.Encoding]::UTF8);"

echo 完了しました！
echo 出力ファイル: "%OUTPUT_FILE%"
pause