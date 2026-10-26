@echo off
rem Double-click to publish a new version to GitHub. Other computers will offer the update.
cd /d "%~dp0"
set /p NOTES=What changed (one line, optional):
node scripts\release.js patch "%NOTES%"
echo.
pause
