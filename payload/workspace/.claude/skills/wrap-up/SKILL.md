---
name: wrap-up
domain: ops
description: The deterministic end-of-session pass — inventory the session's work, record a PROPORTIONAL set of atomic memory notes (1 note for small sessions, 2 for medium 16-40 file-mutations, 3 for large >40 — the verify-memory-pass oracle enforces this on Stop), run an ADVERSARIAL GAP-HUNT when the session is large or a medium session's pass added nothing new (note COUNT is not COVERAGE — a passing pass can still miss the sharpest lesson), regenerate the memory index, consolidate the temp log, then give a clean state summary with no next-step offers. Invoke with /wrap-up when ending a session ("wrap it up", "call it a day", "sign off"); the block-wrap-without-memory hook bounces any wrap-up whose memory pass falls short and points back here.
---

# wrap-up — the end-of-session pass (inventory / record / regenerate / consolidate / summarize)

## What this is

The callable procedure for closing out a session the CORRECT way. A wrap-up is not a goodbye message —
it is a memory pass proportional to the work done, plus log consolidation, plus a clean state summary.
It is enforced: on Stop, `~/.claude/hooks/block-wrap-without-memory.js` asks the evidence oracle
(`$HOME/ace/Code/memory-system/verify-memory-pass.mjs`) whether ENOUGH well-formed, session-attributed
notes exist for this session's work tier. If not, the wrap-up is bounced back to this skill. Do the pass
first; the goodbye writes itself.

## The procedure (do these in order)

### 1. INVENTORY the session's work

Build the list of distinct pieces of work + lessons that emerged. Sources, in order:
- `git status` + changed-file names (`git diff --name-only`) — what was actually touched
- completed tasks this session (task list, TODOs closed)
- today's temp log (`logs/temp/{project}-{username}-{date}-{sid8}.md`) — what you logged as you went

Write the inventory as a short list: each distinct piece of work, and separately each LESSON
(a correction received, a pattern that worked, a trap discovered). The lessons are the point —
they are the durable "how to work" facts.

### 2. RECALL / dedup, then UPDATE or CREATE per topic

For each inventory item worth keeping, check what memory already exists:

```
node "$HOME/ace/Code/memory-system/recall.mjs" "<topic>"
```

- **A note already covers the topic → UPDATE it in place.** Preserve prior info unless now wrong.
  Stamp `metadata.lastSessionId: <current session id>` and leave `originSessionId` untouched
  (it records the creating session). The gate credits either stamp.
- **No note covers it → CREATE an atomic note** in the project memory dir. ONE fact per file, with
  frontmatter: `name` (kebab-case slug matching the filename), `description` (one tight line),
  `metadata.type` (user | feedback | project | reference), and
  `metadata.originSessionId: <current session id>`.

Never create a near-duplicate — that is what the recall step prevents.

### 3. The PROPORTIONALITY CONTRACT (the oracle enforces it)

The number of well-formed session-attributed notes must match the session's size, measured as a
**workScore** — the same quantity the Stop gate and the oracle compute: **+1** per Write/Edit outside
the memory dir and temp logs, **+1** per side-effecting shell command, **+10** per Task delegation
(a delegate's real mutations live in its own sidechain transcript, invisible here, so each delegation
counts as a batch of work — five delegations alone make a session LARGE):

| Session size | workScore | Notes required |
|---|---|---|
| small | up to 15 | >= 1 |
| medium | 16-40 | >= 2 |
| large | over 40 | >= 3 |

Do NOT satisfy this with one project-state note and filler. **Atomize the LESSONS** — the feedback
and reference facts that emerged — not just "what happened". A large session that produced three
notes worth of durable knowledge almost always did; find it in the inventory from step 1.

### 4. ADVERSARIAL GAP-HUNT (large sessions — completeness, not just count)

The proportionality contract checks note COUNT; it cannot check COVERAGE. In practice a long session
can flush 8 notes via record-as-you-go and PASS the oracle cleanly while an adversarial hunt still
finds 3 homeless lessons, including the session's root-cause rule. A wrap pass that adds little or
nothing (no new notes, no substantive updates) on a big session is a smell, not a comfort:
record-as-you-go catches the loud lessons and misses the quiet ones.

**When to run:** MANDATORY when the session is LARGE (workScore > 40). The prompt-time wrap directive
includes the computed workScore when it fires; if no score was injected (slash-command invocation,
fail-open, or a tail-triggered wrap), derive the tier yourself from the step-1 inventory using the
step-3 metric. Also run it when a medium session's wrap pass added little or nothing (no new notes,
no substantive updates). Skip it on small sessions — the insurance costs ~3 agents; spend it where
loss is likely.

**The shape (~3 agents):** a two-phase Workflow —
1. **RECONSTRUCT** (2 parallel agents): (a) a lesson-reconstructor that re-derives every durable
   lesson from RAW evidence (today's temp log + the session's audit/build artifacts), explicitly told
   NOT to trust any prior "memory is complete" claim; (b) a coverage-inventory agent that reads every
   session-attributed note IN FULL and runs `recall.mjs` probes on the lesson themes — so the critic
   judges against the whole brain, not just this session's notes.
2. **GAP-HUNT** (1 critic, structured output): default stance = REFUTE "complete". Its rules of
   judgment: a lesson that is a strict SUBSET of an existing note is COVERED, not a gap; a REAL gap
   means a future session hitting the same situation would NOT be steered right by any existing note;
   prefer UPDATE over CREATE (it must name the closest existing note either way). A false GAPS_FOUND
   that invents filler is as bad as a false COMPLETE.

