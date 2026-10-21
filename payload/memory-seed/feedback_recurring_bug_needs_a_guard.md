---
name: A recurring bug needs a guard, not another patch
description: When the same bug shows up on a third surface, stop patching surfaces; make one authority that every surface imports, and a reconciliation test over real data that fails when any surface disagrees, then prove the guard by reverting the fix.
metadata:
  type: feedback
  seed: aceos-starter
---
One rule implemented separately on several surfaces drifts: each round of fixes finds the same bug on a new surface
(two pages one click apart printing different values for the same figure).

**The fix that ends it**
1. **One authority, imported, never restated:** the rule lives in one module, and every surface imports it.
2. **A reconciliation guard:** a test that builds real data through the actual pipeline and asserts that every surface
   reporting the figure agrees with the stored value.

**Why:** patching instances is whack-a-mole; the third occurrence is the signal to change the deliverable from "fix
this one" to "make the next one impossible".

**How to apply:** a guard nobody has seen fail is not known to work. Revert the fix, run the guard, watch it fail,
restore, watch it pass ([[reference_prove_a_gate_by_attacking_it]]).
