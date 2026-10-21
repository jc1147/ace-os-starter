---
name: Rule constants own their count gates
description: Fail-closed count gates encode a rule's consequence (43 items, 100 stats), not the rule; when the rule constant changes, grep the old number across every generator and verifier and update them in the same edit, or better, derive the expected count from the rule.
metadata:
  type: reference
  seed: aceos-starter
---
Changing one rule constant (every third item becomes every sixth; 100 entries become 101) leaves every hard-coded
expected count downstream stale. A chain that stops at the first failing gate hides the rest, so they are found one
painful run at a time.

**Why:** count gates are good (they catch drift), but a literal count is a copy of the rule's consequence, and copies
drift from their source.

**How to apply:**
- After changing a rule constant, `grep -rn` the old derived number across every generator, verifier and gate
  before running anything, and update them in the same edit.
- Better: compute the expected count from the rule (`items.filter(rule).length`) instead of a literal.
- Or keep a comment beside the rule listing every gate that depends on it.

Related: [[feedback_skill_doc_metric_matches_gate]], [[reference_gates_must_pass_a_null_rebuild]].
