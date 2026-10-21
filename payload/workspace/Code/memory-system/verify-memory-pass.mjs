#!/usr/bin/env node
// verify-memory-pass.mjs — the deterministic EVIDENCE ORACLE for the memory-pass gates (WS-E). v2: PROPORTIONAL.
// A pure, dependency-light judge that answers ONE question for a session segment: "is a genuine memory pass —
// proportional to the work done — evidenced here?" Hooks build against its CLI contract; it decides, it does
// not enforce.
//
//   node verify-memory-pass.mjs --sid <session_id> --mem-dir <dir> --since <epoch_ms>
//                               [--transcript <jsonl>] [--strict-index] [--json]
//   node verify-memory-pass.mjs --sid <session_id> [--require-gaphunt] [--json]      (from ANY folder)
//     --sid alone (no --since): the transcript is found at ~/.claude/projects/*/<sid>.jsonl, --since becomes
//     its first timestamp and --transcript defaults to it (so the tier is proportional, as in the Stop gate);
//     the mem-dir resolves like lib-workspace (home and other-folder sessions find the ace brain).
//     Every existing flag and output is unchanged.
//     exit 0 = PASS      enough well-formed session-attributed notes for the session's work tier
//     exit 1 = NO        not enough evidence (none at all, or fewer ok notes than the tier requires —
//                        "PROPORTIONAL"); also unresolvable mem-dir / missing/invalid args — fail-CLOSED
//     exit 2 = MALFORMED evidence present but at least one evidenced note fails correctness
//              (also: --strict-index and the index is still stale after the repair attempt)
//   --json -> {pass, notes:[{file,ok,problems[]}], since, malformed, required, workScore, evidencedOk}
//
// PROPORTIONALITY (v2): with OPTIONAL --transcript <path>, compute a workScore from the session transcript
// JSONL (parse fail-soft, skip bad lines) — +1 per assistant Write/Edit/NotebookEdit tool_use whose file_path
// is OUTSIDE the mem-dir and NOT a /logs/temp/ write, +1 per side-effect Bash/PowerShell command, and
// +TASK_WORK (10) per Task tool_use (DELEGATED work: the subagent's own mutations live in separate sidechain
// transcripts this oracle never sees, so each delegation counts as a flat batch — otherwise a session that
// fans a big build out to agents reads as near-trivial and under-requires notes) — then
// require requiredFor(score) ok notes: score<=15 -> 1, 16..40 -> 2, >40 -> 3. WITHOUT --transcript the
// behavior is EXACTLY v1 (required = 1) — backward-compatible with hooks that don't pass it.
//
// CHANNEL B: a note counts as MY evidence iff its frontmatter attributes it to this session —
// metadata.originSessionId === sid (note CREATED this session) OR metadata.lastSessionId === sid (note
// UPDATED this session; originSessionId stays untouched — Q2 update convention) — AND its mtimeMs >= since.
// Correctness C on each evidenced note:
// frontmatter parses; has name + description; metadata.type in {user,feedback,project,reference}; body non-empty.
// Index freshness is a best-effort SIDE EFFECT (auto-repair via build-manifest+build-mocs under a regen lock);
// by default it can NEVER cause a non-pass — with auto-repair on, the index self-heals, so proportionality is
// the real teeth. OPT-IN --strict-index (for stricter staff configs; the default hook does NOT pass it): if
// AFTER the repair attempt the index is still stale and the reason isn't a held regen lock -> exit 2.
// Pure node builtins + the sibling build scripts. Never throws to the top.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HOME = (os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VALID_TYPES = new Set(['user', 'feedback', 'project', 'reference']);

// canonical repoSlug (matches ~/.claude/hooks/block-unpersisted-memory.js): abs repo path -> Claude Code
// projects/<slug> folder name (username-agnostic).
// D3 slug rule (= Claude Code's projects/<slug> folder name): every character that is not [A-Za-z0-9] -> "-"
const repoSlug = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').replace(/[^A-Za-z0-9]/g, '-');
const normDir = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');

