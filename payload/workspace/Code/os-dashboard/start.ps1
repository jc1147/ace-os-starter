# Ace OS . Mission Control - launcher (Windows PowerShell).
#
# Usage:   .\start.ps1 [-Chat] [-Port 7777] [-NoOpen]
#   -Chat    turn on the optional chat surface (claude -p behind a secret token, localhost only).
#   -Port    the first port to try (default 7777).
#   -NoOpen  do not open the browser.
#
# Never stops a process it did not start: if Ace OS is already running it just opens the browser;
# if the port is taken by something else it uses the next free port. Keep this window open; Ctrl+C stops it.
[CmdletBinding()]
param(
  [switch]$Chat,
  [int]$Port = 7777,
  [switch]$NoOpen
)
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeArgs = @((Join-Path $here 'start.mjs'), '--port', "$Port")
if ($Chat) { $nodeArgs += '--chat' }
if ($NoOpen) { $nodeArgs += '--no-open' }
& node @nodeArgs
exit $LASTEXITCODE
