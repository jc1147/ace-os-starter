# Ace OS global hooks

Ace OS Starter installs 22 hooks into `~/.claude/hooks/` and wires them in `~/.claude/settings.json`, so they run in
EVERY Claude Code session on this machine (any folder), and in every subagent where noted. They are plain Node.js
scripts (no dependencies). Each one fails OPEN: if a hook itself errors, it allows, so a hook bug never traps a session.

- **Turn one hook off:** remove its entry (the object whose command ends in that file name) from the event list
  under `hooks` in `~/.claude/settings.json`, then start a new session. A hook wired on two events has two entries.
- **Turn them all off:** run the Ace OS Starter uninstaller (it removes only these entries and files).
- **See what they decided:** most hooks append one line per decision to `~/.claude/hook-audit.log`.
- **Test them:** `node ~/.claude/hooks/_test-hooks.mjs` runs every gate both ways and prints `ALL PASS (N/N)`.
- **Bounces are one-shot:** every Stop gate has a circuit breaker, so a session is bounced at most once per stop, never looped.

## Wiring (in run order)

| Event | Hooks |
|---|---|
| SessionStart | `inject-deterministic-contract.js`, `inject-memory-protocol.js`, `inject-memory-corrections.js`, `inject-ultracode-default.js`, `inject-first-run-onboarding.js` |
| SubagentStart | `inject-deterministic-contract.js`, `inject-memory-protocol.js` |
| UserPromptSubmit | `inject-anti-drift.js`, `inject-wrap-memory-directive.js` |
| PreToolUse | `block-memory-md-too-large.js` (`Write\|Edit`), `block-undocumented-launch.js` (`Bash\|PowerShell`), `block-memory-line-bloat.js` (`Write\|Edit`), `block-nonportable-path.js` (`Write\|Edit\|MultiEdit`), `block-commit-without-memory.js` (`Bash\|PowerShell`), `block-shared-file-contention.js` (`Write\|Edit\|MultiEdit\|NotebookEdit\|Bash\|PowerShell`), `block-git-add-sweep.js` (`Bash\|PowerShell`), `block-memory-git-rewrite.js` (`Bash\|PowerShell`) |
| Stop | `block-unverified-completion.js`, `block-unfounded-boot-claim.js`, `block-doc-action-drift.js`, `block-premature-stop.js`, `block-unpersisted-memory.js`, `regen-memory-index.js`, `block-wrap-without-memory.js` |
| SubagentStop | `block-unverified-completion.js`, `block-unfounded-boot-claim.js`, `block-doc-action-drift.js`, `block-premature-stop.js`, `block-unpersisted-memory.js` |

## Operating contract

### `inject-deterministic-contract.js`

- **Runs on:** SessionStart, SubagentStart
- **What it does:** Puts the Deterministic Operating Contract (`~/.claude/deterministic-contract.md`) in front of every session and every subagent.
- **Effect:** Injects context. Never blocks.
- **When it stops you:** Nothing to bypass. Edit `~/.claude/deterministic-contract.md` to change the text; an empty or missing file means nothing is injected.
- **Turn it off:** remove its `inject-deterministic-contract.js` entries from `~/.claude/settings.json` (SessionStart, SubagentStart).

### `inject-ultracode-default.js`

- **Runs on:** SessionStart
- **What it does:** Tells every session that the highest effort level is the intended default (substantive multi-step work should run as Workflows) and how to turn on Remote Control (`/remote-control`, or the setting in `/config`).
- **Effect:** Injects context at session start. Never blocks. It changes how much work Claude takes on per task, which uses more of your plan's usage.
- **When it stops you:** Lower it per session with `/effort high` (or any level).
- **Turn it off:** To stop the directive entirely, remove the `inject-ultracode-default.js` entry from `hooks.SessionStart` in `~/.claude/settings.json`.

### `inject-anti-drift.js`

- **Runs on:** UserPromptSubmit
- **What it does:** Re-injects a one-line reminder of the contract on every prompt, so the discipline survives long sessions and compaction.
- **Effect:** Injects context on each prompt. Never blocks.
- **When it stops you:** Nothing to bypass.
- **Turn it off:** remove its `inject-anti-drift.js` entry from `~/.claude/settings.json` (UserPromptSubmit).

