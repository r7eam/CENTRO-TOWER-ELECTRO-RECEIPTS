@echo off
rem Makes CENTRO TOWER start automatically when this Windows user logs in.
rem To undo: delete "Centro Tower.lnk" from the Startup folder (Win+R, type shell:startup).
cd /d "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\Centro Tower.lnk');" ^
  "$s.TargetPath='%CD%\Start Centro Tower.bat'; $s.WorkingDirectory='%CD%'; $s.WindowStyle=7; $s.Save()"
echo Done. CENTRO TOWER will start automatically at the next login.
pause
