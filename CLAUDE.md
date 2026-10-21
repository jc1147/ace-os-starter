# CLAUDE.md (installer folder)

This folder is the **Ace OS Starter installer**. It is not a workspace to work in.

When the user says anything like **"install"**, **"set me up"**, **"set this up"** or **"start here"** while
Claude Code is open in this folder, follow **[SETUP.md](SETUP.md)** step by step, from the top, without
skipping the checks. SETUP.md is written for you (Claude); every step says what to run, what a good
result looks like, and what to do when it is not good.

Rules while you are in this folder:
- Do not edit any file in this folder. The installer copies from it.
- Ask the user before installing any software (Node.js, git). Never install anything silently.
- Run the dry run first and show the user the plan before the real run.
- Never use `sudo`, never run `npm install`, never change a file in the user's home folder by hand:
  the installer does all of that, with backups.
- If a step STOPS, read its message to the user in plain words and fix the cause with them; then run
  the step again (the installer is safe to re-run).

After a successful install, the real workspace is `~/ace`. Work happens there, in a NEW Claude Code
session, not in this folder.
