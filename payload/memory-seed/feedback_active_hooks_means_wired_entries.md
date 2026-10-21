---
name: Active hooks means wired entries
description: To answer which hooks are active, read the hooks block of settings.json and count entries per event; a hook file in the hooks folder that is not wired does nothing, and one file can be wired several times.
metadata:
  type: feedback
  seed: aceos-starter
---
"Hooks" is overloaded. A hook **file** sits on disk; a hook is **active** only when a `settings.json` `hooks` block
references it under an event (SessionStart, PreToolUse, Stop, ...), optionally with a matcher. The same file can be
wired more than once (for example both Stop and SubagentStop).

**Why:** listing the hooks folder conflates dormant files with the live set, so "what hooks do I have" and "does
this install ship them" get wrong answers.

**How to apply:** for any question about active hooks, parse the wiring verbatim and count entries per event:
- global: `~/.claude/settings.json`, key `hooks`;
- workspace: `<workspace>/.claude/settings.json`, key `hooks`.

The shipped global set is described in `~/.claude/HOOKS.md` ([[reference_the_global_gate_set]]). When checking that
an install shipped everything, check each wired entry exists and runs (`node --check` plus a real event), not that a
folder has the same file names.
