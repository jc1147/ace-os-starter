---
name: When auto mode blocks, finish the rest and hand over the exact command
description: Auto-mode safety checks block some edits and commands (wiring process spawning into a control file, writing credential files, killing processes, publishing to a public place) and a verbal "do what you need" does not lift them; do everything the block does not touch, then give the user the exact edit or a plain copy-paste command.
metadata:
  type: reference
  seed: aceos-starter
---
**What gets blocked.** Settings-level auto-mode checks have refused, among others: edits that wire process spawning
into a supervisor or control file, writes of credential or token files, killing processes, and pushing material to
a public location the user did not name. The same reason is given for the Edit tool, a scripted rewrite of the same
line, and staging the file in git.

**Why:** these are not chat permissions, so a general "do all you need" in the conversation does not lift them, and
the denial itself says to stop and let the user decide. Self-granting a permission rule or scripting around the
block is exactly what it protects against.

**How to apply:**
- Complete everything the block does not touch, so the rest of the work is done and verified.
- Hand the user the gated step verbatim: the exact edit, or a plain copy-paste shell command. Ask for the exact
  command line up front when a publish is involved; a user's literal command for a specific action tends to pass
  where a general approval does not.
- Strip a leading `!` from commands you hand over; it is input sugar for the Claude Code prompt only.
- A script you hand over should print its own outcome (and the real exit status of a piped command), so a log tail
  cannot hide a failure.

Related: [[feedback_never_talk_past_a_safety_block]].
