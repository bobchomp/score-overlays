@echo off
title Score Overlays
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
if not exist .env (
  copy .env.example .env >nul
  echo Created .env - edit it to set CONTROL_PIN and your OBS password.
)
call npm start
pause
