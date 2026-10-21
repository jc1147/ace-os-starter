#!/usr/bin/env node
// block-wrap-without-memory.js — WS-E memory-pass enforcement, WRAP tier. Stop ONLY (NOT SubagentStop).
//
// Closes the "end the day without recording anything" gap: when the user calls a wrap-up on a session that
// did real work, a memory pass should exist for the session. The evidence oracle
// (Code/memory-system/verify-memory-pass.mjs) decides; this hook gates on it. Mirrors
// block-unpersisted-memory.js's breaker + flush-race + turn/prompt extraction.
//
// TRIGGER: the OWNER's own text this turn (lib-owner-text: typed turns + human queued messages; machine text
// such as task prompts, peer messages, skill bodies and continuation summaries never counts) matches WRAP_RE,
// OR the turn invoked /wrap-up (the command or a Skill call), OR the assistant's closing tail matches a narrow
// session-wrap phrase. Repo, memory dir and oracle come from lib-workspace, so home-folder sessions find them.
// EXEMPTIONS (any -> allow): circuit breaker (stop_hook_active); a fresh pass-marker AT THE SESSION'S
// CURRENT WORK TIER (a marker earned while the session was small is ignored once it has done much more
// work — tierOf(currentScore) > tierOf(marker.workScore) re-runs the oracle); a TRIVIAL SESSION
// (workScore === 0: no Write/Edit/NotebookEdit outside the mem-dir//logs/temp/, no side-effect
// Bash/PowerShell, and no Task delegations — nothing to record); repo not memory-ENABLED (mem-dir +
// oracle must both exist).
// EVIDENCE (v2, PROPORTIONAL): oracle with --since = session start (first transcript timestamp) and
// --transcript, which makes it require requiredFor(workScore) ok notes (<=15 -> 1, 16..40 -> 2, >40 -> 3).
//
// MODE: ENFORCING by default (flipped 2026-07-10 after fixture verification) — emits a real block
// ({decision:'block', reason}) on a failed gate. Explicit opt-out: env MEMGATE_ENFORCE === '0' reverts to
// DIAGNOSTIC / LOG-ONLY (audit WOULD-BLOCK + allow). On allow-with-evidence it writes the pass-marker
// (with workScore, for the tier-staleness guard). Fail-OPEN on any error. Tag [wrap-mem-gate].

'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const HOME = (os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
const AUDIT = `${HOME}/.claude/hook-audit.log`;
const ENFORCE = process.env.MEMGATE_ENFORCE !== '0'; // enforcing by default; '0' = explicit log-only opt-out
const MARKER_DIR = `${HOME}/.claude/memory-pass`;

const repoSlug = (p) => String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, '').replace(/[^A-Za-z0-9]/g, '-');
const normDir = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');

