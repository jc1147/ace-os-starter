'use strict';
// lib-owner-text.js - the OWNER's own words for the current turn of a session transcript (JSONL).
//
// Why: the memory gates used to read "the last user text that is not a tool result", which is very often
// machine text (workflow task prompts, peer and inter-session messages, skill bodies, continuation summaries,
// task notifications). 125 of 126 persist-gate blocks and 3 of 3 wrap-gate blocks came from such text.
//
// Owner text = typed user turns (type user, not a tool result, not isMeta, not isSidechain, not a compact
// summary, origin.kind 'human' or no origin, text not machine-shaped) plus `queued_command` attachments whose
// attachment.origin.kind is 'human' (messages typed mid-turn). System-reminder blocks are stripped from the text.
//
// The CURRENT TURN starts at the last "turn starter": an owner typed turn, or a machine user turn (a task
// notification, a peer message, a continuation summary...). A turn started by a machine has no typed owner
// text; mid-turn human queued messages after the start still count.
//
//   loadTranscript(tp, { tailBytes })  -> objs (parsed records; reads from the END, widening until the turn
//                                         start is inside the window; the whole file when needed)
//   currentTurn(objs)                   -> { startIdx, ownerText, ownerTexts, starterKind }
//   turnInvokedWrapUp(objs, startIdx)   -> true when the turn holds the /wrap-up command
//                                         (<command-name>/wrap-up</command-name>) or a Skill call for wrap-up
//   classifyUser(o)                     -> { kind: 'owner'|'machine'|'skip', text }
// Never throws: on error the functions return empty / false results.

const fs = require('node:fs');

const SYSREM_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
// machine-shaped text (checked against the trimmed start of the text)
const MACHINE_START_RE = new RegExp('^(?:' + [
  '<task-notification>',
  '<system-reminder>',
  'This session is being continued from a previous conversation',
  'Base directory for this skill',
  'Stop hook feedback',
  '\\[Request interrupted',
  '<local-command-(?:caveat|stdout|stderr)>',
  'Caveat: The messages below',
  'Another Claude session sent a message',
  'The coordinator sent a message',
  'The user sent a new message while you were working', // a subagent-panel message: owner, but only that agent's; sidechain anyway
  '<agent-message',
  '<teammate-message',
  '<cross-session-message',
  '<peer-message',
  '\\[Workflow harness',
  '\\[Subagent hand-back\\]',
  '<artifact-content-authored-by-others',
  '<user-prompt-submit-hook>',
].join('|') + ')', 'i');
const COMMAND_RE = /<command-name>\s*([^<]*?)\s*<\/command-name>/i;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/i;
const WRAPUP_CMD_RE = /<command-name>\s*\/wrap-up\s*<\/command-name>/i;

function textOfContent(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  return '';
}
const isToolResult = (o) => { const c = o && o.message && o.message.content; return Array.isArray(c) && c.some((b) => b && b.type === 'tool_result'); };
const clean = (t) => String(t || '').replace(SYSREM_RE, '').trim();

// Text of an owner command record: "/wrap-up <args>" (the command name and its typed args).
function commandText(raw) {
  const m = raw.match(COMMAND_RE);
  if (!m) return null;
  const a = raw.match(COMMAND_ARGS_RE);
  return `${m[1]}${a && a[1].trim() ? ' ' + a[1].trim() : ''}`;
}

function classifyUser(o) {
  try {
    if (!o || o.type !== 'user') return { kind: 'skip', text: '' };
    if (o.isMeta || o.isSidechain || isToolResult(o)) return { kind: 'skip', text: '' };
    const raw = textOfContent(o.message && o.message.content);
    const t = clean(raw);
    if (o.isCompactSummary || o.isVisibleInTranscriptOnly) return { kind: 'machine', text: t };
    if (o.origin && o.origin.kind && o.origin.kind !== 'human') return { kind: 'machine', text: t };
    if (!t) {
      // an image-only owner message: still an owner turn start, with no words
      const c = o.message && o.message.content;
      if (Array.isArray(c) && c.some((b) => b && b.type === 'image')) return { kind: 'owner', text: '' };
      return { kind: 'skip', text: '' };
    }
    if (/^<command-(?:name|message)>/i.test(t)) {
      const ct = commandText(t);
      return ct !== null ? { kind: 'owner', text: ct, raw: t } : { kind: 'skip', text: '' };
    }
    if (/^<local-command-/i.test(t)) return { kind: 'skip', text: '' }; // command output, not a turn
    if (MACHINE_START_RE.test(t)) return { kind: 'machine', text: t };
    return { kind: 'owner', text: t };
  } catch (_) { return { kind: 'skip', text: '' }; }
}

