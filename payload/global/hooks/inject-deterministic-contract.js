#!/usr/bin/env node
// Injects the Deterministic Operating Contract as additionalContext.
// Event-agnostic: wired on SessionStart (main agent) AND SubagentStart (subagents);
// echoes back whatever hook_event_name it received so the payload is valid for both.
// Single source of truth: ~/.claude/deterministic-contract.md
// Fail-OPEN: if the contract file is missing/unreadable/empty, emit nothing (never break a session).

'use strict';
const fs = require('node:fs');
const os = require('node:os');
const HOME = (os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
const CONTRACT = `${HOME}/.claude/deterministic-contract.md`;

let data = '';
process.stdin.on('data', c => (data += c));
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(data || '{}'); } catch (_) {}
  const event = input.hook_event_name || 'SessionStart';
  let text = '';
  try { text = fs.readFileSync(CONTRACT, 'utf8'); } catch (_) { process.exit(0); }
  if (!text.trim()) process.exit(0);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: text }
  }));
  process.exit(0);
});
