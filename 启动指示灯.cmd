@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 24 and try again.
  pause
  exit /b 1
)
node.exe "%~dp0scripts\start-desktop.mjs"
set "indicator_exit=%errorlevel%"
if not "%indicator_exit%"=="0" (
  echo.
  echo AI Signal could not start. See the message above.
  pause
)
exit /b %indicator_exit%
