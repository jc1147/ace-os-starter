#!/usr/bin/env node
// PERSISTENCE gate — fires on Stop (main agent) and SubagentStop (subagents).
//
// The proof-gate's mirror image. Proof-gate blocks ENDING A TURN that LIES about being done.
// This blocks ENDING A TURN that QUITS on doable work: the turn did real work, hit a RECOVERABLE
// blocker (and often even named the fix), and is stopping to RECOMMEND/DEFER it instead of doing it
// under standing approval. That's the "it stops, you call it out, then it acts right" failure.
//
// BLOCK when ALL hold:
//   (1) the turn used tools (it was actively working, not pure chat/Q&A), AND
//   (2) the closing message matches a GIVE-UP / execution-deferral pattern
//       ("recommend X before continuing", "the fix is …", "want me to proceed?", "stopping here"), AND
//   (3) it does NOT match a GENUINE owner-gate ("your call/decision/approval", a real choice,
//       "destructive", "needs your …") — those are legitimate stops and are LET THROUGH.
//
// Safety (same contract as the proof-gate):
//   - Fail-OPEN on any error (never trap a session on a hook bug).
//   - Circuit breaker: stop_hook_active === true → ALLOW. AT MOST ONE bounce per stop; no loop.
//     Worst case = one extra "keep going" nudge on a legit pause, never an infinite loop.
//   - Every decision appended to ~/.claude/hook-audit.log.

