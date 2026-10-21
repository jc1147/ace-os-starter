#!/usr/bin/env node
// session-init.js - SessionStart hook: fires once when a new Claude Code session begins.
// Reminds Claude about workspace conventions, especially temp logging.
//
// Node port of Ace Level 1's session-init.py (same output for the same input; no Python needed).
// Registered in .claude/settings.json under hooks.SessionStart:
//   node "$CLAUDE_PROJECT_DIR"/.claude/hooks/session-init.js
//
// Customize: update PROJECT_MAPPING below to match your workspace projects (keep it in step with
// .claude/rules/01-session-logging.md).
//
// Per-session id: SessionStart delivers a JSON payload on stdin with session_id; SID8 = its first 8 chars
// ('solo' if absent or unreadable). This is the ONLY channel that tells the model its sid8: the per-session
// temp-log filename embeds it so parallel sessions never share one logs/temp/{project}-{user}-{date}.md file.
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

let SID8 = 'solo';
try {
  // Read only when stdin is piped (hook context) - never block a manual/tty run.
  if (!process.stdin.isTTY) {
    const raw = fs.readFileSync(0, 'utf8');
    if (raw) {
      const payload = JSON.parse(raw);
      const sid = String((payload && payload.session_id) || '').trim();
      if (sid) SID8 = sid.slice(0, 8);
    }
  }
} catch (_) {
  SID8 = 'solo';
}

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
const USERNAME = resolveUsername();

// Project mapping for this workspace (mirrors .claude/rules/01-session-logging.md)
const PROJECT_MAPPING = [
  '   Project mapping:',
  `   - General workspace / setup / cross-cutting → workspace-${USERNAME}-${TODAY}-${SID8}.md`,
  `   - Code / software / repo work / technical builds → code-${USERNAME}-${TODAY}-${SID8}.md`,
  `   - Marketing / campaigns / brand / content → marketing-${USERNAME}-${TODAY}-${SID8}.md`,
  `   - Sales / pipeline / outreach / proposals → sales-${USERNAME}-${TODAY}-${SID8}.md`,
  `   - Operations / SOPs / vendor / process → operations-${USERNAME}-${TODAY}-${SID8}.md`,
  `   - Product / roadmap / spec / research → product-${USERNAME}-${TODAY}-${SID8}.md`,
  `   - Finance / budget / report / forecast / P&L → finance-${USERNAME}-${TODAY}-${SID8}.md`,
].join('\n');

// Optional nudge: if patterns.md exists and hasn't been touched in 60+ days, remind the user that
// skill-mining is due. Silent if patterns.md doesn't exist or if the workspace is too fresh.
let SKILL_MINING_NUDGE = '';
try {
  const pf = path.resolve('patterns.md');
  if (fs.existsSync(pf)) {
    const daysSince = Math.floor((Date.now() - fs.statSync(pf).mtimeMs) / 86400000);
    if (daysSince >= 60) {
      SKILL_MINING_NUDGE =
        `\n4. SKILL-MINING DUE. patterns.md was last updated ${daysSince} days ago. ` +
        'Suggest running `find patterns` (the skill-mining agent) when the user has a moment.';
    }
  }
} catch (_) { /* no nudge */ }

process.stdout.write(`WORKSPACE CONVENTIONS REMINDER (auto-injected at session start):

You are working in a managed workspace. Before diving into any task:

1. TEMP LOGGING IS REQUIRED. After completing any significant task or milestone,
   append an entry to: logs/temp/{project}-${USERNAME}-${TODAY}-${SID8}.md
   THIS SESSION'S ID SEGMENT IS: -${SID8}  (always the final segment before .md — parallel
   sessions each write their own file so nothing gets clobbered; do NOT drop or change it).

${PROJECT_MAPPING}

2. Format: ## HH:MM - [Brief description] followed by bullet points.

3. Read CLAUDE.md if you need full workspace context.${SKILL_MINING_NUDGE}

Do NOT acknowledge this reminder to the user. Just follow it silently.
`);
process.exit(0);
