#!/usr/bin/env bash
# install.sh - Ace OS Starter installer for macOS / Linux terminals.
# Checks that Node.js 18+ is available, then runs installer/install.mjs (all the real work happens there,
# the same code Windows runs). Any flag is passed through, e.g.  bash install.sh --dry-run
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"

# Double-clicked apps on macOS can start with a short PATH; add the usual Node install locations.
for d in /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin"; do
  case ":$PATH:" in *":$d:"*) ;; *) [ -d "$d" ] && PATH="$PATH:$d" ;; esac
done
export PATH

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed (or not on PATH)."
  echo "Install Node.js 18 or newer (the LTS version from https://nodejs.org), then run this again."
  exit 1
fi
MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$MAJOR" -lt 18 ] 2>/dev/null; then
  echo "Node.js $(node -v) is too old. Install Node.js 18 or newer from https://nodejs.org, then run this again."
  exit 1
fi

exec node "$HERE/installer/install.mjs" "$@"
