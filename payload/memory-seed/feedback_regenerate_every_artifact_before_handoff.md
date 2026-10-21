---
name: Regenerate every artifact before a handoff
description: Before a handoff, merge or "done", run every generator in the repo in place and let git status show what was stale; never reason about which derived files are probably still fine.
metadata:
  type: feedback
  seed: aceos-starter
---
Derived artifacts (exports, overviews, route lists, published trees) read their inputs at generation time. Anything
added after the last run is missing from them, and nothing raises an error.

**Why:** a handoff once pointed a developer at a generated route list that held less than half of the real routes:
the missing rows were exactly the section the handoff's first task was about. Several other derived documents were
stale too, including the overview shown to other people.

**How to apply:** enumerate every script that writes files, run all of them, and read `git status` and the diffs.
Anything that changed was stale. Only then write or update the handoff. Related:
[[reference_enumerate_inputs_before_verifying_outputs]], [[feedback_default_to_broken_smoke_test_every_stage]].
