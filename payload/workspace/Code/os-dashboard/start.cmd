@echo off
REM Ace OS . Mission Control - Windows launcher (double-click or run from cmd).
REM Forwards all args to start.mjs, e.g.  start.cmd --chat --port 7778
REM Never stops a process it did not start: if Ace OS is already running it just opens the browser;
REM if the port is taken by something else it uses the next free port.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or newer is required: https://nodejs.org
  pause
  exit /b 1
)
node "%~dp0start.mjs" %*
