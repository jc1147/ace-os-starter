# SETUP.md - how to install Ace OS Starter (instructions for Claude Code)

You are Claude Code, opened in the Ace OS Starter folder (the folder that holds this file, `install.mjs`
under `installer/`, and `payload/`). The user wants Ace OS installed. Follow these steps in order. After
each step, check the result exactly as written before going on. Talk to the user in plain words; keep
technical detail short.

Ground rules:
- **Ask the user before installing any software** (Node.js, git). Say what you want to install and why,
  and wait for a yes. Never use `sudo` unless the user agrees to type their password.
- Never edit files in this folder, in `~/.claude`, or in `~/ace` by hand. The installer does the work and
  keeps backups.
- If any command prints `STOPPED:` or `FAIL`, stop, explain the message to the user, fix the cause with
  them, and run that step again. The installer is safe to re-run.
- Run every command from this folder (the folder that contains `SETUP.md`).

## Step 1 - Find out the operating system

Run `node -e "console.log(process.platform)"` if Node is present; otherwise use what your environment
reports. `win32` = Windows, `darwin` = macOS. (Linux works but is not officially tested; tell the user.)

## Step 2 - Prerequisites

Check each one. Do not install anything without asking.

### 2a. Node.js 18 or newer (required)

Check: `node --version`
Good: prints `v18` or higher (for example `v22.11.0`).

