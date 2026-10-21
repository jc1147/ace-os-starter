---
name: A skill doc names the exact metric its gate computes
description: When a skill's documentation states a threshold a gate enforces, it must name the same quantity and formula the gate computes, not an English approximation; the wrap-up doc says workScore with its weights because "file changes" under-counts delegated work.
metadata:
  type: feedback
  seed: aceos-starter
---
If a doc says "small sessions need 1 note" while the gate counts something different, a model that follows the doc
faithfully gets bounced.

**Why:** the wrap-up gate computes **workScore**: +1 per Write/Edit outside the memory folder and temp logs, +1 per
side-effecting shell command, **+10 per delegated Task**. A doc phrased as "file changes" makes a session that
delegated five builds look small (few direct writes) while the gate scores it 50, a large session that needs three
notes and a gap-hunt.

**How to apply:**
1. Name the gate's exact metric and formula in the doc.
2. When the metric lives in code (a hook, an oracle), quote its terms verbatim and add a "keep in sync" note.
3. Treat the doc and the enforcing code as one unit: change one, change the other in the same edit.

Related: [[reference_how_wrap_up_works]], [[reference_rule_constants_own_their_count_gates]].
