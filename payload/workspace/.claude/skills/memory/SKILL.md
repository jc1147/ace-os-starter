---
name: memory
domain: ops
description: The file-based second-brain maintenance pass. Record, update, recall, and archive durable cross-session facts the CORRECT way — atomic one-fact notes with frontmatter in the project memory dir, indexed via the manifest+MOC tree (MEMORY.md is a fixed-budget ROUTER — pin only always-on essentials, one-in-one-out), wikilinks to connect, soft-archive never delete. Enforces search-before-write (dedup), sentinel-safe regeneration of generated files, and the 24.4KB MEMORY.md cap (hook-gated). Invoke with /memory to record or reconcile something; the protocol itself is injected into every session by inject-memory-protocol.js and the cap is enforced by block-memory-md-too-large.js.
---

# memory — file-based second brain (record / update / recall / archive)

## What this is

The callable maintenance pass for the persistent, wikilinked memory that survives across sessions.
The memory is the project's source of truth for facts that are **not derivable from the repo** — who
the user is, how they want you to work, ongoing project state, and pointers to external resources.

Two halves enforce it on every session (you don't wire these — they already run):
- **inject-memory-protocol.js** (SessionStart + SubagentStart) puts the short protocol in front of you.
- **block-memory-md-too-large.js** (PreToolUse) hard-blocks any write that pushes MEMORY.md over 24.4KB.

This skill is the *how* — the full procedure those hooks assume you follow.

## Where the memory lives

Per-project. The dir is `~/.claude/projects/<ENCODED-CWD>/memory/`, where `<ENCODED-CWD>` is the
project's absolute path with every character that is not a letter or a digit (`:`, `\`, `/`, `.`,
spaces, `_` ...) replaced by `-`. That is the rule Claude Code itself uses to name the folder.

- With Ace OS the workspace is `~/ace`, so the brain is `~/.claude/projects/<encoded ~/ace>/memory/`.
- Example (macOS) — cwd `/Users/you/ace` → `~/.claude/projects/-Users-you-ace/memory/`.
- Example (Windows) — cwd `D:\work\ace` → `~/.claude/projects/D--work-ace/memory/`
  (`D:` → `D-`, then each `\` → `-`, giving the leading `D--`).
- `MEMORY.md` in that dir is the **index** (loaded into context every session). Every other `*.md`
  is one atomic note.

Resolve it from the current cwd; do not hardcode another project's path. If unsure, derive the
folder by listing `~/.claude/projects/` and matching the encoded cwd.

## The note format

Each note is ONE file holding ONE fact:

```markdown
---
name: <short-kebab-case-slug>            # matches the filename (minus .md)
description: <one line — used to decide relevance during recall; keep tight>
metadata:
  type: user | feedback | project | reference
---

<the fact. For feedback/project, follow with **Why:** and **How to apply:** lines.
Link related notes with [[their-name]].>
```

The four types:
- **user** — who the user is (role, expertise, standing preferences).
- **feedback** — guidance on how you should work (corrections AND confirmed-good approaches). Include the **why**.
- **project** — ongoing work, goals, constraints not derivable from code or git history. Convert relative dates to absolute.
- **reference** — pointers to external resources (URLs, dashboards, tickets).

## RECORD — the procedure (do these in order)

1. **Search before writing (dedup).** Run `node "$HOME/ace/Code/memory-system/recall.mjs" "<topic>"`
   and grep/scan the memory dir for the topic and for likely slugs.
   If a note already covers it → go to UPDATE instead. Never create a near-duplicate.
2. **Write the atomic note** to `<memory-dir>/<slug>.md` with the frontmatter above. One fact only.
   Keep the body tight; put the detail here, not in MEMORY.md.
3. **Index it in the TREE, not MEMORY.md.** Run `node "$HOME/ace/Code/memory-system/reindex.mjs"` —
   it regenerates the manifest + category MOCs (and the sitemap), which IS the note's index entry
   (recall.mjs finds it from there). **Default: NO new MEMORY.md line.**
   MEMORY.md is a fixed-budget ROUTER (~14 pins + active initiatives, hook-capped 24.4KB): pin a line
   ONLY for a new always-on essential or active initiative, and then one-in-one-out — merge or demote
   an existing pin (themed sets belong in a HUB note like `reference_<theme>_hub`,
   which gets ONE pin for many related notes). Keep any pin line ≤ ~140 chars.
4. **Connect + propagate.** Add `[[wikilinks]]` from the new note to related notes, and where it
   materially changes an existing note, add a back-link there too. A `[[name]]` with no file yet is
   fine — it marks a note worth writing.

## UPDATE

Edit the existing note in place (preserve prior info unless it's now wrong). Refresh its
`description` if the hook line in MEMORY.md no longer fits. Don't spawn a v2 file.

## RECALL

Before answering "I don't know" or re-deriving a past decision, scan MEMORY.md + the relevant notes
(`node "$HOME/ace/Code/memory-system/recall.mjs" "<topic>"` searches every note).
Recalled memory is point-in-time: if a note cites a file/function/flag, **verify it still exists in
current source before recommending it.** Correct or soft-archive notes you find to be stale.

## ARCHIVE / DELETE

- **Wrong fact** → delete the note and its MEMORY.md line.
- **Superseded but historically real** → soft-archive: move the file to a `_sunset/` subfolder and
  drop its MEMORY.md line (keep the record, clear the index). Never silently destroy real history.

## Sentinel-safe regeneration (generated files)

For files this skill (or another pass) regenerates — indexes, MOCs, maps — mark machine-owned vs
human-owned regions so a re-run never clobbers hand edits:

```markdown
<!-- @generated:start --> ...regenerated each run... <!-- @generated:end -->
<!-- @user --> ...hand-written, never overwritten...
```

Only rewrite inside `@generated` blocks; treat `@user` content as read-only.

## What NOT to save

- Anything the repo already records (code structure, past fixes, git history, CLAUDE.md).
- Anything that only matters to the current conversation.
- If asked to "remember" one of those, ask what was non-obvious about it and save *that* instead.

## Cross-references

This skill exists in two places that MUST stay byte-identical:
- `~/.claude/skills/memory/SKILL.md` (global — available in every project/session)
- `~/ace/.claude/skills/memory/SKILL.md` (workspace mirror — so the Ace OS dashboard's skill view
  discovers it and workspace subagents load it). Edit one → copy it to the other.

Related machinery: `~/.claude/memory-protocol.md` (the injected reminder),
`~/.claude/hooks/inject-memory-protocol.js`, `~/.claude/hooks/block-memory-md-too-large.js`,
`~/.claude/HOOKS.md` (every installed hook, what it does and how to turn it off).