// ---- args -------------------------------------------------------------------
function parseArgs(argv) {
  const a = { sid: '', memDir: '', since: NaN, json: false, transcript: '', strictIndex: false, requireGaphunt: false, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--json') a.json = true;
    else if (t === '--strict-index') a.strictIndex = true;
    else if (t === '--require-gaphunt') a.requireGaphunt = true;
    else if (t === '--sid') a.sid = argv[++i] || '';
    else if (t === '--mem-dir') a.memDir = argv[++i] || '';
    else if (t === '--since') a.since = Number(argv[++i]);
    else if (t === '--transcript') a.transcript = argv[++i] || '';
    else a.unknown.push(t); // FAIL-CLOSED downstream: an unrecognized flag must never silently weaken the check
    // (2026-07-17 incident: `--tier 3` was silently ignored + no --transcript -> the oracle ran at v1
    // required=1 while the caller believed it was running a tier-3 check).
  }
  return a;
}

// ---- proportionality (v2) -----------------------------------------------------
// side-effecting shell — ported VERBATIM from ~/.claude/hooks/block-wrap-without-memory.js (keep in sync);
// broad on purpose (a false "no work" would under-require and let real work go under-recorded).
const SIDEEFFECT_SHELL_RE = /(>>?)|(\bSet-Content\b)|(\bOut-File\b)|(\btee\b)|(\bsed\b[^|;\n]*-i)|(\bgit\s+(commit|add|push|merge|rebase|reset|checkout|restore|revert|tag|stash|rm|mv|apply|cherry-pick))|(\bnpm\s+(i\b|install|run|publish|ci\b))|(\bnpx\b)|(\b(mkdir|rmdir|rm|mv|cp|touch|ln|chmod|chown)\b)|(New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Set-Item)|(\bfs\.(write|append|mkdir|rm|unlink))/i;
const LOGS_TEMP_RE = /\/logs\/temp\//;
// flat work weight per Task (delegated-subagent) tool_use — the subagent's mutations live in a SEPARATE
// sidechain transcript, invisible here, so each delegation counts as one batch of work. Calibrated to the
// tier boundaries (15/40): 1 Task alone stays tier 1 (10 <= 15) but is never "trivial"; 2+ substantive
// delegations reach tier 2 (20 > 15); 5+ reach tier 3 (50 > 40).
// DUPLICATED in ~/.claude/hooks/block-wrap-without-memory.js (TASK_WORK) — keep in sync.
const TASK_WORK = 10;

// tier function — how many ok notes a session of this work size must evidence.
// DUPLICATED in ~/.claude/hooks/block-wrap-without-memory.js (tierOf) — keep in sync.
function requiredFor(score) { return score > 40 ? 3 : score > 15 ? 2 : 1; }

// workScore from the transcript JSONL: count assistant tool_use blocks that mutate the world —
//   Write/Edit/NotebookEdit whose file_path (fwd slashes, lowercase) is NOT inside the mem-dir and does
//   NOT match /\/logs\/temp\// -> +1  (memory notes + temp logs are bookkeeping, not work)
//   Bash/PowerShell whose command matches SIDEEFFECT_SHELL_RE -> +1
//   Task (delegated subagent) -> +TASK_WORK (its real mutations are in a sidechain transcript we never see)
// Fail-SOFT: unreadable transcript -> 0 (v1 required=1); bad JSONL lines are skipped.
function computeWorkScore(transcriptPath, memDir, diag) {
  let raw = '';
  try { raw = fs.readFileSync(transcriptPath, 'utf8'); }
  catch (e) { diag(`transcript unreadable (${e && e.message}) -> workScore 0 (v1 required=1)`); return 0; }
  const memLower = normDir(memDir).toLowerCase();
  let score = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch (_) { continue; } // fail-soft: skip bad lines
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
        score += TASK_WORK; // delegated work — see TASK_WORK above
      }
    }
  }
  return score;
}