'use strict';
const fs = require('node:fs');
const os = require('node:os');
const HOME = (os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
const AUDIT = `${HOME}/.claude/hook-audit.log`;

function audit(line) { try { fs.appendFileSync(AUDIT, `[${new Date().toISOString()}] [persist-gate] ${line}\n`); } catch (_) {} }
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
    // SubagentStop hands us the MAIN transcript; derive the subagent's own (mirror of proof-gate).
    if (event === 'SubagentStop' && input.agent_id) {
      const base = tp.replace(/\.jsonl$/i, '');
      const direct = `${base}/subagents/agent-${input.agent_id}.jsonl`;
      let found = '';
      if (fs.existsSync(direct)) found = direct;
      else { try { const wf = `${base}/subagents/workflows`; for (const d of fs.readdirSync(wf)) { const c = `${wf}/${d}/agent-${input.agent_id}.jsonl`; if (fs.existsSync(c)) { found = c; break; } } } catch (_) {} }
      if (found) tp = found; else audit(`SubagentStop: derived path not found for agent-${input.agent_id}`);
    }

    const parseObjs = (raw) => { const a = []; for (const l of raw.split('\n')) { if (!l.trim()) continue; try { a.push(JSON.parse(l)); } catch (_) {} } return a; };
    const endsOnAsstText = (objs) => { const o = objs[objs.length - 1]; return !!(o && o.type === 'assistant' && o.message && Array.isArray(o.message.content) && o.message.content.some(b => b && b.type === 'text' && b.text)); };
    const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) {} };

    // FLUSH-RACE GUARD: re-read until the transcript ends on assistant text (the closing message), or budget expires.
    let objs = [];
    let settled = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      let raw = '';
      try { raw = fs.readFileSync(tp, 'utf8'); } catch (_) { return allow('transcript unreadable'); }
      objs = parseObjs(raw);
      if (objs.length && endsOnAsstText(objs)) { settled = true; break; }
      sleepSync(150);
    }
    if (!objs.length) return allow('empty transcript');

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
        if (b.type === 'text' && b.text) lastText = b.text;
        if (b.type === 'tool_use') toolUses.push({ name: b.name });
      }
    }

    // (1) was this an active WORK turn? (used tools) — pure chat/Q&A is not our domain.
    if (!toolUses.length) return allow('no tool use this turn (pure chat/Q&A — exempt)');

    const tail = (lastText || '').slice(-1500);
    if (!tail.trim()) return allow('no closing message');

    // (3) GENUINE owner-gate → legitimate stop, let it through.
    const NEEDS_USER = [
      /\byour (call|decision|approval|sign-?off|input|preference|go[- ]?ahead)\b/i,
      /\bneeds?\s+(your|the\s+owner'?s?|owner|human)\b/i,
      /\bwhich\s+(one|option|approach|direction|way|version)\b/i,
      /\b(option|approach|route)\s+[ab1-3]\b/i,
      /\b(destructive|irreversible|can'?t\s+be\s+undone|cannot\s+be\s+undone)\b/i,
      /\b(approve|authoriz|permission|sign\s*off)\b/i,
      /\bup to you\b/i, /\byour move\b/i, /\bawait(ing)?\s+(your|owner|the owner)\b/i,
      /\b(taste|aesthetic|preference)\b/i, /\bdo you want\b.*\?/i, /\bgreen[- ]?light\b/i,
    ];
    const needsUser = NEEDS_USER.find(p => p.test(tail));
    if (needsUser) return allow(`genuine owner-gate in closing message (${needsUser})`);

    // (2) GIVE-UP / execution-deferral pattern — stopped at a recoverable point with doable work pending.
    const GIVEUP = [
      /\brecommend(ing)?\b[^.?!]{0,90}\b(before|first|prior to)\b/i,
      /\bbefore\s+(any|the)?\s*(further|next|additional|more)\s+(build|run|step|work|pass|phase|change)/i,
      /\bbefore\s+(you|we)?\s*(continue|proceed|build|run|implement|deploy|move on)\b/i,
      /\bthe fix (is|would be|here is|:|=)\b/i,
      /\b(want me to|should i|shall i|do you want me to)\b[^?]{0,100}\?/i,
      /\blet me know if you(?:'?d| would)?\s*(like|want|need)\b/i,
      /\b(stopping|halting|pausing)\s+(here|now)\b/i,
      /\bpoint of no return\b/i,
      /\b(i'?ll|i will|i can|i could|we should)\s+(then\s+)?(fix|port|add|implement|continue|build|run)\b[^.?!]{0,60}\b(if|once|when|after)\b/i,
    ];
    const giveup = GIVEUP.find(p => p.test(tail));

    // (2b) FALSE-CONTINUITY / narrate-then-stop — the closing message claims it is ABOUT TO act
    // ("running it now", "starting the X now") or will "come back with" results, yet the turn is
    // STOPPING. The give-up regexes miss this because it's worded like work-in-progress, not
    // surrender. The discriminator is STRUCTURAL: an imminent-action claim AT A STOP is self-
    // contradicting — if it were really doing the thing, it would be emitting the tool call, not
    // ending the turn. This is the exact pattern that needed a manual "what are you waiting for?".
    const IMMINENT = [
      // verb + ... + "now"  →  "running it now", "starting the render-verify now", "doing it now"
      /\b(start(?:ing)?|run(?:ning)?|build(?:ing)?|doing|execut(?:e|ing)|render(?:ing)?|kick(?:ing)?\s*off|launch(?:ing)?|fir(?:e|ing)\s*up|spin(?:ning)?\s*up|begin(?:ning)?)\b[^.?!]{0,60}\bnow\b/i,
      // defer-with-promise-of-results  →  "I'll come back with…", "report back", "circle back"
      /\b(i'?ll|i will|let me|i'?m going to|i am going to|gonna)\b[^.?!]{0,50}\b(come back|circle back|report back|get back to you|follow up|loop back|be back|return)\b/i,
      // sequencing promise  →  "next, I'll run…", "then I'll build…"
      /\b(next|then|after that|from here|first)\b[^.?!]{0,24}\b(i'?ll|i will|let me|i'?m going to|i am going to)\b[^.?!]{0,40}\b(run|build|do|implement|verify|render|test|start|execute|add|fix|port|continue|capture|check)\b/i,
      // present kickoff  →  "let me run…", "I'll go verify…", "I'm going to build…"
      /\b(let me|i'?ll|i will|i'?m going to|i am going to)\s+(go\s+|now\s+)?(run|build|render|verify|test|execute|implement|start|kick|capture|fetch|pull|generate)\b/i,
      // present-continuous sign-off  →  "kicking off the build", "starting the render now"
      /\b(kicking off|starting|firing up|spinning up|beginning|proceeding (?:to|with))\b[^.?!]{0,40}\b(the|this|that|now|next|render|build|verify|test)\b/i,
    ];
    const imminent = !giveup && IMMINENT.find(p => p.test(tail));

    // (2c) PENDING-WORK ENUMERATION — the turn did real work, has standing approval, and CLOSES by LISTING
    // what is still left ("still ahead", "next up", "the rest of the program", "then I'll …", "that's the
    // next push") instead of doing it. Not give-up, not imminent-narration — a third stop shape: report-the-
    // backlog-and-halt. With approval and no owner-gate, the next item should be STARTED, not listed.
    const PENDING_WORK = [
      /\b(still|more)\s+(to\s+(do|build|come|go|ship|wire|land|tackle|finish)|ahead|remaining|left|outstanding)\b/i,
      /\bnext\s+(up|push|steps?|increment|chunk|on\s+the\s+list)\b/i,
      /\b(the\s+)?(rest|remainder)\s+(of\s+the\s+)?(work|program|plan|build|list|items|backlog|push)\b/i,
      /\b(left|remaining|yet)\s+to\s+(do|build|implement|ship|tackle|finish|wire|land|address)\b/i,
      /\bwhat'?s\s+(left|next|still\s+ahead|remaining|outstanding)\b/i,
      /\bstill\s+(need|have|to)\b[^.?!]{0,24}\b(do|build|implement|wire|land|fix|add|tackle)\b/i,
      /\b(continue|carry on|keep going|pick(?:ing)? (?:this )?up|resume)\b[^.?!]{0,30}\b(next|later|the rest|remaining|program|build|after|tomorrow)\b/i,
      /\bthat'?s\s+the\s+(next|remaining|rest)\b/i,
    ];
    const pending = !giveup && !imminent && PENDING_WORK.find(p => p.test(tail));

    if (!giveup && !imminent && !pending) return allow('no give-up / false-continuity / pending-work-enumeration pattern in closing message');

    const matched = giveup || imminent || pending;
    audit(`DIAG event=${event} kind=${giveup ? 'giveup' : imminent ? 'imminent' : 'pending'} tools=${toolUses.length} pat=${matched} tail=${JSON.stringify(tail.slice(-90))}`);

    if (pending) {
      return block(
        `Persistence gate (${event}) — PENDING-WORK ENUMERATION: you did real work this turn, you have standing ` +
        `approval, and you are STOPPING while LISTING work still left to do (matched ${pending}) instead of doing ` +
        `the next item. There is no genuine owner-gate (decision / approval / destructive / real choice) in your ` +
        `closing message — a backlog you are cleared to do is NOT a stopping point.\n\n` +
        `Per the Deterministic Operating Contract rule 5 (stick to the plan) and the standing job (finish the work, ` +
        `don't file a status report and halt): START THE NEXT ITEM NOW and keep going. Only stop if you are ` +
        `genuinely BLOCKED on the owner, waiting on a TRACKED background job, or the WORK IS ACTUALLY COMPLETE — ` +
        `in which case say so explicitly (name the decision/job, or state plainly that nothing is left).\n\n` +
        `This is one bounce (the circuit breaker allows the next stop), so make it count: do the next thing.`
      );
    }

    if (imminent) {
      return block(
        `Persistence gate (${event}) — FALSE CONTINUITY: your closing message says you are about to act / will ` +
        `"come back with" results (matched ${imminent}), but you are STOPPING instead of doing it. If you were ` +
        `actually running it you'd be making the tool call right now — not ending the turn. There is no genuine ` +
        `owner-gate (decision / approval / destructive / real choice) in your closing message.\n\n` +
        `Per the Deterministic Operating Contract rule 5 (stick to the plan) and the standing job (do the work, ` +
        `don't narrate it and halt): DO IT NOW — make the tool call you just promised and continue the workload. ` +
        `Only stop if you are genuinely BLOCKED on the owner or waiting on a TRACKED background job — in which ` +
        `case REWRITE your closing message to say so explicitly (name the decision you need, or the job/PID).\n\n` +
        `This is one bounce (the circuit breaker allows the next stop), so make it count: act, or state the ` +
        `genuine blocker plainly.`
      );
    }

    return block(
      `Persistence gate (${event}): you used tools this turn and are stopping with WORK STILL PENDING — ` +
      `you matched a give-up / "recommend-it-instead-of-doing-it" pattern (${giveup}) and there is NO genuine ` +
      `owner-gate (decision / approval / destructive / real choice) in your closing message.\n\n` +
      `Per the Deterministic Operating Contract rule 5 (stick to the plan) and the standing job (finish the work, ` +
      `don't file a report and halt): you have approval and a RECOVERABLE blocker. Do ONE of:\n` +
      `  - DO the fix you just named and CONTINUE the workload — don't stop to recommend it, OR\n` +
      `  - If you are genuinely BLOCKED on the owner (a real decision, a destructive/irreversible action, a taste ` +
      `call, or you truly cannot proceed), REWRITE your closing message to say so explicitly and what you need.\n\n` +
      `This is one bounce (the circuit breaker allows the next stop), so make it count: continue the work, or ` +
      `state the genuine blocker plainly.`
    );
  } catch (err) {
    return allow(`unexpected error (fail-open): ${err && err.message}`);
  }
});
