---
name: A wired gate is not proof of enforcement
description: A hook can be wired, inject directives and write audit lines while never blocking anything, because its enforce default is off or it is not registered at all; before trusting a gate, read its enforce condition and find a real BLOCK line in the audit log.
metadata:
  type: feedback
  seed: aceos-starter
---
The existence of an enforcement hook (wired in settings, writing audit lines) does not mean it enforces. Gates often
ship in log-only mode behind an env flag, and an unset flag can mean "never blocks" while everyone believes it does.
A gate script that exists but is not registered in settings is the same as no gate.

**Why:** a memory-on-wrap gate once ran for weeks with its enforce flag defaulting to off: the audit log held only
ALLOW and WOULD-BLOCK lines, and the pressure people felt came entirely from a prompt-time reminder. In the shipped
set, `block-wrap-without-memory.js` enforces by default (`MEMGATE_ENFORCE=0` opts out).

**How to apply:** when auditing or shipping a gate: (1) read its enforce condition and the default when the env var is
unset; (2) grep `~/.claude/hook-audit.log` for an actual BLOCK from it (WOULD-BLOCK means log-only in practice);
(3) confirm it is wired in settings under the event you expect; (4) test the blocking path, not just the allow path.
Related: [[feedback_new_blocking_hooks_ship_diag_first]], [[feedback_verify_mechanism_advances_not_just_wired]].
