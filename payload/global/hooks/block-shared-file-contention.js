#!/usr/bin/env node
// block-shared-file-contention.js — WS-D (multi-session concurrency), GLOBAL layer.
// PreToolUse(Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell).
//
// Serializes writes to SHARED, contention-prone files when TWO OR MORE ace sessions are live in the
// SAME workspace. Session identity = hook-stdin session_id; liveness = session heartbeat files (see
// lib-concurrency.liveSessions). SOLO sessions (zero other live co-resident sessions) are the common
// case and pass with ZERO friction — this hook only engages under real concurrency.
//
// Two contention tiers:
//   HARD-LEASE (serialize via lib-concurrency.acquireLease):
//     - memory notes:  ~/.claude/projects/<slug>/memory/<x>.md  AND the repo-junction spelling
//                      <root>/memory/<x>.md  (same file, two names — matched by either spelling)
//     - MEMORY.md      (any project's router file)
//     - repo-root _MOC-*.md
//     A full-overwrite `Write` to MEMORY.md under concurrency is refused outright (Edit-only, so a
//     stale base fails loudly instead of silently clobbering the other session's index). Otherwise a
//     lease is taken; if a DIFFERENT live session already holds it, the write is bounced with the
//     exact corrective action (re-read then retry).
//   ADVISORY-ONLY (audit + ALLOW, never denied — even under enforce):
//     - **/status.md, **/tasks-inbox.md, **/goals/*.y(a)ml, **/logs/session-log-*.md
//
// Bash|PowerShell coverage (audit finding G3 — the "shell dodge"): a shell write ( > , >> ,
// Set-Content, Add-Content, Out-File, tee, sed -i, fs.writeFile*/appendFile* ) whose TARGET is a
// HARD-LEASE path gets the same treatment as the equivalent Write/Edit, so a session can't sidestep
// the gate by shelling out. Extraction is writer-verb-TIED (Q5): a protected path that is merely
// READ in a command with an unrelated redirect does NOT engage the gate.
//
// MODE (non-negotiable): DIAGNOSTIC / LOG-ONLY by default. Every would-be decision is written to
// ~/.claude/hook-audit.log under [file-lease] and the tool is ALLOWED. It only actually DENIES when
// env ACE_MULTISESSION_ENFORCE === '1'. Fail-OPEN on any internal error (allow). A bug here must
// never block a real session.

'use strict';
const fs = require('node:fs');
const os = require('node:os');
const { normPath, liveSessions, acquireLease } = require('./lib-concurrency.js');