### `block-undocumented-launch.js`

- **Runs on:** PreToolUse (`Bash|PowerShell`)
- **What it does:** Stops hand-spawning a project's entrypoint (`node .../server.js`, `index.js`, `app.js`, `main.js`) when that folder ships a documented launcher (`start.*`, `run.*`, `launch.*`, `serve.*`, `dev.*`).
- **Effect:** Denies the Bash/PowerShell command and names the launcher to use instead.
- **When it stops you:** Run the launcher, or put `DEVIATION-JUSTIFIED: <reason>` in the command (as a trailing comment) or in the message before it. Logged.
- **Turn it off:** remove its `block-undocumented-launch.js` entry from `~/.claude/settings.json` (PreToolUse).

### `block-unverified-completion.js`

- **Runs on:** Stop, SubagentStop
- **What it does:** The proof-of-work gate. Stops a turn that edited files (or ran state-changing commands), says done / fixed / works, and shows no verification: no re-read of a written file, no test/build/verify command, no evidence block.
- **Effect:** Blocks the stop once (the model must verify or say what is unverified). Pure Q&A turns are exempt.
- **When it stops you:** Verify: re-read the changed file, run the test/build, or put an `Evidence:` block in the closing message. A built-in circuit breaker lets the second stop through, so it never loops.
- **Turn it off:** remove its `block-unverified-completion.js` entries from `~/.claude/settings.json` (Stop, SubagentStop).

### `block-unfounded-boot-claim.js`

- **Runs on:** Stop, SubagentStop
- **What it does:** Stops a turn that claims a local server is up at a concrete `localhost` / `127.0.0.1` port without a fresh PASS from `verify-server-boot.mjs` for that port.
- **Effect:** Blocks the stop once and gives the exact verify command.
- **When it stops you:** Run `node ~/.claude/hooks/verify-server-boot.mjs http://127.0.0.1:<port>` (it writes the proof under `~/.claude/verify-artifacts/`), then make the claim.
- **Turn it off:** remove its `block-unfounded-boot-claim.js` entries from `~/.claude/settings.json` (Stop, SubagentStop).

### `block-doc-action-drift.js`

- **Runs on:** Stop, SubagentStop
- **What it does:** A warn-only drift measurer. On a qualifying stop it hands a small summary of the turn to a background worker (`doc-drift-judge-run.mjs`) that asks a small model, via `claude -p`, whether the turn followed the instruction documents in play and the user's request, and logs the verdict.
- **Effect:** NEVER blocks and adds no latency. COSTS model usage: one small-model call per qualifying stop, rate-limited to one per 90 seconds and 40 per day, duplicates skipped (budget file `~/.claude/.doc-drift-budget.json`). Verdicts go to `~/.claude/hook-audit.log` under `[doc-drift]`.
- **When it stops you:** Nothing to bypass (it never blocks).
- **Turn it off:** To stop the background judge calls, remove the `block-doc-action-drift.js` entries from BOTH `hooks.Stop` and `hooks.SubagentStop` in `~/.claude/settings.json`.

### `block-premature-stop.js`

- **Runs on:** Stop, SubagentStop
- **What it does:** The persistence gate. Stops a turn that was actively working and closes by recommending or deferring a fix it could have done ("the fix is ...", "want me to proceed?", "stopping here").
- **Effect:** Blocks the stop once with a keep-going nudge. A genuine hand-off to you (a decision, an approval, a destructive action, a real choice) is let through.
- **When it stops you:** Name the real decision you need from the user in the closing message. Circuit breaker: at most one bounce per stop.
- **Turn it off:** remove its `block-premature-stop.js` entries from `~/.claude/settings.json` (Stop, SubagentStop).

## Memory (the brain)

### `inject-memory-protocol.js`

- **Runs on:** SessionStart, SubagentStart
- **What it does:** Puts the Memory Protocol (`~/.claude/memory-protocol.md`) in front of every session and subagent: recall first, atomic notes, MEMORY.md is a router, dedup, connect.
- **Effect:** Injects context. Never blocks.
- **When it stops you:** Nothing to bypass. Edit `~/.claude/memory-protocol.md` to change the text.
- **Turn it off:** remove its `inject-memory-protocol.js` entries from `~/.claude/settings.json` (SessionStart, SubagentStart).

