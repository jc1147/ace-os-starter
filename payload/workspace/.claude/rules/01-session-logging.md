# Session Logging (All Chats)

Session logs use a **two-tier system**: detailed daily temp logs and brief monthly master logs.

## Tier 1: Temp Logs (Daily, Detailed, Ephemeral)

**Every chat must log work as it happens.** This ensures nothing is lost even if the user walks away without wrapping up.

### How It Works
1. After completing any significant task or milestone, append an entry to a temp log file
2. **Get the GitHub username first:** run `gh api user --jq '.login'` and cache it for the session. This is required — do not skip this step.
3. Use the file path: `logs/temp/{project}-{username}-{YYYY-MM-DD}-{sid8}.md`. The `{username}` segment is mandatory — never omit it. The trailing `{sid8}` is an 8-char session id injected at session start (see "Per-session keying" below) — use the value provided; do not invent or omit it.
4. Session-logger will consolidate these into official logs at end of day

### Per-session keying (`{sid8}`)

`{sid8}` is an 8-character slice of the session id. It is **injected at session start by `session-init.js`** (surfaced in the session context) and **enforced by `block-unkeyed-temp-log.js`**, which blocks a temp-log write whose filename lacks a valid `-{sid8}` suffix. The purpose is isolation: when two or more sessions run the same project on the same day, each writes to its own `{project}-{username}-{date}-{sid8}.md` file, so **concurrent sessions never share — and never clobber — a single temp-log file**. Session-logger merges these per-session files back together at consolidation time (see below).

### What to Log
- Completed tasks or features
- Decisions made
- Problems solved
- Blockers encountered
- Outstanding items when pausing work

### Temp Log Format
```markdown
## HH:MM - [Brief description]
- What was done
- Key decisions or context
- Any blockers or next steps
```

### Project Mapping

Use the project name as the `{project}` prefix. Derive `{username}` at session start — never hardcode a machine's username: read the cached value at `~/.claude_github_username` if it exists; otherwise run `gh api user --jq '.login'` and write the result to that cache file. Date format is `YYYY-MM-DD`. The trailing `-{sid8}` is the per-session key described above — append the injected value to every filename below.

Mapping:
- General workspace / setup / cross-cutting work → `workspace-{username}-{date}-{sid8}.md`
- Code / software / repo work / technical builds → `code-{username}-{date}-{sid8}.md`
- Marketing / campaigns / brand / content → `marketing-{username}-{date}-{sid8}.md`
- Sales / pipeline / outreach / proposals → `sales-{username}-{date}-{sid8}.md`
- Operations / SOPs / vendor / process → `operations-{username}-{date}-{sid8}.md`
- Product / roadmap / spec / research → `product-{username}-{date}-{sid8}.md`
- Finance / budget / report / forecast / P&L → `finance-{username}-{date}-{sid8}.md`

Add a line here (and in the `PROJECT_MAPPING` list in `.claude/hooks/session-init.js`) for every project you add.

### When NOT to Log
- Exploratory questions or research that didn't lead anywhere
- Trivial fixes (typos, formatting)
- Conversations without actionable outcomes

## Tier 2: Master Logs (Monthly, Brief, Permanent)

- Consolidated from temp logs by session-logger agent. When parsing temp-log filenames, treat the trailing `-{sid8}` as **OPTIONAL**: match `{project}-{username}-{YYYY-MM-DD}[-{sid8}].md`, so legacy 3-segment files (`{project}-{username}-{date}.md`) written before per-session keying still parse. Group files by `(project, date)` across every `{sid8}` variant, then **MERGE the entries from all of a group's session files by their `## HH:MM` timestamps** (interleave chronologically) before consolidating into the monthly log — so concurrent sessions on the same project/day fold into one coherent daily record.
- Live in `{Project}/logs/{project}-session-log-{YYYY-MM}.md` (or `logs/session-log-{YYYY-MM}.md` if single-project)
- Brief summaries — key accomplishments, outstanding items, action items
- **Never archived** — these are the canonical history
- Only the current month is loaded into context by default

### Archive (Backup Only)

Processed temp logs are moved to `logs/archive/` by session-logger. This archive is excluded from search via `.claudeignore`.

- **Do NOT read archive files** when catching up on project status or figuring out where we left off
- **Use official session logs** and status files for current context
- **Only read archive** if the user explicitly asks to retrace steps from a specific date, or if official logs are missing context
