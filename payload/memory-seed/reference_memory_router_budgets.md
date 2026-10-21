---
name: Memory router budgets
description: MEMORY.md is a fixed-budget router. Hooks block a write past 24,400 bytes (harness truncation), past the 6,000-byte router budget, past 22 pin bullets, or with an index line over 350 characters; router-audit.mjs checks the same limits and also flags a pin over 220 characters.
metadata:
  type: reference
  seed: aceos-starter
---
**The limits**
- `block-memory-md-too-large.js` (PreToolUse Write|Edit): hard cap 24,400 bytes (past it the harness truncates
  MEMORY.md and Claude silently loses the tail), router budget 6,000 bytes, at most 22 `- [` bullet lines.
- `block-memory-line-bloat.js` (PreToolUse Write|Edit on MEMORY.md and `_MOC-*.md`): no pointer line over 350
  characters. Generated maps are written by the tools, not the Write tool, so they never trip it.
- `router-audit.mjs` reports bytes, bullets and the longest pin, and fails over 6,000 bytes, 22 bullets, or a pin
  over 220 characters.

**Why:** MEMORY.md is loaded into every session. If every note gets a line there, it fills, gets truncated, and
the brain stops growing. The complete per-note index lives in the generated maps and `_manifest.json`, which have no
cap and are searched by `recall.mjs`.

**How to apply:** a new note goes in the tree (its topic), not in MEMORY.md. Pin only what every session must see.
Adding a pin means merging or removing another (one in, one out). Keep each pointer to one line: what it is and why
you would recall it. Related: [[reference_how_your_brain_works]].
