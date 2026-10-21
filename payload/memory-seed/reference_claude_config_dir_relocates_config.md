---
name: CLAUDE_CONFIG_DIR moves the whole config layer
description: CLAUDE_CONFIG_DIR relocates settings.json, hooks, projects and memory, skills, commands and agents, but not the login file ~/.claude.json; any code that reads the config layer must resolve CLAUDE_CONFIG_DIR before assuming ~/.claude, which is why the Ace OS installer stops when it is set elsewhere.
metadata:
  type: reference
  seed: aceos-starter
---
As documented when this note was written:
- **Moves:** `settings.json`, `hooks/`, `projects/` (and so every memory folder), `skills/`, `commands/`, `agents/`.
- **Does not move:** `~/.claude.json` (login state and personal MCP configuration stay shared).

**Why:** a hard-coded `~/.claude` silently breaks under a relocated config: the tool writes to one place while Claude
Code reads another, and nothing errors. Ace OS installs into `~/.claude` and its hooks look there, so the installer
refuses to run when `CLAUDE_CONFIG_DIR` points somewhere else rather than install a stack Claude would never load.

**How to apply:** in any script that touches the config layer, resolve `process.env.CLAUDE_CONFIG_DIR ||
<home>/.claude`. If you use a separate config dir on purpose, know that the Ace OS hooks, skills and brain will not be
seen from it. Related: [[feedback_runtime_files_must_be_portable]].
