---
name: Enumerate inputs before verifying outputs
description: A gate confirms that the N things you built are right, never that N was right; establish the source list from the system's own declaration (its sitemap, index, schema, live probe) and show its count, and never derive a test set from the artifact under test.
metadata:
  type: reference
  seed: aceos-starter
---
"I verified all 1,000" and "there are 1,000" are unrelated claims. A build can be checked item by item, every check
true, while it covers a fraction of the real set because the input list was assembled by accident (an old crawl,
part of an index).

**The self-grading plan.** The same failure in a plan: a verification step that builds its test cases from the plan's
own rows can only probe what the plan already knows. Anything the plan missed is invisible to the test and to any
rollback rule built from the same rows.

**Why:** completeness is never tested by default, and "are you sure nothing is missing?" from a person is then the
only gate.

**How to apply:**
- Before claiming exhaustive coverage, name the authoritative source you enumerated from and its count.
- Probe reality first (the live system, its own index), then diff the artifact against the probe; treat anything the
  probe found and the artifact lacks as a defect in the artifact.

Related: [[reference_gate_scope_narrower_than_its_name]].
