---
name: Runtime files must be portable
description: Nothing that runs or is read as live reference may hold an absolute user path (a home folder with a username) or a username-derived memory slug; derive paths at runtime, and remember comments, docs, JSON and generated output ship too, not just code.
metadata:
  type: feedback
  seed: aceos-starter
---
Everything that runs, or is read as live reference, must work on another machine and another account: no absolute
paths into a user's home folder, no `file:///` links into one, no memory slug that bakes in a username.

**Why:** `block-nonportable-path.js` blocks writes that introduce such paths into runtime code, but only on writes of
code files. Docs, agent and skill markdown, JSON fixtures and generated artifacts (which bake paths at generation
time) slip past it. Comments are shipped content too: a compiler that preserves comments copies an example path
straight into the build output, where a portability check then reads it as a real path and fails a release.

**How to apply:**
- Derive at runtime: `os.homedir()`, `path.join`, `process.env.CLAUDE_PROJECT_DIR`, a path relative to the script.
- Illustrate a path bug with a description ("an account name that contains a space"), never a literal path.
- Compute the memory slug from the resolved path (every character that is not a letter or digit becomes `-`).
- Scan built output and docs, not just source, before you share or install anything.
