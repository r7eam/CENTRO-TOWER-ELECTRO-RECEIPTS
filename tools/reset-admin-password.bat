@echo off
chcp 65001 >nul
title CENTRO TOWER - reset admin password
cd /d "%~dp0.."
node --disable-warning=ExperimentalWarning tools\reset-admin-password.js
pause
