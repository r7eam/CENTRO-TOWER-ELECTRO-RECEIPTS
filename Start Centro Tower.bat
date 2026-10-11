@echo off
title CENTRO TOWER - receipts server
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
node --disable-warning=ExperimentalWarning server.js --open
pause
