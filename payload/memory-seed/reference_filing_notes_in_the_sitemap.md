---
name: Filing notes in the sitemap
description: How the memory sitemap works. Sections and topics live in Code/memory-system/sitemap/tree.json, each note's home in placement.json or its own metadata.home; a note with no home lands in Needs a home until someone files it.
metadata:
  type: reference
  seed: aceos-starter
---
The sitemap gives every note exactly one home, a topic inside a section, so the brain stays browsable as it grows.

**Where it is defined** (in the workspace, `Code/memory-system/sitemap/`):
- `tree.json`: the sections and their topics (slug, name, scope). Add a topic when a subject keeps coming up.
- `placement.json`: a registry of `note file -> { home, also, confidence }`.
- `skills.json`: which topic each workspace skill belongs to.

**A note's home:** its own `metadata.home: <topic slug>` wins; otherwise the registry; otherwise it goes to
"Needs a home" (the inbox). Up to two `metadata.also: [topic, topic]` add cross-references.

**What gets built:** `reindex.mjs` writes `_sitemap.json` in the memory folder and `_SITEMAP.md` plus one
`_MOC-<section>.md` per section in the workspace root, then prints the `sitemap-audit` verdict line. Text you put
between `<!-- @user -->` and `<!-- @end-user -->` in a map survives every rebuild.

**Why:** grouping notes by subject (not by type or by date) is what lets both you and Claude find "everything we
know about X" in one place, and an inbox makes unfiled notes visible instead of lost.

**How to apply:** when writing a note, pick the topic whose scope fits and read that topic's notes first (update
beats create). Set `metadata.home` on the note. If nothing fits, leave it for the inbox and file it at the next
wrap-up. A `sitemap-audit: FAIL` line means a home or a map link is wrong; fix it before ending the session.
Related: [[reference_how_your_brain_works]].
