---
name: How wrap-up works
description: The /wrap-up skill is the end-of-session memory pass. It inventories the session, records a proportional number of atomic notes (1, 2 or 3 by workScore), runs a gap-hunt on large sessions, rebuilds the index and gives a state summary; a Stop hook bounces a wrap-up whose memory pass falls short.
metadata:
  type: reference
  seed: aceos-starter
---
Say "wrap up" (or run `/wrap-up`) when you finish a stretch of work. The skill:
1. Inventories what the session did (files changed, decisions, problems solved).
2. Recalls existing notes on each lesson, then updates or creates atomic notes.
3. Rebuilds the index (`reindex.mjs`) and consolidates the temp log.
4. Ends with a plain state summary: done, verified, open.

**The gate behind it.** `block-wrap-without-memory.js` (Stop) asks the oracle
`Code/memory-system/verify-memory-pass.mjs` whether this session left enough well-formed notes for the work it did.
The oracle scores the session transcript: +1 per Write/Edit outside the memory folder and temp logs, +1 per
side-effecting shell command, +10 per delegated Task. Required notes: score up to 15 needs 1, 16 to 40 needs 2,
over 40 needs 3. A note counts when its `metadata.originSessionId` (new) or `metadata.lastSessionId` (updated)
is this session's id. Large sessions must also leave a gap-hunt receipt; a session with honestly nothing durable
can say so in a receipt that lists what was considered.

**Why:** a session's lessons are lost the moment it ends unless they are written down, and a count alone does not
prove coverage, so large sessions must also look for what the first pass missed.

**How to apply:** treat a bounce as "the pass is short", not as an obstacle: record the missing lessons and stamp
the session id. See [[feedback_wrap_up_mid_session_is_a_checkpoint]], [[feedback_wrap_up_ends_with_state_not_offers]]
and [[feedback_skill_doc_metric_matches_gate]].
