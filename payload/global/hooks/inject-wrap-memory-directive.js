#!/usr/bin/env node
// inject-wrap-memory-directive.js — UserPromptSubmit.
//
// When the user's prompt signals a session wrap-up (WRAP_RE, mirrored from block-wrap-without-memory.js),
// inject an additionalContext directive that tells the agent memory-on-wrap is hook-enforced: run the memory
// skill FIRST (record the pass), stamp metadata.originSessionId with THIS session's live id on every NEW
// note (on an UPDATED note: metadata.lastSessionId, originSessionId untouched — Q2 update convention),
// then give a clean state summary with no next-step offers. On any non-wrap prompt it emits nothing
// (does NOT add a commit-hint on every prompt — that was cut). Fail-OPEN: emit nothing on any error.
//
// GAP-HUNT ADVISORY (added 2026-07-11): on a wrap prompt this hook also computes the session's workScore
// from the transcript (same rules as block-wrap-without-memory.js — keep in sync) and, when the session is
// LARGE (workScore > 40, tier 3), appends an ADVISORY that the /wrap-up skill's step 4 (adversarial
// gap-hunt) is mandatory — note COUNT is not COVERAGE; a passing proportional pass can still miss the
// sharpest lesson (proven 2026-07-11: 8 notes passed the oracle, 3 root-cause-grade gaps remained).
// This is the SOFT channel deliberately: the Stop gate's allow() path has no model-facing output, so the
// advisory lives here at prompt time. Advisory only — never blocks, fail-OPEN (no transcript -> no advisory).

'use strict';
const fs = require('node:fs');
const os = require('node:os');
const cp = require('node:child_process');

const HOME = (os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
const repoSlug = (p) => String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, '').replace(/[^A-Za-z0-9]/g, '-');
const normDir = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');

// ---- workScore rules — DUPLICATED from block-wrap-without-memory.js (and the oracle's computeWorkScore).
// KEEP IN SYNC: a drifted copy here makes the advisory disagree with the gate's tiering.
const SIDEEFFECT_SHELL_RE = /(>>?)|(\bSet-Content\b)|(\bOut-File\b)|(\btee\b)|(\bsed\b[^|;\n]*-i)|(\bgit\s+(commit|add|push|merge|rebase|reset|checkout|restore|revert|tag|stash|rm|mv|apply|cherry-pick))|(\bnpm\s+(i\b|install|run|publish|ci\b))|(\bnpx\b)|(\b(mkdir|rmdir|rm|mv|cp|touch|ln|chmod|chown)\b)|(New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Set-Item)|(\bfs\.(write|append|mkdir|rm|unlink))/i;
const LOGS_TEMP_RE = /\/logs\/temp\//;
const TASK_WORK = 10;
const LARGE_TIER_MIN = 41; // tier 3 boundary: workScore > 40 == tierOf() === 3 in the gate
const tierOf = (score) => (score > 40 ? 3 : score > 15 ? 2 : 1); // DUPLICATED from the gate — keep in sync

// shared libs (same folder). A missing lib means legacy behavior (fail-open).
let LW = null, LO = null;
try { LW = require('./lib-workspace.js'); } catch (_) {}
try { LO = require('./lib-owner-text.js'); } catch (_) {}

// Is the submitted prompt the OWNER's own text? Machine text (task notifications, peer messages, workflow task
// prompts, continuation summaries...) must not trigger the directive. Classified with lib-owner-text's rules.
function ownerPrompt(prompt) {
  if (!LO) return prompt; // legacy: the raw prompt
  const c = LO.classifyUser({ type: 'user', message: { role: 'user', content: prompt } });
  return c.kind === 'owner' ? (c.raw || c.text) : '';
}
// the /wrap-up command, typed ("/wrap-up ...") or as the expanded command record
const WRAPUP_CMD_RE = /(?:^\s*\/wrap-up(?:\s|$)|<command-name>\s*\/wrap-up\s*<\/command-name>)/i;

function resolveRepoRoot(cwd) {
  try {
    const top = cp.execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: cwd || process.cwd(), stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim();
    if (top) return normDir(top);
  } catch (_) {}
  if (process.env.CLAUDE_PROJECT_DIR) return normDir(process.env.CLAUDE_PROJECT_DIR);
  return normDir(cwd || process.cwd());
}

// returns the session's workScore, or null when it cannot be computed (fail-open -> no advisory).
// Also returns null when the repo is not memory-ENABLED (no mem-dir) — the Stop gate allows those
// sessions outright (block-wrap-without-memory.js memDir/oracle check), so a tier advisory there
// would overstate what is enforced.
function computeWorkScore(transcriptPath, cwd) {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
    const repoRoot = resolveRepoRoot(cwd);
    let ws = null; try { ws = LW ? LW.resolveWorkspace({ cwd: normDir(cwd || process.cwd()), env: process.env }) : null; } catch (_) { ws = null; }
    const memDir = process.env.MEMGATE_MEM_DIR || process.env.CLAUDE_MEM_DIR || (ws && ws.memDir) ||
      (repoRoot ? `${HOME}/.claude/projects/${repoSlug(repoRoot)}/memory` : '');
    if (!memDir || !fs.existsSync(memDir)) return null; // not memory-enabled -> no advisory (mirrors the gate)
    const memLower = normDir(memDir).toLowerCase();
    let raw = ''; try { raw = fs.readFileSync(transcriptPath, 'utf8'); } catch (_) { return null; }
    let score = 0;
    for (const l of raw.split('\n')) {
      if (!l.trim()) continue;
      let o; try { o = JSON.parse(l); } catch (_) { continue; }
      if (!o || o.type !== 'assistant' || !o.message || !Array.isArray(o.message.content)) continue;
      for (const b of o.message.content) {
        if (!b || b.type !== 'tool_use') continue;
        if (b.name === 'Write' || b.name === 'Edit' || b.name === 'NotebookEdit') {
          const fp = String((b.input && b.input.file_path) || '').replace(/\\/g, '/').toLowerCase();
          if (!fp) continue;
          if (memLower && (fp === memLower || fp.startsWith(memLower + '/'))) continue;
          if (LOGS_TEMP_RE.test(fp)) continue;
          score++;
        } else if ((b.name === 'Bash' || b.name === 'PowerShell') && SIDEEFFECT_SHELL_RE.test(String((b.input && b.input.command) || ''))) {
          score++;
        } else if (b.name === 'Task') {
          score += TASK_WORK;
        }
      }
    }
    return score;
  } catch (_) { return null; }
}