### `inject-memory-corrections.js`

- **Runs on:** SessionStart
- **What it does:** When you have flagged notes as wrong on the Ace OS memory sitemap page (`/sitemap/`, "This is wrong"), lists the open corrections at session start (at most 6 lines) with the commands to read and close them.
- **Effect:** Injects context only when corrections are open. Never blocks.
- **When it stops you:** Close the corrections (the injected text gives the command).
- **Turn it off:** remove its `inject-memory-corrections.js` entry from `~/.claude/settings.json` (SessionStart).
- **Settings (environment variables):**
  - `CLAUDE_MEM_DIR` — Use this memory folder instead of the one found automatically.
  - `MEMSYS_MEM_DIR` — Same as CLAUDE_MEM_DIR (checked first).

### `block-memory-md-too-large.js`

- **Runs on:** PreToolUse (`Write|Edit`)
- **What it does:** Keeps MEMORY.md a small router. Denies a Write/Edit to any MEMORY.md that would leave it over 24,400 bytes (the size Claude Code truncates at), over the 6,000-byte router budget, over 22 pin lines, or with a pin line over 220 characters.
- **Effect:** Denies the write and explains the fix (no MEMORY.md line for new notes, hub notes, one-in-one-out, `_sunset/`).
- **When it stops you:** Rotate the router (merge, demote, compress pins). `node "$HOME/ace/Code/memory-system/router-audit.mjs"` shows the budget.
- **Turn it off:** remove its `block-memory-md-too-large.js` entry from `~/.claude/settings.json` (PreToolUse).

### `block-memory-line-bloat.js`

- **Runs on:** PreToolUse (`Write|Edit`)
- **What it does:** Denies a hand Write/Edit that puts a pointer line (`- [...`) longer than 350 characters into MEMORY.md or a `_MOC-*.md` file. Generated MOCs are not affected.
- **Effect:** Denies the write.
- **When it stops you:** Shorten the line; the detail belongs in the note itself.
- **Turn it off:** remove its `block-memory-line-bloat.js` entry from `~/.claude/settings.json` (PreToolUse).

### `block-memory-git-rewrite.js`

- **Runs on:** PreToolUse (`Bash|PowerShell`)
- **What it does:** Guards a repo whose `memory` folder is a link (junction/symlink) into `~/.claude/projects/<slug>/memory`: denies checkout, reset --hard, stash, restore and clean commands that would rewrite or delete live notes. Ace OS Starter keeps the brain in `~/.claude/projects/...` and creates NO such link, so on a standard install this guard never engages.
- **Effect:** Denies the git command only in a guarded repo and only when memory files would change. Any other repo: allowed silently.
- **When it stops you:** Put `MEMORY_GIT_OK=1` before the command (bash), `$env:MEMORY_GIT_OK` (PowerShell) or a `# memory-git-ok` comment. Logged.
- **Turn it off:** remove its `block-memory-git-rewrite.js` entry from `~/.claude/settings.json` (PreToolUse).

### `block-unpersisted-memory.js`

- **Runs on:** Stop, SubagentStop
- **What it does:** When YOU said something like "remember that", "from now on", "note that", "don't forget" this turn and nothing was written to the memory folder, stops the turn once and asks Claude to record it. Only your own typed words count (task prompts, agent messages and summaries never trigger it).
- **Effect:** Blocks the stop once (circuit breaker).
- **When it stops you:** Record the note, or say why it should not be saved.
- **Turn it off:** remove its `block-unpersisted-memory.js` entries from `~/.claude/settings.json` (Stop, SubagentStop).

### `regen-memory-index.js`

- **Runs on:** Stop
- **What it does:** Keeps the brain's derived index current at the end of every turn: rebuilds `_manifest.json`, the `_MOC-*.md` category maps and the sitemap when notes changed, and the home-folder router. It only writes index files, never a note.
- **Effect:** Runs on Stop. Never blocks, does nothing when the index is fresh. Logs to `~/.claude/hook-audit.log`.
- **When it stops you:** Nothing to bypass. `node "$HOME/ace/Code/memory-system/reindex.mjs"` does the same by hand.
- **Turn it off:** remove its `regen-memory-index.js` entry from `~/.claude/settings.json` (Stop).
- **Settings (environment variables):**
  - `CLAUDE_MEM_DIR` — Use this memory folder instead of the one found automatically.
  - `MEMSYS_MEM_DIR` — Same as CLAUDE_MEM_DIR (checked first).

