---
name: Verification standards hub
description: Hub for the proof standards - recall this whenever claiming anything is done, works, is enforced or looks right; one line per standard with a link to the full rule.
metadata:
  type: reference
  seed: aceos-starter
---
The verification standards, one line each (the linked note holds the rule and the why):

- [[feedback_default_to_broken_smoke_test_every_stage]]: every stage is broken until a real smoke test, both directions.
- [[feedback_grep_is_not_a_visual_audit]]: looks claims need a Read of real screenshots, desktop and mobile.
- [[feedback_render_verify_dashboard_by_looking]]: dashboards verify by reading a screenshot, then the DOM.
- [[feedback_gate_presence_is_not_enforcement]]: a wired gate may be log-only; find a real BLOCK.
- [[feedback_verify_mechanism_advances_not_just_wired]]: "auto-updating" needs the state to actually move.
- [[reference_prove_a_gate_by_attacking_it]]: inject each violation; it must fail; restore to green.
- [[reference_gates_must_pass_a_null_rebuild]]: a rerun that changes nothing must pass.
- [[reference_gate_must_fail_on_unparsable]]: unparsable input fails, never skips.
- [[reference_gate_scope_narrower_than_its_name]]: a gate proves only the bytes it reads.
- [[reference_enumerate_inputs_before_verifying_outputs]]: name the source list and its count first.
- [[reference_syntax_check_is_not_a_run_check]]: run it where it actually runs.
- [[feedback_regenerate_every_artifact_before_handoff]]: run every generator, let git status answer.

**Why:** the operating contract says "evidence or flag"; these are what evidence means in practice.

**How to apply:** before a done, works, fixed or verified claim, pick the standards that apply and meet them in the
same turn, or say plainly what is unverified.
