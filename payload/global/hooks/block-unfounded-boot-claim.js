#!/usr/bin/env node
// block-unfounded-boot-claim.js — GODCLAUDE v2, Phase 2 (L2 verification gate). Stop + SubagentStop.
//
// Blocks ending a turn that CLAIMS a local server/app is up at a concrete localhost URL/port
// WITHOUT a fresh verify-server-boot artifact (PASS) for that target. The un-fakeable backstop to
// "I started the server and it works": the proof-gate can't see it (no file mutation) and the
// launch-gate only governs HOW you launched, not that the result is actually alive.
//
// Fires ONLY when the closing tail has BOTH a boot verb (up/live/running/serving/started/…) AND a
// concrete local target (http://127.0.0.1:PORT / localhost:PORT / "port PORT") — FP-safe (generic
// "the deploy is live" with no local target does NOT fire). Then: no fresh artifact -> BLOCK (run the
// harness); fresh but verdict=fail while claiming up -> BLOCK; fresh PASS -> ALLOW.
//
// Escape: run  node ~/.claude/hooks/verify-server-boot.mjs <url>  (writes the artifact), then claim.
// Safety: fail-OPEN on any error; circuit breaker on stop_hook_active; [boot-gate] audit each decision.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const HOME = (os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
const AUDIT = `${HOME}/.claude/hook-audit.log`;
const ARTIFACT_DIR = `${HOME}/.claude/verify-artifacts/server-boot`;
const FRESH_MS = 15 * 60 * 1000;

function audit(l) { try { fs.appendFileSync(AUDIT, `[${new Date().toISOString()}] [boot-gate] ${l}\n`); } catch (_) {} }
function allow(r) { audit(`ALLOW: ${r}`); process.exit(0); }
function block(r) { audit(`BLOCK: ${String(r).slice(0, 160)}`); process.stdout.write(JSON.stringify({ decision: 'block', reason: r })); process.exit(0); }

