@echo off
title Score Overlays - update
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update.ps1"
if errorlevel 1 (
  echo.
  echo The update did not finish, so the server was not started. See the messages above.
  pause
  exit /b 1
)
echo.
echo Starting the score server...
call "%~dp0start.bat"