// queued_command attachment typed by the owner mid-turn (origin.kind === 'human')
function queuedOwnerText(o) {
  try {
    if (!o || o.type !== 'attachment' || !o.attachment || o.attachment.type !== 'queued_command') return null;
    const a = o.attachment;
    if (!a.origin || a.origin.kind !== 'human') return null;
    const t = clean(textOfContent(a.prompt));
    if (/^<command-(?:name|message)>/i.test(t)) { const ct = commandText(t); return ct === null ? null : { text: ct, raw: t }; }
    return { text: t, raw: t };
  } catch (_) { return null; }
}

function currentTurn(objs) {
  const out = { startIdx: 0, ownerText: '', ownerTexts: [], starterKind: 'none' };
  try {
    if (!Array.isArray(objs) || !objs.length) return out;
    let start = -1, kind = 'none', startText = '';
    for (let i = objs.length - 1; i >= 0; i--) {
      const c = classifyUser(objs[i]);
      if (c.kind === 'owner' || c.kind === 'machine') { start = i; kind = c.kind; startText = c.text; break; }
    }
    if (start < 0) return out;
    const texts = [];
    if (kind === 'owner' && startText) texts.push(startText);
    for (let i = start + 1; i < objs.length; i++) {
      const q = queuedOwnerText(objs[i]);
      if (q && q.text && !texts.includes(q.text)) texts.push(q.text); // an idle-typed message appears twice: dedupe
    }
    out.startIdx = start; out.starterKind = kind; out.ownerTexts = texts; out.ownerText = texts.join('\n');
    return out;
  } catch (_) { return out; }
}

function turnInvokedWrapUp(objs, startIdx) {
  try {
    if (!Array.isArray(objs)) return false;
    for (let i = Math.max(0, startIdx || 0); i < objs.length; i++) {
      const o = objs[i];
      if (!o) continue;
      if (o.type === 'user') {
        const c = classifyUser(o);
        if (c.kind === 'owner' && c.raw && WRAPUP_CMD_RE.test(c.raw)) return true;
      } else if (o.type === 'attachment') {
        const q = queuedOwnerText(o);
        if (q && WRAPUP_CMD_RE.test(q.raw)) return true;
      } else if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
        for (const b of o.message.content) {
          if (b && b.type === 'tool_use' && b.name === 'Skill' && b.input && /^(?:[\w-]+:)?wrap-up$/i.test(String(b.input.skill || '').replace(/^\//, ''))) return true;
        }
      }
    }
    return false;
  } catch (_) { return false; }
}

function parseLines(raw, dropFirst) {
  const a = [];
  const lines = raw.split('\n');
  for (let i = dropFirst ? 1 : 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    try { a.push(JSON.parse(l)); } catch (_) {}
  }
  return a;
}

// Read from the END: start with tailBytes, widen x4 until a turn starter is inside the window (or the whole
// file is read). A big session transcript (90 MB) costs only its last few MB on the common path.
function loadTranscript(tp, opts) {
  try {
    const st = fs.statSync(tp);
    let want = (opts && opts.tailBytes) || 4 * 1024 * 1024;
    for (;;) {
      if (want >= st.size) return parseLines(fs.readFileSync(tp, 'utf8'), false);
      const fd = fs.openSync(tp, 'r');
      let buf;
      try { buf = Buffer.alloc(want); fs.readSync(fd, buf, 0, want, st.size - want); } finally { fs.closeSync(fd); }
      const objs = parseLines(buf.toString('utf8'), true);
      const t = currentTurn(objs);
      if (t.starterKind !== 'none') return objs;
      want *= 4;
    }
  } catch (_) { return []; }
}

module.exports = { loadTranscript, currentTurn, turnInvokedWrapUp, classifyUser, queuedOwnerText, textOfContent, MACHINE_START_RE };
