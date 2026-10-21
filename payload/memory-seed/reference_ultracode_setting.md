---
name: Ultracode is a session setting
description: Ultracode is a Claude Code session setting (chosen in /effort) that raises reasoning effort and lets Claude orchestrate multi-agent workflows for substantive tasks; it is not an API effort level and cannot be saved in the settings file, which is why a SessionStart hook injects it as a default.
metadata:
  type: reference
  seed: aceos-starter
---
As documented when this note was written (check the current Claude Code docs if it matters):
- **Ultracode** is a Claude Code setting, not a model or API effort level. It uses the highest effort the model
  offers and has Claude orchestrate workflows (parallel subagents) for substantive tasks.
- It is **session-only**: set with `/effort`, not accepted by the `effortLevel` setting or the effort flag. It is
  offered only on models that support that effort level and only when workflows are enabled.
- **Ultrathink** is different: one turn of deeper reasoning, no orchestration.

**Why:** because it cannot be stored as a setting, Ace OS ships `inject-ultracode-default.js` (SessionStart), which
tells each session to work that way by default. Workflows spend more usage than single-agent turns.

**How to apply:** if usage matters more than depth for a while, remove that hook's entry from
`~/.claude/settings.json` (see `~/.claude/HOOKS.md`) or pick a lower effort in `/effort`. Related:
[[reference_the_global_gate_set]].
