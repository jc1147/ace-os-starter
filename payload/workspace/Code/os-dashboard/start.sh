#!/usr/bin/env bash
# Ace OS . Mission Control - launcher (macOS / Linux).
#
# Usage:   ./start.sh [--chat] [--port 7777] [--no-open]
#
# Never stops a process it did not start: if Ace OS is already running it just opens the browser;
# if the port is taken by something else it uses the next free port. Keep this terminal open; Ctrl+C stops it.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
# A double-clicked "Start Ace OS.command" can start with a short PATH; add the usual Node install locations
# (Homebrew on Apple Silicon and Intel, the nodejs.org installer, Volta), the same list install.sh uses.
for d in /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin"; do
  case ":$PATH:" in *":$d:"*) ;; *) [ -d "$d" ] && PATH="$PATH:$d" ;; esac
done
export PATH
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 or newer is required: https://nodejs.org"
  exit 1
fi
exec node "$HERE/start.mjs" "$@"
