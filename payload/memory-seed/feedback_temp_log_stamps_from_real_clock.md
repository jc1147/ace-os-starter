---
name: Temp log times come from the real clock
description: Every temp-log "## HH:MM" heading must come from the machine clock read in the same command that appends the entry, never estimated, because consolidation merges sessions by those stamps and a guessed time puts the record out of order.
metadata:
  type: feedback
  seed: aceos-starter
---
Read the clock for every temp-log entry (`date "+%H:%M"` in bash, `Get-Date -Format HH:mm` in PowerShell) in the
same command that appends it, and use that value. If the session crosses midnight, put the date in the entry title.

**Why:** a model's sense of time drifts badly over a long session; guessed stamps have landed hours off. The
session-logger merges per-session temp logs by their `## HH:MM` headings, so wrong stamps interleave the day in the
wrong order, and anyone reconstructing what happened gets a false sequence. A stamp not read from the clock is a
fabricated fact in the record.

**How to apply:**
- Brief every subagent that may log to stamp from the clock the same way, or to report back and not log.
- When two entries describe the same work, merge them by content and keep the parent's stamp.
- Never trust entry order as time order when agents were involved.

Related: [[feedback_wrap_up_mid_session_is_a_checkpoint]].