// ---- frontmatter ------------------------------------------------------------
// Minimal 2-level YAML-ish parser for the note format (top-level name/description + a `metadata:` block that
// nests node_type/type/originSessionId). Returns { ok, fm, body }. fm.metadata is always an object.
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
function parseNote(raw) {
  const text = String(raw || '').replace(/^﻿/, ''); // strip BOM
  const m = text.match(FM_RE);
  if (!m) return { ok: false, fm: null, body: text };
  const fm = { metadata: {} };
  let inMeta = false;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const kv = line.match(/^(\s*)([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) continue;
    const indent = kv[1].length, key = kv[2];
    let val = kv[3].trim().replace(/^["']|["']$/g, '');
    if (indent === 0) {
      inMeta = key === 'metadata';
      if (!inMeta) fm[key] = val;
    } else if (inMeta) {
      fm.metadata[key] = val;
    }
  }
  return { ok: true, fm, body: text.slice(m[0].length) };
}

// ---- correctness C ----------------------------------------------------------
function checkNote(fm, body) {
  const problems = [];
  if (!fm) { problems.push('frontmatter did not parse'); return problems; }
  if (!fm.name) problems.push('missing frontmatter: name');
  if (!fm.description) problems.push('missing frontmatter: description');
  const t = fm.metadata && fm.metadata.type;
  if (!t) problems.push('missing frontmatter: metadata.type');
  else if (!VALID_TYPES.has(String(t).toLowerCase())) problems.push(`metadata.type not in {user,feedback,project,reference}: "${t}"`);
  if (!body || !body.trim()) problems.push('empty body');
  return problems;
}

// ---- mem-dir resolution -----------------------------------------------------
// --mem-dir > CLAUDE_MEM_DIR > (git rev-parse --show-toplevel -> repoSlug -> ${HOME}/.claude/projects/<slug>/memory)
// lib-workspace.js (CommonJS, with the hooks): staging layout, installed hooks, bootstrap seed copy.
const SEAM_HOME = normDir(process.env.MEMSYS_TEST_HOME || HOME);
function loadWorkspaceLib() {
  const req = createRequire(import.meta.url);
  const cands = [
    process.env.MEMSYS_HOOKS_DIR && path.join(process.env.MEMSYS_HOOKS_DIR, 'lib-workspace.js'),
    path.join(HERE, '..', 'hooks', 'lib-workspace.js'),
    path.join(SEAM_HOME, '.claude', 'hooks', 'lib-workspace.js'),
    path.join(HERE, '..', '..', 'bootstrap', 'dotclaude', 'hooks', 'lib-workspace.js'),
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return req(c); } catch (_) {} }
  return null;
}
// --sid alone: the session transcript at ~/.claude/projects/*/<sid>.jsonl ('' when not found)
function findTranscript(sid) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(sid || ''))) return '';
  const root = path.join(SEAM_HOME, '.claude', 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch (_) { return ''; }
  for (const d of dirs) { const p = path.join(root, d, `${sid}.jsonl`); try { if (fs.statSync(p).isFile()) return normDir(p); } catch (_) {} }
  return '';
}
// first timestamp of a transcript (epoch ms), NaN when none
function firstTimestamp(tp) {
  try {
    const fd = fs.openSync(tp, 'r');
    try {
      const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 4 * 1024 * 1024));
      fs.readSync(fd, buf, 0, buf.length, 0);
      for (const line of buf.toString('utf8').split('\n')) {
        let o; try { o = JSON.parse(line); } catch (_) { continue; }
        const n = o && o.timestamp ? Date.parse(o.timestamp) : NaN;
        if (Number.isFinite(n)) return n;
      }
    } finally { fs.closeSync(fd); }
  } catch (_) {}
  return NaN;
}

function resolveMemDir(argMemDir) {
  if (argMemDir) return normDir(argMemDir);
  if (process.env.CLAUDE_MEM_DIR) return normDir(process.env.CLAUDE_MEM_DIR);
  // lib-workspace: env MEMSYS_MEM_DIR, the ace git toplevel, or the ace brain found structurally (any folder)
  try {
    const lw = loadWorkspaceLib();
    const ws = lw && lw.resolveWorkspace({ cwd: process.cwd(), env: process.env });
    if (ws && ws.memDir) return normDir(ws.memDir);
  } catch (_) { /* fall through to the legacy git rule */ }
  try {
    const top = cp.execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (top) return `${HOME}/.claude/projects/${repoSlug(normDir(top))}/memory`;
  } catch (_) { /* not a repo / git missing -> unresolvable */ }
  return null;
}

// ---- index freshness (best-effort side effect; NEVER affects pass/fail) ------
function isStale(memDir, notes) {
  const manPath = path.join(memDir, '_manifest.json');
  if (!fs.existsSync(manPath)) return 'no manifest';
  let man = null;
  try { man = JSON.parse(fs.readFileSync(manPath, 'utf8')); } catch (_) { return 'manifest unreadable'; }
  const manMtime = fs.statSync(manPath).mtimeMs;
  let newest = 0;
  for (const f of notes) { try { const mt = fs.statSync(path.join(memDir, f)).mtimeMs; if (mt > newest) newest = mt; } catch (_) {} }
  if ((man.count || 0) !== notes.length) return `count ${man.count} -> ${notes.length}`;
  if (newest > manMtime) return 'a note is newer than the manifest';
  return null;
}

