#!/usr/bin/env node
// block-git-add-sweep.js — WS-D (multi-session concurrency), GLOBAL layer. PreToolUse(Bash|PowerShell).
//
// The shared git INDEX is the real cross-session hazard (audit finding, critique-v2 #2): two live ace
// sessions in the same working tree share ONE index, so a sweep-stage ( git add -A / --all / . ) or a
// stage-and-commit-all ( git commit -a / -am ) — and even a bare `git commit` that isn't pathspec-scoped
// — will fold the OTHER session's staged / working WIP into this session's commit. The fix is to make a
// commit take ONLY named paths: `git commit -m "…" -- <paths>`.
//
// ENGAGES only when >=2 live co-resident sessions (self + >=1 other). SOLO sessions pass with zero
// friction. Under concurrency it flags:
//   - git add -A | --all | .            (sweep staging of the shared index)
//   - git commit -a | -am              (stage-all + commit)
//   - a plain `git commit` that is NOT pathspec-scoped (no ` -- <paths>`) and is not --amend
// Every other git usage is untouched.
//
// MODE (non-negotiable): DIAGNOSTIC / LOG-ONLY by default — audits the would-be decision to
// ~/.claude/hook-audit.log under [git-sweep] and ALLOWS. It only DENIES when env
// ACE_MULTISESSION_ENFORCE === '1'. Fail-OPEN on any internal error (allow).

'use strict';
const fs = require('node:fs');
const os = require('node:os');
const { liveSessions } = require('./lib-concurrency.js');

const HOME = (os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
const AUDIT = `${HOME}/.claude/hook-audit.log`;
const ENFORCE = process.env.ACE_MULTISESSION_ENFORCE === '1';

function audit(line) {
  try { fs.appendFileSync(AUDIT, `[${new Date().toISOString()}] [git-sweep] ${line}\n`); } catch (_) {}
}
function allow() { process.exit(0); }
function deny(reason) {
  audit(`BLOCK: ${String(reason).slice(0, 200)}`);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
  process.exit(0);
}
function block(reason, detail) {
  if (ENFORCE) return deny(reason);
  audit(`WOULD-BLOCK: ${detail || String(reason).slice(0, 200)}`);
  process.exit(0);
}

// Q4 fix (audit 2026-07-07): match on a QUOTE-STRIPPED command, and anchor the `git` invocation at a
// real command boundary (start of string/line, or after ; & | ( ). Before this, text INSIDE quoted
// strings tripped the gate — `git commit -m "never use git add -A" -- x` was DENIED — and
// `echo git add -A` matched via the bare \b boundary.
// Quoted spans are replaced with a neutral token (not removed) so a quoted pathspec after ` -- `
// still counts as scoping.
function stripQuoted(cmd) {
  return String(cmd).replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, 'Q');
}
// A `git` invocation must sit at a command boundary.
const GIT_AT_BOUNDARY = '(?:^|[\\n;&|(])\\s*git\\s+';
// A `git add` that sweeps the whole index: -A, --all, or a bare `.` pathspec.
const ADD_SWEEP_RE = new RegExp(GIT_AT_BOUNDARY + 'add\\b(?=[^\\n;&|]*\\s(?:-A\\b|--all\\b|\\.(?:\\s|$)))', 'i');
// Any `git commit` invocation.
const COMMIT_RE = new RegExp(GIT_AT_BOUNDARY + 'commit\\b', 'i');
// `git commit -a` / `-am` / `-ma` / `--all` (stage-all + commit) — only meaningful for messaging;
// such a commit is inherently unscoped so the unscoped-commit rule catches it regardless.
const COMMIT_ALL_RE = new RegExp(GIT_AT_BOUNDARY + 'commit\\b[^\\n;&|]*\\s(?:-a|-am|-ma|--all)\\b', 'i');
// Pathspec scoping: a ` -- ` separator (with something after it).
const PATHSPEC_RE = /\s--\s+\S/;
const AMEND_RE = new RegExp(GIT_AT_BOUNDARY + 'commit\\b[^\\n;&|]*\\s--amend\\b', 'i');

let data = '';
process.stdin.on('data', c => (data += c));
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(data || '{}'); } catch (_) { return allow(); }
  try {
    const tool = input.tool_name || '';
    if (tool !== 'Bash' && tool !== 'PowerShell') return allow();
    const rawCmd = ((input.tool_input && input.tool_input.command) || '') + '';
    if (!rawCmd) return allow();
    // All matching runs on the QUOTE-STRIPPED command (Q4) — quoted text can never trip the gate.
    const cmd = stripQuoted(rawCmd);
    // cheap prefilter: no git add/commit -> nothing to do
    if (!/\bgit\s+(add|commit)\b/i.test(cmd)) return allow();

    const sid = input.session_id || input.sessionId || '';
    const cwd = input.cwd || process.cwd() || '';

    // Zero-friction solo path.
    let others = [];
    try { others = liveSessions(cwd, sid); } catch (_) { others = []; }
    if (!others.length) return allow();

    const sid8 = String(sid).slice(0, 8);
    const n = others.length;

    // `git add -A|--all|.` — sweep staging of the shared index (independent of any commit).
    if (ADD_SWEEP_RE.test(cmd)) {
      return block(
        `Multi-session contention: \`git add -A|--all|.\` sweeps the SHARED index while ${n} other session(s) are live in this working tree — it would stage the other session's WIP too. ` +
        `Stage only your paths (\`git add -- <your paths>\`) and commit them explicitly with \`git commit -m "…" -- <your paths>\`.`,
        `${sid8} git-add-sweep (${n} co-live): ${cmd.slice(0, 120)}`
      );
    }

    // A `git commit` that is pathspec-scoped (\` -- <paths>\`) or --amend is the SAFE form -> allow.
    if (COMMIT_RE.test(cmd) && !PATHSPEC_RE.test(cmd) && !AMEND_RE.test(cmd)) {
      // Unscoped commit. `-a|-am` stages everything; a bare `git commit -m` takes the shared index.
      if (COMMIT_ALL_RE.test(cmd)) {
        return block(
          `Multi-session contention: \`git commit -a|-am\` stages+commits everything in the SHARED working tree while ${n} other session(s) are live — it would swallow the other session's changes. ` +
          `Commit only named paths: \`git commit -m "…" -- <your paths>\`.`,
          `${sid8} git-commit-all (${n} co-live): ${cmd.slice(0, 120)}`
        );
      }
      return block(
        `Multi-session contention: a plain \`git commit\` takes whatever is staged in the SHARED index while ${n} other session(s) are live — it can capture the other session's staged WIP. ` +
        `Scope the commit to your paths: \`git commit -m "…" -- <your paths>\`.`,
        `${sid8} git-commit-unscoped (${n} co-live): ${cmd.slice(0, 120)}`
      );
    }

    return allow();
  } catch (err) {
    audit(`ALLOW: unexpected error (fail-open): ${err && err.message}`);
    process.exit(0);
  }
});