## Ace OS

### `inject-first-run-onboarding.js`

- **Runs on:** SessionStart
- **What it does:** First-run nudge. Until onboarding is finished it tells Claude to run the `start-here` agent (it ships in the Ace OS workspace, `~/ace`).
- **Effect:** Injects context at session start while the marker `~/.claude/.ace-os-onboarded` is absent; silent once it exists. Never blocks.
- **When it stops you:** Tell Claude you have already set up, or create the marker file `~/.claude/.ace-os-onboarded` yourself. `start-here` writes it when it finishes.
- **Turn it off:** remove its `inject-first-run-onboarding.js` entry from `~/.claude/settings.json` (SessionStart).
- **Settings (environment variables):**
  - `CLAUDE_CONFIG_DIR` — Where the marker is looked for (default `~/.claude`).

## Wrap-up

### `inject-wrap-memory-directive.js`

- **Runs on:** UserPromptSubmit
- **What it does:** When your prompt is a session wrap ("wrap it up", "call it a day", "done for now", ...), tells Claude that the memory pass is enforced, gives it this session's id for note attribution, and, for a large session, says the wrap-up skill's gap-hunt step is mandatory.
- **Effect:** Injects context on wrap prompts only. Never blocks.
- **When it stops you:** Nothing to bypass.
- **Turn it off:** remove its `inject-wrap-memory-directive.js` entry from `~/.claude/settings.json` (UserPromptSubmit).
- **Settings (environment variables):**
  - `CLAUDE_MEM_DIR` — Use this memory folder instead of the one found automatically.
  - `MEMGATE_MEM_DIR` — Memory folder override for the memory gates (checked first).

### `block-commit-without-memory.js`

- **Runs on:** PreToolUse (`Bash|PowerShell`)
- **What it does:** A `git commit` of non-trivial work in the Ace workspace should come with a memory pass for the same stretch of work. Asks the same oracle as the wrap gate.
- **Effect:** LOG-ONLY by default: writes WOULD-BLOCK to `~/.claude/hook-audit.log` and allows. Denies only with `MEMGATE_ENFORCE=1`. Trivial diffs (<= 25 lines and <= 3 files), memory/log-only commits and repos without the oracle are never gated.
- **When it stops you:** Record the pass, or add `DEVIATION-JUSTIFIED: <reason>` to the command or your message.
- **Turn it off:** remove its `block-commit-without-memory.js` entry from `~/.claude/settings.json` (PreToolUse).
- **Settings (environment variables):**
  - `MEMGATE_ENFORCE` — `1` = deny instead of log.
  - `MEMGATE_TRIVIAL_LINES` — Changed-line threshold below which a commit is trivial (default 25).
  - `MEMGATE_TRIVIAL_FILES` — File-count threshold below which a commit is trivial (default 3).
  - `MEMGATE_MEM_DIR` — Memory folder override (checked first).
  - `CLAUDE_MEM_DIR` — Memory folder override.

### `block-wrap-without-memory.js`

- **Runs on:** Stop
- **What it does:** When you wrap up a session that did real work, asks the evidence oracle (`~/ace/Code/memory-system/verify-memory-pass.mjs`) whether enough well-formed notes attributed to this session exist (1 / 2 / 3 by session size, plus a gap-hunt receipt for large sessions). If not, the wrap is bounced to the `/wrap-up` skill.
- **Effect:** ENFORCING by default: blocks the stop once. Trivial sessions (no edits, no side-effect commands, no delegations) are never gated.
- **When it stops you:** Run `/wrap-up`. If genuinely nothing durable happened, the skill's NOTHING_DURABLE receipt satisfies the oracle.
- **Turn it off:** remove its `block-wrap-without-memory.js` entry from `~/.claude/settings.json` (Stop).
- **Settings (environment variables):**
  - `MEMGATE_ENFORCE` — `0` = log-only (audit the would-be block and allow). Unset or `1` = enforce.
  - `MEMGATE_MEM_DIR` — Memory folder override (checked first).
  - `CLAUDE_MEM_DIR` — Memory folder override.

