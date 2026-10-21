#!/usr/bin/env node
// block-commit-without-memory.js — WS-E memory-pass enforcement, COMMIT tier. PreToolUse(Bash|PowerShell).
//
// Closes the "commit the work, never record the lesson" gap: a git commit that lands NON-trivial work
// should be accompanied by a memory pass for the same segment. The evidence oracle
// (Code/memory-system/verify-memory-pass.mjs) decides whether a pass exists; this hook just gates on it.
//
// ENGAGEMENT LADDER (first miss on any rung -> SILENT allow; only a genuine "committed real work with no
// memory pass" reaches the block):
//   (a) the command is a REAL git commit (excludes --dry-run / --amend / --no-verify / -n)
//   (b) repo is memory-ENABLED: mem-dir resolves AND the oracle file exists (else silent pass — never
//       demand impossible actions in a foreign repo)
//   (c) the staged diff is NON-trivial: `git diff --cached --numstat` (5s); if the command carries a
//       ` -- <paths>` pathspec the diff is scoped to it; trivial = <=25 changed lines AND <=3 files
//       (env MEMGATE_TRIVIAL_LINES / MEMGATE_TRIVIAL_FILES) -> pass
//   (d) NOT memory-housekeeping: if EVERY staged path is under memory/ | _MOC-*.md | MEMORY.md | logs/ |
//       goals/ -> pass (a memory/bookkeeping commit is not itself gated)
//   (e) a fresh pass-marker ~/.claude/memory-pass/<sid>.json with ts >= segmentStart -> allow
//   (f) shell to the oracle with --since=segmentStart; exit 0 -> allow AND write the pass-marker
//   (g) DEVIATION-JUSTIFIED: in the command or the last assistant message -> allow + audit
//
// segmentStart = timestamp of the LAST git-commit tool_use already in the transcript (read only for the
// boundary ts — this is NOT channel-A evidence), else the transcript's first timestamp, else 0.
//
// MODE (non-negotiable): DIAGNOSTIC / LOG-ONLY by default — every would-be decision is audited as
// WOULD-BLOCK and the tool is ALLOWED. It only DENIES when env MEMGATE_ENFORCE === '1'. Fail-OPEN on any
// internal error (allow). Tag [mem-commit-gate].

'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const HOME = (os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
const AUDIT = `${HOME}/.claude/hook-audit.log`;
const ENFORCE = process.env.MEMGATE_ENFORCE === '1';
const TRIVIAL_LINES = Number(process.env.MEMGATE_TRIVIAL_LINES) || 25;
const TRIVIAL_FILES = Number(process.env.MEMGATE_TRIVIAL_FILES) || 3;
const MARKER_DIR = `${HOME}/.claude/memory-pass`;

const repoSlug = (p) => String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, '').replace(/[^A-Za-z0-9]/g, '-');
const normDir = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');

function audit(line) { try { fs.appendFileSync(AUDIT, `[${new Date().toISOString()}] [mem-commit-gate] ${line}\n`); } catch (_) {} }
function passSilently() { process.exit(0); }              // not engaged (cheap path, no log)
function allow(reason) { audit(`ALLOW: ${reason}`); process.exit(0); }
function deny(reason) {
  audit(`BLOCK: ${String(reason).slice(0, 160)}`);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
  process.exit(0);
}
// engagement: enforce -> deny; diag -> audit WOULD-BLOCK + allow.
function engageBlock(reason, detail) {
  if (ENFORCE) return deny(reason);
  audit(`WOULD-BLOCK: ${detail || String(reason).slice(0, 160)}`);
  process.exit(0);
}

