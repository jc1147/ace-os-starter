---
name: A project wrap leaves a resume doc and a kickstart line
description: When wrapping a multi-session project, keep a current _RESUME-HERE.md in the project folder (state, commands, next step) with a copy-paste kickstart sentence inside it, update it at every wrap, and name the session so claude --resume can find it.
metadata:
  type: feedback
  seed: aceos-starter
---
For work that spans sessions, re-entry should take one paste. At each wrap:
1. Update **`_RESUME-HERE.md`** in the project folder: the exact current state, commit refs, the key commands, and
   the prioritised next step. A stale resume doc (finished steps still listed as pending) is a real failure.
2. Put a **kickstart** sentence inside it: what to read first, the recommended first move, and the expected first
   friction. Keeping it in the same file stops the two drifting apart.

**Resuming the conversation itself.** `/rename <title>` names a session; `claude --resume "<title>"` reopens it on an
exact title match (case and outer spaces are ignored, punctuation counts, quote the title). The lookup only covers
sessions started in the folder you run it from, so run it from the workspace. A "resume point" can also be just a
note: a fresh session asked to resume it finds it through recall.

**Why:** the next session starts with no memory of this one; a current doc plus a kickstart line gets it in sync in
minutes instead of a re-investigation.

**How to apply:** do not call the wrap complete until the resume doc matches reality (its next step is really next,
the repo state it describes is the real state). Related: [[feedback_wrap_up_ends_with_state_not_offers]].