**Then YOU verify each claimed gap** — read the named closest-existing note yourself before acting
(the critic can be wrong in both directions), write/update only the survivors with the step-2
attribution stamps, and re-run step 5's regen so the recovered notes get indexed.

**WRITE THE RECEIPT (enforced on tier-3 wraps).** Whatever method ran — the
3-agent Workflow OR a documented manual hunt — the hunt must leave evidence the oracle can check:
`<mem-dir>/_gaphunt/<session-id>.json` with `{ sid, ts, method: "workflow"|"manual",
lessonsReconstructed: [..], gapsFound: [..], notesWritten: [..], verdict: "COMPLETE"|"GAPS_FOUND" }`.
The Stop-gate oracle (`--require-gaphunt`, hook-passed) BOUNCES a workScore>40 wrap without a
fresh, sid-matched receipt carrying a non-empty `lessonsReconstructed[]`. A manual hunt is
legitimate (credit-constrained days) — but it must enumerate the reconstructed lessons in the
receipt, which is exactly the discipline that makes a manual hunt real instead of a vibe.
Receipts are session bookkeeping, not memory: never index them, never link them from notes.

### 5. REGENERATE the index + ROUTER AUDIT

```
node "$HOME/ace/Code/memory-system/reindex.mjs"
node "$HOME/ace/Code/memory-system/router-audit.mjs" "<mem>/MEMORY.md"
```

`<mem>` is the memory dir reindex prints on its first line (`[reindex] mem=<mem> ...`); passing it makes
router-audit work from any folder, the home folder included.

Then verify the pass the way the Stop gate will (works from any folder):

```
node "$HOME/ace/Code/memory-system/verify-memory-pass.mjs" --sid <this session's id>
```

Add `--require-gaphunt` only when step 4's tier rules require a gap hunt (workScore > 40). Print its verdict
line (PASS / PROPORTIONAL / NO EVIDENCE / MALFORMED / GAP-HUNT MISSING) in the step 7 summary. If it is not
PASS, fix it now (write or repair the missing notes or the receipt, re-run step 5) before the summary.

New/updated notes go in the TREE (their category MOC), **not as new MEMORY.md lines** — MEMORY.md is a
fixed-budget ROUTER (6,000-byte budget · 22 bullet lines · 220 chars/pin, hook-enforced at write time by
`block-memory-md-too-large.js`). Pin a line ONLY for a new always-on essential or active initiative, and
then one-in-one-out (merge themed pins into a hub note like `reference_<theme>_hub`).
If router-audit reports OVER BUDGET, rotate NOW as part of this wrap-up — merge/demote/compress — so the
user never has to clean the router by hand.

### 6. CONSOLIDATE the temp log

Append a final `## HH:MM` entry to today's temp log summarizing the session: what was completed,
key decisions, and any outstanding items. This is what session-logger folds into the monthly log.

### 7. CLEAN STATE SUMMARY — then stop

Give a plain statement of where things stand: what is done, what is verified, what remains open.
**Report the SESSION-TOTAL memory ledger, not just this pass's delta** (a thin final wrap reads as
"nothing was logged" when several notes already exist): one line listing every
note created/updated across the WHOLE session — including notes from mid-session wrap bounces and
record-as-you-go — e.g. "Memory this session: 3 created (a, b, c) · 2 updated (d, e)". A long
session often wraps more than once; the final summary owns the running total.
**No next-step offers** ("want me to X?" is banned — the user decides what happens next).

**If genuinely nothing durable emerged: declare it, don't manufacture.** Write the receipt
`<mem-dir>/_gaphunt/<session-id>.json` with
`verdict: "NOTHING_DURABLE"` and a non-empty `considered: [{topic, why}, ...]` — every candidate
lesson you weighed and WHY it doesn't merit a note (repo-derivable / conversation-local /
strict subset of an existing note, name it). The oracle honors this receipt and waives the note
count at any tier. Filler notes to satisfy the gate are a worse corruption than an empty pass —
but an empty pass without the considered[] audit is just laziness wearing a flag; the receipt
is what separates them. (A trivial session with zero file-mutations never triggers the gate at all.)

## What NOT to save

- Anything the repo already records (code structure, the diff you just made, git history, CLAUDE.md).
- Conversation-local detail that will not matter next session.
- If something feels worth saving but is repo-derivable, save the NON-obvious part (the why, the trap,
  the decision) instead of the artifact.

## Cross-references

This skill exists in two places that MUST stay byte-identical:
- `~/.claude/skills/wrap-up/SKILL.md` (global — available in every project/session)
- `~/ace/.claude/skills/wrap-up/SKILL.md` (workspace mirror — so workspace subagents and the Ace OS
  dashboard's skill view discover it). Edit one → copy it to the other.

Related machinery: the `memory` skill (the full record/update/recall/archive procedure this pass
uses), `$HOME/ace/Code/memory-system/verify-memory-pass.mjs` (the proportional evidence oracle),
`~/.claude/hooks/block-wrap-without-memory.js` (the Stop gate that bounces short wrap-ups here),
`~/.claude/hooks/inject-wrap-memory-directive.js` (the prompt-time reminder — it computes the
session's workScore and flags when step 4's gap-hunt is mandatory), and `~/.claude/HOOKS.md` (every
installed hook, what it does and how to turn it off).