If it is missing or older than 18, tell the user Node.js is required and ask permission to install the
LTS version:
- **Windows:** `winget install --id OpenJS.NodeJS.LTS -e` (if `winget` is missing, ask the user to download
  the "LTS" Windows installer from https://nodejs.org and run it).
- **macOS:** if `brew --version` works: `brew install node`. Otherwise ask the user to download the "LTS"
  macOS installer from https://nodejs.org and run it.

After installing, `node --version` in your current shell may still fail because the PATH was loaded before
the install. Ask the user to close and reopen Claude Code in this folder, then continue from Step 2a.

### 2b. git (required on Windows, recommended on macOS)

Check: `git --version`
Good: prints a version.

- **Windows: required.** Claude Code runs Ace's hooks with Git Bash, which comes with Git for Windows.
  Without it, Claude Code runs them with PowerShell instead, and the workspace hooks in `~/ace` cannot find
  their files (the user would see hook errors on every message). If git is missing, explain this and ask
  permission to install it: `winget install --id Git.Git -e` (if `winget` is missing, ask the user to
  download Git for Windows from https://git-scm.com/download/win and install it with the default options).
  Do not continue the install without it.
- **macOS: recommended.** If it is missing, ask whether to install it (Ace works without git, but the
  workspace will not be a git repository): `xcode-select --install` (opens a system dialog the user must
  accept), or `brew install git`. If the user says no, continue; the installer will print a WARN for git,
  which is fine on macOS.

### 2c. Claude Code settings location

Check (Windows PowerShell): `echo $env:CLAUDE_CONFIG_DIR`
Check (macOS / bash): `echo "$CLAUDE_CONFIG_DIR"`
Good: prints nothing. If it prints a folder, tell the user Ace OS installs into the standard `~/.claude`
folder and ask them to remove the `CLAUDE_CONFIG_DIR` setting (or point it at their home `.claude`
folder) before continuing.

### 2d. The workspace folder `~/ace`

Check (Windows PowerShell): `Test-Path "$HOME\ace"`
Check (macOS / bash): `ls -d ~/ace`
Good: `False` / "No such file or directory" (a fresh install), or a folder that contains `.ace-os/install.json`
(an earlier Ace OS install; the installer will update it).

If `~/ace` exists and is NOT an Ace OS install, tell the user and ask them to rename it (for example to
`ace-old`). Do not rename or delete it yourself unless they ask you to.

Also make sure this installer folder is not itself `~/ace` or inside it. If it is, ask the user to move it
(for example to `~/aceos-starter`) and reopen Claude Code there.

## Step 3 - Dry run

Run: `node installer/install.mjs --dry-run`

Good: the output ends with `DRY RUN complete: nothing was changed.` and shows `PLAN  would ...` lines.

Tell the user, in a few short lines, what the installer will do (taken from the PLAN lines): create
`~/ace`, add hooks / skills / docs to `~/.claude` (backups of anything replaced), add hook entries to
`~/.claude/settings.json` without touching their other settings, put starter notes in their brain folder,
and add a "Start Ace OS" launcher. Ask: "Shall I go ahead?" Wait for a yes.

If it printed `STOPPED:`, explain the message and fix the cause first (see Troubleshooting).

## Step 4 - Install

Run: `node installer/install.mjs`

It takes one to three minutes (the last step starts the dashboard once to test it, then stops it).
Good: the output ends with `INSTALL OK`. A few `WARN` lines (for example "git not found") are acceptable;
read them to the user.

If it ends with `INSTALL FINISHED WITH ... PROBLEM(S)`, show the user the FAIL lines, fix the cause, and
run Step 4 again.

## Step 5 - Verify

Run: `node installer/doctor.mjs`
Good: every line says `PASS` (a `WARN` line is acceptable if you can explain it), and the last line ends
with `-> PASS`. Check in particular:
- `hook wiring` says `29/29 entries`
- `memory folder + MEMORY.md` and `recall finds a seed note` are PASS
- `dashboard boots`, `GET /brain/` and `GET /api/neurons (live stream)` are PASS

If anything FAILs, see Troubleshooting, fix it, and run Step 4 and Step 5 again.

## Step 6 - Tell the user what to do next

Say this (in your own words is fine, but keep all four points):

1. **Open a NEW Claude Code session in `~/ace`** (the new gates and memory load when a session starts;
   this installer session does not count). On Windows, if Git was installed during this setup, fully quit
   Claude Code (and the Claude app, if they use it) first, so the new session finds Git Bash. For example: in a terminal `cd ~/ace` then `claude`, or open the
   `ace` folder in your editor or the Claude app.
2. In that new session, **type "start here"**. Claude will get to know you, set up your goals and your
   first project, and save what it learns to your brain.
3. **Double-click "Start Ace OS"** in the `ace` folder (`Start Ace OS.cmd` on Windows,
   `Start Ace OS.command` on macOS) to open the dashboard in your browser. Keep the window it opens; closing
   it stops Ace OS.
4. **End every work session with `/wrap-up`**. Claude saves the session's lessons to the brain and tidies
   the logs, so the next session starts where this one ended.

Also tell them: keep this installer folder; `node installer/doctor.mjs` checks the install and
`node installer/uninstall.mjs` removes it (the workspace and brain are kept unless they ask otherwise).

## Troubleshooting

| Message | What it means | What to do |
|---|---|---|
| `STOPPED: ... ~/ace already exists and was not created by this installer` | a folder named `ace` is already in the home folder | ask the user to rename it (e.g. `ace-old`), then rerun Step 3 |
| `STOPPED: ... settings.json is not valid JSON` | the user's Claude Code settings file is damaged | show the user the file `~/.claude/settings.json` and the error; with their OK, fix the JSON (or move the file aside), then rerun |
| `STOPPED: CLAUDE_CONFIG_DIR is set ...` | Claude Code is configured to use another settings folder | see Step 2c |
| `STOPPED: this installer folder is inside ~/ace` | the download was put in the wrong place | move this folder elsewhere, reopen Claude Code there |
| `STOPPED: this release folder is incomplete` | the download is missing files | download / unzip the release again |
| `Node ... is too old` / `node: command not found` | Node.js missing or old | Step 2a |
| `FAIL reindex` or `FAIL recall finds a seed note` | the brain tools could not run | run `node ~/ace/Code/memory-system/reindex.mjs` and show the user its output; rerun Step 4 |
| `FAIL dashboard boots` | the dashboard did not start | run `node installer/doctor.mjs` again (a busy computer can be slow); if it still fails, show the user the detail column |
| `WARN git not found` on Windows, or "hook error" lines in the new session | Git for Windows is missing, so Claude Code ran the hooks with PowerShell | Step 2b: install Git for Windows, fully quit and reopen Claude Code, then start the session in `~/ace` again |
| `WARN node is not on the default shell PATH` (Linux) | Node is installed somewhere the hooks would not find it | nothing to do: the installer wired the hooks with Node's full path |
| `FAIL node used by hooks ... missing` | Node was upgraded or moved after the install (on macOS the hooks call Node by its full path, because Claude Code started from the Dock or Finder cannot see Homebrew, nvm or Volta) | rerun Step 4: it points the hooks at the current Node |

The installer writes backups of anything it replaces to `~/.claude/backups/aceos-starter-<time>/`, and of
any of the user's edited tool files to `~/ace/.ace-os/backups/<time>/`.
