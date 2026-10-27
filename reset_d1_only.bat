@echo off
cd /d "%~dp0"

echo ==============================
echo  Reset D1 (chamagame-archive)
echo  Drops all tables and recreates EMPTY tables.
echo  No data is uploaded. D1 will be EMPTY afterwards.
echo ==============================
set /p ANS=Type yes to continue: 
if /i not "%ANS%"=="yes" goto cancel

echo.
echo [1/4] Regenerating schema.sql from the local DB...
python export_for_d1.py
if errorlevel 1 goto fail_nochange
for %%A in (d1_export\schema.sql) do if %%~zA LSS 1000 goto empty_local

echo.
echo [2/4] Dropping D1 tables...
call npx wrangler d1 execute chamagame-archive --remote --file=./reset_d1.sql -y
if errorlevel 1 goto fail

echo.
echo [3/4] Creating empty tables on D1...
call npx wrangler d1 execute chamagame-archive --remote --file=./d1_export/schema.sql -y
if errorlevel 1 goto fail

echo.
echo [4/4] Resetting d1_synced.txt (moved to d1_synced.bak)...
if exist d1_synced.txt move /y d1_synced.txt d1_synced.bak > nul

echo.
echo ==============================
echo  Done. D1 is now empty.
echo  Next: run update_and_sync_old.bat, then run fts.sql
echo ==============================
pause
exit /b 0

:cancel
echo Cancelled. Nothing was changed.
pause
exit /b 1

:empty_local
echo ERROR: the local DB (chama_archive.db in THIS folder) is empty or missing.
echo Nothing was changed on D1. Run this in the folder that has the real chama_archive.db.
pause
exit /b 1

:fail_nochange
echo ERROR before touching D1. Nothing was changed on D1.
pause
exit /b 1

:fail
echo ERROR while changing D1. D1 may be in a partial state.
echo Check it with: npx wrangler d1 execute chamagame-archive --remote --command "SELECT name, type FROM sqlite_master"
pause
exit /b 1