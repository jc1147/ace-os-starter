# Ace OS

Your business workspace with Claude built in. You work here; Claude tracks what was done, what was decided and
what is next, remembers what it learned across sessions, and has to prove its work before it calls anything done.

## What is in here

| Piece | What it does |
|---|---|
| **Agents** (`.claude/agents/`) | Named helpers you trigger in plain English: setup, status, logs, git, goals, triage, pattern mining. |
| **Temp logs** (`logs/temp/`) | Every session writes what it did as it goes. `session-logger` rolls them into a monthly log. |
| **The brain** (`Code/memory-system/` + the `memory` and `wrap-up` skills) | A file-based memory: one fact per note, searchable, organised into a sitemap. Claude reads it every session. |
| **The gates** (`~/.claude/hooks/`) | Global hooks that block unproven "done" claims, keep the memory honest and catch common mistakes. See `~/.claude/HOOKS.md`. |
| **Ace OS dashboard** (`Code/os-dashboard/`) | Mission Control in your browser, with a live 3D view of the brain and a sitemap of every note. |
| **Goals** (`goals/`, `goals-schema.md`) | An OKR system in YAML: objectives, key results, initiatives, tasks. |

## First time

Open this folder in Claude Code and say **"start here"**. The `start-here` agent asks who you are and what you
work on, records that in your brain, offers to set up goals, and registers your first project. It takes about
ten minutes. Want the big picture first? Say **"how does this work"** for the `system-overview` tour.

## Every day

| Say this | What happens |
|---|---|
| "what's the status" | `status-reporter` builds a project dashboard from your status files, goals and logs |
| "what should I work on" | `pm` triages your tasks into ready / blocked / needs a decision |
| "save my work" | `workspace-sync` commits (and pushes, if you have a remote) in plain English |
| "consolidate my logs" | `session-logger` rolls today's temp logs into the monthly session log |
| "weekly review" | `goals-weekly-review` collects key-result actuals and drafts a summary email |
| "find patterns" | `skill-mining` looks back over your logs for wins to repeat and friction to fix |
| `/wrap-up` | End of a working session: records what was learned in the brain, rebuilds the index, tidies the log |

**Open Ace OS:** double-click `Start Ace OS` in this folder (Windows `Start Ace OS.cmd`, macOS
`Start Ace OS.command`). Your browser opens Mission Control on `http://127.0.0.1:7777` (or the next free port).

**Search the brain yourself:** `node "$HOME/ace/Code/memory-system/recall.mjs" "your topic"`.

## Settings you may want to change

- **Permission prompts.** `.claude/settings.json` ships with `"defaultMode": "bypassPermissions"`, so Claude does
  not ask before each action inside this folder. Remove that line (or set it to `"default"`) to be asked every
  time. Review changes with `git diff` either way.
- **A gate you do not want.** Every global hook is listed in `~/.claude/HOOKS.md` with how to turn it off.
- **Project mapping for temp logs.** Edit `.claude/rules/01-session-logging.md` and the mapping in
  `.claude/hooks/session-init.js` together.

## Requirements

Node.js 18 or newer. Git is recommended (for `workspace-sync` and history). Nothing else: every tool here uses
only Node's standard library, so there is no `npm install`.

## Credits and license

- **Ace Level 1** (the workspace method, agents, goals system and logging conventions): MIT, Copyright (c)
  Alcanah Partners LLC, founded by Alfred Naayem.
- **Ace OS**, the **GodClaude** gates, the brain and the dashboard: MIT, Copyright (c) James Compton.
- **three.js** (the 3D brain renderer): MIT, Copyright (c) three.js authors.

See `LICENSE` for the full text.
