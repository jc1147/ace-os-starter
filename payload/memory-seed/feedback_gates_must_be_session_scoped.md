---
name: Gates must be session-scoped
description: A Stop or verification gate that picks its target by global freshness (the newest file anywhere, a shared port or report file) fires on another concurrent session's work and blocks the innocent one; derive the target from this session's id, transcript and its own edited files.
metadata:
  type: feedback
  seed: aceos-starter
---
A gate that selects what to check by **global** state ("the most recently modified build folder", "the report for
port N", "the newest artifact anywhere") will latch onto work done by a **different** session running at the same
time, and keep bouncing this session's Stop over files it never touched.

**Why:** running several Claude sessions on one machine and one working tree is normal. A gate keyed to global
freshness turns every other session's half-finished work into this session's blocker, and the bounce message makes
no sense to the person reading it.

**How to apply:** when writing or auditing any Stop, PreToolUse or verification gate, derive its target from the
event's `session_id` and `transcript_path` and the files this session edited. If a gate must look at shared state,
it must still confirm this session touched the flagged artifact before blocking. Ship it diagnostic-first and watch
the audit log for cross-session fires ([[feedback_new_blocking_hooks_ship_diag_first]]).
