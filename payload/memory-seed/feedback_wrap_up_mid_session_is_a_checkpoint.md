---
name: A mid-session wrap-up is a checkpoint
description: /wrap-up can be called in the middle of a long session as a memory flush, not a goodbye; run the full proportional pass, report the session-total memory ledger, do not stop, and check the temp log's last entry against the clock because a log can go silently stale.
metadata:
  type: feedback
  seed: aceos-starter
---
Wrap-ups are also used mid-session: flush the durable lessons into the brain and get a clean state read while the
work continues, so the context stays sharp and survives a compaction or a crash.

**Why:** it is a memory-hygiene tool, not only a closing ritual. Treating it as an ending (stopping, saying goodbye)
or as already done ("memory looks complete") throws away its value.

**How to apply:**
- Run the full procedure ([[reference_how_wrap_up_works]]), proportional to the work since the session began.
- Frame the summary as a checkpoint: done, verified, open, and the **session-total** memory ledger (notes created
  and updated across every pass so far), then keep going on the next instruction.
- Each later pass should look for what earlier passes missed; reconstruct lessons from the raw temp log and the
  transcript, not from the feeling that memory is complete.
- **Check the temp log's last entry time against the clock.** A temp log can stop being written hours before the
  work stops, so it records the dead-end theories in detail and none of the actual answer. If the last stamp is
  far behind the clock, rebuild the missing stretch from the transcript before writing notes.
