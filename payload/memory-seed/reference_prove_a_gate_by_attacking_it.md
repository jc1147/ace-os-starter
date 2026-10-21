---
name: Prove a gate by attacking it
description: A gate that has only ever passed is decoration; prove it on a scratch copy by injecting each violation it claims to catch (it must FAIL with a useful message), restoring to green, and feeding look-alikes that must not trip it.
metadata:
  type: reference
  seed: aceos-starter
---
**The method**
1. Copy the tree to a scratch path. Never mutate the real one.
2. Get a **green baseline** on the untouched copy with the full, unmodified verifier (not a slice of it).
3. For each assertion, inject the exact violation it claims to catch. It must **fail**, with a message that tells the
   next person what to do.
4. Restore and confirm green again; the baselines on either side are what make the failures mean something.
5. Control the other direction: inputs that look like violations but are fine must not trip it.
6. Finish with `git status --porcelain` (or hashes) to prove the real tree never moved.

**Why:** a self-tested gate is usually defeated by the first realistic edit: it reads only part of the page or file,
or it matches only the spelling its author thought of. Until something has tried to get past it, you know it runs,
not that it catches anything.

**How to apply:** do this before calling any new gate or hook done, and again after widening one. When an attack gets
through, the fix is to the gate, then re-run the whole attack set. Related: [[reference_gate_must_fail_on_unparsable]],
[[reference_gates_must_pass_a_null_rebuild]], [[reference_verification_standards_hub]].
