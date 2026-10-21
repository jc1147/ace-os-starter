@echo off
REM install.cmd - double-click this on Windows to install Ace OS Starter.
REM Checks that Node.js 18+ is available, then runs installer\install.mjs (any flag is passed through,
REM e.g.  install.cmd --dry-run ). Set ACE_OS_NO_PAUSE=1 to skip the final pause.
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not on PATH.
  echo Install Node.js 18 or newer ^(the LTS version from https://nodejs.org^), then run this again.
  if not defined ACE_OS_NO_PAUSE pause
  exit /b 1
)
node -e "process.exit(+process.versions.node.split('.')[0] >= 18 ? 0 : 1)"
if errorlevel 1 (
  echo Your Node.js is older than 18. Install the LTS version from https://nodejs.org, then run this again.
  if not defined ACE_OS_NO_PAUSE pause
  exit /b 1
)
set DRY=
echo %* | find /i "--dry-run" >nul && set DRY=1
node "%~dp0installer\install.mjs" %*
set RC=%ERRORLEVEL%
echo.
if not "%RC%"=="0" goto failed
if defined DRY (echo Ace OS Starter: dry run finished. Nothing was changed.) else (echo Ace OS Starter: install finished.)
goto done
:failed
echo Ace OS Starter: install stopped ^(code %RC%^). Read the messages above.
:done
if not defined ACE_OS_NO_PAUSE pause
exit /b %RC%
