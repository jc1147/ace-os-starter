---
name: Scripts that hooks run are live
description: Editing a script that a live hook executes (the memory-system tools, anything in ~/.claude/hooks) is changing the live system, not just repo code; prove a live surface unchanged with content hashes and counts, not git status, and derive paths from the resolved workspace root, never the current folder.
metadata:
  type: feedback
  seed: aceos-starter
---
The Stop hook `regen-memory-index.js` runs `Code/memory-system/build-manifest.mjs`, `build-mocs.mjs` and the sitemap
builder after sessions; other hooks call `verify-memory-pass.mjs`. Changing those files changes what runs at the end
of every session, including other sessions running right now.

**Why:** a refactor once left one read path keyed to the current folder. The live hook then ran from a different
folder, read an empty manifest, and rewrote three maps with zero notes. The notes were untouched (the maps are
regenerable), but the graph looked gutted. The check that "proved" nothing changed was `git status`, and a file that
was already modified stays " M" while its content changes again.

**How to apply:**
1. Treat any change to a script a hook or agent invokes as touching the live system.
2. Prove a live surface unchanged by hashing it (and counting notes and map entries) before and after; never by
   `git status` alone.
3. Derive runtime paths from the resolved workspace root (env override, git toplevel, a marker walk-up, or the
   script's own folder), never `process.cwd()`; a hook may run from any folder.

Related: [[feedback_edit_notes_read_before_write]].
