---
name: How your brain works
description: Start here. The brain is a folder of small markdown notes that Claude reads and writes across sessions; MEMORY.md is a short router, the sitemap files every note under one topic, recall.mjs searches all of it, and reindex.mjs rebuilds the maps.
metadata:
  type: reference
  seed: aceos-starter
---
The brain is Claude's long-term memory for this workspace. It lives where Claude Code keeps project memory:
`~/.claude/projects/<workspace slug>/memory/` (the slug is the workspace path with every character that is not a
letter or digit turned into `-`). Every session and every subagent gets the memory rules injected at start.

**What is in it**
- **Notes.** One fact per file, with frontmatter: `name`, `description`, `metadata.type` (`user` about you,
  `feedback` your rules for Claude, `project` work in flight, `reference` how-to and facts). A new note also carries
  `metadata.originSessionId`; an updated note gets `metadata.lastSessionId`.
- **MEMORY.md.** A router, not a list. It holds links to the maps and a handful of always-on pins. Hooks block a
  MEMORY.md that grows past its budget ([[reference_memory_router_budgets]]).
- **The sitemap.** Every note has one home: a section, then a topic ([[reference_filing_notes_in_the_sitemap]]).
- **Generated files.** `_manifest.json`, `_sitemap.json`, and the maps `_SITEMAP.md` and `_MOC-*.md` in the
  workspace root. Never hand-edit inside a generated block.

**The commands** (from any folder):
- `node "$HOME/ace/Code/memory-system/recall.mjs" "<topic>"` finds notes; run it before writing a new one.
- `node "$HOME/ace/Code/memory-system/reindex.mjs"` rebuilds the manifest, the maps and the sitemap. A Stop hook
  also does this for you after a session writes notes.
- `node "$HOME/ace/Code/memory-system/router-audit.mjs" <path to MEMORY.md>` checks the router budget.

**Why:** a session forgets everything when it ends. Notes are how a lesson, a rule you gave, or a decision survives
to the next session, and the maps are how Claude (and you, in the Ace OS brain view) find them again.

**How to apply:** recall first, update an existing note before creating a near-duplicate, keep one fact per note,
link related notes with a wikilink (the note's file name without `.md`, in double square brackets), and run `/wrap-up` at the end of a working session
([[reference_how_wrap_up_works]]).
