---
name: Grep is not a visual audit
description: A claim about how a rendered page looks needs a Read of a real screenshot, desktop and mobile; greps and marker counts prove structure only, the proof-of-work gate accepts them anyway, and an agent's own "looks great" is unverified until you look.
metadata:
  type: feedback
  seed: aceos-starter
---
Any claim about appearance ("clean", "premium", "fixed the layout") must be backed by opening a rendered screenshot
and reading it, at desktop and at mobile width. A grep (doctype, balanced tags, counts, link checks) only supports a
structural claim.

**Why:** the proof-of-work Stop gate passes as soon as some verification ran in the turn; a grep counts. Proof of
work being present is not proof of the specific claim, and no hook judges looks. Pages reported as polished on the
strength of a grep have had obvious visual bugs that a person saw in seconds.

**How to apply:** render, then Read the image yourself. Render mobile too. Never relay a subagent's aesthetic
self-report as verified. Related: [[feedback_render_verify_dashboard_by_looking]],
[[reference_verification_standards_hub]].
