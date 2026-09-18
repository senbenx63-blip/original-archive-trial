# json/txt ファイルを 拡張子/年号 のフォルダに自動振り分けするスクリプト
# このスクリプトと同じ場所に .json / .txt ファイルを置いて実行してください

$targetExtensions = @('.json', '.txt')
$files = Get-ChildItem -Path $PSScriptRoot -File | Where-Object { $targetExtensions -contains $_.Extension }

if ($files.Count -eq 0) {
    Write-Host "対象の .json / .txt ファイルが見つかりませんでした。"
    exit
}

foreach ($file in $files) {
    $baseName = $file.BaseName   # 拡張子を除いたファイル名（例: 072426_2）

    if ($baseName -match '^(\d{6})') {
        $code = $matches[1]
        $year = '20' + $code.Substring(4, 2)   # 下2桁から年号を判定（例: 072426 → 2026）
        $folderType = $file.Extension.TrimStart('.')   # json または txt

        $destDir = Join-Path $PSScriptRoot (Join-Path $folderType $year)
        if (-not (Test-Path $destDir)) {
            New-Item -ItemType Directory -Path $destDir | Out-Null
        }

        $destPath = Join-Path $destDir $file.Name
        Move-Item -Path $file.FullName -Destination $destPath -Force
        Write-Host "移動しました: $($file.Name) → $folderType\$year\"
    } else {
        Write-Host "スキップ（6桁の数字が見つかりません）: $($file.Name)"
    }
}

Write-Host ""
Write-Host "完了しました。"
