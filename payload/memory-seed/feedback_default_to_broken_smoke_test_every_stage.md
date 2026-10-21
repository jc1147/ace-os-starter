---
name: Default to broken, smoke-test every stage
description: On any multi-stage build, treat every stage as broken until a deterministic smoke test on real data proves it, shown with the actual output; prove each gate in both directions (a good input passes, a deliberately broken one fails).
metadata:
  type: feedback
  seed: aceos-starter
---
Advance a stage only on a green, demonstrated check, never on "the logic is correct". Report pass or FAIL with the
artifact itself (exit codes, output lines, JSON, screenshots), never a summary claim.

**Why:** optimistic, narrative status reports hide integration risk until the end. "It is all broken until there is
nothing left to fix" surfaces problems while they are cheap, and keeps reports factual instead of flattering.

**How to apply:**
1. Define each stage's smoke test before building the stage.
2. Run it on real inputs and show the result.
3. Prove gates fail closed with a known-bad fixture, not just that the happy path passes.
4. Source every fact from live inputs, not memory; list what is still unverified, plainly.

Related: [[reference_verification_standards_hub]], [[reference_prove_a_gate_by_attacking_it]].
