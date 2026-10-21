#!/usr/bin/env node
// block-unkeyed-temp-log.js — WS-D (multi-session concurrency), PROJECT layer. PreToolUse.
//
// Enforces the per-session temp-log convention: every write to logs/temp/*.md must land in a
// file whose name ends in "-<sid8>.md" for THIS session (sid8 = session_id[:8], injected by
// session-init.js). One shared logs/temp/{project}-{user}-{date}.md file across parallel sessions
// is the collision point WS-D exists to kill — so an UNKEYED temp-log write (no sid8, or another
// session's sid8) is what this gate catches.
//
// Coverage:
//   (a) Write | Edit | MultiEdit whose target file_path normalizes under <ws>/logs/temp/*.md
//       (excludes the _mine-digests/ subdir and non-.md files like .gitkeep).
//   (b) Bash | PowerShell commands that WRITE to such a path — the 'Bash-dodge' channel (audit G3):
//       redirect (> / >>), tee, Set-Content, Add-Content, Out-File onto a logs/temp/*.md path.
//
// Modes (fail-OPEN, DIAG by default — a bug must NEVER block a real session):
//   DIAG (default)               : audit '[temp-log-key] WOULD-BLOCK <file>' and ALLOW.
//   ENFORCE (ACE_MULTISESSION_ENFORCE==='1'): deny with the corrected filename.
//   missing session_id / any error / correctly-keyed / not-a-temp-log : ALLOW silently.
//
// Self-contained: inlines a small lexical normPath (does NOT require the global lib-concurrency).
// Mirrors the house hook skeleton (block-undocumented-launch / block-memory-md-too-large).

'use strict';
const fs = require('node:fs');
const os = require('node:os');

const ENFORCE = process.env.ACE_MULTISESSION_ENFORCE === '1';
const HOME = (os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
const AUDIT = `${HOME}/.claude/hook-audit.log`;

function audit(line) {
  try { fs.appendFileSync(AUDIT, `[${new Date().toISOString()}] [temp-log-key] ${line}\n`); } catch (_) {}
}
function allow() { process.exit(0); }                 // silent pass (fail-open / keyed / N/A)
function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
  process.exit(0);
}

// --- inline lexical normPath: backslash->slash, git-bash /c/ -> c:/, lowercase drive, collapse
//     dup slashes, strip trailing slash, lowercase whole (temp-log matching is case-insensitive). ---
function normPath(p) {
  let s = String(p == null ? '' : p).replace(/\\/g, '/');
  s = s.replace(/^\/([a-zA-Z])\//, (m, d) => `${d.toLowerCase()}:/`); // /c/x -> c:/x
  s = s.replace(/^([a-zA-Z]):/, (m, d) => `${d.toLowerCase()}:`);     // C: -> c:
  s = s.replace(/\/{2,}/g, '/');                                       // collapse //
  if (s.length > 1) s = s.replace(/\/+$/, '');                         // strip trailing /
  return s.toLowerCase();
}

// A normalized path is a gated temp-log iff it's under .../logs/temp/, ends .md, and is not
// in the _mine-digests/ subdir. (.gitkeep is auto-excluded by the .md requirement.)
function isTempLog(np) {
  // Anchor at start-or-slash so RELATIVE shell paths (logs/temp/x.md, common in Bash|PowerShell
  // whose cwd is the workspace root) match too — not just absolute Write/Edit file_paths.
  if (!/(?:^|\/)logs\/temp\//.test(np)) return false;
  if (/(?:^|\/)logs\/temp\/_mine-digests\//.test(np)) return false;
  if (!np.endsWith('.md')) return false;
  const base = np.slice(np.lastIndexOf('/') + 1);
  if (base === '.gitkeep') return false;
  return true;
}

// Correctly keyed iff the filename (sans .md) ends with "-<sid8>" (case-insensitive).
function isKeyed(np, sid8) {
  const base = np.slice(np.lastIndexOf('/') + 1).replace(/\.md$/, '');
  return base.endsWith('-' + sid8.toLowerCase());
}

// Build the corrected filename: strip a trailing sid-shaped "-<8 hex>" (another session's key or
// a stray one) if present, then append this session's "-<sid8>.md".
function correctedName(np, sid8) {
  const base = np.slice(np.lastIndexOf('/') + 1).replace(/\.md$/, '');
  const stem = base.replace(/-[0-9a-f]{8}$/i, '');
  return `${stem}-${sid8}.md`;
}

// Pull a logs/temp/*.md path OUT of a shell command, but only when a WRITE verb targets it
// (redirect / tee / Set-Content / Add-Content / Out-File) — a bare `cat logs/temp/x.md` read
// must not trip the gate. Returns the first matched raw path, or ''.
function extractShellTempLog(cmd) {
  const PATH = `([^\\s"'|>&;]*logs[\\/\\\\]temp[\\/\\\\][^\\s"'|>&;]*\\.md)`;
  const WRITERS = [
    new RegExp(`(?:>>?|1>>?|2>>?)\\s*["']?${PATH}`, 'i'),                                  // echo … > / >>
    new RegExp(`\\btee\\b(?:\\s+-a\\b)?\\s+["']?${PATH}`, 'i'),                             // tee [-a] path
    new RegExp(`(?:Set-Content|Add-Content|Out-File)\\b[^|>&;]*?["']?${PATH}`, 'i'),        // PS cmdlets
  ];
  for (const re of WRITERS) {
    const m = cmd.match(re);
    if (m && m[1]) return m[1];
  }
  return '';
}

let data = '';
process.stdin.on('data', c => (data += c));
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(data || '{}'); } catch (_) { return allow(); }
  try {
    const sid = (input.session_id || '').trim();
    if (!sid) return allow();               // fail-open: no session identity, can't key
    const sid8 = sid.slice(0, 8);
    const tool = input.tool_name || '';
    const ti = input.tool_input || {};

    // Resolve the target temp-log path per tool class.
    let raw = '';
    if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit') {
      raw = ti.file_path || '';
    } else if (tool === 'Bash' || tool === 'PowerShell') {
      raw = extractShellTempLog(ti.command || '');
    } else {
      return allow();                       // tool out of scope
    }
    if (!raw) return allow();

    const np = normPath(raw);
    if (!isTempLog(np)) return allow();     // not a gated temp-log write
    if (isKeyed(np, sid8)) return allow();  // already this session's file — fine

    // Unkeyed (or wrong-session) temp-log write.
    const fname = np.slice(np.lastIndexOf('/') + 1);
    const corrected = correctedName(np, sid8);
    if (!ENFORCE) {
      audit(`WOULD-BLOCK ${fname} (sid8=${sid8}, want ${corrected})`);
      return allow();
    }
    audit(`BLOCK ${fname} -> ${corrected} (sid8=${sid8})`);
    return deny(
      `Temp-log must be per-session: "${fname}" is not keyed to THIS session (sid8=${sid8}). ` +
      `Write to "${corrected}" instead (the filename must end in -${sid8}.md so parallel ` +
      `sessions never clobber a shared logs/temp file).`
    );
  } catch (err) {
    audit(`ALLOW: unexpected error (fail-open): ${err && err.message}`);
    process.exit(0);
  }
});