// inline O_EXCL lock (deliberately NOT requiring the CommonJS hooks lib-concurrency.js; this is an .mjs tool).
// Returns 'held' if a live, non-stale lock is present (skip-and-move-on); otherwise runs fn under the lock.
function withRegenLock(lockFile, staleMs, fn) {
  let acquired = false;
  try {
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' });
    acquired = true;
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      let stale = false;
      try { const cur = JSON.parse(fs.readFileSync(lockFile, 'utf8')); stale = !cur || typeof cur.ts !== 'number' || (Date.now() - cur.ts) > staleMs; }
      catch (_) { stale = true; }
      if (!stale) return 'held';
      try { fs.unlinkSync(lockFile); } catch (_) {}
      try { fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' }); acquired = true; }
      catch (_) { return 'held'; }
    } else {
      return fn(); // fail-open: lock infra unavailable -> do the work unlocked
    }
  }
  try { return fn(); } finally { if (acquired) { try { fs.unlinkSync(lockFile); } catch (_) {} } }
}

// Which repo root may build-mocs write _MOC-*.md into for this repair? ONLY a root we can PROVE the
// mem-dir belongs to (its projects-slug memory path equals the mem-dir). Candidates: the cwd's git
// toplevel, then this script's own repo (HERE/../..). No match -> return null and pass NO MEMSYS_ROOT,
// so build-mocs sandboxes its MOC output next to the mem-dir instead of rewriting a live repo root
// from foreign/fixture data (the Q1 incomplete-hotfix class).
function repairRootFor(memDir) {
  const candidates = [];
  try {
    const top = cp.execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (top) candidates.push(normDir(top));
  } catch (_) { /* not a repo / git missing */ }
  candidates.push(normDir(path.resolve(HERE, '..', '..')));
  const md = normDir(memDir).toLowerCase();
  for (const root of candidates) {
    if (`${HOME}/.claude/projects/${repoSlug(root)}/memory`.toLowerCase() === md) return root;
  }
  return null;
}

// Returns a status string for --strict-index: 'fresh' | 'repaired' | 'lock-held' | 'skipped' | 'failed'.
// In DEFAULT mode the return value is ignored — repair stays a side effect that can never change the verdict.
function maybeRepairIndex(memDir, notes, diag) {
  try {
    const mf = path.join(HERE, 'build-manifest.mjs');
    const mo = path.join(HERE, 'build-mocs.mjs');
    if (!fs.existsSync(mf) || !fs.existsSync(mo)) { diag('index-repair skipped: build scripts not present'); return 'skipped'; }
    const reason = isStale(memDir, notes);
    if (!reason) return 'fresh'; // nothing to do
    const run = () => {
      // pin BOTH the mem-dir and (when provable) the repo root so the builders cannot re-derive a
      // divergent target from their own cwd/env walk; unproven root -> sandboxed MOC output.
      const env = { ...process.env, MEMSYS_MEM_DIR: memDir };
      const root = repairRootFor(memDir);
      if (root) { env.MEMSYS_ROOT = root; diag(`index-repair root: ${root}`); }
      else diag('index-repair root: none proven -> MOC output sandboxed next to mem-dir');
      cp.execFileSync('node', [mf], { timeout: 20000, stdio: 'pipe', env });     // manifest first (build-mocs reads it)
      cp.execFileSync('node', [mo], { timeout: 20000, stdio: 'pipe', env });
    };
    const res = withRegenLock(path.join(memDir, '_regen.lock'), 90000, run);
    if (res === 'held') { diag(`index-repair skipped: regen lock held (${reason})`); return 'lock-held'; }
    diag(`index-repair ok (${reason})`);
    return 'repaired';
  } catch (e) {
    diag(`repair-failed: ${e && e.message}`); // NEVER fail the oracle on a repair error (default mode)
    return 'failed';
  }
}