// wrap-up intent (anchored) — KEEP BYTE-IDENTICAL with block-wrap-without-memory.js.
// 2026-10-10 (Phase 2): "end of day" used as a noun no longer triggers: after a possessive ("my end of day"),
// before "/" or "-" ("end of day/begining of day") or before a meeting-type noun ("end of day meetings").
// Q13 tuning (audit 2026-07-07): strong anchors stay (end of day/session, call it a day/night,
// close out the session, wrap it/things up, wrap up standalone-or-EOL); excluded false positives:
//   'sign off ON <x>' (approval, not departure) · 'wrap up a|the|my|this <noun>' (code/task object;
//   'the day/session/work' still count) · 'done for now,<more instructions>' (continuation).
const WRAP_RE = /\b(?:wrap\s+(?:it|things)\s+up\b|wrap\s+up(?=\s+(?:the|this|my|our)\s+(?:day|session|work)\b)|wrap\s+up\b(?!\s+(?:a|an|the|my|this|that|these|those|your|our|some|each|every)\b)|(?<!\b(?:my|our|your|his|her|their)\s+)end\s+of\s+(?:the\s+)?(?:day|session)\b(?!\s*[\/-])(?!\s+(?:meetings?|calls?|reports?|recaps?|updates?|summary|summaries|emails?|sync|standups?|check-?ins?)\b)|close\s+out\s+(?:the\s+)?session\b|call\s+it\s+(?:a\s+(?:day|night)|here)\b|sign(?:ing)?\s+off\b(?!\s+on\b)|done\s+for\s+(?:today|the\s+day)\b|done\s+for\s+now\b(?!\s*[,;:—–-])(?!\s+(?:but|next|then|and|so|now|please|go|do|let|can|could|just|after|before|first)\b))/i;

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(data || '{}'); } catch (_) { process.exit(0); }
  try {
    const event = input.hook_event_name || 'UserPromptSubmit';
    const prompt = ownerPrompt(String(input.prompt || ''));
    if (!WRAP_RE.test(prompt) && !WRAPUP_CMD_RE.test(prompt)) process.exit(0); // non-wrap or machine text -> no output
    const sid = input.session_id || input.sessionId || '';

    // gap-hunt advisory (soft, fail-open): compute workScore only on wrap prompts; null -> no advisory.
    // The score also goes into the BASE text at every tier (when computable) so the skill's step 3/4
    // tiering never depends on the LARGE advisory alone (critic REAL-1, 2026-07-11).
    const workScore = computeWorkScore(input.transcript_path, input.cwd);
    const scoreLine = (workScore !== null)
      ? ` Computed workScore for this session so far: ${workScore} (tier ${tierOf(workScore)}).`
      : '';
    const advisory = (workScore !== null && workScore >= LARGE_TIER_MIN)
      ? `\nLARGE SESSION (workScore=${workScore} > 40, tier 3): the /wrap-up skill's step 4 — ADVERSARIAL ` +
        `GAP-HUNT — is MANDATORY for this wrap. Note COUNT is not COVERAGE: record-as-you-go catches the ` +
        `loud lessons and misses the quiet ones, and a passing oracle can still leave the sharpest lesson ` +
        `homeless. Reconstruct the session's durable lessons from raw evidence, run the refute-stance critic, ` +
        `verify each claimed gap yourself, then write/update only the survivors.`
      : '';

    const text =
      `WRAP-UP DETECTED — memory-on-wrap is hook-enforced (block-wrap-without-memory.js) and PROPORTIONAL: ` +
      `the oracle requires 1 note for small sessions, 2 for medium (16-40 workScore: file-mutations + ` +
      `delegations), 3 for large (>40) — a single note will NOT pass a big session. Run the /wrap-up SKILL ` +
      `(it walks the whole pass: inventory → recall/dedup → proportional atomic notes → adversarial ` +
      `gap-hunt (large sessions) → regen index → consolidate temp log → clean summary) BEFORE your closing ` +
      `summary.${scoreLine}${advisory}\n` +
      `Raw steps if the skill is unavailable:\n` +
      `  1. node "$HOME/ace/Code/memory-system/recall.mjs" "<topic>"   (dedup / find the note to update)\n` +
      `  2. write or update ATOMIC note(s) in the memory dir with frontmatter (name / description / ` +
      `metadata.type: user|feedback|project|reference) — atomize the LESSONS, one fact per note\n` +
      `  3. node "$HOME/ace/Code/memory-system/reindex.mjs"\n` +
      `Attribution (how the gate credits the pass): stamp metadata.originSessionId: ${sid} on every NEW note; ` +
      `on an UPDATED note set metadata.lastSessionId: ${sid} and leave originSessionId untouched (it records ` +
      `the creating session). UPDATE of an existing note is the PREFERRED action when one covers the topic. ` +
      `Then give a clean state summary — no next-step offers. If nothing durable emerged this session, say so ` +
      `explicitly instead.`;

    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
    process.exit(0);
  } catch (_) { process.exit(0); }
});
