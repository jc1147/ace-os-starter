# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in this workspace.

## Workspace Purpose

This is **Ace OS**: your business workspace with an AI operating layer built in. Your files (code, documents,
spreadsheets, whatever you work on) live here, and Claude tracks progress, decisions and goals alongside them.

Ace OS is built on **Ace Level 1** (the workspace method: agents, temp logs, session logs, goals) and adds three
things on top:

- **The gates** — global Claude Code hooks in `~/.claude/hooks/` that make Claude prove its work before it says
  "done", keep the memory honest and stop common mistakes. The full list is in `~/.claude/HOOKS.md`.
- **The brain** — a file-based memory that persists across sessions, with tools in `Code/memory-system/` and the
  `memory` and `wrap-up` skills.
- **The Ace OS dashboard** — Mission Control in your browser, with a live 3D view of the brain
  (`Code/os-dashboard/`).

## Workspace Structure

| Path | Purpose |
|------|---------|
| `CLAUDE.md` | This file: workspace context Claude reads on every session |
| `README.md` | What this workspace is and how to use it day to day |
| `tasks-inbox.md` | Open list of work not yet tied to a project or goal |
| `goals/` | YAML OKR system (created by `goals-onboarding`) |
| `goals-schema.md` | Reference spec for the OKR YAML format |
| `.claude/agents/` | Installed agents (see `.claude/agents/manifest.json`) |
| `.claude/hooks/` | Workspace hooks: `session-init.js`, `prompt-check.js`, `block-unkeyed-temp-log.js` |
| `.claude/rules/` | Always-active behavioral rules |
| `.claude/skills/` | Workspace copies of the `memory` and `wrap-up` skills (identical to `~/.claude/skills/`) |
| `.claude/settings.json` | Permission mode and workspace hook wiring |
| `Code/memory-system/` | The brain's tools: `recall`, `reindex`, the index builders, the audits |
| `Code/os-dashboard/` | The Ace OS dashboard (Mission Control + the 3D brain) |
| `mcp-guides/` | Setup guides for optional integrations (Google Workspace and prerequisites) |
| `logs/temp/` | Real-time work capture, one file per session (consolidated into session logs) |
| `logs/archive/` | Processed temp logs (excluded from search) |
| `ace.code-workspace` | VS Code workspace file: open this instead of `code .` |
| `_SITEMAP.md`, `_MOC-*.md` | Generated maps of the brain (rebuilt by `reindex`; never hand-edit inside the generated block) |

## Project Locations

| Project | Location | Description |
|---------|----------|-------------|
| Workspace | `.` | The hub: this file, agents, hooks, rules, the brain's tools and `logs/`. |

_Add a row for every project folder or repo you work on (for example `Marketing/`, `Sales/`, `Code/my-app/`).
`start-here` adds the first ones for you; tell Claude "add a project at <path>" to register more._

## Session Role

When working in this workspace, Claude should:
- Help with project work (code, documents, planning, whatever the user needs)
- Track work automatically through temp logs and session logs
- Keep status and goals files updated as work progresses
- Record durable lessons in the brain (see "The brain" below) and recall them before re-deriving anything
- Surface active priorities and blockers when asked "what's the status"

## Reporting Structure

For each project (or for this single workspace):
- `status.md`: current priorities, active workstreams, blockers
- `goals/`: YAML OKR system (annual objectives, quarterly KRs, initiatives, tasks-inbox)
- `tasks-inbox.md` (root): actionable items not yet tied to an initiative
- `logs/session-log-{YYYY-MM}.md`: monthly summary (consolidated by `session-logger`)

## Agents

Installed agents live in `.claude/agents/`. Read `.claude/agents/manifest.json` for the inventory and which are
default vs optional.

| Agent | Purpose | Trigger |
|-------|---------|---------|
| `system-overview` | Tour of how Ace and Ace OS work before diving in | "intro", "how does this work", "explain the system" |
| `start-here` | First-run onboarding: you, your goals, your first project | "start here", "set me up" |
| `vscode-setup` | Configure VS Code: extensions, layout, permission layers | "set up VS Code" |
| `session-logger` | Consolidate temp logs into session logs | "consolidate my logs" |
| `workspace-sync` | Git operations through natural language | "save my work", "sync" |
| `status-reporter` | Project dashboard | "what's the status" |
| `calendar-audit` | Review calendar events, log outcomes (needs Google Workspace MCP) | "check my calendar" |
| `goals-onboarding` | Set up the OKR YAML structure | "set up goals" |
| `goals-weekly-review` | Weekly KR actuals + narrative email | "weekly review" |
| `pm` | Triage tasks into ready / blocked / needs-decision; suggest assignments | "what should I work on", "triage my tasks" |
| `skill-mining` | Surface patterns from history (wins to repeat, friction to fix, SOP candidates) | "find patterns" |
| `os-worker` | The worker the dashboard chat hands real work to | used by the dashboard chat |

