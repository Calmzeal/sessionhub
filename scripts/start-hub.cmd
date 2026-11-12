@echo off
cd /d "%~dp0.."
where node >nul 2>nul
if %errorlevel%==0 (
  node server\index.js
) else (
  "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" server\index.js
)
if errorlevel 1 pause
