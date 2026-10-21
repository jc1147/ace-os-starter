---
name: New blocking hooks ship in diagnostic mode first
description: Every new blocking hook or gate first logs WOULD-BLOCK and allows, behind its own environment variable, with a written rule for when to flip it to enforce; text-matching gates especially, because they false-positive on their first real use.
metadata:
  type: feedback
  seed: aceos-starter
---
A new blocking behaviour (hook, gate, sweep) ships **diagnostic-first**: it writes `WOULD-BLOCK <reason, files>` to
the hook audit log (`~/.claude/hook-audit.log`) and allows the action, behind its own environment variable (unset =
diagnostic). The note or header states the flip criterion, for example "N days with zero false WOULD-BLOCK lines".

**Why:** a gate that ships enforcing and false-positives on its first real firing blocks clean work, and usually has
to be pulled the same day. Reusing an existing enforce switch is the same mistake: the new gate inherits enforcement
on day one.

**How to apply:**
- One new env var per new blocking behaviour; never piggyback on a switch that is already on.
- WOULD-BLOCK lines must name the offending files so each one can be judged true or false.
- Text-matching detection and unproven events or matchers are automatically diagnostic-first.
- Enforce-first is acceptable only when argued explicitly (for example extending an already-proven gate, with
  negative tests for the new cases).

Related: [[feedback_gate_presence_is_not_enforcement]], the inverse failure.
