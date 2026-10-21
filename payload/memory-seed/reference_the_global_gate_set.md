---
name: The global gate set
description: What the global hooks installed by Ace OS do, by event - SessionStart injectors (contract, memory protocol, corrections, ultracode, first-run onboarding), prompt-time reminders, PreToolUse gates (memory size, launch, portability, commit; plus three that stay idle here), and Stop gates (proof of work, boot claims, doc drift, persistence, memory). Full detail in ~/.claude/HOOKS.md.
metadata:
  type: reference
  seed: aceos-starter
---
The global hooks live in `~/.claude/hooks/` and are wired in `~/.claude/settings.json`. `~/.claude/HOOKS.md` lists
each one with how to turn it off. In short:

- **SessionStart / SubagentStart (inject, never block):** the deterministic operating contract, the memory protocol,
  open memory corrections flagged on the sitemap page, the ultracode default, and a first-run nudge to run the
  `start-here` onboarding.
- **UserPromptSubmit (inject):** a short anti-drift reminder of the contract on every prompt; a wrap-up directive
  when the prompt asks to wrap up.
- **PreToolUse (block):** MEMORY.md size and router budget, index line length, absolute user paths in runtime code
  (`block-nonportable-path`), hand-starting a server when the project ships a launcher (`block-undocumented-launch`;
  `DEVIATION-JUSTIFIED:` with a reason allows it), and committing real work with no memory pass. Three more are
  wired but idle in this install: the shared-file and `git add -A` sweep gates only engage when other live sessions
  are detected (nothing here writes the session heartbeats they read), and the memory git-rewrite guard only engages
  when a workspace links its memory folder into git.
- **Stop / SubagentStop (block the end of a turn):** claiming done or fixed after edits with no verification shown
  (proof of work); claiming a local server is up without a fresh boot check; stopping on doable work (persistence);
  a "remember this" that wrote nothing; a doc-versus-action drift measurer (log only). On Stop only: rebuilding the
  memory index, and the wrap-up memory gate ([[reference_how_wrap_up_works]]).

**Why:** the contract says "prove it or say it is unverified"; these hooks are what make that hold when the model
would otherwise take the cheap path. They raise the floor, they do not guarantee correctness.

**How to apply:** read a bounce as information about the turn (missing proof, missing note), fix that, and end the
turn again. See [[feedback_closing_message_what_stop_gates_want]] and [[feedback_active_hooks_means_wired_entries]].
