#!/usr/bin/env node
// PERSIST-TO-MEMORY gate — Stop/SubagentStop. Closes the last memory-enforcement asymmetry: the system gates
// WRITE-size (cap) + per-line bloat + points at recall, but nothing made sure an EXPLICIT "remember this"
// actually got recorded. Nudges (one bounce) when the USER gave a durable-save instruction this turn
// (remember that/to/this · note that · going forward · from now on · don't forget · keep in mind · lesson
// learned · save this · for the record · memorize) AND nothing was written to the memory dir.
// CONSERVATIVE by design (explicit user signal only — "did a fact emerge?" is not hook-detectable). One-bounce
// circuit-breaker (worst case = one extra nudge), fail-OPEN. Mirror of block-premature-stop.js's structure.
// The signal is read ONLY from the owner's own text this turn (lib-owner-text): workflow task prompts,
// inter-session and peer messages, skill bodies, continuation summaries, task notifications and coordinator
// messages never trigger it (they caused 125 of 126 blocks through 2026-10-10). The transcript is read from
// its end.

'use strict';
const fs = require('node:fs');
const os = require('node:os');
let LO = null; try { LO = require('./lib-owner-text.js'); } catch (_) {}
const HOME = (os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
// canonical repoSlug: abs repo path -> Claude Code projects/<slug> folder name (every char that is not
// [A-Za-z0-9] becomes '-', the rule Claude Code itself uses)
const repoSlug = (p) => String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, '').replace(/[^A-Za-z0-9]/g, '-');
// portable: derive the projects slug from CLAUDE_PROJECT_DIR (the hook receives it) else cwd; ${HOME}/ace = legacy fallback
const PROJECT_DIR = (process.env.CLAUDE_PROJECT_DIR || process.cwd() || `${HOME}/ace`).replace(/\\/g, '/').replace(/\/+$/, '');
const SLUG = repoSlug(PROJECT_DIR);
const AUDIT = `${HOME}/.claude/hook-audit.log`;
function audit(l) { try { fs.appendFileSync(AUDIT, `[${new Date().toISOString()}] [persist-mem-gate] ${l}\n`); } catch (_) {} }
function allow(r) { audit(`ALLOW: ${r}`); process.exit(0); }
function block(r) { audit(`BLOCK: ${r.slice(0, 160)}`); process.stdout.write(JSON.stringify({ decision: 'block', reason: r })); process.exit(0); }

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(data || '{}'); } catch (_) { return allow('unparsable (fail-open)'); }
  try {
    const event = input.hook_event_name || 'Stop';
    if (input.stop_hook_active === true) return allow('stop_hook_active (circuit breaker)');
    let tp = input.transcript_path;
    if (!tp || !fs.existsSync(tp)) return allow('no transcript');
    if (event === 'SubagentStop' && input.agent_id) {
      const base = tp.replace(/\.jsonl$/i, ''); const direct = `${base}/subagents/agent-${input.agent_id}.jsonl`; let found = '';
      if (fs.existsSync(direct)) found = direct;
      else { try { const wf = `${base}/subagents/workflows`; for (const d of fs.readdirSync(wf)) { const c = `${wf}/${d}/agent-${input.agent_id}.jsonl`; if (fs.existsSync(c)) { found = c; break; } } } catch (_) {} }
      if (found) tp = found;
    }
    const parse = (raw) => { const a = []; for (const l of raw.split('\n')) { if (!l.trim()) continue; try { a.push(JSON.parse(l)); } catch (_) {} } return a; };
    const endsAsst = (o) => { const x = o[o.length - 1]; return !!(x && x.type === 'assistant' && x.message && Array.isArray(x.message.content) && x.message.content.some((b) => b && b.type === 'text' && b.text)); };
    const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) {} };
    let objs = [];
    for (let a = 0; a < 8; a++) {
      if (LO) objs = LO.loadTranscript(tp); // reads from the end; [] when unreadable
      else { let raw = ''; try { raw = fs.readFileSync(tp, 'utf8'); } catch (_) { return allow('unreadable'); } objs = parse(raw); }
      if (objs.length && endsAsst(objs)) break; sleep(150);
    }
    if (!objs.length) return allow('empty');

    // turn start + the OWNER's own text this turn (lib-owner-text). Legacy fallback (lib missing): the last
    // user text that is not a tool result.
    let startIdx = 0, promptText = '';
    if (LO) {
      const t = LO.currentTurn(objs);
      startIdx = t.startIdx; promptText = t.ownerText;
      if (!promptText) return allow(`no owner text this turn (turn started by ${t.starterKind})`);
    } else {
      for (let i = objs.length - 1; i >= 0; i--) {
        const o = objs[i];
        if (o.type === 'user') {
          const c = o.message && o.message.content;
          const isTR = Array.isArray(c) && c.some((b) => b && b.type === 'tool_result');
          let txt = ''; if (typeof c === 'string') txt = c; else if (Array.isArray(c)) txt = c.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ');
          if (txt && !isTR) { startIdx = i; promptText = txt; break; }
        }
      }
    }
    if (!promptText) return allow('no user prompt this turn');

    const SIGNAL = /\b(remember\s+(that|to|this)|note\s+that|make\s+a\s+note|for\s+next\s+time|going\s+forward|from\s+now\s+on|don'?t\s+forget|keep\s+in\s+mind|lesson\s+learned|save\s+(this|that)\b|for\s+the\s+record|take\s+note|add\s+(this|that)\s+to\s+(memory|the\s+brain)|commit\s+(this|that)\s+to\s+memory|memorize)\b/i;
    if (!SIGNAL.test(promptText)) return allow('no explicit durable-save signal in user prompt');

    // did the turn WRITE to memory? (Write/Edit to the memory dir/MEMORY.md/_MOC, or a memory-maintenance command)
    const turn = objs.slice(startIdx);
    const MEMW = new RegExp('[\\/\\\\]memory[\\/\\\\]|MEMORY\\.md$|_MOC-[a-z]+\\.md$|' + SLUG + '[\\/\\\\]?memory', 'i');
    const MEMCMD = /build-manifest|build-mocs|memory-system|[\/\\]memory[\/\\]/i;
    let wrote = false;
    for (const o of turn) {
      if (o.type !== 'assistant' || !o.message || !Array.isArray(o.message.content)) continue;
      for (const b of o.message.content) {
        if (b.type !== 'tool_use') continue;
        const ip = b.input || {};
        if ((b.name === 'Write' || b.name === 'Edit' || b.name === 'NotebookEdit') && MEMW.test(String(ip.file_path || ip.notebook_path || ''))) wrote = true;
        if ((b.name === 'Bash' || b.name === 'PowerShell') && MEMCMD.test(String(ip.command || ''))) wrote = true;
      }
      if (wrote) break;
    }
    if (wrote) return allow('explicit save-signal + a memory write happened');

    audit(`DIAG event=${event} signal=1 wrote=0 prompt=${JSON.stringify(promptText.slice(0, 80))}`);
    return block(
      `Persistence-to-memory gate (${event}): the user gave an explicit durable instruction this turn ` +
      `(matched a remember / note-that / going-forward / save-this signal) but NOTHING was written to the memory dir.\n\n` +
      `Before you stop: RECORD it — write or update an ATOMIC note in the memory dir per the memory protocol (the fact ` +
      `in the note body + a short MEMORY.md/MOC pointer; run \`recall.mjs "<topic>"\` first to dedup) — OR, if this is ` +
      `NOT a durable memory fact (a one-off task, an ephemeral detail), say so explicitly in your closing message.\n\n` +
      `This is one bounce (the circuit breaker allows the next stop), so make it count: persist it or state why it isn't durable.`
    );
  } catch (e) { return allow(`error (fail-open): ${e && e.message}`); }
});
