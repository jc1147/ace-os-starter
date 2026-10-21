#!/usr/bin/env node
// GENERAL proof-of-work gate — fires on Stop (main agent) and SubagentStop (subagents).
//
// Blocks ENDING A TURN that (1) mutated files AND (2) asserts completion/success in the
// closing message AND (3) shows NO verification this turn. This is the deterministic answer
// to "it edits something, says 'done/fixed/works', and ends without ever proving it."
//
// Verification signatures (any one clears the gate):
//   - a Read (or cat/type/Get-Content) of a path written this turn  → re-read
//   - a Bash/PowerShell command matching test/build/lint/curl/diff/verify
//   - an evidence marker in the closing message (fenced code block, "Evidence:",
//     "Test output:", "Verified-via:", "exit 0", "N passed", "HTTP .. 200")
//
// Non-mutating turns (pure Q&A / research / read-only) are STRUCTURALLY EXEMPT.
//
// Safety:
//   - Fail-OPEN on any error (never trap a session on a hook bug).
//   - Circuit breaker: stop_hook_active === true → ALLOW. Guarantees AT MOST ONE hard
//     bounce per stop; no infinite loop. (Tradeoff: a determined no-op could stop twice.)
//   - Every decision appended to ~/.claude/hook-audit.log.

'use strict';
const fs = require('node:fs');
const os = require('node:os');
const HOME = (os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
const AUDIT = `${HOME}/.claude/hook-audit.log`;

function audit(line) { try { fs.appendFileSync(AUDIT, `[${new Date().toISOString()}] [proof-gate] ${line}\n`); } catch (_) {} }
function allow(reason) { audit(`ALLOW: ${reason}`); process.exit(0); }
function block(reason) { audit(`BLOCK: ${reason.slice(0, 160)}`); process.stdout.write(JSON.stringify({ decision: 'block', reason })); process.exit(0); }

let data = '';
process.stdin.on('data', c => (data += c));
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(data || '{}'); } catch (_) { return allow('input unparsable (fail-open)'); }
  try {
    const event = input.hook_event_name || 'Stop';
    if (input.stop_hook_active === true) return allow('stop_hook_active=true (circuit breaker)');

    let tp = input.transcript_path;
    if (!tp || !fs.existsSync(tp)) return allow('no transcript path');
    // EMPIRICAL (2026-06-01): SubagentStop hands us the MAIN session transcript_path,
    // NOT the subagent's. The subagent's own transcript lives at
    // <main-transcript-without-.jsonl>/subagents/agent-<agent_id>.jsonl — derive it so we
    // judge the SUBAGENT's closing message, not the parent's turn.
    if (event === 'SubagentStop' && input.agent_id) {
      const base = tp.replace(/\.jsonl$/i, '');
      const direct = `${base}/subagents/agent-${input.agent_id}.jsonl`;
      let found = '';
      if (fs.existsSync(direct)) found = direct;
      else { // workflow agents live at <base>/subagents/workflows/wf_*/agent-<id>.jsonl
        try { const wf = `${base}/subagents/workflows`; for (const d of fs.readdirSync(wf)) { const c = `${wf}/${d}/agent-${input.agent_id}.jsonl`; if (fs.existsSync(c)) { found = c; break; } } } catch (_) {}
      }
      if (found) tp = found; else audit(`SubagentStop: derived path not found (direct+workflow) for agent-${input.agent_id}`);
    }

    const parseObjs = (raw) => { const a = []; for (const l of raw.split('\n')) { if (!l.trim()) continue; try { a.push(JSON.parse(l)); } catch (_) {} } return a; };
    const endsOnAsstText = (objs) => { const o = objs[objs.length - 1]; return !!(o && o.type === 'assistant' && o.message && Array.isArray(o.message.content) && o.message.content.some(b => b && b.type === 'text' && b.text)); };
    const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) {} };

    // FLUSH-RACE GUARD: at Stop/SubagentStop time the FINAL assistant text (the closing
    // message that carries the completion claim) may not be flushed to the transcript yet.
    // Re-read until the transcript ends on an assistant-text message, or the budget expires.
    let objs = [];
    let settled = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      let raw = '';
      try { raw = fs.readFileSync(tp, 'utf8'); } catch (_) { return allow('transcript unreadable'); }
      objs = parseObjs(raw);
      if (objs.length && endsOnAsstText(objs)) { settled = true; break; }
      sleepSync(150); // ~max 1.2s total; well within hook timeout
    }
    if (!objs.length) return allow('empty transcript');
    audit(`read ${settled ? 'settled' : 'UNSETTLED(flush budget expired)'} lastType=${objs[objs.length - 1] && objs[objs.length - 1].type}`);

    // Start of current turn = after the last genuine user prompt (not a tool_result).
    let startIdx = 0;
    for (let i = objs.length - 1; i >= 0; i--) {
      const o = objs[i];
      if (o.type === 'user') {
        const c = o.message && o.message.content;
        const isToolResult = Array.isArray(c) && c.some(b => b && b.type === 'tool_result');
        const isText = typeof c === 'string' || (Array.isArray(c) && c.some(b => b && b.type === 'text'));
        if (isText && !isToolResult) { startIdx = i; break; }
      }
    }
    const turn = objs.slice(startIdx);

    const toolUses = [];
    let lastText = '';
    for (const o of turn) {
      if (o.type !== 'assistant' || !o.message || !Array.isArray(o.message.content)) continue;
      for (const b of o.message.content) {
        if (b.type === 'text' && b.text) lastText = b.text;        // last assistant text wins = closing message
        if (b.type === 'tool_use') toolUses.push({ name: b.name, input: b.input || {} });
      }
    }
    if (!toolUses.length && !lastText) return allow('no assistant activity in turn');

    // (1) did this turn DO something — a file mutation OR a side-effecting (state-changing) command?
    const MUT = new Set(['Write', 'Edit', 'NotebookEdit']);
    const mutations = toolUses.filter(t => MUT.has(t.name));
    // Phase 1a (GODCLAUDE v2): state-changing shell commands ALSO engage the gate, so "ran a
    // deploy/install/push/build and claimed success without proof" is caught — not just file edits.
    // Read-only inspection (ls/cat/grep/git status|log|diff/HTTP GET/--version/--check/test) is NOT
    // side-effecting, so pure-inspection turns stay exempt. Denylist = high-signal state-changers (FP-safe).
    const SIDE_EFFECT_CMD = /\b(npm|pnpm|yarn)\s+(i\b|install|add|ci|run\s+(start|dev|serve|build|deploy|release)|start|publish|deploy)|\bpip\s+install\b|\bgit\s+(commit|push|merge|rebase|reset|checkout|tag|cherry-pick|revert|clean)\b|\b(rm|rmdir|mv|cp)\s+|\bRemove-Item\b|\bMove-Item\b|\bCopy-Item\b|\bNew-Item\b|\bmkdir\b|\bOut-File\b|\bSet-Content\b|\bAdd-Content\b|\b(docker|kubectl|vercel|netlify|gh|aws|gcloud|terraform)\s+\w|\bprisma\s+(migrate|db\s+push)\b|\bnode\s+[^\n]*\b(build|deploy|migrate|seed|publish|release|install)\b/i;
    const sideEffectCmds = toolUses.filter(t => (t.name === 'Bash' || t.name === 'PowerShell') && SIDE_EFFECT_CMD.test(t.input.command || ''));
    audit(`DIAG event=${event} tx=${tp.split(/[\\/]/).pop()} settled=${settled} idx=${startIdx}/${objs.length} muts=${mutations.length} sideFx=${sideEffectCmds.length} tools=[${toolUses.map(t => t.name).join(',')}] tail=${JSON.stringify((lastText || '').slice(-70))}`);
    if (!mutations.length && !sideEffectCmds.length) return allow('no file mutation or side-effecting command this turn (exempt)');
    const writtenPaths = mutations
      .map(t => (t.input.file_path || t.input.notebook_path || '').replace(/\\/g, '/'))
      .filter(Boolean);

    // (2) completion claim in closing message?
    const CLAIM = [
      /\b(all\s+)?done\b/i, /\ball set\b/i, /\bcomplete(d)?\b/i, /\bfinished\b/i,
      /\bfixed\b/i, /\bresolved\b/i, /\bverified\b/i, /\bconfirmed\b/i, /\bvalidated\b/i,
      /\b(it\s+)?works\b/i, /\bworking\b/i, /\bready\b/i, /\bpass(es|ing)?\b/i,
      /\bsuccessfully\b/i, /\bshould\s+(now\s+)?(work|be fixed|pass)\b/i, /\bimplemented\b/i
    ];
    // Tightened 2026-06-01: scan only the closing-message TAIL (sign-off region) for claims, so a
    // "done"/"works" in the mid-message analysis of a long turn doesn't trip the gate. Claim WORD
    // list is kept intact on purpose (narrowing it would risk missing real fakes — fail-closed).
    const claimTail = (lastText || '').slice(-1200);
    const claimPat = CLAIM.find(p => p.test(claimTail));
    if (!claimPat) return allow('no completion claim in closing-message tail');

    // (3) verification signature anywhere in turn?
    let verified = false, why = '';
    const TEST_CMD = /\b(npm|pnpm|yarn)\s+(run\s+)?(test|build|lint|typecheck)\b|\b(pytest|jest|vitest|mocha|playwright|tsc)\b|\bcargo\s+(test|build|check)\b|\bgo\s+test\b|\bcurl\b|\bwget\b|\bInvoke-WebRequest\b|\biwr\b|\bInvoke-RestMethod\b|\bGet-NetTCPConnection\b|\bdiff\b|node\b[^\n]*\b(test|verify|check|assert)\b|\.test\.|\.spec\./i;
    for (const t of toolUses) {
      if (verified) break;
      if (t.name === 'Read') {
        const fp = (t.input.file_path || '').replace(/\\/g, '/');
        if (fp && writtenPaths.some(w => w && (fp.includes(w) || w.includes(fp)))) { verified = true; why = 're-read of written path'; }
      }
      if (t.name === 'Bash' || t.name === 'PowerShell') {
        const cmd = t.input.command || '';
        if (/\b(cat|type|Get-Content|head|tail)\b/i.test(cmd) && writtenPaths.some(w => w && cmd.includes(w.split('/').pop()))) { verified = true; why = 'cat/type of written file'; }
        if (!verified && TEST_CMD.test(cmd)) { verified = true; why = 'test/verify command ran'; }
      }
    }
    if (!verified) {
      // Tightened 2026-06-01: a BARE fenced code block NO LONGER counts as evidence (it let
      // a block quoting logs clear the gate — the Test-2 false-negative). Real signals only:
      // explicit markers, exit-0, N passed, HTTP 200, or a shell-prompt line ($ cmd) showing a command ran.
      const EV = [/\bevidence:/i, /\btest output:/i, /\bverified[- ]via:/i, /\bexit(\s+code)?:?\s*0\b/i, /\b\d+\s+(passed|passing)\b/i, /HTTP\/[12][^\n]*\b200\b/i, /^\s*\$\s+\S/m];
      if (EV.some(p => p.test(lastText))) { verified = true; why = 'evidence marker in message'; }
    }
    if (verified) return allow(`claim+action but verified (${why})`);

    const didWhat = mutations.length
      ? `mutated ${mutations.length} file(s)`
      : `ran ${sideEffectCmds.length} state-changing command(s)`;
    const changedLine = mutations.length
      ? `Files changed this turn: ${writtenPaths.join(', ') || '(paths not captured)'}.`
      : `State-changing command(s) this turn: ${sideEffectCmds.map(t => (t.input.command || '').slice(0, 80)).join(' | ') || '(not captured)'}.`;
    return block(
      `Proof-of-work gate (${event}): you are ending a turn that ${didWhat} and asserts completion ` +
      `(matched ${claimPat}), but this turn shows NO verification.\n\n` +
      `Per the Deterministic Operating Contract rule 3 (evidence-or-flag) and rule 4 (re-audit before done): before you stop, do ONE of:\n` +
      `  - Re-read the file(s) you changed / re-check the result (an HTTP probe, a status query, a test), OR\n` +
      `  - Run the relevant test / build / check command and show its output, OR\n` +
      `  - If you genuinely cannot verify, REWRITE your closing message to drop the completion claim and state explicitly what is unverified and why.\n\n` +
      `${changedLine}\n` +
      `This is one bounce (circuit breaker allows the next stop), so make it count: verify or downgrade the claim.`
    );
  } catch (err) {
    return allow(`unexpected error (fail-open): ${err && err.message}`);
  }
});
