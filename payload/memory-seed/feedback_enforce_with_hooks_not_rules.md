---
name: Enforce with hooks, not rules
description: When something must never happen again, the enforcement is a Claude Code hook that runs every time, not a new paragraph in CLAUDE.md, a rules file or a checklist that depends on the model remembering it.
metadata:
  type: feedback
  seed: aceos-starter
---
When the ask is "make sure this never happens again", "enforce X" or "this should be a hook", build a hook
(PreToolUse, Stop, or an injector) and test it. Do not answer with a rules update, a CLAUDE.md line or a skill
procedure tweak as the enforcement mechanism.

**Why:** rules and docs only work if the model reads, remembers and applies them on every turn; they drift,
especially in long sessions and after compaction. A hook fires deterministically and can stop the model. Two caveats:
a hook that times out is cancelled and the tool runs anyway, and a hook in log-only mode enforces nothing
([[feedback_gate_presence_is_not_enforcement]]).

**How to apply:** pick the event, scope, output and invocation explicitly
([[reference_hook_anatomy_four_decisions]]); prove it blocks a real violation and passes a clean case; wire it in
settings; document how to turn it off. Docs still matter for explaining why, but they are not the guard.