// ---- main -------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv.slice(2));
  const diags = [];
  const diag = (m) => { diags.push(m); try { process.stderr.write(`[verify-memory-pass] ${m}\n`); } catch (_) {} };

  // fail-CLOSED helper: exit 1 (no evidence) with a diag note in the JSON notes[] array.
  const noEvidence = (why) => finish(1, false, false, [{ file: '(diag)', ok: false, problems: [why] }], args);

  if (args.unknown.length) return noEvidence(`unknown arg(s): ${args.unknown.join(' ')} — refusing to run a weaker check than the caller intended`);
  if (!args.sid) return noEvidence('missing --sid');
  // --sid alone (no --since at all): find the transcript, since = its first timestamp, and use it for the
  // proportional tier unless --transcript was given. A --since that is present but invalid still fails closed.
  if (!Number.isFinite(args.since) && !process.argv.includes('--since')) {
    const tp = args.transcript || findTranscript(args.sid);
    if (!tp) return noEvidence(`no --since given and no transcript found for sid ${args.sid} under ~/.claude/projects/*/`);
    const first = firstTimestamp(tp);
    if (!Number.isFinite(first)) return noEvidence(`no --since given and no timestamp in ${tp}`);
    args.since = first;
    if (!args.transcript) args.transcript = tp;
    diag(`--sid only: transcript ${tp}, since ${first}`);
  }
  if (!Number.isFinite(args.since)) return noEvidence('missing/invalid --since (epoch ms)');

  const memDir = resolveMemDir(args.memDir);
  if (!memDir) return noEvidence('mem-dir unresolvable (no --mem-dir, no CLAUDE_MEM_DIR, not a git repo)');
  if (!fs.existsSync(memDir)) return noEvidence(`mem-dir not found: ${memDir}`);

  let notes = [];
  try { notes = fs.readdirSync(memDir).filter((f) => f.toLowerCase().endsWith('.md') && f.toUpperCase() !== 'MEMORY.MD'); }
  catch (e) { return noEvidence(`mem-dir unreadable: ${e && e.message}`); }

  // best-effort freshness repair — in default mode a side effect only; cannot change the verdict.
  const repair = maybeRepairIndex(memDir, notes, diag);

  // --strict-index (opt-in): after the repair attempt the index must be fresh, unless a live regen
  // lock (another writer mid-flight) explains the staleness.
  if (args.strictIndex && repair !== 'lock-held') {
    const still = isStale(memDir, notes);
    if (still) {
      return finish(2, false, true,
        [{ file: '(index)', ok: false, problems: [`strict-index: index still stale after repair attempt: ${still}`] }], args);
    }
  }

  // proportionality (v2): --transcript present -> compute workScore; absent -> EXACTLY v1 (required = 1).
  const workScore = args.transcript ? computeWorkScore(args.transcript, memDir, diag) : null;
  const required = requiredFor(workScore || 0);

  // channel B: attribute + window + correctness.
  // Attribution (Q2 update convention): a note CREATED this session carries originSessionId === sid;
  // a note UPDATED this session carries lastSessionId === sid (originSessionId untouched — provenance
  // is never restamped). EITHER credits the session, gated by mtime >= since + correctness.
  const evidenced = [];
  for (const f of notes) {
    const fp = path.join(memDir, f);
    let st, raw;
    try { st = fs.statSync(fp); raw = fs.readFileSync(fp, 'utf8'); } catch (_) { continue; }
    const { fm, body } = parseNote(raw);
    const osid = fm && fm.metadata && fm.metadata.originSessionId;
    const lsid = fm && fm.metadata && fm.metadata.lastSessionId;
    if ((osid === args.sid || lsid === args.sid) && st.mtimeMs >= args.since) {
      const problems = checkNote(fm, body);
      evidenced.push({ file: f, ok: problems.length === 0, problems });
    }
  }

  const evidencedOk = evidenced.filter((n) => n.ok).length;
  const extra = { required, workScore, evidencedOk };

  // NOTHING-DURABLE declaration (v3): a session may legitimately yield no durable memory — but never
  // silently. If the note count would fail, honor a receipt that DECLARES emptiness and shows its work:
  // _gaphunt/<sid>.json with verdict "NOTHING_DURABLE" and a non-empty considered[] where every entry
  // carries {topic, why} (why it is repo-derivable/ephemeral/already-covered). Auditable nothing, not
  // silent nothing — the filler-note pressure and the lazy-skip pressure both die here.
  if (evidencedOk < required) {
    try {
      const rPath = path.join(memDir, '_gaphunt', `${args.sid}.json`);
      const st = fs.statSync(rPath);
      const r = JSON.parse(fs.readFileSync(rPath, 'utf8'));
      const consideredOk = Array.isArray(r.considered) && r.considered.length > 0 &&
        r.considered.every((c) => c && c.topic && c.why);
      if (st.mtimeMs >= args.since && r.sid === args.sid && r.verdict === 'NOTHING_DURABLE' && consideredOk) {
        extra.nothingDurable = r.considered.length;
        return finish(0, true, false, evidenced, args, extra);
      }
    } catch (_) { /* no receipt / unreadable -> fall through to the normal fail paths */ }
  }

  if (evidenced.length === 0) return finish(1, false, false, [], args, extra);
  if (evidenced.some((n) => !n.ok)) return finish(2, false, true, evidenced, args, extra);
  if (evidencedOk < required) return finish(1, false, false, evidenced, args, extra); // PROPORTIONAL shortfall

  // COVERAGE (v3, opt-in --require-gaphunt): note COUNT cannot prove the RIGHT lessons were captured
  // (proven 2026-07-11 and again 2026-07-17: passing wraps with homeless lessons). For LARGE sessions
  // (workScore > 40) the wrap must also evidence a gap-hunt RECEIPT: <memDir>/_gaphunt/<sid>.json,
  // fresh (mtime >= since), sid-matched, with a non-empty lessonsReconstructed[] and a verdict.
  // The receipt is method-agnostic (3-agent workflow OR a documented manual hunt) — what it proves is
  // that reconstruction-vs-brain HAPPENED, not how.
  if (args.requireGaphunt && (workScore || 0) > 40) {
    const rPath = path.join(memDir, '_gaphunt', `${args.sid}.json`);
    let receiptProblem = null;
    try {
      const st = fs.statSync(rPath);
      const r = JSON.parse(fs.readFileSync(rPath, 'utf8'));
      if (st.mtimeMs < args.since) receiptProblem = 'receipt is older than this session segment';
      else if (r.sid !== args.sid) receiptProblem = 'receipt sid mismatch';
      else if (!Array.isArray(r.lessonsReconstructed) || r.lessonsReconstructed.length === 0) receiptProblem = 'receipt has no lessonsReconstructed[]';
      else if (!r.verdict) receiptProblem = 'receipt has no verdict';
    } catch (e) { receiptProblem = `no gap-hunt receipt at _gaphunt/${args.sid}.json (${e && e.code === 'ENOENT' ? 'missing' : e && e.message})`; }
    if (receiptProblem) {
      extra.gaphunt = receiptProblem; // distinct message channel — must not masquerade as a count shortfall
      return finish(1, false, false,
        [...evidenced, { file: `_gaphunt/${args.sid}.json`, ok: false, problems: [`GAP-HUNT (tier 3): ${receiptProblem} — run wrap-up step 4 and write the receipt`] }],
        args, extra);
    }
  }
  return finish(0, true, false, evidenced, args, extra);
}

