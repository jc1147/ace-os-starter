---
name: How recall ranks notes
description: recall.mjs ranks with BM25F over every note read straight from disk - the file slug and name weigh 3, the description 2, the body 1 - so a rule added deep in a long note whose description still describes the old topic is hard to find.
metadata:
  type: reference
  seed: aceos-starter
---
`node "$HOME/ace/Code/memory-system/recall.mjs" "<query>"` scores every note on disk (so notes written since the
last reindex are found): slug words and `name` at weight 3, `description` at weight 2, the full body at weight 1.
Whole-word tokens, stopwords dropped, light plural folding. `aliases.json` beside it can declare equivalent terms
(a group's other forms match at half weight). `--top N` shows more hits, `--json` is machine-readable.

**Why:** a new rule appended as a late section of a long note, under a description that still names the note's
original topic, ranks below unrelated notes. For a future session, "not findable" is the same as "not recorded".

**How to apply:**
- When updating a note with a new rule, also update its `description` with the rule's key terms.
- Prefer short atomic notes whose opening lines state the rule; tell the story after.
- Put the most distinctive term in the file name.
- Use recall as the dedup check before writing a note, and do not treat a probe that returns unrelated notes as
  proof that a lesson is covered.

Related: [[reference_how_your_brain_works]].
