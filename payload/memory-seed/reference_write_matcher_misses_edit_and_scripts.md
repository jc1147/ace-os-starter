---
name: A Write matcher misses Edit and script writes
description: A PreToolUse hook with matcher Write fires only on the Write tool; the Edit tool and a script writing with fs.writeFileSync or shell redirection bypass it, so whole-path enforcement needs Write and Edit (and MultiEdit) matchers plus a Stop or PostToolUse check that re-reads the file on disk.
metadata:
  type: reference
  seed: aceos-starter
---
A PreToolUse hook registered with `matcher: "Write"` fires only on the **Write tool**. It does not fire on:
- the **Edit** (or MultiEdit) tool;
- a **Bash/PowerShell/Node** command that writes the file (`fs.writeFileSync`, `>` redirection, a copy).

**Why:** a gate suite can look airtight (fail-closed, fires on a clean Write) and protect nothing once the work
routes through Edit or a script, which is exactly what happens when an agent writes a helper script to splice files.
Green build, zero enforcement.

**How to apply:**
- For an invariant that must hold for every change to a path, match `Write|Edit|MultiEdit`, and add a shell matcher
  or move the heavy check to a Stop/PostToolUse gate that re-reads the file on disk however it was written.
- When auditing whether gates held in a session, check how each file was written, not only that gates exist.

Related: [[reference_hook_scoping_settings_vs_skill]], [[reference_gate_scope_narrower_than_its_name]].
