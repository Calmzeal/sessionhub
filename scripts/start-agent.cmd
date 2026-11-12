@echo off
cd /d "%~dp0.."
where node >nul 2>nul
if %errorlevel%==0 (
  node agent\agent.js
) else (
  "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" agent\agent.js
)
if errorlevel 1 pause
