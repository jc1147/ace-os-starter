#!/usr/bin/env node
// prompt-check.js - UserPromptSubmit hook: fires on every user message.
// Lightweight reminder to keep temp logging top of mind.
//
// Node port of Ace Level 1's prompt-check.py (no Python needed), with one deliberate fix: it understands the
// per-session temp-log names (logs/temp/{project}-{user}-{date}-{sid8}.md, see .claude/rules/01-session-logging.md).
// The Python original only matched {date}.md, so it kept saying "no temp logs" and suggested an unkeyed name that
// block-unkeyed-temp-log.js then flags. This version checks whether THIS session already has a temp log for today:
// if not, the reminder is stronger and names the exact keyed file; if it does, it gives a shorter nudge.
// Registered in .claude/settings.json under hooks.UserPromptSubmit:
//   node "$CLAUDE_PROJECT_DIR"/.claude/hooks/prompt-check.js
//
// Username: ~/.claude_github_username (cache) -> `gh api user --jq .login` -> `git config user.name` -> the OS
// user name, sanitized to [A-Za-z0-9-] and written to the cache. Never throws: a hook must not break a session.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const TODAY = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
// CLAUDE_PROJECT_DIR is set by Claude Code when running hooks. Fall back to resolving from this script's
// location (../../ from .claude/hooks/).
const WORKSPACE_ROOT = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
const TEMP_LOG_DIR = path.join(WORKSPACE_ROOT, 'logs', 'temp');

function resolveUsername() {
  const sanitize = (s) => String(s || '').trim().replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  const cacheFile = path.join(os.homedir(), '.claude_github_username');
  try {
    if (fs.existsSync(cacheFile)) {
      const cached = sanitize(fs.readFileSync(cacheFile, 'utf8'));
      if (cached) return cached;
    }
  } catch (_) { /* fall through to detection */ }
  const run = (cmd, args) => {
    try {
      const r = cp.spawnSync(cmd, args, { encoding: 'utf8', timeout: 10000, windowsHide: true });
      return r.status === 0 ? String(r.stdout || '').trim() : '';
    } catch (_) { return ''; }
  };
  let name = sanitize(run('gh', ['api', 'user', '--jq', '.login']));
  if (!name) name = sanitize(run('git', ['config', 'user.name']));
  if (!name) { try { name = sanitize(os.userInfo().username); } catch (_) { name = ''; } }
  if (!name) name = 'unknown';
  try { fs.writeFileSync(cacheFile, name); } catch (_) { /* cache is best-effort */ }
  return name;
}

// The session key: the first 8 characters of session_id from the hook payload on stdin (the same rule as
// session-init.js). 'solo' when there is no payload.
function readSid8() {
  try {
    if (process.stdin.isTTY) return 'solo';
    const payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}') || {};
    const sid = String(payload.session_id || '').trim();
    return sid ? sid.slice(0, 8) : 'solo';
  } catch (_) { return 'solo'; }
}

try {
  const SID8 = readSid8();
  const USERNAME = resolveUsername();
  let isDir = false;
  try { isDir = fs.statSync(TEMP_LOG_DIR).isDirectory(); } catch (_) { isDir = false; }
  if (isDir) {
    const files = fs.readdirSync(TEMP_LOG_DIR);
    // this session's own log for today ({date}-{sid8}.md); with no session key, any log for today counts
    const mine = SID8 === 'solo'
      ? files.filter((f) => f.endsWith(`-${TODAY}.md`) || f.includes(`-${TODAY}-`))
      : files.filter((f) => f.endsWith(`-${TODAY}-${SID8}.md`));
    if (!mine.length) {
      process.stdout.write(
        `TEMP LOG REMINDER: No temp log for this session today (${TODAY}).\n` +
        "If you've done significant work this session, create a temp log entry now.\n" +
        `File: logs/temp/{project}-${USERNAME}-${TODAY}-${SID8}.md\n`
      );
    } else {
      process.stdout.write('TEMP LOG: Remember to update logs/temp/ if you complete significant work.\n');
    }
  }
} catch (_) { /* fail-open: print nothing */ }
process.exit(0);
