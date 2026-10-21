---
name: A gate's scope can be narrower than its name
description: A wired, blocking, passing gate proves only what it actually reads; when it checks one object (the data layer, a scratch render, one section) while the claim ships somewhere else (the rendered page, the published file), its green means nothing for that claim.
metadata:
  type: reference
  seed: aceos-starter
---
This is neither log-only mode nor a wrong assertion. It is **scope**: the gate serialises one object, and the claim
it protects lives where that object does not reach. Typical shapes:
- named for a global property ("X appears nowhere") but testing one section;
- checking the data while the defect is in the rendered output built from it;
- render gates checking an in-memory or scratch copy while boot gates load the published file on disk, so a fix
  rendered only to scratch passes one set and the other set re-proves the stale published file.

**Why:** a green gate with a confident name is trusted for more than it checks, and the gap only shows when someone
looks at the real output.

**How to apply:** for each gate, write down exactly which bytes it reads. Either widen it to the final serialised
output (the file that ships), or rename it so it claims only what it proves. After a fix, re-run the gates against
the artifact that actually ships. Related: [[feedback_gate_presence_is_not_enforcement]],
[[reference_write_matcher_misses_edit_and_scripts]].
