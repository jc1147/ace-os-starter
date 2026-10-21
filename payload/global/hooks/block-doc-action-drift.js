#!/usr/bin/env node
// block-doc-action-drift.js — GODCLAUDE v3 (Phase 3), SHADOW / WARN-ONLY. Stop + SubagentStop.
// Semantic doc-vs-action drift MEASURER. It NEVER BLOCKS. On a qualifying stop it writes a bounded
// payload and fires a DETACHED worker (doc-drift-judge-run.mjs) that asks a cheap `claude -p` judge
// "did the turn honor the docs in play?" and logs the verdict. Zero added latency (fire-and-forget).
// Guards: re-entrancy env-fuse (below) + the worker calls claude with --bare (skips hooks).
// Flip to a real blocking gate is a SEPARATE, later, evidence-gated change — not here.
'use strict';
const fs = require('node:fs'), os = require('node:os'), crypto = require('node:crypto'), cp = require('node:child_process');
const HOME = (os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
const AUDIT = `${HOME}/.claude/hook-audit.log`;
const QUEUE = `${HOME}/.claude/.doc-drift-queue`;
const BUDGET = `${HOME}/.claude/.doc-drift-budget.json`;
const WORKER = `${HOME}/.claude/hooks/doc-drift-judge-run.mjs`;
const DRYRUN = process.env.DOC_DRIFT_DRYRUN === '1';

function audit(l) { try { fs.appendFileSync(AUDIT, `[${new Date().toISOString()}] [doc-drift] ${l}\n`); } catch (_) {} }
function skip(r) { if (DRYRUN) process.stdout.write(JSON.stringify({ decision: 'skip', reason: r })); else audit(`SKIP: ${r}`); process.exit(0); }

if (process.env.CLAUDE_DOC_DRIFT_JUDGE) process.exit(0); // re-entrancy fuse: never judge inside the judge

let data = '';
process.stdin.on('data', c => (data += c));
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(data || '{}'); } catch (_) { process.exit(0); }
  try {
    const event = input.hook_event_name || 'Stop';
    if (input.stop_hook_active === true) return skip('circuit-breaker');
    let tp = input.transcript_path;
    if (!tp || !fs.existsSync(tp)) return skip('no-transcript');
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
    for (let i = 0; i < 8; i++) { let raw = ''; try { raw = fs.readFileSync(tp, 'utf8'); } catch (_) { return skip('unreadable'); } objs = parse(raw); if (objs.length && endsAsst(objs)) break; sleep(150); }
    if (!objs.length) return skip('empty');
    let start = 0;
    for (let i = objs.length - 1; i >= 0; i--) { const o = objs[i]; if (o.type === 'user') { const c = o.message && o.message.content; const tr = Array.isArray(c) && c.some(b => b && b.type === 'tool_result'); const tx = typeof c === 'string' || (Array.isArray(c) && c.some(b => b && b.type === 'text')); if (tx && !tr) { start = i; break; } } }
    const turn = objs.slice(start);

    // The OWNER'S REQUEST this turn (the turn-starting user message) + the real permission_mode. These are the
    // signals the judge needs to tell "a PLAN/AUDIT was asked for" from "build it" — previously absent, so the
    // judge guessed "plan mode" from document prose. (Fix 2026-06-26: plan-only-requested-but-agent-built.)
    const startObj = objs[start];
    let userRequest = '';
    if (startObj && startObj.type === 'user' && startObj.message) {
      const c = startObj.message.content;
      userRequest = typeof c === 'string' ? c : (Array.isArray(c) ? c.filter(b => b && b.type === 'text').map(b => b.text).join('\n') : '');
    }
    const permMode = input.permission_mode || input.permissionMode || '';

    const toolUses = []; let lastText = ''; const resultById = {};
    for (const o of turn) {
      if (o.type === 'user' && o.message && Array.isArray(o.message.content)) { for (const b of o.message.content) { if (b && b.type === 'tool_result') { const t = Array.isArray(b.content) ? b.content.map(x => (x && x.text) || '').join('') : (typeof b.content === 'string' ? b.content : ''); resultById[b.tool_use_id] = t; } } }
      if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) { for (const b of o.message.content) { if (b.type === 'text' && b.text) lastText = b.text; if (b.type === 'tool_use') toolUses.push(b); } }
    }

    // P2 substantive action
    const MUT = new Set(['Write', 'Edit', 'NotebookEdit']);
    // Broader than the proof-gate's denylist: a `node …` spawn (the canonical 2026-06-21 drift) counts here.
    const SIDE = /\bnode(?:\.exe)?\s+\S|\b(npm|pnpm|yarn)\s+\S|\bpip\s+install\b|\bgit\s+(commit|push|merge|reset|checkout|rebase)\b|\bRemove-Item\b|\bMove-Item\b|\bNew-Item\b|\bmkdir\b|\b(docker|kubectl|vercel|netlify|gh|terraform)\b/i;
    const muts = toolUses.filter(t => MUT.has(t.name));
    const sidefx = toolUses.filter(t => (t.name === 'Bash' || t.name === 'PowerShell') && SIDE.test((t.input && t.input.command) || ''));
    if (!muts.length && !sidefx.length) return skip('no-substantive-action');

    // P3 instruction-doc in play
    const DOC = /_RESUME-HERE|RESUME|RUNBOOK|README|CLAUDE\.md|_PLAN|PLAYBOOK|_DECISIONS|_KICKSTART|HANDOFF|SKILL\.md|CONTRACT|STRATEGY|SPEC/i;
    const docReads = toolUses.filter(t => t.name === 'Read' && DOC.test(((t.input && t.input.file_path) || '').replace(/\\/g, '/')));
    const msgRefDoc = /runbook|resume[- ]here|start\.ps1|the plan|per the doc|as documented|launcher|contract|spec/i.test(lastText);
    if (!docReads.length && !msgRefDoc) return skip('no-doc-in-play');

    // P4 assertive close
    const CLAIM = /\b(done|complete(d)?|finished|fixed|resolved|verified|confirmed|works|working|ready|implemented|ran|started|launched|deployed|built|published|created|set up|configured)\b/i;
    if (!CLAIM.test((lastText || '').slice(-1200))) return skip('no-claim');

    // P5 novelty + budget (token bucket: 1/90s, 40/day, dedup)
    const sig = crypto.createHash('sha1').update(toolUses.map(t => t.name).sort().join(',') + muts.map(t => (t.input && t.input.file_path) || '').join(',') + (lastText || '').slice(-200)).digest('hex').slice(0, 12);
    let budget = { day: '', count: 0, last: 0, seen: [] };
    try { budget = JSON.parse(fs.readFileSync(BUDGET, 'utf8')); } catch (_) {}
    const today = new Date().toISOString().slice(0, 10), nowMs = Date.now();
    if (budget.day !== today) budget = { day: today, count: 0, last: 0, seen: [] };
    if ((budget.seen || []).includes(sig)) return skip('dup');
    if (budget.last && nowMs - budget.last < 90000) return skip('rate-90s');
    if (budget.count >= 40) return skip('budget-40d');

    // -> JUDGE: build bounded payload
    const docsBlock = docReads.slice(0, 3).map(t => { const p = ((t.input && t.input.file_path) || '').replace(/\\/g, '/'); const r = resultById[t.id] || ''; const s = r.length > 2000 ? r.slice(0, 1200) + '\n…\n' + r.slice(-800) : r; return `<doc path="${p}">\n${s}\n</doc>`; }).join('\n');
    const actionsBlock = toolUses.slice(0, 40).map(t => { const a = (t.input && (t.input.file_path || t.input.notebook_path || t.input.command || t.input.pattern)) || ''; return `${t.name}(${String(a).replace(/\\/g, '/').slice(0, 120)})`; }).join('\n');
    const closeBlock = (lastText || '').slice(-1200);
    const docs = docReads.map(t => ((t.input && t.input.file_path) || '').split(/[\\/]/).pop());
    const payload = { ts: new Date().toISOString(), event, sig, tx: tp.split(/[\\/]/).pop(), muts: muts.length, sidefx: sidefx.length, permMode, userRequest: userRequest.slice(0, 800), docs, docsBlock, actionsBlock, closeBlock };

    if (DRYRUN) { process.stdout.write(JSON.stringify({ decision: 'judge', sig, docs, permMode, userRequest: userRequest.slice(0, 160) })); return process.exit(0); }

    fs.mkdirSync(QUEUE, { recursive: true });
    const pf = `${QUEUE}/${today}_${sig}.json`;
    fs.writeFileSync(pf, JSON.stringify(payload));
    budget.count++; budget.last = nowMs; budget.seen = (budget.seen || []).slice(-50); budget.seen.push(sig);
    try { fs.writeFileSync(BUDGET, JSON.stringify(budget)); } catch (_) {}
    audit(`DIAG event=${event} sig=${sig} muts=${muts.length} sidefx=${sidefx.length} docs=[${docs.join(',')}] -> ENQUEUED (shadow async judge)`);
    try { const ch = cp.spawn(process.execPath, [WORKER, pf], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, CLAUDE_DOC_DRIFT_JUDGE: '1' } }); ch.unref(); } catch (e) { audit(`worker-spawn-failed (fail-open): ${e.message}`); }
    process.exit(0);
  } catch (err) { audit(`unexpected error (fail-open): ${err && err.message}`); process.exit(0); }
});