function finish(code, pass, malformed, notes, args, extra) {
  const x = extra || { required: 1, workScore: null, evidencedOk: 0 };
  if (args.json) {
    process.stdout.write(JSON.stringify({
      pass, notes, since: args.since, malformed,
      required: x.required, workScore: x.workScore, evidencedOk: x.evidencedOk,
    }) + '\n');
  } else {
    if (pass && x.nothingDurable) process.stdout.write(`PASS (NOTHING-DURABLE declared): ${x.nothingDurable} candidate(s) considered + rejected with reasons in _gaphunt/${args.sid}.json — no notes required\n`);
    else if (pass) process.stdout.write(`PASS: ${notes.length} note(s) evidence session ${args.sid} since ${args.since} (required ${x.required})\n`);
    else if (x.gaphunt) {
      process.stdout.write(`GAP-HUNT MISSING (tier 3): ${x.gaphunt} — note count passed (${x.evidencedOk}/${x.required}) but coverage is unproven; run wrap-up step 4 and write _gaphunt/<sid>.json\n`);
    } else if (malformed) {
      process.stdout.write(`MALFORMED: evidenced note(s) fail correctness:\n`);
      for (const n of notes) if (!n.ok) process.stdout.write(`  ${n.file}: ${n.problems.join('; ')}\n`);
    } else if (x.evidencedOk > 0) {
      process.stdout.write(`PROPORTIONAL: ${x.evidencedOk} ok note(s) evidenced, ${x.required} required (work score ${x.workScore})\n`);
    } else {
      const why = notes.length && notes[0].problems ? notes[0].problems.join('; ') : 'no evidenced note for this session segment';
      process.stdout.write(`NO EVIDENCE: ${why}\n`);
    }
  }
  process.exit(code);
}

try { main(); } catch (e) {
  // absolute top-level guard: fail-CLOSED (no evidence) but NEVER throw.
  try { process.stderr.write(`[verify-memory-pass] fatal (fail-closed to exit 1): ${e && e.message}\n`); } catch (_) {}
  process.exit(1);
}