let data = '';
process.stdin.on('data', c => (data += c));
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(data || '{}'); } catch (_) { return allow('input unparsable (fail-open)'); }
  try {
    const event = input.hook_event_name || 'Stop';
    if (input.stop_hook_active === true) return allow('stop_hook_active (circuit breaker)');
    let tp = input.transcript_path;
    if (!tp || !fs.existsSync(tp)) return allow('no transcript path');
    if (event === 'SubagentStop' && input.agent_id) {
      const base = tp.replace(/\.jsonl$/i, '');
      const direct = `${base}/subagents/agent-${input.agent_id}.jsonl`;
      if (fs.existsSync(direct)) tp = direct;
      else { try { const wf = `${base}/subagents/workflows`; for (const d of fs.readdirSync(wf)) { const c = `${wf}/${d}/agent-${input.agent_id}.jsonl`; if (fs.existsSync(c)) { tp = c; break; } } } catch (_) {} }
    }
    const parse = raw => { const a = []; for (const l of raw.split('\n')) { if (!l.trim()) continue; try { a.push(JSON.parse(l)); } catch (_) {} } return a; };
    const endsAsst = o => { const x = o[o.length - 1]; return !!(x && x.type === 'assistant' && x.message && Array.isArray(x.message.content) && x.message.content.some(b => b && b.type === 'text' && b.text)); };
    const sleep = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) {} };
    let objs = [];
    for (let i = 0; i < 8; i++) { let raw = ''; try { raw = fs.readFileSync(tp, 'utf8'); } catch (_) { return allow('transcript unreadable'); } objs = parse(raw); if (objs.length && endsAsst(objs)) break; sleep(150); }
    if (!objs.length) return allow('empty transcript');
    let start = 0;
    for (let i = objs.length - 1; i >= 0; i--) { const o = objs[i]; if (o.type === 'user') { const c = o.message && o.message.content; const tr = Array.isArray(c) && c.some(b => b && b.type === 'tool_result'); const tx = typeof c === 'string' || (Array.isArray(c) && c.some(b => b && b.type === 'text')); if (tx && !tr) { start = i; break; } } }
    const turn = objs.slice(start);
    let lastText = '';
    for (const o of turn) { if (o.type !== 'assistant' || !o.message || !Array.isArray(o.message.content)) continue; for (const b of o.message.content) { if (b.type === 'text' && b.text) lastText = b.text; } }
    const tail = (lastText || '').slice(-1200);

    const BOOT_VERB = /\b(up|live|running|serving|booted|started|launched|listening|online|available|reachable|ready)\b/i;
    const targets = [];
    let m;
    const reUrl = /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(?::(\d{2,5}))?/gi;
    while ((m = reUrl.exec(tail))) targets.push(m[2] || '80');
    const reHostPort = /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\s*:\s*(\d{2,5})\b/gi;
    while ((m = reHostPort.exec(tail))) targets.push(m[1]);
    const rePort = /\bport\s+(\d{2,5})\b/gi;
    while ((m = rePort.exec(tail))) targets.push(m[1]);

    if (!BOOT_VERB.test(tail) || !targets.length) return allow('no local-server boot claim in tail');

    const now = Date.now();
    const aliases = ['127.0.0.1', 'localhost', '0.0.0.0'];
    function freshReport(port) {
      for (const h of aliases) {
        const f = path.join(ARTIFACT_DIR, `${h}_${port}.report.json`);
        try { if (!fs.existsSync(f)) continue; const st = fs.statSync(f); if (now - st.mtimeMs > FRESH_MS) continue; const r = JSON.parse(fs.readFileSync(f, 'utf8')); return { verdict: r.verdict, reason: r.reason }; } catch (_) {}
      }
      return null;
    }
    const ports = [...new Set(targets)];

    // SESSION-SCOPE (cross-session-bleed fix 2026-07-09): the boot artifact is keyed by
    // <host>_<port> ONLY — no session id — so a CONCURRENT session's fresh PASS/FAIL for the
    // same port would otherwise found (false-pass) or block (false-block) THIS session's claim.
    // Only honor an artifact for a port THIS session actually PROVED by running verify-server-boot
    // itself (its own transcript shows the harness command for that port). A port this session
    // never ran the harness for is treated as unproven — foreign artifacts are IGNORED, and the
    // claim falls to the normal "prove it yourself" block. Fail-OPEN: if the scan throws, fall
    // back to honoring any fresh artifact (old behavior) so a scan bug never blocks.
    let scopeToSession = true;
    const provedPorts = new Set();
    try {
      const portsFromCmd = (cmd) => {
        const out = []; let mm;
        const r1 = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::(\d{2,5}))?/gi;
        while ((mm = r1.exec(cmd))) out.push(mm[1] || '80');
        const r2 = /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\s*:\s*(\d{2,5})\b/gi;
        while ((mm = r2.exec(cmd))) out.push(mm[1]);
        const r3 = /:(\d{2,5})\b/g; // fallback: any :PORT token in the harness command
        while ((mm = r3.exec(cmd))) out.push(mm[1]);
        return out;
      };
      for (const o of objs) {
        if (o.type !== 'assistant' || !o.message || !Array.isArray(o.message.content)) continue;
        for (const b of o.message.content) {
          if (!b || b.type !== 'tool_use' || !/^(Bash|PowerShell)$/.test(b.name || '')) continue;
          const cmd = (b.input && b.input.command) || '';
          if (!/verify-server-boot/i.test(cmd)) continue;
          for (const p of portsFromCmd(cmd)) provedPorts.add(p);
        }
      }
    } catch (_) { scopeToSession = false; } // scan failed -> fail-open (honor any fresh artifact)

    const missing = [], failed = [];
    for (const port of ports) {
      // Foreign artifact (this session never ran the harness for this port) -> unproven.
      if (scopeToSession && !provedPorts.has(port)) { missing.push(port); continue; }
      const r = freshReport(port);
      if (!r) missing.push(port);
      else if (r.verdict !== 'pass') failed.push(`${port}:${r.reason || 'fail'}`);
    }
    audit(`DIAG event=${event} ports=[${ports.join(',')}] missing=[${missing.join(',')}] failed=[${failed.join(';')}]`);

    if (failed.length) return block(
      `Boot-gate (${event}): you claim a local server is up, but its fresh verify-server-boot artifact verdict is FAIL — ${failed.join(', ')}.\n` +
      `The server is NOT serving. Report the real result, or fix it and re-run:  node "${HOME}/.claude/hooks/verify-server-boot.mjs" http://127.0.0.1:${ports[0]} /`);
    if (missing.length) return block(
      `Boot-gate (${event}): you assert a local server is up on port(s) ${missing.join(', ')}, but there is NO fresh verify-server-boot artifact for it.\n` +
      `Prove it (don't self-report):  node "${HOME}/.claude/hooks/verify-server-boot.mjs" http://127.0.0.1:${missing[0]} /\n` +
      `then claim it's up only if the artifact verdict is PASS. A server can die between your last glance and now — the artifact is the un-fakeable proof.`);
    return allow(`boot claim backed by fresh PASS artifact (ports ${ports.join(',')})`);
  } catch (err) { return allow(`unexpected error (fail-open): ${err && err.message}`); }
});
