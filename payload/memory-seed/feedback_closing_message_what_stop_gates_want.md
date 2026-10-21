---
name: What the Stop gates want from a closing message
description: Two Stop gates read the last message. The persistence gate bounces "X is building now" style closings while work is open, so name the blocker instead; the proof-of-work gate bounces completion words after edits with no verification shown, so run a check in the turn or say "written, not yet run".
metadata:
  type: feedback
  seed: aceos-starter
---
1. **Persistence gate (`block-premature-stop.js`).** It matches closings like "(starting|running|building) ... now"
   and stopping to recommend work that could be done. While a tracked background job runs, say so precisely: "the
   build is a background job that has not reported back; I am waiting on its completion notification." Name the
   blocker (a user decision, or the tracked job). Do not poll or invent a heartbeat to dodge the gate; the
   notification re-invokes the session.
2. **Proof-of-work gate (`block-unverified-completion.js`).** It fires when the turn changed files and the closing
   says done, works, fixed, passes and the like, with no verification in the turn. Run the check (a test, a build,
   `node --check`, a re-read, an HTTP probe) and show its output, or drop the completion words and say plainly what
   is written but not yet run.

**Why:** each bounce costs a turn, and the bounced wording usually was an overstatement or a quiet stop.

**How to apply:** before ending a turn, ask: did I change files, and did I show proof in this turn? Is anything still
open, and have I named exactly what it is waiting on? Related: [[reference_the_global_gate_set]].