function audit(line) { try { fs.appendFileSync(AUDIT, `[${new Date().toISOString()}] [wrap-mem-gate] ${line}\n`); } catch (_) {} }
function allow(reason) { audit(`ALLOW: ${reason}`); process.exit(0); }
function block(reason, detail) {
  if (!ENFORCE) { audit(`WOULD-BLOCK: ${detail || String(reason).slice(0, 160)}`); process.exit(0); }
  audit(`BLOCK: ${String(reason).slice(0, 160)}`);
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

// wrap-up intent in the USER prompt (anchored) — KEEP BYTE-IDENTICAL with inject-wrap-memory-directive.js.
// 2026-10-10 (Phase 2): "end of day" used as a noun no longer triggers: after a possessive ("my end of day"),
// before "/" or "-" ("end of day/begining of day") or before a meeting-type noun ("end of day meetings").
// Q13 tuning (audit 2026-07-07): strong anchors stay (end of day/session, call it a day/night,
// close out the session, wrap it/things up, wrap up standalone-or-EOL); excluded false positives:
//   'sign off ON <x>' (approval, not departure) · 'wrap up a|the|my|this <noun>' (code/task object;
//   'the day/session/work' still count) · 'done for now,<more instructions>' (continuation).
const WRAP_RE = /\b(?:wrap\s+(?:it|things)\s+up\b|wrap\s+up(?=\s+(?:the|this|my|our)\s+(?:day|session|work)\b)|wrap\s+up\b(?!\s+(?:a|an|the|my|this|that|these|those|your|our|some|each|every)\b)|(?<!\b(?:my|our|your|his|her|their)\s+)end\s+of\s+(?:the\s+)?(?:day|session)\b(?!\s*[\/-])(?!\s+(?:meetings?|calls?|reports?|recaps?|updates?|summary|summaries|emails?|sync|standups?|check-?ins?)\b)|close\s+out\s+(?:the\s+)?session\b|call\s+it\s+(?:a\s+(?:day|night)|here)\b|sign(?:ing)?\s+off\b(?!\s+on\b)|done\s+for\s+(?:today|the\s+day)\b|done\s+for\s+now\b(?!\s*[,;:—–-])(?!\s+(?:but|next|then|and|so|now|please|go|do|let|can|could|just|after|before|first)\b))/i;
// narrow session-wrap phrasing in the ASSISTANT closing tail
const WRAP_TAIL_RE = /\b(session\s+(summary|wrap[- ]?up|complete|is\s+(?:complete|done))|wrapping\s+up(?:\s+the\s+session)?|that'?s\s+a\s+wrap|end\s+of\s+session|clean\s+state\s+summary|calling\s+it\s+(?:a\s+day|here))\b/i;
// side-effecting shell — broad on purpose (a false "trivial" exemption would let real work go unrecorded).
// Ported VERBATIM into Code/memory-system/verify-memory-pass.mjs (v2 workScore) — keep in sync.
const SIDEEFFECT_SHELL_RE = /(>>?)|(\bSet-Content\b)|(\bOut-File\b)|(\btee\b)|(\bsed\b[^|;\n]*-i)|(\bgit\s+(commit|add|push|merge|rebase|reset|checkout|restore|revert|tag|stash|rm|mv|apply|cherry-pick))|(\bnpm\s+(i\b|install|run|publish|ci\b))|(\bnpx\b)|(\b(mkdir|rmdir|rm|mv|cp|touch|ln|chmod|chown)\b)|(New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Set-Item)|(\bfs\.(write|append|mkdir|rm|unlink))/i;
// writes to these never count as work (bookkeeping, not output)
const LOGS_TEMP_RE = /\/logs\/temp\//;
// proportionality tier — DUPLICATED from Code/memory-system/verify-memory-pass.mjs requiredFor(); keep in sync.
const tierOf = (score) => (score > 40 ? 3 : score > 15 ? 2 : 1);
// flat work weight per Task (delegated-subagent) tool_use — the subagent's mutations live in a SEPARATE
// sidechain transcript, invisible here, so each delegation counts as one batch of work (1 Task = tier 1 but
// never "trivial"; 2+ = tier 2; 5+ = tier 3). DUPLICATED from the oracle's TASK_WORK — keep in sync.
const TASK_WORK = 10;

// shared libs (same folder). A missing lib means legacy behavior (fail-open, never a crash at load).
let LW = null, LO = null;
try { LW = require('./lib-workspace.js'); } catch (_) {}
try { LO = require('./lib-owner-text.js'); } catch (_) {}

function resolveRepoRoot(cwd) {
  try {
    const top = cp.execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: cwd || process.cwd(), stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim();
    if (top) return normDir(top);
  } catch (_) {}
  if (process.env.CLAUDE_PROJECT_DIR) return normDir(process.env.CLAUDE_PROJECT_DIR);
  return normDir(cwd || process.cwd());
}
// memory dir: explicit env first (MEMGATE_MEM_DIR, CLAUDE_MEM_DIR), then lib-workspace (any cwd resolves to
// the ace brain), then the legacy cwd-repo slug.
function resolveMemDir(ws, repoRoot) {
  if (process.env.MEMGATE_MEM_DIR) return normDir(process.env.MEMGATE_MEM_DIR);
  if (process.env.CLAUDE_MEM_DIR) return normDir(process.env.CLAUDE_MEM_DIR);
  if (ws && ws.memDir) return normDir(ws.memDir);
  if (!repoRoot) return null;
  return `${HOME}/.claude/projects/${repoSlug(repoRoot)}/memory`;
}
// oracle: lib-workspace's tools dir first, then the cwd repo's own copy (legacy; also the fixture-test seam).
function oraclePath(ws, repoRoot) {
  const cands = [];
  if (ws && ws.toolsDir) cands.push(normDir(path.join(ws.toolsDir, 'verify-memory-pass.mjs')));
  if (repoRoot) cands.push(normDir(path.join(repoRoot, 'Code', 'memory-system', 'verify-memory-pass.mjs')));
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
  return cands[0] || '';
}

// Q7: markers carry { sid, ts, oracle:'pass', notes:[...] } and are VALIDATED on read
// (mk.sid === sid && mk.oracle === 'pass') — a marker file's mere existence is not credit.
function markerPath(sid) { return `${MARKER_DIR}/${String(sid).replace(/[^A-Za-z0-9._-]/g, '_')}.json`; }
function readMarker(sid) { try { return JSON.parse(fs.readFileSync(markerPath(sid), 'utf8')); } catch (_) { return null; } }
function markerValid(mk, sid) { return !!(mk && mk.sid === sid && mk.oracle === 'pass' && Number.isFinite(mk.ts)); }
function writeMarker(sid, oracle, notes, workScore) {
  // workScore recorded at pass time so the tier-staleness guard can compare later wrap-ups against it.
  try { fs.mkdirSync(MARKER_DIR, { recursive: true }); fs.writeFileSync(markerPath(sid), JSON.stringify({ sid, ts: Date.now(), oracle, notes: Array.isArray(notes) ? notes : [], workScore: Number.isFinite(workScore) ? workScore : 0 })); } catch (_) {}
}

// returns { status, notes, required } (status 0/1/2, notes = evidencing filenames, required = the oracle's
// proportional note requirement or null) or null on spawn error (fail-open).
function runOracle(oracle, sid, memDir, since, transcript) {
  let r;
  const argv = [oracle, '--sid', sid, '--mem-dir', memDir, '--since', String(since)];
  if (transcript) argv.push('--transcript', transcript, '--require-gaphunt'); // v2 proportional + v3 coverage:
  // tier-3 (workScore>40) must also evidence a gap-hunt receipt (_gaphunt/<sid>.json) — count is not
  // coverage (2026-07-11 + 2026-07-17: passing wraps left lessons homeless). Oracle enforces only >40.
  argv.push('--json');
  try { r = cp.spawnSync('node', argv, { timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (_) { return null; }
  if (!r || r.error || typeof r.status !== 'number') return null;
  let notes = [], required = null;
  try {
    const j = JSON.parse(String(r.stdout || ''));
    if (j && Array.isArray(j.notes)) notes = j.notes.map((n) => n && n.file).filter(Boolean);
    if (j && Number.isFinite(j.required)) required = j.required;
  } catch (_) {}
  return { status: r.status, notes, required };
}

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(data || '{}'); } catch (_) { return allow('input unparsable (fail-open)'); }
  try {
    const event = input.hook_event_name || 'Stop';
    if (event === 'SubagentStop') return allow('SubagentStop — wrap gate is Stop-only');
    if (input.stop_hook_active === true) return allow('stop_hook_active (circuit breaker)');

    const sid = input.session_id || input.sessionId || '';
    if (!sid) return allow('no session_id (fail-open)');
    const tp = input.transcript_path;
    if (!tp || !fs.existsSync(tp)) return allow('no transcript');

    const parse = (raw) => { const a = []; for (const l of raw.split('\n')) { if (!l.trim()) continue; try { a.push(JSON.parse(l)); } catch (_) {} } return a; };
    const endsAsst = (o) => { const x = o[o.length - 1]; return !!(x && x.type === 'assistant' && x.message && Array.isArray(x.message.content) && x.message.content.some((b) => b && b.type === 'text' && b.text)); };
    const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) {} };

    // flush-race: re-read until the transcript ends on assistant text or budget expires. The trigger only
    // needs the current turn, so read from the END (lib-owner-text); the whole file is read only once the
    // gate has triggered (the work score and the session start need it).
    const readAll = () => { try { return parse(fs.readFileSync(tp, 'utf8')); } catch (_) { return null; } };
    const readTurn = () => (LO ? LO.loadTranscript(tp) : readAll());
    let objs = [];
    for (let a = 0; a < 8; a++) {
      objs = readTurn();
      if (objs === null) return allow('transcript unreadable');
      if (objs.length && endsAsst(objs)) break;
      sleep(150);
    }
    if (!objs.length) return allow('empty transcript');

    // current turn: the OWNER's own text (lib-owner-text) + the closing assistant tail.
    // Legacy fallback (lib missing): the last user text that is not a tool result (the old rule).
    let startIdx = 0, promptText = '', wrapCmd = false, ownerStarted = true;
    if (LO) {
      const t = LO.currentTurn(objs);
      startIdx = t.startIdx; promptText = t.ownerText;
      ownerStarted = t.starterKind === 'owner';
      wrapCmd = LO.turnInvokedWrapUp(objs, startIdx);
    } else {
      for (let i = objs.length - 1; i >= 0; i--) {
        const o = objs[i];
        if (o.type === 'user') {
          const c = o.message && o.message.content;
          const isTR = Array.isArray(c) && c.some((b) => b && b.type === 'tool_result');
          let txt = ''; if (typeof c === 'string') txt = c; else if (Array.isArray(c)) txt = c.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ');
          if (txt && !isTR) { startIdx = i; promptText = txt; break; }
        }
      }
    }
    let tail = '';
    for (const o of objs.slice(startIdx)) {
      if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
        const t = o.message.content.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text).join('\n');
        if (t) tail = t;
      }
    }

    // TRIGGER
    const byPrompt = WRAP_RE.test(promptText || '');
    const byCmd = wrapCmd;
    // the closing-text trigger only on a turn the OWNER started: a task notification, heartbeat or peer message
    // never triggers the gate (e.g. an agent's "The launcher builder is wrapping up.")
    const byTail = ownerStarted && WRAP_TAIL_RE.test((tail || '').slice(-1500));
    if (!byPrompt && !byCmd && !byTail) return allow('no wrap-up trigger (owner text/command/tail)');

    // memory-ENABLED? (lib-workspace: home and other-folder sessions resolve to the ace brain)
    const cwd = normDir(input.cwd || process.cwd());
    const repoRoot = resolveRepoRoot(cwd);
    let ws = null; try { ws = LW ? LW.resolveWorkspace({ cwd, env: process.env }) : null; } catch (_) { ws = null; }
    const memDir = resolveMemDir(ws, repoRoot);
    const oracle = oraclePath(ws, repoRoot);
    if (!memDir || !fs.existsSync(memDir) || !oracle || !fs.existsSync(oracle)) return allow('repo not memory-enabled (no mem-dir/oracle)');

    // the work score and the session start need the WHOLE transcript (the trigger read only its end)
    { const all = readAll(); if (all && all.length >= objs.length) objs = all; }

    // WORK SCORE (v2) — same rules as the oracle's computeWorkScore (keep in sync): +1 per
    // Write/Edit/NotebookEdit whose file_path (fwd slashes, lowercase) is outside the mem-dir and not a
    // /logs/temp/ write; +1 per side-effect Bash/PowerShell; +TASK_WORK per Task (delegated subagent —
    // its real mutations are in a sidechain transcript). score 0 == the old TRIVIAL SESSION exemption.
    const memLower = memDir.toLowerCase();
    let workScore = 0;
    for (const o of objs) {
      if (o.type !== 'assistant' || !o.message || !Array.isArray(o.message.content)) continue;
      for (const b of o.message.content) {
        if (!b || b.type !== 'tool_use') continue;
        if (b.name === 'Write' || b.name === 'Edit' || b.name === 'NotebookEdit') {
          const fp = String((b.input && b.input.file_path) || '').replace(/\\/g, '/').toLowerCase();
          if (!fp) continue;
          if (fp === memLower || fp.startsWith(memLower + '/')) continue; // memory notes are the pass, not the work
          if (LOGS_TEMP_RE.test(fp)) continue;                            // temp logs are bookkeeping
          workScore++;
        } else if ((b.name === 'Bash' || b.name === 'PowerShell') && SIDEEFFECT_SHELL_RE.test(String((b.input && b.input.command) || ''))) {
          workScore++;
        } else if (b.name === 'Task') {
          workScore += TASK_WORK; // delegated work — see TASK_WORK above
        }
      }
    }
    if (workScore === 0) return allow('trivial session (no edits / side-effect shell — nothing to record)');

    // session start = first transcript timestamp, else 0.
    let sessionStart = 0;
    for (const o of objs) { const n = o && o.timestamp ? Date.parse(o.timestamp) : NaN; if (Number.isFinite(n)) { sessionStart = n; break; } }

    // fresh VALID pass-marker? (Q7: sid + oracle:'pass' must match — existence is not credit)
    // Tier-staleness guard (v2): a marker earned at a smaller work tier does NOT cover a session that
    // has since done much more work — ignore it and re-run the oracle. Legacy markers without
    // workScore are treated as workScore 0 (tier 1).
    const mk = readMarker(sid);
    if (markerValid(mk, sid) && mk.ts >= sessionStart) {
      const mkScore = Number.isFinite(mk.workScore) ? mk.workScore : 0;
      if (tierOf(workScore) <= tierOf(mkScore)) {
        return allow(`fresh pass-marker (ts=${mk.ts} >= sessionStart=${sessionStart}, tier ${tierOf(workScore)} <= ${tierOf(mkScore)})`);
      }
      audit(`marker tier-stale (marker tier ${tierOf(mkScore)} < current tier ${tierOf(workScore)}) — re-running oracle`);
    }

    // oracle (v2: --transcript makes the requirement proportional to workScore)
    const orc = runOracle(oracle, sid, memDir, sessionStart, tp);
    if (orc === null) return allow('oracle unavailable (fail-open)');
    if (orc.status === 0) { writeMarker(sid, 'pass', orc.notes, workScore); return allow(`oracle: memory pass evidenced (workScore=${workScore})`); }

    const required = Number.isFinite(orc.required) ? orc.required : tierOf(workScore);
    const oracleWord = orc.status === 2 ? 'a note was written but it is MALFORMED' : 'NO sufficient memory pass is evidenced';
    const detail = `sid=${String(sid).slice(0, 8)} trigger=${byPrompt ? 'prompt' : byCmd ? 'command' : 'tail'} oracle=${orc.status} since=${sessionStart} workScore=${workScore} required=${required}`;
    audit(`DIAG ${detail}`);
    return block(
      `Memory-on-wrap gate (${event}): you are wrapping up a session that did real work, but ${oracleWord} for it. ` +
      `This session's work requires ${required} note(s) (work score ${workScore}).\n\n` +
      `Before you close out, run the /wrap-up skill (it walks the whole pass). Fallback — the 3 raw steps:\n` +
      `  1. node "$HOME/ace/Code/memory-system/recall.mjs" "<topic>"   (dedup / find the note to update)\n` +
      `  2. write or update ATOMIC note(s) in the memory dir with frontmatter (name / description / ` +
      `metadata.type: user|feedback|project|reference) — ${required} well-formed note(s) for this session. ` +
      `Attribution: on a NEW note stamp ` +
      `metadata.originSessionId: ${sid}; on an UPDATED note set metadata.lastSessionId: ${sid} ` +
      `and leave originSessionId untouched (it records the creating session) — the gate credits either.\n` +
      `  3. node "$HOME/ace/Code/memory-system/reindex.mjs"\n\n` +
      `Then give your clean state summary (no next-step offers). If nothing durable emerged this session, ` +
      `say so explicitly in your closing message. This is one bounce (the circuit breaker allows the next stop).`,
      detail
    );
  } catch (err) {
    return allow(`unexpected error (fail-open): ${err && err.message}`);
  }
});