## Portability and parallel sessions

### `block-nonportable-path.js`

- **Runs on:** PreToolUse (`Write|Edit|MultiEdit`)
- **What it does:** Denies a Write/Edit that ADDS a machine-specific home path (a `<drive>:\Users\<name>` path, a `/<drive>/Users/<name>` path, or a username-derived memory-folder name) to a code file (.js .mjs .cjs .ts .tsx .py .ps1 .psm1 .sh .bash .bat .cmd), so your code keeps working on another machine or user account. Docs, data and comment lines are not checked.
- **Effect:** Denies the write and suggests `os.homedir()`, `CLAUDE_PROJECT_DIR` or a relative path.
- **When it stops you:** Add a `portable-exempt` comment on that line (for a deliberate fixture or example).
- **Turn it off:** remove its `block-nonportable-path.js` entry from `~/.claude/settings.json` (PreToolUse).

### `block-shared-file-contention.js`

- **Runs on:** PreToolUse (`Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell`)
- **What it does:** For two or more Claude sessions working in the same workspace at once: serializes writes to memory notes, MEMORY.md and `_MOC-*.md` with short file leases, and refuses a full-overwrite Write of MEMORY.md while another session is live.
- **Effect:** LOG-ONLY by default (audits `[file-lease]` and allows); denies only with `ACE_MULTISESSION_ENFORCE=1`. It learns which sessions are live from heartbeat files in `~/.claude/session-beats/`; Ace OS Starter ships no heartbeat writer, so out of the box every session counts as solo and this gate stays dormant.
- **When it stops you:** Re-read the file and retry once the other session's lease (120 s) has passed.
- **Turn it off:** remove its `block-shared-file-contention.js` entry from `~/.claude/settings.json` (PreToolUse).
- **Settings (environment variables):**
  - `ACE_MULTISESSION_ENFORCE` — `1` = deny instead of log.

### `block-git-add-sweep.js`

- **Runs on:** PreToolUse (`Bash|PowerShell`)
- **What it does:** For two or more live sessions in one working tree: flags `git add -A` / `--all` / `.`, `git commit -a`, and an un-scoped `git commit`, which would sweep the other session's work into this commit. The safe form is `git commit -m "..." -- <paths>`.
- **Effect:** LOG-ONLY by default (audits `[git-sweep]` and allows); denies only with `ACE_MULTISESSION_ENFORCE=1`. Uses the same heartbeat files as the contention gate, so it is dormant out of the box.
- **When it stops you:** Commit named paths only.
- **Turn it off:** remove its `block-git-add-sweep.js` entry from `~/.claude/settings.json` (PreToolUse).
- **Settings (environment variables):**
  - `ACE_MULTISESSION_ENFORCE` — `1` = deny instead of log.

## Support files (not wired; used by the hooks above)

- `lib-workspace.js` — Finds the Ace workspace (`~/ace`) and its brain folder from any working folder (env, then git toplevel, then the `~/.claude/projects/*-ace/memory` folder). Used by the memory hooks.
- `lib-concurrency.js` — Path normalization, session liveness (heartbeat files), file leases and lock files for the parallel-session gates and the index regenerator.
- `lib-owner-text.js` — Reads YOUR own typed words for the current turn out of the session transcript, so machine text (task prompts, agent messages, summaries) never triggers a memory gate.
- `doc-drift-judge-run.mjs` — The background worker `block-doc-action-drift.js` starts: it calls `claude -p` with a small model and logs the verdict.
- `verify-server-boot.mjs` — `node ~/.claude/hooks/verify-server-boot.mjs <url> [path]` probes a local server and writes the PASS/FAIL proof `block-unfounded-boot-claim.js` looks for.
- `_test-hooks.mjs` — The hook test suite: `node ~/.claude/hooks/_test-hooks.mjs` runs every gate both ways (should block / should allow) against throwaway fixtures and prints `ALL PASS (N/N)`. It writes fixtures under `~/.claude/hooks/_testfix` and throwaway folders in your temp folder only.
