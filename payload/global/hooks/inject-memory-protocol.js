#!/usr/bin/env node
// Injects the Memory Protocol as additionalContext — the "frontrunner" that puts the
// file-based memory rules in front of EVERY session and subagent.
// Event-agnostic: wired on SessionStart (main agent) AND SubagentStart (subagents);
// echoes back whatever hook_event_name it received so the payload is valid for both.
// Single source of truth: ~/.claude/memory-protocol.md
// Fail-OPEN: if the file is missing/unreadable/empty, emit nothing (never break a session).

'use strict';
const fs = require('node:fs');
const os = require('node:os');
const HOME = (os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
const PROTOCOL = `${HOME}/.claude/memory-protocol.md`;

let data = '';
process.stdin.on('data', c => (data += c));
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(data || '{}'); } catch (_) {}
  const event = input.hook_event_name || 'SessionStart';
  let text = '';
  try { text = fs.readFileSync(PROTOCOL, 'utf8'); } catch (_) { process.exit(0); }
  if (!text.trim()) process.exit(0);
  // Append the LIVE session id so new notes can be stamped with metadata.originSessionId (the memory-pass
  // enforcement gates attribute a pass by that field). Pulled from the stdin payload; omit if absent.
  const sid = input.session_id || input.sessionId || '';
  if (sid) text += `\n\nThis session's id, to stamp as metadata.originSessionId on new notes: ${sid}\n`;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: text }
  }));
  process.exit(0);
});
