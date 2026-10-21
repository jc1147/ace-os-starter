#!/usr/bin/env node
// block-undocumented-launch.js — GODCLAUDE v2, Phase 1b.  PreToolUse(Bash|PowerShell).
//
// Stops the 2026-06-21 failure class: hand-spawning a project's server/app entrypoint
// (e.g. `node .../server.js`) when that project ships a documented launcher script
// (start.ps1 / start.sh / run.* / launch.* / serve.* / dev.*) — i.e. ignoring the
// documented way to run it. This is PROCEDURAL drift, which the proof-gate cannot see
// (no file mutation, and the agent may even "verify" the wrong action).
//
// BLOCKS (PreToolUse deny) when ALL hold:
//   (1) the command directly RUNS a node entrypoint: node <…/(server|index|app|main).(js|mjs|cjs)>
//       (not `node --check/--eval/--version/…` — those don't launch anything)
//   (2) the entrypoint's directory contains a launcher script (start|run|launch|serve|dev).(ps1|sh|bat|cmd)
//   (3) the command is NOT invoking that launcher
//   (4) no `DEVIATION-JUSTIFIED:` marker in the command or the turn's last assistant message
//
// Escape (contract invariant #5 — explicit + logged): put `DEVIATION-JUSTIFIED: <reason>` in the
// command (e.g. a trailing comment) or in your message before the call. Every ENGAGEMENT (block OR
// justified-allow) is logged to hook-audit.log under [launch-gate]; commands that don't run an
// entrypoint are passed SILENTLY (no log) to keep the PreToolUse path cheap and the audit log clean.
//
// Safety: fail-OPEN on any error (never wedge a session).

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const HOME = (os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
const AUDIT = `${HOME}/.claude/hook-audit.log`;

function audit(line) { try { fs.appendFileSync(AUDIT, `[${new Date().toISOString()}] [launch-gate] ${line}\n`); } catch (_) {} }
function allow(reason) { audit(`ALLOW: ${reason}`); process.exit(0); } // only called once engaged
function passSilently() { process.exit(0); }                          // not applicable: no log
function deny(reason) {
  audit(`BLOCK: ${String(reason).slice(0, 160)}`);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
  process.exit(0);
}

const LAUNCHER_RE = /^(start|run|launch|serve|dev)\.(ps1|sh|bat|cmd)$/i;
// runs a node entrypoint file named server/index/app/main:
// a quoted path may contain spaces (homes like "John Smith"); an unquoted one ends at whitespace
const ENTRY_RE = /\bnode(?:\.exe)?\b[^\n|&;]*?(?:"([^"\n]*(?:server|index|app|main)\.(?:js|mjs|cjs))"|'([^'\n]*(?:server|index|app|main)\.(?:js|mjs|cjs))'|([^\s"']*(?:server|index|app|main)\.(?:js|mjs|cjs)))/i;
// node invoked in a NON-launching mode (syntax check / eval / version / help) — not a real spawn:
const NONLAUNCH_RE = /\bnode(?:\.exe)?\b[^\n]*?\s(--check|--eval|-e|--print|-p|--version|-v|--help|-h)\b/i;

let data = '';
process.stdin.on('data', c => (data += c));
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(data || '{}'); } catch (_) { return passSilently(); }
  try {
    const tool = input.tool_name || '';
    if (tool !== 'Bash' && tool !== 'PowerShell') return passSilently();
    const cmd = (input.tool_input && input.tool_input.command) || '';
    if (!cmd) return passSilently();

    // (1) does it directly RUN a node entrypoint? (and not a --check/--eval/etc.)
    if (NONLAUNCH_RE.test(cmd)) return passSilently();
    const m = cmd.match(ENTRY_RE);
    if (!m) return passSilently();
    const entry = (m[1] || m[2] || m[3]).replace(/\\/g, '/');

    // resolve the entrypoint directory (absolute path, or relative to cwd)
    const cwd = String(input.cwd || process.cwd() || '').replace(/\\/g, '/');
    const isAbs = /^[a-zA-Z]:\//.test(entry) || entry.startsWith('/');
    const entryAbs = isAbs ? entry : (cwd ? `${cwd}/${entry}` : entry);
    const dir = path.posix.dirname(entryAbs);

    // (2) launcher script present in that directory?
    let launchers = [];
    try { launchers = fs.readdirSync(dir).filter(f => LAUNCHER_RE.test(f)); } catch (_) { return passSilently(); }
    if (!launchers.length) return passSilently();

    // (3) is the command actually invoking one of those launchers? then it's fine.
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (launchers.some(l => new RegExp(`\\b${esc(l)}\\b`, 'i').test(cmd))) {
      return allow(`invoking launcher (${launchers.join(',')}) entry=${entry}`);
    }

    // (4) deviation marker in the command or the last assistant message?
    const MARK = /DEVIATION-?JUSTIFIED\s*:/i;
    if (MARK.test(cmd)) return allow(`DEVIATION-JUSTIFIED in command (entry=${entry})`);
    let lastText = '';
    try {
      const tp = input.transcript_path;
      if (tp && fs.existsSync(tp)) {
        const objs = fs.readFileSync(tp, 'utf8').split('\n').filter(Boolean)
          .map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
        for (let i = objs.length - 1; i >= 0 && i >= objs.length - 6; i--) {
          const o = objs[i];
          if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
            const t = o.message.content.filter(b => b && b.type === 'text' && b.text).map(b => b.text).join('\n');
            if (t) { lastText = t; break; }
          }
        }
      }
    } catch (_) {}
    if (MARK.test(lastText)) return allow(`DEVIATION-JUSTIFIED in message (entry=${entry})`);

    // BLOCK
    return deny(
      `Launch-gate: you are about to hand-spawn "${entry}" directly, but its directory ships a documented ` +
      `launcher (${launchers.join(', ')}). Per the documented runbook, start it that way:\n` +
      `  - run the launcher (e.g. ./${launchers[0]}), OR\n` +
      `  - if you genuinely must bypass it, put "DEVIATION-JUSTIFIED: <reason>" in your message ` +
      `(or as a trailing comment on the command) and it will pass (and be logged).\n` +
      `Why: an agent once ran "node server.js" instead of the documented start.ps1 — this gate closes that.`
    );
  } catch (err) {
    audit(`ALLOW: unexpected error (fail-open): ${err && err.message}`);
    process.exit(0);
  }
});
