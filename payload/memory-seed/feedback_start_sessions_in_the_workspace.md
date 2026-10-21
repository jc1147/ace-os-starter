---
name: Start Claude in the workspace folder
description: A session's project - its CLAUDE.md, workspace hooks, skills, MCP servers and its memory folder - is fixed by the folder it starts in, so start Claude Code in ~/ace; a terminal tab that opens in the home folder silently runs a different project.
metadata:
  type: feedback
  seed: aceos-starter
---
Claude Code picks the project from the folder it is launched in. A session started in `~/ace` gets the workspace
CLAUDE.md, the workspace hooks and skills, and the brain at `~/.claude/projects/<slug of ~/ace>/memory/`. A session
started in the home folder (a new terminal tab often opens there) gets none of the workspace layer and a different,
usually empty, memory folder.

**Why:** weeks of sessions can run from the wrong folder without anyone noticing, because the global hooks still
fire. Notes may still land in the right brain (the memory tools find it structurally), but workspace rules, temp
logging and skills are missing, and session history is filed under another project.

**How to apply:**
- Open the terminal in `~/ace` before running `claude` (set your terminal profile's starting folder to it), or use
  the Ace OS launcher.
- If you notice a session is in the wrong folder, restart it from `~/ace`. Carrying an old session over with
  `claude --resume <session-id> --fork-session` from inside `~/ace` has worked, but treat that as unverified on your
  machine and check what loaded.

Related: [[reference_how_your_brain_works]].
