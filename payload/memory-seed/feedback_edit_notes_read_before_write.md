---
name: Edit notes by reading first, then writing
description: A script that edits a memory note must read the whole file before opening it for writing, because opening for write truncates first; refuse a write that shrinks the note, keep line endings, and prefer the Edit tool for single-note changes.
metadata:
  type: feedback
  seed: aceos-starter
---
A one-liner like `open(p, "w").write(update(p))` empties the note before `update` reads it: the open truncates, the
read sees an empty file, and the note is left at 0 bytes.

**Why:** notes are often the only copy of a hard-won decision, and an empty note is silent data loss that neither
the index nor the wrap-up gate flags; it simply stops being found.

**How to apply:**
- Read the whole file into memory, compute the new text, then write it (ideally to a temp file and rename).
- Refuse to write when the result is shorter than the original; a shrinking "update" is almost always a bug.
- Keep line endings as they are (text mode on Windows can silently convert a whole note to CRLF).
- Prefer the Edit tool for a single-note change; it cannot truncate.
- If the workspace is a git repo, commit the brain's state you care about, or keep a copy, before bulk edits.

Related: [[feedback_scripts_hooks_run_are_live]].
