---
name: Gates must pass a null rebuild
description: A gate must be shown to PASS on a rerun that changes nothing, not only to FAIL on a perturbation; a gate that recognises its lawful states by one run's literal end values becomes a landmine on the next innocent rebuild.
metadata:
  type: reference
  seed: aceos-starter
---
Proving a gate can still fail is half the proof. The other half is a **null rebuild**: rerun the whole chain with no
real change and the gate must pass.

**Why:** a gate whose "before" and "after" states were written as the literal numbers of the run it was built on
(count == 4, then == 0) cannot hold on a different dataset or a wording-only rerun. It fails closed on a clean
rebuild, and whoever hits it is tempted to "fix" it by typing today's numbers in, which removes the protection.

**How to apply:** express a gate's states by what the rule says (the delta is empty; the count fell by exactly the
re-read set), never by literal end values. Add a null rebuild to the gate's own tests, next to the attack tests in
[[reference_prove_a_gate_by_attacking_it]]. Related: [[reference_rule_constants_own_their_count_gates]].
