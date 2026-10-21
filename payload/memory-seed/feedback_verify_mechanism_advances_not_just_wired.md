---
name: Verify the mechanism advances, not just that it is wired
description: An "auto-updating", "enforced" or "always current" claim needs proof that the state actually changes on real completion; a regenerator, hook and wiring that all exist can still re-render stale state forever.
metadata:
  type: feedback
  seed: aceos-starter
---
A progress tracker was declared "auto-updating and enforced" because the regenerator, the PostToolUse hook and the
stamping wiring all existed. The underlying state file never advanced: the regenerator only re-rendered what was
there (it could downgrade a status, never upgrade one), so the tracker showed steps "upcoming" after all of them were
finished.

**Why:** wiring present is not mechanism working. This is the same overstatement the proof-of-work gate bounces, in a
form the gate cannot see.

**How to apply:** for any "X stays current / is enforced" claim, run the mechanism end to end: complete a real step (or
deliberately leave one stale) and confirm the output reflects the new reality. The strongest proof is adversarial:
break the input and watch the output change. Related: [[feedback_gate_presence_is_not_enforcement]].
