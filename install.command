#!/bin/bash
# install.command - double-click this on macOS to install Ace OS Starter.
# It opens Terminal, runs install.sh and keeps the window open so you can read the result.
# If macOS says it cannot be opened: System Settings -> Privacy & Security -> Open Anyway, or run `bash install.sh` in Terminal.
# If it says you lack permission: open Terminal in this folder and run   bash install.sh
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE" || exit 1
bash "$HERE/install.sh" "$@"
RC=$?
echo
if [ "$RC" -eq 0 ]; then echo "Ace OS Starter: install finished."; else echo "Ace OS Starter: install stopped (code $RC). Read the messages above."; fi
read -r -p "Press Return to close this window..." _
exit "$RC"