const HOME = (os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
const AUDIT = `${HOME}/.claude/hook-audit.log`;
const ENFORCE = process.env.ACE_MULTISESSION_ENFORCE === '1';

function audit(line) {
  try { fs.appendFileSync(AUDIT, `[${new Date().toISOString()}] [file-lease] ${line}\n`); } catch (_) {}
}
function allow() { process.exit(0); } // silent allow (no engagement)
function deny(reason) {
  audit(`BLOCK: ${String(reason).slice(0, 200)}`);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
  process.exit(0);
}
// Engagement point: enforce -> deny; diag -> audit WOULD-BLOCK and allow.
function block(reason, detail) {
  if (ENFORCE) return deny(reason);
  audit(`WOULD-BLOCK: ${detail || String(reason).slice(0, 200)}`);
  process.exit(0);
}

// ---- path classification (operates on a normPath'd string) -------------------
// MEMORY.md lives INSIDE the memory dir (<root>/memory/MEMORY.md), so check it BEFORE the note rule.
const RE_MEMORY_MD  = /\/MEMORY\.md$/;                 // the router file (uppercase, any project)
const RE_MEM_NOTE   = /\/memory\/[^/]+\.md$/i;         // covers BOTH .claude/projects/<slug>/memory/x.md AND <root>/memory/x.md
const RE_MOC        = /\/_MOC-[^/]+\.md$/i;            // repo-root _MOC-*.md
const RE_STATUS     = /\/status\.md$/i;
const RE_TASKS      = /\/tasks-inbox\.md$/i;
const RE_GOALS_YAML = /\/goals\/[^/]+\.ya?ml$/i;
const RE_SESSIONLOG = /\/logs\/session-log-[^/]*\.md$/i;

// returns { tier:'hard'|'advisory'|null, kind, isMemoryMd }
function classify(normalized) {
  if (RE_MEMORY_MD.test(normalized)) return { tier: 'hard', kind: 'MEMORY.md', isMemoryMd: true };
  if (RE_MEM_NOTE.test(normalized))  return { tier: 'hard', kind: 'memory-note', isMemoryMd: false };
  if (RE_MOC.test(normalized))       return { tier: 'hard', kind: '_MOC', isMemoryMd: false };
  if (RE_STATUS.test(normalized))     return { tier: 'advisory', kind: 'status.md', isMemoryMd: false };
  if (RE_TASKS.test(normalized))      return { tier: 'advisory', kind: 'tasks-inbox.md', isMemoryMd: false };
  if (RE_GOALS_YAML.test(normalized)) return { tier: 'advisory', kind: 'goals-yaml', isMemoryMd: false };
  if (RE_SESSIONLOG.test(normalized)) return { tier: 'advisory', kind: 'session-log', isMemoryMd: false };
  return { tier: null, kind: null, isMemoryMd: false };
}

// ---- shell write-target extraction (Bash|PowerShell) -------------------------
// Q5 fix (audit 2026-07-07): writer-verb-TIED extraction, mirroring block-unkeyed-temp-log.js.
// Before this, ANY write operator anywhere in the command tied ANY .md token to a lease
// (`grep x note.md > /tmp/out` was treated as a write to note.md). Now a path only counts when it
// is the TARGET of a write verb: redirect (> / >> / 1> / 2>), tee [-a], Set-Content / Add-Content /
// Out-File, sed -i, fs.writeFile*/appendFile*. Leases are only acquired for these actual targets.
// Returns [{ path, append }] — `append` distinguishes append vs truncate for the MEMORY.md rule.
const SHELL_TOK = `"([^"]+)"|'([^']+)'|([^\\s"'<>|;&()]+)`;
function extractShellWriteTargets(cmd) {
  const s = String(cmd || '');
  const out = [];
  const push = (m, i, append) => { const p = m[i] || m[i + 1] || m[i + 2] || ''; if (p) out.push({ path: p, append }); };
  let m;
  // redirects: > >> 1> 1>> 2> 2>>  (target = the very next token)
  const reRedir = new RegExp(`(\\d?>>|\\d?>)\\s*(?:${SHELL_TOK})`, 'g');
  while ((m = reRedir.exec(s)) !== null) push(m, 2, m[1].includes('>>'));
  // tee [-a|--append] <target>
  const reTee = new RegExp(`\\btee\\b\\s+(?:(-a|--append)\\s+)?(?:${SHELL_TOK})`, 'gi');
  while ((m = reTee.exec(s)) !== null) push(m, 2, !!m[1]);
  // PS cmdlets: the tracked-file token must appear in the cmdlet's OWN argument segment.
  // Set-Content / Out-File truncate (unless -Append); Add-Content appends.
  const rePS = /\b(Set-Content|Out-File|Add-Content)\b([^|;&\n]*)/gi;
  while ((m = rePS.exec(s)) !== null) {
    const isAppend = /^add-content$/i.test(m[1]) || /-Append\b/i.test(m[2]);
    const seg = new RegExp(SHELL_TOK, 'g');
    let t;
    while ((t = seg.exec(m[2])) !== null) {
      const tok = t[1] || t[2] || t[3] || '';
      if (/\.(md|ya?ml)$/i.test(tok)) out.push({ path: tok, append: isAppend });
    }
  }
  // sed -i (in-place edit): tracked-file token within the sed segment is the target.
  const reSed = /\bsed\b([^|;&\n]*\s-i\b[^|;&\n]*)/gi;
  while ((m = reSed.exec(s)) !== null) {
    const seg = new RegExp(SHELL_TOK, 'g');
    let t;
    while ((t = seg.exec(m[1])) !== null) {
      const tok = t[1] || t[2] || t[3] || '';
      if (/\.(md|ya?ml)$/i.test(tok)) out.push({ path: tok, append: false }); // in-place rewrite = not an append
    }
  }
  // node -e inline fs writes: first string arg is the target.
  const reFs = /\bfs\.(writeFile|writeFileSync|appendFile|appendFileSync)\s*\(\s*["'`]([^"'`]+)["'`]/g;
  while ((m = reFs.exec(s)) !== null) out.push({ path: m[2], append: /^append/i.test(m[1]) });
  return out;
}

let data = '';
process.stdin.on('data', c => (data += c));
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(data || '{}'); } catch (_) { return allow(); }
  try {
    const tool = input.tool_name || '';
    const sid = input.session_id || input.sessionId || '';
    const cwd = input.cwd || process.cwd() || '';
    const ti = input.tool_input || {};

    const isFileTool  = tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit'; // Q6: MultiEdit covered
    const isShellTool = tool === 'Bash' || tool === 'PowerShell';
    if (!isFileTool && !isShellTool) return allow();

    // Zero-friction solo path: no OTHER live co-resident session -> never engage.
    let others = [];
    try { others = liveSessions(cwd, sid); } catch (_) { others = []; }
    if (!others.length) return allow();

    const sid8 = String(sid).slice(0, 8);

    if (isFileTool) {
      const target = ti.file_path || ti.notebook_path || '';
      if (!target) return allow();
      const norm = normPath(target);
      const cls = classify(norm);
      if (!cls.tier) return allow();

      if (cls.tier === 'advisory') {
        audit(`ADVISORY: ${sid8} ${tool} ${cls.kind} ${norm} (${others.length} co-live) — allowed`);
        return allow();
      }
      // HARD tier.
      // Full-overwrite Write to MEMORY.md under concurrency -> refuse (Edit-only).
      if (cls.isMemoryMd && tool === 'Write') {
        return block(
          `Multi-session contention: a full-overwrite Write to MEMORY.md is refused while ${others.length} other session(s) are live in this workspace. ` +
          `Use Edit on MEMORY.md (a targeted Edit fails loudly on a stale base instead of silently clobbering the other session's index).`,
          `${sid8} Write MEMORY.md ${norm} (${others.length} co-live)`
        );
      }
      // Otherwise take a lease.
      let holder = null;
      try { holder = acquireLease(norm, sid); } catch (_) { holder = null; }
      if (holder && holder !== sid) {
        const h8 = String(holder).slice(0, 8);
        return block(
          `Multi-session contention: session ${h8} holds the lease on ${cls.kind} (${norm}). Re-read the file, then retry your ${tool}.`,
          `${sid8} ${tool} ${cls.kind} held-by ${h8} ${norm}`
        );
      }
      return allow(); // acquired (or fail-open) -> proceed
    }

    // ---- shell tool ----
    const cmd = (ti.command || '') + '';
    if (!cmd) return allow();
    // Q5: only writer-verb TARGETS are considered (and leases only acquired for those).
    const targets = extractShellWriteTargets(cmd);
    if (!targets.length) return allow();
    for (const tgt of targets) {
      const tok = tgt.path;
      if (!/\.(md|ya?ml)$/i.test(tok)) continue; // only tracked-file shapes matter
      // resolve relative to cwd for classification
      const isAbs = /^[a-zA-Z]:[\\/]/.test(tok) || tok.startsWith('/') || tok.startsWith('\\');
      const abs = isAbs ? tok : `${cwd}/${tok}`;
      const norm = normPath(abs);
      const cls = classify(norm);
      if (!cls.tier) continue;
      if (cls.tier === 'advisory') {
        audit(`ADVISORY: ${sid8} shell-write ${cls.kind} ${norm} (${others.length} co-live) — allowed`);
        continue;
      }
      // HARD tier via shell.
      if (cls.isMemoryMd && !tgt.append) {
        return block(
          `Multi-session contention: a truncating shell write to MEMORY.md is refused while ${others.length} other session(s) are live. ` +
          `Use an Edit on MEMORY.md instead of a shell overwrite (a targeted Edit fails loudly on a stale base instead of clobbering the other session's index).`,
          `${sid8} shell-overwrite MEMORY.md ${norm} (${others.length} co-live)`
        );
      }
      let holder = null;
      try { holder = acquireLease(norm, sid); } catch (_) { holder = null; }
      if (holder && holder !== sid) {
        const h8 = String(holder).slice(0, 8);
        return block(
          `Multi-session contention: session ${h8} holds the lease on ${cls.kind} (${norm}). Re-read the file, then retry (or write via Edit).`,
          `${sid8} shell-write ${cls.kind} held-by ${h8} ${norm}`
        );
      }
    }
    return allow();
  } catch (err) {
    audit(`ALLOW: unexpected error (fail-open): ${err && err.message}`);
    process.exit(0);
  }
});