## The brain (memory)

Your brain lives where Claude Code keeps project memory:
`~/.claude/projects/<this workspace's slug>/memory/` (the slug is this folder's full path with every character
that is not a letter or digit turned into `-`). It is plain markdown, one fact per note, with frontmatter.

- **Recall first.** Before saying "I don't know" or re-deciding something, run
  `node "$HOME/ace/Code/memory-system/recall.mjs" "<topic>"` (keyword search over every note; also the duplicate
  check before writing a new one).
- **Record** durable facts as atomic notes with the `memory` skill (`/memory`). `MEMORY.md` is a small router,
  not a list: new notes go in the tree, and `node "$HOME/ace/Code/memory-system/reindex.mjs"` rebuilds the
  index, the type maps and the sitemap.
- **Wrap up** every working session with `/wrap-up`: it records a proportional set of notes, rebuilds the index,
  consolidates the temp log and gives a clean summary. A Stop gate checks that the memory pass happened.

The full protocol is injected into every session from `~/.claude/memory-protocol.md`.

## The gates (global hooks)

Ace OS installs a set of global hooks in `~/.claude/hooks/`, wired in `~/.claude/settings.json`. They run in
every Claude Code session on this machine, not just in this folder. In short: a deterministic operating
contract is injected at session start; Stop gates bounce "done / works / fixed" claims that have no proof in
the turn; memory gates keep `MEMORY.md` small and make sure a wrap-up records what was learned; PreToolUse gates
block machine-specific paths written into files, oversized `MEMORY.md` writes, commits of real work with no memory
pass, and starting a server by hand when it ships a launcher. `~/.claude/HOOKS.md` lists every hook, what it
blocks or injects, and how to turn it off.

## Ace OS dashboard

Double-click `Start Ace OS` in this folder (Windows: `Start Ace OS.cmd`, macOS: `Start Ace OS.command`), or run
the start script in `Code/os-dashboard/`. It opens Mission Control in your browser on `http://127.0.0.1:7777`
(or the next free port). The Calm window shows the 3D brain; Expand opens it full screen at `/brain/`, and
`/sitemap/` shows every note by subject. The chat panel is off until you turn it on.

## Temp Logging

**Every chat must log work as it happens.**

1. After completing any significant task or milestone, append an entry to a temp log file
2. File path: `logs/temp/{project}-{username}-{YYYY-MM-DD}-{sid8}.md`
   - `{username}` comes from `~/.claude_github_username` (your GitHub login, else your git or OS user name)
   - `{project}` defaults to `workspace` for single-project workspaces
   - `{sid8}` is an 8-character per-session key injected at session start by `session-init.js`, so concurrent
     sessions never share a temp-log file (see `.claude/rules/01-session-logging.md`)
3. `session-logger` consolidates these into the official session log on demand or at the end of the day

### Temp Log Format

```markdown
## HH:MM - [Brief description]
- What was done
- Key decisions or context
- Any blockers or next steps
```

## Working Guidelines

- Always read existing files before making modifications
- When updating documents, preserve existing information unless explicitly asked to remove it
- Use consistent formatting within document types
- Date-stamp entries where temporal context matters
- Never modify code without explicit permission from the user

## Permission Mode

This workspace ships with `defaultMode: bypassPermissions` in `.claude/settings.json`: Claude runs without
confirmation prompts inside this folder. Review changes with `git diff` before pushing.

To switch to per-prompt confirmations, edit `.claude/settings.json` and remove the `defaultMode` line, or set it
to `"default"`. See `vscode-setup` for the full breakdown of permission layers.

## Adding New Projects

When you have more folders or repos to bring in:
1. Tell Claude: "I want to add a project at `~/code/my-app`"
2. Claude (via `start-here`) adds the workspace pieces to that repo if you want them (`.claude/`, a tailored CLAUDE.md)
3. Adds it to the Project Locations table here
4. Creates a tracking folder for it (status, goals, session log)
5. Updates the temp log project mapping in `.claude/rules/01-session-logging.md` and `.claude/hooks/session-init.js`
