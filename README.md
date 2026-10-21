# Ace OS Starter

Ace OS turns Claude Code into a working partner that remembers, checks its own work and shows you what it
knows. This folder installs it on **Windows** or **macOS** in a few minutes.

What you get:

- **The Ace workspace** at `~/ace`: a home for your projects with built-in agents (`start here`, status,
  goals, session logging and more), session logs and a tasks inbox.
- **The gates**: a set of Claude Code hooks that run on every session. They make Claude state its plan,
  prove "done" with evidence, keep its memory, and stop before risky moves. `~/.claude/HOOKS.md` lists every one.
- **The brain**: a memory folder that Claude reads and writes as small linked notes, with a keyword
  `recall` tool, a sitemap and a `/wrap-up` command that saves what a session learned.
- **Ace OS**: a local web dashboard (Mission Control) with a live 3D view of the brain, opened in your browser.
  It runs only on your computer (`http://127.0.0.1`).

## Requirements

- [Claude Code](https://claude.com/claude-code), signed in.
- **Node.js 18 or newer** (the LTS version from https://nodejs.org). Check with `node --version`.
- **git**: required on Windows ([Git for Windows](https://git-scm.com/download/win); Claude Code runs Ace's hooks
  with its Git Bash), recommended on macOS. Check with `git --version`.

## Install

**The easy way:** open this folder in Claude Code and say **"set me up"**. Claude follows `SETUP.md`: it
checks the requirements (and asks before installing anything), shows you a dry run, installs, and checks the
result.

**By hand:**

| | |
|---|---|
| Windows | double-click `install.cmd`, or in a terminal here: `node installer/install.mjs` |
| macOS | double-click `install.command` (if macOS blocks it: System Settings → Privacy & Security → Open Anyway), or in Terminal here: `bash install.sh` |

Add `--dry-run` to see the plan without changing anything. The installer is safe to run again; running a
newer version updates the tools and leaves your own notes, projects and edits alone.

What it changes: it creates `~/ace`, adds its hooks, skills and docs to `~/.claude` (backing up any file it
replaces to `~/.claude/backups/`), adds its hook entries to `~/.claude/settings.json` without touching your
other settings, and puts a few starter notes in your brain folder. It does not install other software.

Note: the workspace's `.claude/settings.json` uses `"defaultMode": "bypassPermissions"`, so Claude does not
ask before each action inside `~/ace`. To get the prompts back, remove that line (or set it to `"default"`).

## Daily use

1. Double-click **Start Ace OS** in `~/ace` to open the dashboard.
2. Open Claude Code in `~/ace` (a **new** session after installing). The first time, type **"start here"**.
3. Work as usual. End each session with **`/wrap-up`**, so Claude saves what it learned to the brain.

## Check or remove

- Check the install: `node installer/doctor.mjs` (from this folder). Every line should say PASS.
- Remove it: `node installer/uninstall.mjs`. Your workspace and your brain are kept unless you add
  `--purge-workspace` and/or `--purge-brain`. Files the installer replaced are restored from their backups.

Keep this folder after installing; the doctor and the uninstaller run from here.

## Credits

- Ace OS, the GodClaude hooks and this installer: James Compton (SGEN). MIT License.
- The Ace workspace is built on Ace Level 1 by Alcanah Partners LLC (MIT License).
- The 3D brain uses three.js (MIT License).

See `LICENSE`.
