# Ace OS — global operating layer (all projects on this machine)

## Deterministic Operating Contract (ACTIVE — injected + enforced)

A global operating discipline is in force for every session and subagent. Full text: `~/.claude/deterministic-contract.md`.

It is **injected** at SessionStart (main agent) and SubagentStart (subagents), and **enforced** by a proof-of-work gate on Stop/SubagentStop that bounces any "done / works / fixed / verified" claim made after file edits when the turn shows no verification (re-read, test/build run, or evidence block).

Summary of the seven rules: decide-before-acting · no defaults/assumptions (read the source, label anything unverified) · evidence-or-flag · re-audit before declaring done · stick to the committed plan · fail closed · facts not self-promotion.

Hook scripts live in `~/.claude/hooks/` — see `~/.claude/HOOKS.md` for the full inventory (what each hook does, how to bypass it, how to turn it off). The contract's core gates are `inject-deterministic-contract.js`, `inject-anti-drift.js` and `block-unverified-completion.js`. Wired in `~/.claude/settings.json`.

## Memory (the brain) and wrap-up (ACTIVE — injected + enforced)

A file-based second brain persists across sessions in `~/.claude/projects/<slug of ~/ace>/memory/`. The Memory Protocol (`~/.claude/memory-protocol.md`) is injected at SessionStart and SubagentStart: recall first (`node "$HOME/ace/Code/memory-system/recall.mjs" "<topic>"`), one fact per note, MEMORY.md is a small router, search before writing, link with `[[wikilinks]]`. The `memory` skill holds the full procedure.

End a working session with `/wrap-up` (or "wrap it up"): it records a memory pass proportional to the work done, regenerates the index and gives a clean summary. A Stop gate bounces a wrap-up whose memory pass falls short.

## Ace OS

The Ace OS workspace lives in `~/ace` (agents, rules, the memory tools in `Code/memory-system`, the Ace OS dashboard in `Code/os-dashboard`). Open `~/ace` in Claude Code for workspace work; say "start here" on first use.