// ---- git commit detection ---------------------------------------------------
// a real `git ... commit` subcommand (allow leading -C/-c/flags between git and commit)
const COMMIT_RE = /(?:^|[;&|(]|\s)git\s+(?:-C\s+\S+\s+|-c\s+\S+\s+|--?\S+\s+)*commit(?=\s|$)/i;
// flags that mean "not a fresh work-recording commit" -> exclude
const COMMIT_EXCLUDE_RE = /--dry-run|--amend|--no-verify|(?:^|\s)-n(?=\s|$)/i;
const DEVIATION_RE = /DEVIATION-?JUSTIFIED\s*:/i;
// housekeeping staged paths (repo-relative, forward slash)
const HOUSEKEEPING_RE = /^(memory\/|_MOC-[a-z]+\.md$|MEMORY\.md$|logs\/|goals\/)/i;

// ---- resolution (mirror the oracle's contract) ------------------------------
function resolveRepoRoot(cwd) {
  try {
    const top = cp.execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: cwd || process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (top) return normDir(top);
  } catch (_) { /* not a repo */ }
  if (process.env.CLAUDE_PROJECT_DIR) return normDir(process.env.CLAUDE_PROJECT_DIR);
  return normDir(cwd || process.cwd());
}
// lib-workspace (same folder): any cwd resolves to the ace brain. Missing lib -> legacy (fail-open).
let LW = null; try { LW = require('./lib-workspace.js'); } catch (_) {}
function resolveWs(cwd) { try { return LW ? LW.resolveWorkspace({ cwd, env: process.env }) : null; } catch (_) { return null; } }
// memory dir: explicit env first, then lib-workspace, then the legacy cwd-repo slug.
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

// ---- pass-marker ------------------------------------------------------------
// Q7: markers carry { sid, ts, oracle:'pass', notes:[...] } and are VALIDATED on read
// (mk.sid === sid && mk.oracle === 'pass') — a marker file's mere existence is not credit.
function markerPath(sid) { return `${MARKER_DIR}/${String(sid).replace(/[^A-Za-z0-9._-]/g, '_')}.json`; }
function readMarker(sid) { try { return JSON.parse(fs.readFileSync(markerPath(sid), 'utf8')); } catch (_) { return null; } }
function markerValid(mk, sid) { return !!(mk && mk.sid === sid && mk.oracle === 'pass' && Number.isFinite(mk.ts)); }
function writeMarker(sid, oracle, notes) {
  try { fs.mkdirSync(MARKER_DIR, { recursive: true }); fs.writeFileSync(markerPath(sid), JSON.stringify({ sid, ts: Date.now(), oracle, notes: Array.isArray(notes) ? notes : [] })); } catch (_) {}
}

// ---- transcript helpers -----------------------------------------------------
function parseObjs(tp) {
  try {
    return fs.readFileSync(tp, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}
function tsMs(o) { const t = o && o.timestamp; const n = t ? Date.parse(t) : NaN; return Number.isFinite(n) ? n : NaN; }
// segmentStart = ts of the last git-commit tool_use in transcript, else first timestamp, else 0.
function segmentStart(objs) {
  let firstTs = 0;
  for (const o of objs) { const n = tsMs(o); if (Number.isFinite(n)) { firstTs = n; break; } }
  let lastCommit = 0;
  for (const o of objs) {
    if (o.type !== 'assistant' || !o.message || !Array.isArray(o.message.content)) continue;
    for (const b of o.message.content) {
      if (b.type !== 'tool_use' || (b.name !== 'Bash' && b.name !== 'PowerShell')) continue;
      const c = String((b.input && b.input.command) || '');
      if (COMMIT_RE.test(c) && !COMMIT_EXCLUDE_RE.test(c)) { const n = tsMs(o); if (Number.isFinite(n) && n > lastCommit) lastCommit = n; }
    }
  }
  return lastCommit || firstTs || 0;
}
function lastAssistantText(objs) {
  for (let i = objs.length - 1; i >= 0 && i >= objs.length - 6; i--) {
    const o = objs[i];
    if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
      const t = o.message.content.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text).join('\n');
      if (t) return t;
    }
  }
  return '';
}

// ---- staged diff ------------------------------------------------------------
// pull a ` -- <paths>` pathspec off the commit command (up to the next shell separator).
function extractPathspec(cmd) {
  const m = cmd.match(/\s--\s+([^\n;&|]+)/);
  if (!m) return [];
  const rest = m[1].trim();
  if (!rest) return [];
  const toks = [];
  const re = /"([^"]+)"|'([^']+)'|(\S+)/g; let x;
  while ((x = re.exec(rest)) !== null) toks.push(x[1] || x[2] || x[3]);
  return toks;
}
// returns { files, changed, paths } or null on git error (fail-open).
function stagedStats(cwd, pathspec) {
  const args = ['diff', '--cached', '--numstat'];
  if (pathspec.length) args.push('--', ...pathspec);
  let r;
  try { r = cp.spawnSync('git', args, { cwd, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (_) { return null; }
  if (!r || r.status !== 0 || r.stdout == null) return null;
  const lines = r.stdout.toString().split('\n').filter((l) => l.trim());
  let files = 0, changed = 0; const paths = [];
  for (const l of lines) {
    const m = l.match(/^(\S+)\t(\S+)\t(.+)$/);
    if (!m) continue;
    files++;
    const add = m[1] === '-' ? 0 : (parseInt(m[1], 10) || 0);
    const del = m[2] === '-' ? 0 : (parseInt(m[2], 10) || 0);
    changed += add + del;
    let p = m[3];
    // rename form: "old => new" or "dir/{old => new}/f" — take the resulting path best-effort
    if (p.includes('=>')) p = p.replace(/\{[^}]*=>\s*([^}]*)\}/g, '$1').replace(/^.*=>\s*/, '').trim();
    paths.push(p.replace(/\\/g, '/'));
  }
  return { files, changed, paths };
}

// ---- oracle -----------------------------------------------------------------
// returns { status, notes } (status 0/1/2, notes = evidencing filenames) or null on spawn error (fail-open).
function runOracle(oracle, sid, memDir, since) {
  let r;
  try { r = cp.spawnSync('node', [oracle, '--sid', sid, '--mem-dir', memDir, '--since', String(since), '--json'], { timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (_) { return null; }
  if (!r || r.error || typeof r.status !== 'number') return null;
  let notes = [];
  try { const j = JSON.parse(String(r.stdout || '')); if (j && Array.isArray(j.notes)) notes = j.notes.map((n) => n && n.file).filter(Boolean); } catch (_) {}
  return { status: r.status, notes };
}

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(data || '{}'); } catch (_) { return passSilently(); }
  try {
    const tool = input.tool_name || '';
    if (tool !== 'Bash' && tool !== 'PowerShell') return passSilently();
    const cmd = String((input.tool_input && input.tool_input.command) || '');
    if (!cmd) return passSilently();

    // (a) a real git commit?
    if (!COMMIT_RE.test(cmd) || COMMIT_EXCLUDE_RE.test(cmd)) return passSilently();

    const sid = input.session_id || input.sessionId || '';
    if (!sid) return allow('no session_id (fail-open)');
    const cwd = normDir(input.cwd || process.cwd());
    const repoRoot = resolveRepoRoot(cwd);

    // (b) memory-ENABLED? mem-dir resolves AND oracle exists.
    const ws = resolveWs(cwd);
    // engage only for commits IN the ace repo: lib-workspace finds the ace brain from any folder, but a commit in
    // an unrelated repo is not ace work (and would cost a transcript parse + an oracle run per commit).
    if (ws && ws.aceRoot && normDir(repoRoot).toLowerCase() !== normDir(ws.aceRoot).toLowerCase()) return passSilently();
    const memDir = resolveMemDir(ws, repoRoot);
    const oracle = oraclePath(ws, repoRoot);
    if (!memDir || !fs.existsSync(memDir) || !oracle || !fs.existsSync(oracle)) {
      return passSilently(); // foreign / non-memory repo — never demand impossible actions
    }

    // (c) non-trivial staged diff?
    const pathspec = extractPathspec(cmd);
    const stats = stagedStats(cwd, pathspec);
    if (!stats) return allow('staged diff unavailable (fail-open)');
    if (stats.files === 0) return allow('nothing staged');
    if (stats.changed <= TRIVIAL_LINES && stats.files <= TRIVIAL_FILES) {
      return allow(`trivial diff (${stats.files}f/${stats.changed}L <= ${TRIVIAL_FILES}f/${TRIVIAL_LINES}L)`);
    }

    // (d) memory-housekeeping-only?
    if (stats.paths.length && stats.paths.every((p) => HOUSEKEEPING_RE.test(p))) {
      return allow(`housekeeping-only paths (${stats.paths.length})`);
    }

    // Q11: parse the transcript ONCE and reuse — segmentStart needs the whole parse; the
    // lastAssistantText deviation check reuses the same objects (it only inspects the last
    // few entries), so the 10-90MB file is never read a second time.
    const objs = parseObjs(input.transcript_path || '');
    const start = segmentStart(objs);

    // (e) fresh VALID pass-marker? (Q7: sid + oracle:'pass' must match — existence is not credit)
    const mk = readMarker(sid);
    if (markerValid(mk, sid) && mk.ts >= start) return allow(`fresh pass-marker (ts=${mk.ts} >= segmentStart=${start})`);

    // (f) oracle says a pass is evidenced?
    const orc = runOracle(oracle, sid, memDir, start);
    if (orc === null) return allow('oracle unavailable (fail-open)');
    if (orc.status === 0) { writeMarker(sid, 'pass', orc.notes); return allow('oracle: memory pass evidenced'); }

    // (g) explicit deviation?
    if (DEVIATION_RE.test(cmd)) return allow('DEVIATION-JUSTIFIED in command');
    const lastText = lastAssistantText(objs);
    if (DEVIATION_RE.test(lastText)) return allow('DEVIATION-JUSTIFIED in last assistant message');

    // engage
    const oracleWord = orc.status === 2 ? 'a note WAS written but it is MALFORMED' : 'NO memory pass is evidenced';
    const detail = `sid=${String(sid).slice(0, 8)} files=${stats.files} lines=${stats.changed} oracle=${orc.status} since=${start}`;
    return engageBlock(
      `Memory-commit gate: you are committing NON-trivial work (${stats.files} file(s), ${stats.changed} changed line(s)) ` +
      `but ${oracleWord} for this segment.\n\n` +
      `Do the memory pass BEFORE this commit (3 steps):\n` +
      `  1. node "$HOME/ace/Code/memory-system/recall.mjs" "<topic>"   — dedup / find the note to update\n` +
      `  2. write or update an ATOMIC note in the memory dir with frontmatter (name / description / ` +
      `metadata.type: user|feedback|project|reference). Attribution: on a NEW note stamp ` +
      `metadata.originSessionId: ${sid}; on an UPDATED note set metadata.lastSessionId: ${sid} ` +
      `and leave originSessionId untouched (it records the creating session) — the gate credits either.\n` +
      `  3. node "$HOME/ace/Code/memory-system/reindex.mjs"\n\n` +
      `Then retry the commit. If this commit genuinely records no durable lesson, add ` +
      `"DEVIATION-JUSTIFIED: <reason>" to the command (or your message) and it will pass (and be logged).`,
      detail
    );
  } catch (err) {
    return allow(`unexpected error (fail-open): ${err && err.message}`);
  }
});
