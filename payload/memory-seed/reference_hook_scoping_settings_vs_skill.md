---
name: Hook scoping, settings versus skill frontmatter
description: Where a Claude Code hook is declared decides when it fires. settings.json hooks fire for the whole session and load only from the launch folder and the user folder (no parent fallback); skill or agent frontmatter hooks fire only while that skill or agent is active; CLAUDE_PROJECT_DIR is the launch folder, not the git root.
metadata:
  type: reference
  seed: aceos-starter
---
**The rules**
- **`~/.claude/settings.json` hooks** fire in every project. **`<project>/.claude/settings.json` hooks** fire for
  every matching event in sessions launched from that folder. Settings do not cascade from parent folders: a session
  started in a subfolder does not load the parent's project settings.
- **Skill or agent frontmatter `hooks:`** fire only while that skill or agent is active, and are cleaned up when it
  ends. A tool call made without invoking the skill will not trigger them, by design.
- **`$CLAUDE_PROJECT_DIR`** is the folder the session was launched from, not necessarily the git root. Building a
  path from it as if it were the repo root can double a path segment.
- **Timeouts:** a hook that does not finish inside its timeout is cancelled and the tool call goes ahead. A slow
  blocking hook is a hook that sometimes does not block.

**Why:** a smoke test that writes a file without activating the skill makes skill hooks look broken; "fixing" that by
adding a settings file in a shared parent folder changes the hooks of every other session launched there.

**How to apply:** test skill hooks with the skill actually invoked. Never add a `.claude/settings.json` in a folder
other sessions launch from without checking what it does to them. Keep blocking hooks fast. Related:
[[reference_hook_anatomy_four_decisions]], [[reference_write_matcher_misses_edit_and_scripts]].
