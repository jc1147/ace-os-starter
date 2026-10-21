/*
 * Ace OS · Mission Control — dashboard server
 * ---------------------------------------------------
 * Clean re-implementation under the ACE license.
 * Architecture inspired by cth9191/agentic-os-dashboard (NOT copied):
 * this is an independent stdlib-only rewrite. The cth9191 fork hand-defined
 * its skill list; the /api/skills endpoint here AUTO-DISCOVERS skills by
 * reading each SKILL.md frontmatter (the cth9191-fork upgrade).
 *
 * Hard constraints:
 *   - Node.js stdlib ONLY (http, fs, path, child_process, os). No deps.
 *   - Binds 127.0.0.1:7777 — localhost only, never 0.0.0.0.
 *   - READ-ONLY on ~/.claude state. The single side-effecting route is
 *     POST /trigger, which spawns `claude -p` and is gated by the UI behind
 *     an explicit confirm.
 *   - Fail-soft: any read/parse error is caught and surfaced as an `error`
 *     field on that panel's JSON. A bad read NEVER crashes the server.
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { exec, spawn } = require('child_process');
const crypto = require('crypto');

// ---- Configuration (absolute paths; this box is the only deploy target) ----
const HOST = '127.0.0.1';
// Port is env-configurable (PORT or DASH_PORT) so a second instance / a staff box can rebind
// without editing source. Defaults to 7777. The loopback guard + Host-header check both key off it.
const PORT = parseInt(process.env.PORT || process.env.DASH_PORT || '', 10) || 7777;

// Workspace root. STACK_ROOT env override wins; otherwise resolve two dirs up from this file
// (Code/os-dashboard/ -> repo root). NO CLAUDE_PROJECT_DIR (audit #16: that can point at the
// wrong jail when a session launches from a subdir).
const ROOT = (process.env.STACK_ROOT || path.resolve(__dirname, '..', '..')).replace(/\\/g, '/');
const USER_CLAUDE = os.homedir().replace(/\\/g, '/') + '/.claude';
const repoSlug = (p) => String(p).replace(/[^A-Za-z0-9]/g, '-'); // Claude Code's rule: every char outside [A-Za-z0-9] -> '-'
const ROOT_SLUG = repoSlug(ROOT);

// Owner-local timezone for the day-bucketed telemetry. DASH_TZ env override wins; otherwise use the
// machine's own resolved timezone.
const DASH_TZ = process.env.DASH_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const PATHS = {
  lock: path.join(ROOT, '.claude', 'scheduled_tasks.lock'),
  settings: path.join(ROOT, '.claude', 'settings.json'),
  hooksDir: path.join(ROOT, '.claude', 'hooks'),
  skillsDir: path.join(ROOT, '.claude', 'skills'),
  memoryDir: path.join(USER_CLAUDE, 'projects', ROOT_SLUG, 'memory'),
  memoryFile: path.join(USER_CLAUDE, 'projects', ROOT_SLUG, 'memory', 'MEMORY.md'),
  indexHtml: path.join(__dirname, 'index.html'),
};

const MEMORY_CAP = 24400;       // byte ceiling enforced by block-memory-md-too-large.js
const TRIGGER_OUTPUT_CAP = 200000; // cap spawned-process output to keep responses bounded

// ---- Voice/chat auth (Phase: owner opt-in) ----
// The /api/chat endpoint spawns `claude -p` — a powerful surface. It is gated by BOTH
// the loopback guard (server binds 127.0.0.1; Tailscale `serve` proxies from localhost
// so only YOUR tailnet devices reach it) AND a per-install secret token below. The page
// fetches the token from /api/config (same loopback/tailnet gate) and sends it on each call.
const CHAT_TOKEN_FILE = path.join(__dirname, '.chat-token');
let CHAT_TOKEN = '';
try { CHAT_TOKEN = fs.readFileSync(CHAT_TOKEN_FILE, 'utf8').trim(); } catch (_) {}
if (!CHAT_TOKEN || CHAT_TOKEN.length < 24) {
  CHAT_TOKEN = crypto.randomBytes(24).toString('hex');
  try { fs.writeFileSync(CHAT_TOKEN_FILE, CHAT_TOKEN, { mode: 0o600 }); } catch (_) {}
}
function chatAuthed(req) {
  const t = req.headers['x-chat-token'] || '';
  return CHAT_TOKEN.length >= 24 && t.length === CHAT_TOKEN.length &&
    crypto.timingSafeEqual(Buffer.from(t), Buffer.from(CHAT_TOKEN));
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// Strip a UTF-8/UTF-16 BOM if present so JSON.parse / frontmatter parsing works.
function stripBom(s) {
  if (s.charCodeAt(0) === 0xfeff) return s.slice(1);
  return s;
}

function readTextSafe(p) {
  // Returns string content. Throws on failure (callers catch and fail-soft).
  return stripBom(fs.readFileSync(p, 'utf8'));
}

// Parse a leading `---\n ... \n---` YAML-ish frontmatter block into a flat map.
// Deliberately minimal: top-level `key: value` pairs only (skills use that shape).
function parseFrontmatter(text) {
  const out = {};
  const t = text.replace(/\r\n/g, '\n');
  if (!t.startsWith('---')) return out;
  const end = t.indexOf('\n---', 3);
  if (end === -1) return out;
  const block = t.slice(3, end).split('\n');
  for (const raw of block) {
    const line = raw.trimEnd();
    if (!line || /^\s/.test(line)) continue; // skip blanks + nested (indented) keys
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    // unwrap matching surrounding quotes
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    out[m[1].toLowerCase()] = val;
  }
  return out;
}

// ---------------------------------------------------------------------------
// /api/sessions — scheduler lock + live claude.exe count
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// /api/graph — knowledge graph of the wikilinked memory dir
// Each *.md => a node (type from nested metadata.type); each [[wikilink]] => a
// directed link. MEMORY.md = the hub. Fail-soft, capped at 300 nodes.
// ---------------------------------------------------------------------------
function parseMemoryMeta(text) {
  const out = { name: null, type: null, desc: null };
  const t = String(text || '').replace(/\r\n/g, '\n');
  if (!t.startsWith('---')) return out;
  const end = t.indexOf('\n---', 3);
  if (end === -1) return out;
  let inMeta = false;
  for (const raw of t.slice(3, end).split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line) continue;
    if (!/^\s/.test(line)) {
      const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!m) { inMeta = false; continue; }
      const k = m[1].toLowerCase();
      inMeta = k === 'metadata';
      if (k === 'name') out.name = m[2].trim().replace(/^["']|["']$/g, '');
      else if (k === 'description') out.desc = m[2].trim().replace(/^["']|["']$/g, '');
    } else if (inMeta) {
      const s = line.match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
      if (s && s[1].toLowerCase() === 'type') out.type = s[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

function apiGraph() {
  const VALID = new Set(['feedback', 'project', 'reference', 'user', 'note']);
  const PRE = /^(feedback|project|reference|user|note)[_-]/i;
  const deBom = (x) => (x.charCodeAt(0) === 0xfeff ? x.slice(1) : x);
  const norm = (x) => String(x || '').toLowerCase().trim().replace(/\.md$/, '').replace(/[\s_]+/g, '-').replace(/-+/g, '-');
  const strip = (k) => k.replace(/^(feedback|project|reference|user|note)-/i, '');
  const pretty = (x) => String(x).replace(PRE, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  const readSafe = (fp) => { try { return deBom(fs.readFileSync(fp, 'utf8')); } catch (e) { return ''; } };
  // desc: a BOUNDED one-line description for the hover-card (from frontmatter already in memory —
  // no extra I/O). Whitespace-collapsed and hard-capped at 140 chars; additive field on nodes,
  // so the existing nodes/links/stats consumers are untouched.
  const clip = (s) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > 140 ? s.slice(0, 139).replace(/\s+\S*$/, '') + '…' : s; };
  const nodes = [], byId = new Map(), alias = new Map(), bodies = new Map();
  const reg = (key, id) => { if (!key) return; if (!alias.has(key)) alias.set(key, id); const st = strip(key); if (st && !alias.has(st)) alias.set(st, id); };
  const add = (id, label, type, raw, desc) => { if (byId.has(id) || nodes.length >= 600) return byId.get(id); const n = { id, label, type, deg: 0 }; const d = clip(desc); if (d) n.desc = d; nodes.push(n); byId.set(id, n); if (raw != null) bodies.set(id, raw); reg(norm(id), id); return n; };

  // 1) MEMORY notes (dense wikilinked brain)
  try {
    for (const f of fs.readdirSync(PATHS.memoryDir).filter((x) => x.toLowerCase().endsWith('.md'))) {
      const id = f.replace(/\.md$/, '');
      const raw = readSafe(path.join(PATHS.memoryDir, f));
      let type = 'note', label = pretty(id), desc = null;
      if (f.toUpperCase() === 'MEMORY.MD') { type = 'user'; label = 'Memory index'; desc = 'The router — MOC tree links + always-on essentials; every note is reachable from here.'; }
      else {
        const m = parseMemoryMeta(raw);
        if (m.type && VALID.has(m.type.toLowerCase())) type = m.type.toLowerCase();
        else { const pm = (id.match(PRE) || [])[1]; if (pm) type = pm.toLowerCase(); }
        if (m.name) { label = m.name; reg(norm(m.name), id); }
        if (m.desc) desc = m.desc;
      }
      add(id, label, type, raw, desc);
    }
  } catch (e) {}

  // 2) SKILLS grouped under DOMAIN hubs (the brain, organized)
  const domHub = {}, skillDom = {};
  try {
    const sdir = path.join(ROOT, '.claude', 'skills');
    for (const d of fs.readdirSync(sdir)) {
      const sp = path.join(sdir, d, 'SKILL.md');
      if (!fs.existsSync(sp)) continue;
      const raw = readSafe(sp);
      const dm = (raw.match(/\ndomain:\s*([a-z-]+)/i) || [])[1] || 'ops';
      const nmM = raw.match(/\nname:\s*(.+)/);
      const nm = nmM ? nmM[1].trim().replace(/^["']|["']$/g, '') : d;
      // description for the hover-card: same frontmatter we already read. If the value is a YAML
      // fold/literal marker (| or >), fall through to the first indented content line after it.
      let sDesc = null;
      const dM = raw.match(/\ndescription:[ \t]*(.*)(?:\n([ \t]+\S.*))?/);
      if (dM) { const v = (dM[1] || '').trim().replace(/^["']|["']$/g, ''); sDesc = (/^[|>][+-]?$/.test(v) || !v) ? (dM[2] || '').trim() : v; }
      const sid = 'skill:' + d;
      add(sid, nm, 'skill', null, sDesc);
      reg(norm(d), sid); reg(norm(nm), sid); reg(norm('skill-' + d), sid);   // make skills resolvable link targets ([[web-mockup]] etc.)
      skillDom[sid] = dm;
      if (!domHub[dm]) { add('domain:' + dm, dm.toUpperCase(), 'domain', null); reg(norm(dm), 'domain:' + dm); domHub[dm] = 'domain:' + dm; }
    }
  } catch (e) {}

  // 3) MOC read-layer (routing structure). NOTE the regex allows a BARE _INDEX.md (no chars after
  // "INDEX") — without the `(?:-.+)?` the old `.+` requirement excluded _INDEX entirely, so every
  // [[_INDEX]] backlink resolved to null and the hub showed deg:0. We also register each MOC node's
  // id AND its display-label form into the same alias map the regular notes use, so [[_MOC-skills]]
  // / [[_INDEX]] wikilinks (which carry the leading underscore) resolve through norm() like any note.
  try {
    // _SITEMAP (2026-10-10) is a node too: the retired June stubs (_INDEX, _MOC-skills ...) link only to it, so
    // without it the domain-hub -> _MOC-skills bridge below would end at a dead stub.
    for (const f of fs.readdirSync(ROOT).filter((x) => /^_(?:INDEX|SITEMAP|MOC-.+)\.md$/i.test(x))) {
      const id = f.replace(/\.md$/, '');
      const label = id.replace(/^_/, '').replace(/-/g, ' ');
      add(id, label, 'moc', readSafe(path.join(ROOT, f)),
        /^_SITEMAP$/i.test(id) ? 'The memory sitemap: every note filed under one of 16 sections, then a topic.'
        : /^_INDEX/i.test(id) ? 'Whole-workspace read-layer root — skills · code projects · business · memory.'
                            : 'Map of content — generated per-category routing index of every note in this branch.');
      // add() already did reg(norm(id), id); also register the label form + the no-leading-underscore
      // id form so wikilinks written either way ([[_INDEX]], [[INDEX]], [[Index]]) all land on this node.
      reg(norm(label), id);
      reg(norm(id.replace(/^_+/, '')), id);
    }
  } catch (e) {}

  // ---- links ----
  const links = [], seen = new Set();
  const pushLink = (a, b) => { if (!a || !b || a === b) return; const k = a + '|' + b; if (seen.has(k)) return; seen.add(k); links.push({ source: a, target: b }); if (byId.get(a)) byId.get(a).deg++; if (byId.get(b)) byId.get(b).deg++; };
  const resolve = (t) => { const k = norm(t); if (alias.has(k)) return alias.get(k); const st = strip(k); if (alias.has(st)) return alias.get(st); return null; };
  for (const [id, body] of bodies) {
    const re = /\[\[([^\]]+)\]\]/g; let m;
    while ((m = re.exec(body)) !== null) { const tid = resolve(m[1].split('|')[0].split('#')[0].trim()); if (tid) pushLink(id, tid); }
    const md = /\]\(([^)\s]+?\.md)(?:#[^)]*)?\)/g; let mm;   // ALSO follow markdown [text](target.md) links — connects MEMORY.md's index (was an orphan)
    while ((mm = md.exec(body)) !== null) { const tid = resolve(mm[1].split(/[\\/]/).pop()); if (tid) pushLink(id, tid); }
  }
  for (const sid in skillDom) { if (domHub[skillDom[sid]]) pushLink(sid, domHub[skillDom[sid]]); }
  // BRIDGE the skill/domain island into the read-layer backbone: every domain hub -> _MOC-skills -> _INDEX -> the brain
  const mocSkills = resolve('_MOC-skills'); if (mocSkills) for (const dm in domHub) pushLink(domHub[dm], mocSkills);

  return { nodes, links, stats: { nodes: nodes.length, links: links.length } };
}

// Shared, ~3s-cached claude process count. /api/agents (3.5s poll) and /api/sessions both used to
// spawn their OWN probe per request, ~doubling the child-process rate; this collapses it to ~1/3s.
// Cross-platform: win32 -> tasklist for claude.exe; linux -> `pgrep -fc claude`; macOS (BSD pgrep has no -c) ->
// `pgrep -f claude | wc -l`. All count full-cmdline matches.
const _IS_WIN = process.platform === 'win32';
let _procCache = { count: null, ts: 0 };
function claudeProcCount(cb) {
  const now = Date.now();
  if (_procCache.count != null && now - _procCache.ts < 3000) return cb(_procCache.count);
  const cmd = _IS_WIN
    ? 'tasklist /fi "imagename eq claude.exe" /fo csv'
    : (process.platform === 'darwin' ? 'pgrep -f claude | wc -l' : 'pgrep -fc claude');
  exec(cmd, { windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
    let count = null;
    const text = String(stdout || '');
    if (_IS_WIN) {
      // tasklist prints a CSV header + one row per match, or "INFO: No tasks..." when none.
      if (!err) count = /no tasks are running/i.test(text) ? 0 : Math.max(0, text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0).length - 1);
    } else {
      // pgrep -c prints just the count. Exit code 1 means "no matches" (count 0), NOT an error.
      const n = parseInt(text.trim(), 10);
      if (Number.isFinite(n)) count = n;
      else if (err && err.code === 1) count = 0;
    }
    if (count != null) _procCache = { count, ts: Date.now() };
    cb(count);
  });
}
function apiSessions() {
  return new Promise((resolve) => {
    const result = { lock: null, claudeProcs: null };

    // 1) Read the scheduler lock (optional file).
    try {
      if (fs.existsSync(PATHS.lock)) {
        const raw = readTextSafe(PATHS.lock).trim();
        if (raw) {
          try {
            result.lock = JSON.parse(raw);
          } catch (e) {
            result.lock = { error: 'lock present but unparseable: ' + e.message, raw };
          }
        } else {
          result.lock = null; // empty file == no active lock
        }
      } else {
        result.lock = null; // absent == no active lock
      }
    } catch (e) {
      result.lock = { error: e.message };
    }

    // 2) claude.exe count via the shared ~3s cache (so /api/agents + /api/sessions don't double-spawn tasklist).
    claudeProcCount((count) => {
      result.claudeProcs = (count != null) ? count : { error: 'tasklist unavailable' };
      resolve(result);
    });
  });
}

// ---------------------------------------------------------------------------
// /api/memory — MEMORY.md size vs cap + .md file count in the memory dir
// ---------------------------------------------------------------------------

function apiMemory() {
  // Fail-soft on a fresh/staff box: if this workspace has no memory dir yet, say so cleanly
  // (initialized:false + hint) rather than surfacing raw ENOENT errors on every field.
  if (!fs.existsSync(PATHS.memoryDir)) {
    return { initialized: false, cap: MEMORY_CAP, hint: 'No memory brain for this workspace yet (' + PATHS.memoryDir + '). Open a Claude session here, or run Code/memory-system/build-manifest.mjs, to initialize it.' };
  }
  const out = { bytes: null, cap: MEMORY_CAP, pct: null, fileCount: null, overCap: null };
  try {
    const st = fs.statSync(PATHS.memoryFile);
    out.bytes = st.size;
    out.pct = Math.round((st.size / MEMORY_CAP) * 1000) / 10; // one-decimal percent
    out.overCap = st.size > MEMORY_CAP;
  } catch (e) {
    out.error = 'MEMORY.md: ' + e.message;
  }
  try {
    const files = fs.readdirSync(PATHS.memoryDir);
    out.fileCount = files.filter((f) => f.toLowerCase().endsWith('.md')).length;
  } catch (e) {
    // Keep any MEMORY.md error; append the dir error rather than clobbering.
    out.error = (out.error ? out.error + ' | ' : '') + 'memory dir: ' + e.message;
  }
  return out;
}

// ---------------------------------------------------------------------------
// /api/memory-timeline — recent memory CHANGES (by mtime) + protocol correctness
// ---------------------------------------------------------------------------
//
// SPEC #5: "a TIMELINE of recent memory changes and what was changed when I hover,
// and whether it was done correctly or incorrectly per our memory system/protocol."
//
// HONESTY NOTE (load-bearing): the memory NOTES are out of git, so the only signal
// we have is each file's LAST-MODIFIED time (mtime). mtime covers add AND edit, and
// it CANNOT distinguish add vs edit vs delete (a deleted file simply isn't there to
// scan). So this is a "recent changes / last modified" view — NOT a fabricated
// add/edit/delete history. The card labels it that way; we do not invent provenance.
//
// CORRECTNESS RUBRIC (from ~/.claude/memory-protocol.md + the memory skill):
//   A note is flagged INCORRECT (with specific issues) if ANY of:
//     - missing/empty frontmatter `name`
//     - missing/empty frontmatter `description`
//     - `metadata.type` not in {feedback, project, reference, user}
//     - NOT atomic: body (post-frontmatter prose) > MEM_TL_ATOMIC_BYTES (~3 KB) =
//       likely a dump rather than one fact
//     - `description` spans multiple lines (should be one line)
//   SOFT WARNING (does NOT make a note incorrect, but is surfaced as an issue):
//     - has no [[wikilinks]] (the protocol wants notes connected)
//   MEMORY.md itself is the ROUTER and is judged separately (routerOk), not as a note.
//
// PERFORMANCE DISCIPLINE (mirrors the skill/burn caches): a per-request scan of the
// ~140-file dir hung this single-threaded server TWICE before. So the scan is NEVER
// on the request path. A module-level cache MEM_TL_CACHE is built:
//   - once shortly after startup (kicked off from server.listen, non-blocking), and
//   - every MEM_TL_REFRESH_MS (~5 min) by setInterval.
// apiMemoryTimeline() only READS the cache — O(1), no I/O on the request.

const MEM_TL_ATOMIC_BYTES = 3072;     // ~3 KB body ceiling: above this a note is "likely a dump"
const MEM_TL_TOP = 30;                 // most-recent N changes returned
const MEM_TL_REFRESH_MS = 5 * 60 * 1000; // ~5 min background refresh
const MEM_TL_TYPES = new Set(['feedback', 'project', 'reference', 'user']);

let MEM_TL_CACHE = { entries: [], routerOk: null, routerBytes: null, cap: MEMORY_CAP, fileCount: null, builtAt: 0, error: null };
let MEM_TL_BUILDING = false;

// Parse one memory note's leading `--- ... ---` frontmatter into { name, description,
// type, descMultiline } and return the post-frontmatter body. Handles the real shape:
//   name: ... (or quoted)
//   description: "..." (single line; we DETECT a multi-line value)
//   metadata:
//     type: feedback
// `descMultiline` = true if the description value continues onto a following indented
// line (a YAML block/continuation) — the protocol wants a one-line description.
function parseMemoryNote(text) {
  const out = { name: null, description: null, type: null, descMultiline: false, body: '' };
  const t = String(text || '').replace(/\r\n/g, '\n');
  if (!t.startsWith('---')) { out.body = t; return out; }
  const end = t.indexOf('\n---', 3);
  if (end === -1) { out.body = t; return out; }
  const block = t.slice(3, end).split('\n');
  out.body = t.slice(end + 4).replace(/^\n+/, ''); // everything after the closing ---
  let inMeta = false, sawDescKey = false;
  const unquote = (v) => v.replace(/^["']|["']$/g, '');
  for (let i = 0; i < block.length; i++) {
    const raw = block[i].replace(/\s+$/, '');
    if (!raw) { sawDescKey = false; continue; }
    if (!/^\s/.test(raw)) {
      // top-level key
      const m = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!m) { inMeta = false; sawDescKey = false; continue; }
      const k = m[1].toLowerCase();
      inMeta = (k === 'metadata');
      if (k === 'name') { const v = unquote(m[2].trim()); out.name = v || null; }
      if (k === 'description') {
        const v = m[2].trim();
        sawDescKey = true;
        if (v === '' || v === '|' || v === '>' || v === '|-' || v === '>-') {
          // YAML block scalar → inherently multi-line
          out.descMultiline = true;
          out.description = '';
        } else {
          out.description = unquote(v) || null;
        }
        continue;
      }
      sawDescKey = false;
    } else if (inMeta) {
      const s = raw.match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
      if (s && s[1].toLowerCase() === 'type') out.type = unquote(s[2].trim()) || null;
      sawDescKey = false;
    } else if (sawDescKey) {
      // an indented line directly under `description:` = a continued/multi-line value
      out.descMultiline = true;
    }
  }
  return out;
}

// Apply the protocol rubric to a parsed note. Returns { correct, issues:[] }.
function judgeMemoryNote(parsed) {
  const issues = [];
  if (!parsed.name || !parsed.name.trim()) issues.push('Missing frontmatter name');
  if (parsed.descMultiline) issues.push('Description spans multiple lines (should be one line)');
  if (!parsed.description || !parsed.description.trim()) {
    // a multi-line/block description already flagged above; only add the empty note once
    if (!parsed.descMultiline) issues.push('Missing frontmatter description');
  }
  if (!parsed.type) issues.push('Missing metadata.type');
  else if (!MEM_TL_TYPES.has(parsed.type.toLowerCase())) issues.push('metadata.type "' + parsed.type + '" not in {feedback, project, reference, user}');
  const bodyBytes = Buffer.byteLength(parsed.body || '', 'utf8');
  if (bodyBytes > MEM_TL_ATOMIC_BYTES) issues.push('Not atomic — body is ' + (bodyBytes / 1024).toFixed(1) + ' KB (>3 KB likely a dump)');
  const correct = issues.length === 0;
  // SOFT warning: no wikilinks. Appended AFTER the correct/incorrect decision so it
  // never flips a clean note to incorrect — it is advisory only.
  if (!/\[\[[^\]]+\]\]/.test(parsed.body || '')) issues.push('Warning: no [[wikilinks]] — note is not connected');
  return { correct, issues };
}

// Build (refresh) the recent-changes cache off the request path. Synchronous fs over
// ~140 small files is fast, but we still run it from a setTimeout/setInterval so it is
// NEVER triggered by an inbound request. Fail-soft: a bad file is skipped; a dir error
// is recorded on the cache without throwing.
function refreshMemoryTimeline() {
  if (MEM_TL_BUILDING) return;
  MEM_TL_BUILDING = true;
  try {
    const next = { entries: [], routerOk: null, routerBytes: null, cap: MEMORY_CAP, fileCount: null, builtAt: Date.now(), error: null };

    // Router health: MEMORY.md must stay UNDER the cap to keep the brain uncapped.
    try {
      const st = fs.statSync(PATHS.memoryFile);
      next.routerBytes = st.size;
      next.routerOk = st.size < MEMORY_CAP;
    } catch (e) {
      next.error = 'MEMORY.md: ' + e.message;
    }

    let files = [];
    try {
      files = fs.readdirSync(PATHS.memoryDir).filter((f) => f.toLowerCase().endsWith('.md'));
    } catch (e) {
      next.error = (next.error ? next.error + ' | ' : '') + 'memory dir: ' + e.message;
      MEM_TL_CACHE = next;
      return;
    }
    next.fileCount = files.length;

    const rows = [];
    for (const f of files) {
      // Skip the router + generated index/MOC files — they are NOT atomic notes and
      // would always read as "incorrect" against the per-note rubric (false alarms).
      if (f.toUpperCase() === 'MEMORY.MD') continue;
      if (/^_(?:INDEX|MOC-|manifest)/i.test(f)) continue;
      const fp = path.join(PATHS.memoryDir, f);
      let st, raw;
      try { st = fs.statSync(fp); } catch { continue; }
      try { raw = stripBom(fs.readFileSync(fp, 'utf8')); } catch { continue; }
      const parsed = parseMemoryNote(raw);
      const verdict = judgeMemoryNote(parsed);
      rows.push({
        name: parsed.name || f.replace(/\.md$/, ''),
        file: f,
        type: (parsed.type && MEM_TL_TYPES.has(parsed.type.toLowerCase())) ? parsed.type.toLowerCase() : (parsed.type || 'unknown'),
        mtimeMs: st.mtimeMs,
        description: parsed.description || '',
        correct: verdict.correct,
        issues: verdict.issues,
      });
    }
    rows.sort((a, b) => b.mtimeMs - a.mtimeMs); // most-recent change first
    next.entries = rows.slice(0, MEM_TL_TOP);
    next.totalNotes = rows.length;
    next.incorrectCount = rows.filter((r) => !r.correct).length;
    MEM_TL_CACHE = next;
  } catch (e) {
    MEM_TL_CACHE = Object.assign({}, MEM_TL_CACHE, { error: 'timeline build: ' + e.message });
  } finally {
    MEM_TL_BUILDING = false;
  }
}

// Request-path handler: returns the pre-built cache ONLY (no scan here). If the first
// background build hasn't landed yet, returns an empty (building) snapshot honestly.
function apiMemoryTimeline() {
  // Fail-soft on a fresh/staff box: no memory dir -> initialized:false + hint (not an error snapshot).
  if (!fs.existsSync(PATHS.memoryDir)) {
    return { initialized: false, cap: MEMORY_CAP, entries: [], hint: 'No memory brain for this workspace yet (' + PATHS.memoryDir + '). It initializes on first Claude session / memory-system build.' };
  }
  const c = MEM_TL_CACHE;
  return {
    label: 'recent changes / last modified',           // honest: mtime, not an add/edit/delete log
    note: 'Sorted by file last-modified time (mtime). mtime covers add + edit; it cannot distinguish add vs edit vs delete.',
    routerOk: c.routerOk,
    routerBytes: c.routerBytes,
    cap: c.cap,
    fileCount: c.fileCount,
    totalNotes: c.totalNotes != null ? c.totalNotes : null,
    incorrectCount: c.incorrectCount != null ? c.incorrectCount : null,
    entries: Array.isArray(c.entries) ? c.entries : [],
    builtAt: c.builtAt || 0,
    building: (c.builtAt || 0) === 0,
    error: c.error || undefined,
  };
}

// ---------------------------------------------------------------------------
// /api/hooks — hook GOVERNANCE (PHASE 4)
// ---------------------------------------------------------------------------
//
// Each hook entry now carries the full governance picture so the card can show
// ALL hooks (not a truncated chip cloud) with a hover detail:
//   name       — script basename (e.g. "regen-memory-index.js")
//   scope      — 'project' | 'global' | 'both' (which .claude tree(s) the FILE lives in)
//   wired      — bool: is its basename referenced anywhere in settings.json `hooks`
//   events     — array of lifecycle events it is wired on, e.g. ["Stop","SubagentStop"]
//                (deduped + ordered by the canonical lifecycle order; [] when dormant)
//   desc       — the script's first meaningful leading comment line (// or /*…),
//                trimmed to ~140 chars; the "what it does"
//   lines      — script line count (raw)
//   complexity — line-count bucket: 'small' (<40) | 'med' (40–119) | 'large' (≥120)
//
// Why line-count for complexity (the single signal the owner asked us to pick):
// event-count is ALREADY shown to the eye as the event tags on each row, so it
// would be a redundant second view of the same fact. The script's size is the
// orthogonal "how much is going on inside" signal that the tags don't convey.
// `events` is still returned (the card renders them) and `events.length` is there
// for anyone who prefers that lens.
//
// Reading ~45 small hook files is cheap, but we still CACHE the desc/line-count
// per file (keyed by path+mtime) so repeated polls don't re-read+re-scan on every
// 5s request. The cache self-invalidates when a file's mtime changes and is also
// time-boxed (HOOK_META_TTL_MS) so a removed file eventually drops out.

const CANONICAL_EVENT_ORDER = [
  'SessionStart', 'SubagentStart', 'UserPromptSubmit',
  'PreToolUse', 'PostToolUse', 'Notification',
  'Stop', 'SubagentStop', 'PreCompact', 'SessionEnd',
];
const HOOK_META_TTL_MS = 10 * 60 * 1000; // refresh desc/line metadata at most this often
let HOOK_META_CACHE = new Map();          // absPath -> { mtimeMs, desc, lines }
let HOOK_META_CACHE_AT = 0;

function collectHookCommandFilenames(node, acc) {
  // Recursively walk the settings.hooks structure, collecting every command's
  // referenced script basename (e.g. "enforce-agent-delegation.js").
  if (node == null) return;
  if (Array.isArray(node)) {
    for (const item of node) collectHookCommandFilenames(item, acc);
    return;
  }
  if (typeof node === 'object') {
    if (typeof node.command === 'string') {
      const cmd = node.command;
      // Match the last token that looks like a script file (.js/.mjs/.cjs/.py).
      const matches = cmd.match(/[^\s"'`]+\.(?:js|mjs|cjs|py)/g);
      if (matches) {
        for (const m of matches) {
          const base = m.split(/[\\/]/).pop();
          if (base) acc.add(base);
        }
      }
    }
    for (const k of Object.keys(node)) collectHookCommandFilenames(node[k], acc);
  }
}

// Walk settings.hooks one level shallower than collectHookCommandFilenames: for
// each event key (Stop, PreToolUse, …) record which script basenames are wired
// on it. Returns Map(basename -> Set(events)). Fail-soft.
function collectHookEventsFromSettings(settingsHooks, evMap) {
  if (!settingsHooks || typeof settingsHooks !== 'object') return;
  for (const event of Object.keys(settingsHooks)) {
    const blocks = Array.isArray(settingsHooks[event]) ? settingsHooks[event] : [];
    for (const block of blocks) {
      const hooks = block && Array.isArray(block.hooks) ? block.hooks : [];
      for (const h of hooks) {
        const cmd = h && typeof h.command === 'string' ? h.command : '';
        const matches = cmd.match(/[^\s"'`]+\.(?:js|mjs|cjs|py)/g);
        if (!matches) continue;
        for (const m of matches) {
          const base = m.split(/[\\/]/).pop();
          if (!base) continue;
          if (!evMap.has(base)) evMap.set(base, new Set());
          evMap.get(base).add(event);
        }
      }
    }
  }
}

// Extract a hook's first meaningful description line: the first non-blank,
// non-shebang `//` line, or the first real line of a leading /* … */ block
// (handling JSDoc `* …` continuation). Returns '' if none. ≤140 chars.
function extractHookDesc(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let inBlock = false;
  for (let raw of lines) {
    let s = raw.trim();
    if (s === '') continue;
    if (s.startsWith('#!')) continue; // shebang
    if (!inBlock && s.startsWith('//')) {
      const d = s.replace(/^\/+\s?/, '').trim();
      if (d) return d.slice(0, 140);
      continue;
    }
    if (!inBlock && s.startsWith('/*')) {
      s = s.replace(/^\/\*+\s?/, '');
      if (s.includes('*/')) s = s.replace(/\*\/.*$/, '');
      s = s.replace(/^\*+\s?/, '').trim();
      if (s) return s.slice(0, 140);
      inBlock = true;
      continue;
    }
    if (inBlock) {
      if (s === '*' || s === '*/') continue;
      s = s.replace(/\*\/.*$/, '').replace(/^\*+\s?/, '').trim();
      if (s) return s.slice(0, 140);
      continue;
    }
    return ''; // first real code line, no leading comment
  }
  return '';
}

function complexityBucket(lines) {
  if (lines >= 120) return 'large';
  if (lines >= 40) return 'med';
  return 'small';
}

// Read (or reuse cached) desc + line-count for one hook file. Cheap: small files,
// and a per-file mtime cache that survives across requests. Fail-soft.
function hookMeta(absPath) {
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(absPath).mtimeMs; } catch (_) { /* unreadable -> defaults below */ }
  const cached = HOOK_META_CACHE.get(absPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached;
  let desc = '', lines = 0;
  try {
    const txt = readTextSafe(absPath);
    desc = extractHookDesc(txt);
    lines = txt.replace(/\r\n/g, '\n').split('\n').length;
  } catch (_) { /* fail-soft: empty desc, 0 lines */ }
  const entry = { mtimeMs, desc, lines };
  HOOK_META_CACHE.set(absPath, entry);
  return entry;
}

function apiHooks() {
  const out = { total: null, wired: [], dormant: [], hooks: [] };
  const errors = [];

  // Time-box the metadata cache: drop everything periodically so a deleted hook
  // file (or an edited comment) can't linger forever. mtime still invalidates
  // individual entries between sweeps; this just bounds the staleness window.
  if (Date.now() - HOOK_META_CACHE_AT > HOOK_META_TTL_MS) {
    HOOK_META_CACHE = new Map();
    HOOK_META_CACHE_AT = Date.now();
  }

  // Scan one .claude tree: parse its settings.json, collect referenced command
  // basenames AND the per-event wiring, then list its *.js / *.mjs hook files.
  // A file is "wired" iff referenced in THIS tree's settings. Fail-soft per tree
  // (a read error on one tree must not crash or block the other tree).
  const eventsByName = new Map(); // basename -> Set(events) across BOTH trees
  function scanTree(label, settingsPath, hooksDirPath) {
    const referenced = new Set();
    try {
      const settings = JSON.parse(readTextSafe(settingsPath));
      collectHookCommandFilenames(settings.hooks || {}, referenced);
      collectHookEventsFromSettings(settings.hooks || {}, eventsByName);
    } catch (e) {
      errors.push(label + ' settings.json: ' + e.message);
    }
    let hookFiles = [];
    try {
      hookFiles = fs
        .readdirSync(hooksDirPath)
        // PHASE 4: include .mjs hooks too (the previous .js-only filter hid
        // real hooks like verify-server-boot.mjs / doc-drift-judge-run.mjs).
        .filter((f) => /\.(?:js|mjs)$/i.test(f));
    } catch (e) {
      errors.push(label + ' hooks dir: ' + e.message);
    }
    return { referenced, hookFiles, hooksDirPath };
  }

  const project = scanTree('project', PATHS.settings, PATHS.hooksDir);
  const global = scanTree(
    'global',
    path.join(USER_CLAUDE, 'settings.json'),
    path.join(USER_CLAUDE, 'hooks')
  );

  // Dedupe across trees by filename into a unified list.
  // scope: 'project' | 'global' | 'both'  (which trees the FILE is present in)
  // wired: true if referenced in ANY tree it appears in.
  // dir:   absolute path to the file in ONE present tree (project wins) so we can
  //        read its desc/line-count.
  const byName = new Map();
  function ingest(scopeTag, tree) {
    for (const f of tree.hookFiles) {
      const entry = byName.get(f) || {
        name: f, inProject: false, inGlobal: false, wired: false, absPath: null,
      };
      if (scopeTag === 'project') { entry.inProject = true; if (!entry.absPath) entry.absPath = path.join(tree.hooksDirPath, f); }
      if (scopeTag === 'global') { entry.inGlobal = true; if (!entry.absPath) entry.absPath = path.join(tree.hooksDirPath, f); }
      if (tree.referenced.has(f)) entry.wired = true;
      byName.set(f, entry);
    }
  }
  ingest('project', project);
  ingest('global', global);

  const orderIdx = (ev) => {
    const i = CANONICAL_EVENT_ORDER.indexOf(ev);
    return i === -1 ? CANONICAL_EVENT_ORDER.length : i;
  };

  // D-13: "support" files live in hooks/ but are NOT wireable hooks — libraries
  // require()'d by hooks (lib-*), the regression harness (_test-*), and workers
  // spawned/shelled BY hooks (doc-drift-judge-run.mjs from block-doc-action-drift.js,
  // verify-server-boot.mjs from block-unfounded-boot-claim.js). Rendering them as
  // "dormant" reads as neglect. Classify by basename, but ONLY when no settings
  // tree references the file — an explicit wiring always wins over the name rule.
  const SUPPORT_BASENAMES = new Set(['doc-drift-judge-run.mjs', 'verify-server-boot.mjs']);
  const isSupportName = (n) => /^_/.test(n) || /^lib-/i.test(n) || SUPPORT_BASENAMES.has(n);
  const referencedAnywhere = (n) => project.referenced.has(n) || global.referenced.has(n);

  const hooks = [];
  for (const e of byName.values()) {
    const scope = e.inProject && e.inGlobal ? 'both' : (e.inGlobal ? 'global' : 'project');
    const events = eventsByName.has(e.name)
      ? [...eventsByName.get(e.name)].sort((a, b) => orderIdx(a) - orderIdx(b) || a.localeCompare(b))
      : [];
    const meta = e.absPath ? hookMeta(e.absPath) : { desc: '', lines: 0 };
    hooks.push({
      name: e.name,
      scope,
      wired: e.wired,
      support: isSupportName(e.name) && !referencedAnywhere(e.name),
      events,
      desc: meta.desc || '',
      lines: meta.lines || 0,
      complexity: complexityBucket(meta.lines || 0),
    });
  }
  // Wired first, then by name. (The frontend re-sorts anyway, but a stable,
  // sensible default helps any other consumer.)
  hooks.sort((a, b) =>
    a.wired === b.wired ? a.name.localeCompare(b.name) : (a.wired ? -1 : 1)
  );

  // Full enriched list (NOT truncated — the card scrolls internally).
  out.hooks = hooks;
  out.total = hooks.length;
  // Backward-compatible string arrays so older readers (e.g. the Features-tile
  // metric that counts `wired.length`) keep working. Support files are excluded
  // from `dormant` (they are not un-wired hooks) but stay in `hooks` above with
  // support:true, so nothing disappears from the full list. `wired` semantics
  // are unchanged (support files are never wired — see the classifier above).
  out.wired = hooks.filter((h) => h.wired).map((h) => h.name).sort();
  out.dormant = hooks.filter((h) => !h.wired && !h.support).map((h) => h.name).sort();
  if (errors.length) out.error = errors.join(' | ');
  return out;
}

// ---------------------------------------------------------------------------
// Skill last-run cache (PHASE 3 drill-in: per-skill lastRun + gateCount)
// ---------------------------------------------------------------------------
//
// lastRun = the most-recent timestamp a `Skill` tool-use referenced a skill,
// scanned out of the session transcripts under ~/.claude/projects/**/*.jsonl.
//
// CRITICAL: the scan is NEVER on the request path. A synchronous multi-thousand-
// file scan blocks the single-threaded event loop and makes EVERY endpoint flap
// "unreachable" (this exact failure already happened with the gates log). Instead
// a module-level cache `SKILL_LASTRUN` is refreshed:
//   - once shortly after startup (kicked off from server.listen, non-blocking), and
//   - every SKILL_REFRESH_MS (~10 min) by setInterval.
// apiSkills() only READS the cache — O(1), no I/O on the request.
//
// Scope of the scan (honest caps):
//   - only transcripts whose mtime is within SKILL_SCAN_WINDOW_DAYS (120d),
//   - newest-mtime first, capped at SKILL_MAX_FILES files and SKILL_MAX_TOTAL_BYTES total,
//   - each file is streamed line-by-line (readline yields to the event loop, so the
//     refresh never hard-blocks); a cheap `indexOf('"name":"Skill"')` pre-filter means
//     JSON.parse fires only on the handful of lines that actually carry a Skill use.
// A skill with no recorded Skill tool-use gets lastRun = null ("never seen").
// Verified over the REAL corpus (2.39 GB / 5008 files, ~13s): finds 50 Skill
// tool-uses across 17 skills, matching a full ground-truth parse exactly. See
// _phase3-isolated-test.mjs for the standalone proof harness.

const SKILL_SCAN_WINDOW_DAYS = 120;
const SKILL_MAX_FILES = 8000;                        // > current 5008; headroom, still bounded
const SKILL_MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024; // total-bytes safety ceiling per refresh
const SKILL_REFRESH_MS = 10 * 60 * 1000;             // ~10 min
const SKILL_MARK = '"name":"Skill"';

let SKILL_LASTRUN = {};       // { skillName -> epoch ms } — most-recent Skill tool-use
let SKILL_LASTRUN_META = { refreshedAt: 0, filesScanned: 0, totalUses: 0, scanning: false, capped: false };

function listSkillTranscripts() {
  const out = [];
  const cutoff = Date.now() - SKILL_SCAN_WINDOW_DAYS * 86400000;
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          const st = fs.statSync(full);
          if (st.mtimeMs >= cutoff) out.push({ full, mtimeMs: st.mtimeMs, size: st.size });
        } catch { /* skip unreadable */ }
      }
    }
  };
  walk(PROJECTS_DIR);
  out.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first so the cap keeps the recent ones
  return out.slice(0, SKILL_MAX_FILES);
}

function scanSkillFile(file, lastRun) {
  return new Promise((resolve) => {
    let uses = 0;
    let rl;
    try {
      rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    } catch { resolve(0); return; }
    rl.on('line', (line) => {
      if (line.indexOf(SKILL_MARK) === -1) return; // cheap pre-filter; JSON.parse only on hits
      let obj;
      try { obj = JSON.parse(line); } catch { return; }
      const ts = obj && obj.timestamp ? Date.parse(obj.timestamp) : NaN;
      if (!Number.isFinite(ts)) return;
      const content = obj && obj.message && Array.isArray(obj.message.content) ? obj.message.content : [];
      for (const c of content) {
        if (c && c.type === 'tool_use' && c.name === 'Skill' && c.input && c.input.skill) {
          const sk = String(c.input.skill);
          uses++;
          if (!lastRun[sk] || ts > lastRun[sk]) lastRun[sk] = ts;
        }
      }
    });
    rl.on('close', () => resolve(uses));
    rl.on('error', () => resolve(uses));
  });
}

// Refresh the lastRun cache. async + awaited per file so readline yields to the event
// loop between files — the refresh runs "in the background" without hard-blocking requests.
async function refreshSkillLastRun() {
  if (SKILL_LASTRUN_META.scanning) return; // never overlap two scans
  SKILL_LASTRUN_META.scanning = true;
  try {
    const lastRun = {};
    let files;
    try { files = listSkillTranscripts(); } catch { files = []; }
    let bytes = 0, scanned = 0, total = 0, capped = false;
    for (const f of files) {
      if (bytes + f.size > SKILL_MAX_TOTAL_BYTES) { capped = true; break; }
      bytes += f.size; scanned++;
      try { total += await scanSkillFile(f.full, lastRun); } catch { /* fail-soft per file */ }
    }
    SKILL_LASTRUN = lastRun; // atomic swap — readers always see a complete map
    SKILL_LASTRUN_META = { refreshedAt: Date.now(), filesScanned: scanned, totalUses: total, scanning: false, capped };
  } catch (_) {
    SKILL_LASTRUN_META.scanning = false;
  }
}

// gateCount (complexity) — CHEAP, request-path safe. The "most representative" gate count
// per skill, taken as the MAX of three sources (different skills register gates differently
// on this Windows setup, where frontmatter `hooks:` fail-open so gates live in settings.json):
//   1. live ~/ace/.claude/settings.json — # of PreToolUse/PostToolUse/Stop hook command
//      entries whose command references this skill's scripts dir (the authoritative wired set),
//   2. scripts/_settings-patch.json `hooks_entries` length (a churn-proof backup record some skills keep),
//   3. # of verify-*.{mjs,js} / block-*.{mjs,js} gate scripts in scripts/ (and scripts/hooks/).
// 0 if a skill registers no gates. settings.json is one small file + a handful of statReaddir
// calls — negligible per request; cached once per apiSkills() call below.
function buildSettingsGateCounts() {
  const counts = {};
  try {
    const cfg = JSON.parse(stripBom(fs.readFileSync(PATHS.settings, 'utf8')));
    const hooks = cfg.hooks || {};
    for (const event of Object.keys(hooks)) {
      const blocks = Array.isArray(hooks[event]) ? hooks[event] : [];
      for (const b of blocks)
        for (const h of (Array.isArray(b.hooks) ? b.hooks : [])) {
          const m = String(h.command || '').match(/skills[\\/]+([^\\/]+)[\\/]+scripts/);
          if (m) counts[m[1]] = (counts[m[1]] || 0) + 1;
        }
    }
  } catch (_) { /* fail-soft — no settings = no wired counts */ }
  return counts;
}
function skillPatchEntryCount(skillDir) {
  try {
    const j = JSON.parse(stripBom(fs.readFileSync(path.join(skillDir, 'scripts', '_settings-patch.json'), 'utf8')));
    if (Array.isArray(j.hooks_entries)) return j.hooks_entries.length;
  } catch (_) {}
  return 0;
}
function skillGateFileCount(skillDir) {
  const isGate = (f) => /^(verify|block)-.*\.(mjs|js)$/.test(f);
  let n = 0;
  const walk = (dir, depth) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isFile() && isGate(e.name)) n++;
      else if (e.isDirectory() && depth === 0 && e.name === 'hooks') walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(path.join(skillDir, 'scripts'), 0);
  return n;
}
function computeGateCount(skillDirName, settingsCounts) {
  const dir = path.join(PATHS.skillsDir, skillDirName);
  return Math.max(settingsCounts[skillDirName] || 0, skillPatchEntryCount(dir), skillGateFileCount(dir), 0);
}

// ---------------------------------------------------------------------------
// /api/skills — auto-discover skills from each SKILL.md frontmatter
// ---------------------------------------------------------------------------

function apiSkills() {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(PATHS.skillsDir, { withFileTypes: true });
  } catch (e) {
    return { error: 'skills dir: ' + e.message };
  }

  // gateCount sources are cheap but shared across all skills — compute the
  // settings.json wired-counts ONCE per request, then reuse per skill.
  const settingsCounts = buildSettingsGateCounts();

  // lastRun is read from the pre-warmed module cache (NEVER scanned here). The
  // transcript records the skill by its INVOCATION SLUG (input.skill), which is
  // normally the directory name; look up by both the frontmatter name and the
  // dir name so a name/slug mismatch still resolves.
  const lastRunOf = (fmName, dirName) => {
    const a = fmName != null ? SKILL_LASTRUN[fmName] : undefined;
    const b = SKILL_LASTRUN[dirName];
    const v = (a != null && b != null) ? Math.max(a, b) : (a != null ? a : b);
    return (v != null) ? v : null; // null = "never seen" in any scanned transcript
  };

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const skillMd = path.join(PATHS.skillsDir, ent.name, 'SKILL.md');
    try {
      if (!fs.existsSync(skillMd)) continue;
      const fm = parseFrontmatter(readTextSafe(skillMd));
      out.push({
        name: fm.name || ent.name,
        domain: fm.domain || 'uncategorized',
        description: fm.description || '',
        lastRun: lastRunOf(fm.name, ent.name),       // epoch ms, or null if never seen
        gateCount: computeGateCount(ent.name, settingsCounts), // complexity = # gates registered
      });
    } catch (e) {
      // Fail-soft per skill: record the dir with an error rather than dropping it.
      out.push({ name: ent.name, domain: 'uncategorized', description: '', lastRun: null, gateCount: 0, error: e.message });
    }
  }

  // Sortable/groupable by domain, then name (stable, deterministic order).
  out.sort((a, b) => {
    if (a.domain !== b.domain) return a.domain < b.domain ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return out;
}

// ---------------------------------------------------------------------------
// /api/gates — LIVE gate telemetry (the /api/spend stub was removed in this fork)
// ---------------------------------------------------------------------------

// LIVE gate telemetry — reads the real proof-of-work audit log so the cockpit shows
// the deterministic gates actually firing (ALLOW/BLOCK), not a stub.
function apiGates() {
  const HOME = String(process.env.USERPROFILE || os.homedir()).replace(/\\/g, '/');
  const log = path.join(HOME, '.claude', 'hook-audit.log');
  try {
    const raw = fs.readFileSync(log, 'utf8');
    // Bucket by the local calendar day (DASH_TZ), NOT UTC.
    // Compute the day's UTC window ONCE, then cheap string-compare per line. (Calling
    // toLocaleDateString per log line blocked the single-threaded event loop ~2.5s on a 37k-line
    // log — endpoints flapped "unreachable". ISO timestamps sort lexicographically so >=/< works.)
    const TZ = DASH_TZ;
    const _ref = new Date();
    const _offsetMs = new Date(_ref.toLocaleString('en-US', { timeZone: 'UTC' })).getTime() - new Date(_ref.toLocaleString('en-US', { timeZone: TZ })).getTime();
    const _todayLocal = _ref.toLocaleDateString('en-CA', { timeZone: TZ });
    const _startUtcMs = Date.parse(_todayLocal + 'T00:00:00Z') + _offsetMs;
    const startISO = new Date(_startUtcMs).toISOString();
    const endISO = new Date(_startUtcMs + 86400000).toISOString();
    let allow = 0, block = 0;
    const byGate = {}; // per-gate today tallies: { [gate]: { allow, block } }
    const recent = [];
    // doc-drift runs in SHADOW mode — it never BLOCKs, so allow/block is meaningless.
    // The real signal is the verdict= embedded in the reason. Summarize TODAY's doc-drift
    // lines by verdict, and capture the most-recent `drifted` catches (docs + reason text).
    const drift = { drifted: 0, compliant: 0, unverifiable: 0 };
    const driftEvents = []; // chronological `drifted` catches today: { ts, docs, reason }
    for (const l of raw.split('\n')) {
      const m = l.match(/^\[([^\]]+)\]\s*\[([^\]]+)\]\s*(ALLOW|BLOCK):\s*(.*)$/);
      if (!m) continue;
      const ts = m[1], gate = m[2], decision = m[3], reason = m[4];
      if (ts >= startISO && ts < endISO) {
        if (decision === 'ALLOW') allow++; else block++;
        const g = byGate[gate] || (byGate[gate] = { allow: 0, block: 0 });
        if (decision === 'ALLOW') g.allow++; else g.block++;
        if (gate === 'doc-drift') {
          const vm = reason.match(/verdict=(\w+)/);
          const verdict = vm ? vm[1] : '';
          if (verdict && Object.prototype.hasOwnProperty.call(drift, verdict)) drift[verdict]++;
          if (verdict === 'drifted') {
            const dm = reason.match(/docs=\[([^\]]*)\]/);
            const docs = dm ? dm[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
            const rm = reason.match(/reason="([^"]*)"/);
            const human = rm ? rm[1].slice(0, 180) : '';
            driftEvents.push({ ts, docs, reason: human });
          }
        }
      }
      recent.push({ ts, gate, decision, reason: reason.slice(0, 140) });
    }
    const recentDrifts = driftEvents.slice(-6).reverse(); // newest first, up to 6
    const docDrift = { drifted: drift.drifted, compliant: drift.compliant, unverifiable: drift.unverifiable, recentDrifts };
    return { status: 'live', today: { allow, block, total: allow + block }, byGate, docDrift, recent: recent.slice(-14).reverse(), source: 'hook-audit.log' };
  } catch (e) {
    return { status: 'error', error: e.message, note: 'no audit log yet — gates log on first Stop/SubagentStop decision' };
  }
}

// ---------------------------------------------------------------------------
// /api/gates-compare — REAL gate telemetry comparison of two periods.
// Default: period A = today (Pacific), period B = yesterday (Pacific). The owner can set a custom
// baseline (?day=YYYY-MM-DD compares today vs that Pacific day) or arbitrary ranges
// (?aFrom&aTo&bFrom&bTo as epoch-ms). For EACH period: total ALLOW, total BLOCK, block-rate, and
// per-gate {allow,block}. Plus deltas (today minus baseline) on total blocks, block-rate, and per-gate.
//
// Performance discipline (mirrors apiGates): bucket BOTH periods by precomputed [startISO,endISO)
// UTC windows derived from the owner's Pacific local day — then a SINGLE pass over the log does cheap
// string compares per line (NO toLocaleDateString per line; that blocked the loop ~2.5s on the 37k
// line log). The log is read ONCE and bucketed into both windows in that one pass. Cache ~30s on the
// DEFAULT (today-vs-yesterday) path; custom ranges compute fresh.
// ---------------------------------------------------------------------------
const GATES_CMP_TTL = 30 * 1000;
let _gatesCmpCache = { data: null, ts: 0, key: '' };

// Pacific-local-day [startISO,endISO) UTC window for a given Pacific calendar day (YYYY-MM-DD).
// Reuses the exact offset trick apiGates() uses (DST-safe: offset is recomputed per day, and since the
// window is for that specific day it reflects that day's standard/daylight offset).
function pacificDayWindowISO(dayYmd, TZ) {
  const ref = new Date(dayYmd + 'T12:00:00Z'); // midday anchor → robust against either side of a DST flip
  const offsetMs = new Date(ref.toLocaleString('en-US', { timeZone: 'UTC' })).getTime()
                 - new Date(ref.toLocaleString('en-US', { timeZone: TZ })).getTime();
  const startUtcMs = Date.parse(dayYmd + 'T00:00:00Z') + offsetMs;
  return {
    fromMs: startUtcMs,
    toMs: startUtcMs + 86400000,
    startISO: new Date(startUtcMs).toISOString(),
    endISO: new Date(startUtcMs + 86400000).toISOString(),
  };
}
// The Pacific calendar day (YYYY-MM-DD) that `ms` falls in, optionally shifted by `dayDelta` days.
function pacificYmd(ms, TZ, dayDelta) {
  return new Date(ms + (dayDelta || 0) * 86400000).toLocaleDateString('en-CA', { timeZone: TZ });
}

function apiGatesCompare(opts) {
  opts = opts || {};
  const HOME = String(process.env.USERPROFILE || os.homedir()).replace(/\\/g, '/');
  const log = path.join(HOME, '.claude', 'hook-audit.log');
  const TZ = DASH_TZ;
  const now = Date.now();

  // ----- Resolve the two periods (A = "current", B = "baseline") -----
  // Priority: explicit epoch ranges (aFrom/aTo/bFrom/bTo) > ?day=… (today vs that day) > default (today vs yesterday).
  let A, B; // each: { label, fromMs, toMs, startISO, endISO }
  const fin = (n) => typeof n === 'number' && isFinite(n);
  const winFromRange = (fromMs, toMs, label) => ({
    label, fromMs, toMs, startISO: new Date(fromMs).toISOString(), endISO: new Date(toMs).toISOString(),
  });
  if (fin(opts.aFrom) && fin(opts.aTo) && fin(opts.bFrom) && fin(opts.bTo) && opts.aTo > opts.aFrom && opts.bTo > opts.bFrom) {
    const dfmt = (ms) => new Date(ms).toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric' });
    A = winFromRange(opts.aFrom, opts.aTo, dfmt(opts.aFrom) + (pacificYmd(opts.aFrom, TZ) === pacificYmd(opts.aTo - 1, TZ) ? '' : '–' + dfmt(opts.aTo - 1)));
    B = winFromRange(opts.bFrom, opts.bTo, dfmt(opts.bFrom) + (pacificYmd(opts.bFrom, TZ) === pacificYmd(opts.bTo - 1, TZ) ? '' : '–' + dfmt(opts.bTo - 1)));
  } else {
    const todayYmd = pacificYmd(now, TZ, 0);
    const aWin = pacificDayWindowISO(todayYmd, TZ);
    A = { label: 'Today', ...aWin };
    let baselineYmd;
    if (typeof opts.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.day) && opts.day !== todayYmd) {
      baselineYmd = opts.day;
    } else {
      baselineYmd = pacificYmd(now, TZ, -1); // yesterday (Pacific)
    }
    const bWin = pacificDayWindowISO(baselineYmd, TZ);
    const isYesterday = baselineYmd === pacificYmd(now, TZ, -1);
    B = { label: isYesterday ? 'Yesterday' : baselineYmd, ...bWin };
  }

  // ----- Read log ONCE, bucket into BOTH windows in a single pass (cheap ISO string compares) -----
  let raw;
  try {
    raw = fs.readFileSync(log, 'utf8');
  } catch (e) {
    return { status: 'error', error: e.message, note: 'no audit log yet — gates log on first Stop/SubagentStop decision' };
  }
  const blank = () => ({ allow: 0, block: 0, byGate: {} });
  const accA = blank(), accB = blank();
  const bump = (acc, gate, decision) => {
    if (decision === 'ALLOW') acc.allow++; else acc.block++;
    const g = acc.byGate[gate] || (acc.byGate[gate] = { allow: 0, block: 0 });
    if (decision === 'ALLOW') g.allow++; else g.block++;
  };
  for (const l of raw.split('\n')) {
    const m = l.match(/^\[([^\]]+)\]\s*\[([^\]]+)\]\s*(ALLOW|BLOCK):/);
    if (!m) continue;
    const ts = m[1], gate = m[2], decision = m[3];
    if (ts >= A.startISO && ts < A.endISO) bump(accA, gate, decision);
    if (ts >= B.startISO && ts < B.endISO) bump(accB, gate, decision);
  }

  const rate = (a) => { const t = a.allow + a.block; return t ? Math.round((a.block / t) * 1000) / 10 : 0; };
  const shape = (acc, win) => ({
    label: win.label, from: win.fromMs, to: win.toMs,
    allow: acc.allow, block: acc.block, total: acc.allow + acc.block,
    blockRatePct: rate(acc), byGate: acc.byGate,
  });
  const a = shape(accA, A), b = shape(accB, B);

  // ----- Deltas (A minus B): blocks, block-rate, per-gate block delta -----
  const perGate = {};
  const gates = new Set([...Object.keys(accA.byGate), ...Object.keys(accB.byGate)]);
  for (const g of gates) {
    const ga = accA.byGate[g] || { allow: 0, block: 0 };
    const gb = accB.byGate[g] || { allow: 0, block: 0 };
    perGate[g] = {
      aAllow: ga.allow, aBlock: ga.block, bAllow: gb.allow, bBlock: gb.block,
      blockDelta: ga.block - gb.block,
    };
  }
  const deltas = {
    blockDelta: a.block - b.block,
    blockRateDeltaPct: Math.round((a.blockRatePct - b.blockRatePct) * 10) / 10,
    perGate,
  };

  return { status: 'live', a, b, deltas, tz: TZ, source: 'hook-audit.log', ts: now };
}

function apiGatesCompareCached(opts, isDefault) {
  if (!isDefault) return apiGatesCompare(opts);
  const now = Date.now();
  // The default key is stable within the TTL window AND across a Pacific-day rollover (encode today's
  // Pacific day so the cache invalidates when "today" advances).
  const TZ = DASH_TZ;
  const key = 'default:' + new Date(now).toLocaleDateString('en-CA', { timeZone: TZ });
  if (_gatesCmpCache.data && _gatesCmpCache.key === key && now - _gatesCmpCache.ts < GATES_CMP_TTL) {
    return { ..._gatesCmpCache.data, cached: true };
  }
  const data = apiGatesCompare(opts);
  _gatesCmpCache = { data, ts: now, key };
  return data;
}


// GATE FIELD — CUMULATIVE gate telemetry for the brain's ambient "gate field" visual.
// Same audit log as apiGates(), but counts the FULL history (not just today) so the
// green-lightning / purple-nebula field GROWS over time instead of resetting daily.
// Reads at most the last GATE_FIELD_CAP bytes for safety (the file is append-only, so
// the tail is the newest decisions; older history beyond the cap is intentionally dropped).
// Fail-soft: any error returns an { error } field, never throws — the server must not crash.
// GET /api/files?path=<relative> — read-only listing of the ace workspace tree (confined to ROOT).
// GET /api/file-read?path=<rel> — bounded, read-only file TEXT for the Zone-4 compare pane (verify an
// agent's edit against its claimed change). Same workspace-jail as apiFiles; caps size; rejects binaries.
// Resolve a workspace-relative path and CONFINE it to ROOT. Uses path.resolve (collapses EVERY ../,
// not a one-pass regex) + a SEPARATOR-ANCHORED boundary so siblings like `ace_tree.json` can't slip past a
// bare prefix match. Returns the absolute path, or null if it escapes the jail.
function jailToRoot(rel) {
  const rootResolved = path.resolve(ROOT);
  const abs = path.resolve(rootResolved, String(rel || '').replace(/\\/g, '/').replace(/^\/+/, ''));
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) return null;
  return abs;
}
// The cockpit must NEVER serve secret-bearing files — the file-read pane would otherwise leak credentials.
function isSecretPath(abs) {
  const b = path.basename(abs).toLowerCase();
  const norm = String(abs).replace(/\\/g, '/').toLowerCase();
  if (/^\.?(mcp\.json|chat-token|chat-enabled|credentials\.json|env|netrc|npmrc)$/.test(b)) return true;
  if (b === 'settings.local.json' || b === '.credentials.json' || b === 'sessions.json') return true;
  if (b === '.session-secret') return true;                       // D-2: session secret
  if (/^\.env(\..+)?$/.test(b)) return true;                      // D-2: .env / .env.local / .env.production / .env.* variants
  if (/[-._]key.*\.json$/.test(b)) return true;                   // D-2: gcp-key.json, service_account_key.json, etc.
  if (/\.(key|pem|pfx|p12|crt)$/.test(b)) return true;
  if (/\/credentials\//.test(norm)) return true;                  // D-2: any file under a credentials/ path segment
  if (/[\\/]\.git[\\/]/.test(abs)) return true;
  return false;
}
function apiFileRead(rel) {
  const abs = jailToRoot(rel);
  if (!abs) return { path: rel || '', error: 'out of bounds' };
  if (isSecretPath(abs)) return { path: rel || '', error: 'refused: secret-bearing file (not served)' };
  try {
    const st = fs.statSync(abs);
    if (st.isDirectory()) return { path: rel, error: 'is a directory' };
    const CAP = 256 * 1024;
    const fd = fs.openSync(abs, 'r'); const buf = Buffer.alloc(Math.min(CAP, st.size));
    const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
    const text = buf.slice(0, n).toString('utf8');
    if (text.indexOf(String.fromCharCode(0)) >= 0) return { path: rel, size: st.size, binary: true };
    return { path: rel, size: st.size, truncated: st.size > CAP, text };
  } catch (e) { return { path: rel, error: e.message }; }
}
function apiFiles(rel) {
  const safe = String(rel || '').replace(/\\/g, '/').replace(/\.\.(\/|$)/g, '').replace(/^\/+/, '').replace(/\/+$/, '');
  const abs = jailToRoot(safe);
  if (!abs) return { path: '', entries: [], error: 'out of bounds' };   // path.resolve + separator-anchored jail (no prefix-match escape)
  let entries = [];
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.name !== '.git' && e.name !== 'node_modules' && !e.name.startsWith('.DS'))
      .map((e) => { let size = 0, mtime = 0; try { const st = fs.statSync(path.join(abs, e.name)); size = e.isFile() ? st.size : 0; mtime = st.mtimeMs; } catch (_) {} return { name: e.name, dir: e.isDirectory(), size, mtime }; })
      .sort((a, b) => (Number(b.dir) - Number(a.dir)) || a.name.localeCompare(b.name));
  } catch (e) { return { path: safe, entries: [], error: e.code || 'read error' }; }
  return { path: safe, entries: entries.slice(0, 800) };
}

function apiGateField() {
  const HOME = String(process.env.USERPROFILE || os.homedir()).replace(/\\/g, '/');
  const log = path.join(HOME, '.claude', 'hook-audit.log');
  const GATE_FIELD_CAP = 16 * 1024 * 1024; // 16 MB safety cap on the read
  try {
    let raw;
    const st = fs.statSync(log);
    if (st.size > GATE_FIELD_CAP) {
      // Read only the trailing GATE_FIELD_CAP bytes (newest decisions).
      const fd = fs.openSync(log, 'r');
      try {
        const buf = Buffer.alloc(GATE_FIELD_CAP);
        fs.readSync(fd, buf, 0, GATE_FIELD_CAP, st.size - GATE_FIELD_CAP);
        raw = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
      // Drop a possibly-partial first line.
      const nl = raw.indexOf('\n');
      if (nl >= 0) raw = raw.slice(nl + 1);
    } else {
      raw = fs.readFileSync(log, 'utf8');
    }
    let allow = 0, block = 0;
    for (const l of raw.split('\n')) {
      const m = l.match(/\]\s*(ALLOW|BLOCK):/);
      if (!m) continue;
      if (m[1] === 'ALLOW') allow++; else block++;
    }
    return { status: 'live', allow, block, total: allow + block, capped: st.size > GATE_FIELD_CAP, source: 'hook-audit.log' };
  } catch (e) {
    return { status: 'error', error: e.message, allow: 0, block: 0 };
  }
}

// ---------------------------------------------------------------------------
// POST /trigger — spawn `claude -p "<prompt>"` (localhost-only, capped output)
// ---------------------------------------------------------------------------

function handleTrigger(req, res) {
  let body = '';
  let tooBig = false;
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1024 * 64) {
      tooBig = true;
      req.destroy();
    }
  });
  req.on('error', () => {
    if (!res.headersSent) sendJson(res, 400, { error: 'request stream error' });
  });
  req.on('end', () => {
    if (tooBig) return sendJson(res, 413, { error: 'prompt too large' });

    let prompt;
    try {
      const parsed = JSON.parse(body || '{}');
      prompt = parsed.prompt;
    } catch (e) {
      return sendJson(res, 400, { error: 'invalid JSON body: ' + e.message });
    }
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      return sendJson(res, 400, { error: 'body.prompt (non-empty string) required' });
    }

    // SECURITY: the `claude -p` spawn is an RCE surface. Gated behind the SAME owner opt-in
    // flag as chat (Code/os-dashboard/.chat-enabled) + the loopback guard above.
    if (!chatEnabled()) return sendJson(res, 403, { error: 'trigger disabled', note: 'enable by creating Code/os-dashboard/.chat-enabled (the same flag that enables chat).' });

    // Spawn claude without a shell; pass the prompt as a discrete argv element
    // so there is no shell-injection surface from the prompt text.
    let child;
    try {
      child = spawn('claude', ['-p', prompt], {
        cwd: ROOT,
        windowsHide: true,
        shell: false,
      });
    } catch (e) {
      return sendJson(res, 500, { error: 'spawn failed: ' + e.message });
    }

    let out = '';
    let err = '';
    let capped = false;
    let settled = false;

    const finish = (status, payload) => {
      if (settled) return;
      settled = true;
      sendJson(res, status, payload);
    };

    child.stdout.on('data', (d) => {
      if (out.length < TRIGGER_OUTPUT_CAP) out += d;
      else capped = true;
    });
    child.stderr.on('data', (d) => {
      if (err.length < TRIGGER_OUTPUT_CAP) err += d;
      else capped = true;
    });
    child.on('error', (e) => {
      finish(500, { error: 'claude process error: ' + e.message });
    });
    child.on('close', (code) => {
      finish(200, {
        output: out.slice(0, TRIGGER_OUTPUT_CAP),
        stderr: err.slice(0, TRIGGER_OUTPUT_CAP),
        exitCode: code,
        capped,
      });
    });

    // Hard wall-clock ceiling so a hung agent can't hold the socket forever.
    const killTimer = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {}
      finish(200, {
        output: out.slice(0, TRIGGER_OUTPUT_CAP),
        stderr: err.slice(0, TRIGGER_OUTPUT_CAP),
        exitCode: null,
        capped,
        timedOut: true,
      });
    }, 10 * 60 * 1000);
    child.on('close', () => clearTimeout(killTimer));
  });
}

// ---------------------------------------------------------------------------
// GET / — serve index.html
// ---------------------------------------------------------------------------

function serveIndex(res) {
  fs.readFile(PATHS.indexHtml, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('index.html not found at ' + PATHS.indexHtml);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// NEUROGALAXY live-brain layer — activity SSE + ambient stars + vendored three.js.
// All append-only in-memory state. Spawns NOTHING, writes NO files. The POST is
// strictly less privileged than the disabled /trigger and shares the loopback guard.
// ---------------------------------------------------------------------------
const sseClients = new Set();
const ACTIVITY = []; // bounded ring, last 64 events

function broadcast(evt) {
  const line = 'data: ' + JSON.stringify(evt) + '\n\n';
  for (const res of sseClients) { try { res.write(line); } catch (_) { sseClients.delete(res); } }
}

// /api/stars — ambient galaxy dust. Sample ~2400 of the .md pool to deterministic
// hashed xyz, computed ONCE / 60s cache so it never sits on the /api/graph hot path.
let STARS_CACHE = null, STARS_AT = 0;
function buildStars() {
  const h01 = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; };
  const paths = [];
  const SKIP = new Set(['node_modules', '.git', '_archive', '_quarantine', 'logs', '.venv', '__pycache__', '_sunset', '.obsidian', '.playwright-mcp']);
  (function walk(dir, depth) {
    if (depth > 6 || paths.length > 20000) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (e.name.startsWith('.') && e.name !== '.claude') continue;
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(fp, depth + 1); }
      else if (e.name.toLowerCase().endsWith('.md')) paths.push(fp);
    }
  })(ROOT, 0);
  const step = Math.max(1, Math.floor(paths.length / 2400)), stars = [];
  for (let i = 0; i < paths.length && stars.length < 2400; i += step) {
    const s = paths[i], a = h01(s + 'a'), b = h01(s + 'b'), c = h01(s + 'c'), d = h01(s + 'd');
    const rr = Math.pow(d, 1.7) * 27, th = a * 6.2831, ph = Math.acos(2 * b - 1);
    stars.push({ x: +(Math.sin(ph) * Math.cos(th) * rr).toFixed(2), y: +(Math.sin(ph) * Math.sin(th) * rr).toFixed(2), z: +(Math.cos(ph) * rr).toFixed(2), b: +(0.24 + c * 0.55).toFixed(2) });
  }
  return { stars, count: stars.length, pool: paths.length };
}
function apiStars() {
  const now = Date.now();
  if (!STARS_CACHE || now - STARS_AT > 60000) { try { STARS_CACHE = buildStars(); } catch (e) { STARS_CACHE = { stars: [], count: 0, error: e.message }; } STARS_AT = now; }
  return STARS_CACHE;
}

function serveVendorThree(res) {
  const p = path.join(__dirname, 'vendor', 'three.min.js');
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('three.min.js not vendored at ' + p); return; }
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': data.length });
    res.end(data);
  });
}

// GET /favicon.ico — a tiny self-contained inline SVG icon so browsers stop logging a standing 404.
// (Palette left neutral on purpose — the visual reskin is a separate, owner-gated stage.)
const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#120d22"/><circle cx="8" cy="8" r="3.4" fill="#a78bfa"/></svg>';
function serveFavicon(res) {
  const body = Buffer.from(FAVICON_SVG);
  res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'max-age=86400', 'Content-Length': body.length });
  res.end(body);
}

// SSE — hand-rolled writeHead WITHOUT Content-Length (sendJson always sets it, which breaks a stream).
function sseStream(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 2000\n\n');
  res.write('data: ' + JSON.stringify({ kind: 'hello', ts: Date.now() }) + '\n\n');
  sseClients.add(res);
  const hb = setInterval(() => { try { res.write(':\n\n'); } catch (_) {} }, 15000);
  req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
}

// POST /api/activity — bounded body, whitelist {kind,text,seed}. Side effect = a flash, nothing more.
function postActivity(req, res) {
  let body = '', big = false;
  req.on('data', (c) => { body += c; if (body.length > 4096) { big = true; req.destroy(); } });
  req.on('error', () => { if (!res.headersSent) sendJson(res, 400, { error: 'stream error' }); });
  req.on('end', () => {
    if (big) return sendJson(res, 413, { error: 'too large' });
    let p; try { p = JSON.parse(body || '{}'); } catch (e) { return sendJson(res, 400, { error: 'bad json' }); }
    const kind = ['speak', 'respond', 'tool', 'think'].includes(p.kind) ? p.kind : 'think';
    const evt = { kind, text: String(p.text || '').slice(0, 200), seed: p.seed ? String(p.seed).slice(0, 120) : null, ts: Date.now() };
    ACTIVITY.push(evt); if (ACTIVITY.length > 64) ACTIVITY.shift();
    broadcast(evt);
    sendJson(res, 202, { ok: true, clients: sseClients.size });
  });
}

// ---------------------------------------------------------------------------
// BRAIN VIEW (/brain) — the 3D Cortex page (Code/os-dashboard/brain/) and its own live stream.
// /api/neurons is a SEPARATE SSE stream from /api/activity: the old NEUROGALAXY fires on every
// /api/activity event, so the detailed per-tool events go here and the old brain is untouched.
// One event per tool call in every watched session (no global throttle): which tool, which file
// path, note ids named in a shell command, a recall query, a skill. Never the command text itself
// or any file content. Loopback-only like every route; spawns nothing except the brain-data
// generator, which runs async, single-flight, only when a page asks for fresh data.
// ---------------------------------------------------------------------------
const neuronClients = new Set();
const NEURON_IDS = new Map(); // tool_use_id -> { tool, path }, bounded, so a failed tool's error can name its file
const ACE_SLUG_N = repoSlug(ROOT);
const HOME_SLUG_N = repoSlug(String(process.env.USERPROFILE || os.homedir()).replace(/\\/g, '/'));
const NOTE_ID_RE = /\b(?:feedback|project|reference|user)_[a-z0-9_]{3,}/gi;

function broadcastNeuron(evt) {
  const line = 'data: ' + JSON.stringify(evt) + '\n\n';
  for (const res of neuronClients) { try { res.write(line); } catch (_) { neuronClients.delete(res); } }
}

function sseNeurons(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 2000\n\n');
  res.write('data: ' + JSON.stringify({ kind: 'hello', ts: Date.now() }) + '\n\n');
  neuronClients.add(res);
  const hb = setInterval(() => { try { res.write(':\n\n'); } catch (_) {} }, 15000);
  req.on('close', () => { clearInterval(hb); neuronClients.delete(res); });
}

// Which session a transcript belongs to, from its path: projects/<slug>/<sid>.jsonl or
// projects/<slug>/<sid>/subagents/.../agent-<id>.jsonl.
function neuronWho(fp) {
  const parts = String(fp).replace(/\\/g, '/').split('/');
  const pi = parts.lastIndexOf('projects');
  const slug = parts[pi + 1] || '';
  const rest = parts.slice(pi + 2);
  const session = String(rest[0] || '').replace(/\.jsonl$/i, '').slice(0, 8);
  const last = rest.length > 1 ? String(rest[rest.length - 1]).replace(/\.jsonl$/i, '') : '';
  const folder = slug === HOME_SLUG_N ? 'home' : (slug === ACE_SLUG_N || SESS_PROJ_RE.test(slug)) ? 'ace' : 'other';
  return { session, agent: /^agent-/i.test(last) ? last.slice(0, 24) : null, folder };
}

function neuronFromToolUse(b, who) {
  const tool = String(b.name || '').slice(0, 60);
  const inp = b.input || {};
  let act = 'run', p = inp.file_path || inp.notebook_path || null, notes = [], recall = null, skill = null;
  if (/^(Read|NotebookRead)$/.test(tool)) act = 'read';
  else if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) act = 'write';
  else if (/^(Grep|Glob)$/.test(tool)) { act = 'search'; p = inp.path || null; }
  else if (tool === 'Skill') { act = 'skill'; skill = String(inp.skill || '').slice(0, 80) || null; }
  else if (/^(Agent|Task|Workflow)$/.test(tool)) act = 'spawn';
  else if (/^(Bash|PowerShell)$/.test(tool)) {
    const cmd = String(inp.command || '');
    const m = cmd.match(NOTE_ID_RE);
    if (m) notes = [...new Set(m.map((s) => s.toLowerCase()))].slice(0, 12);
    if (/\bMEMORY\.md\b/.test(cmd)) notes.push('MEMORY');
    const moc = cmd.match(/_(?:MOC-[A-Za-z0-9-]+|INDEX)\b/g);
    if (moc) for (const x of new Set(moc)) notes.push(x);
    const r = cmd.match(/recall\.mjs\s+["']([^"'\n]{1,120})["']/);
    if (r) { recall = r[1]; act = 'search'; }
  }
  return { kind: 'neuron', act, tool, path: p ? String(p).slice(0, 400) : null, notes, recall, skill, session: who.session, agent: who.agent, folder: who.folder, ts: Date.now() };
}

// Every tool call in the newly appended part of a transcript (at most 24 per append, last 512 KB).
function emitNeurons(fp, from, to) {
  const start = Math.max(from, to - 512 * 1024), len = to - start;
  if (len <= 0) return;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(fp, 'r');
  try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
  const who = neuronWho(fp);
  let n = 0;
  for (const line of buf.toString('utf8').split('\n')) {
    if (n >= 24) break;
    if (line.indexOf('"tool_use"') < 0 && line.indexOf('"is_error":true') < 0) continue; // cheap prefilter before JSON.parse
    let o; try { o = JSON.parse(line); } catch (_) { continue; } // a partial first line fails here and is skipped
    const c = o && o.message && o.message.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (n >= 24) break;
      if (b && b.type === 'tool_use') {
        const ev = neuronFromToolUse(b, who);
        NEURON_IDS.set(b.id, { tool: ev.tool, path: ev.path });
        if (NEURON_IDS.size > 400) NEURON_IDS.delete(NEURON_IDS.keys().next().value);
        broadcastNeuron(ev); n++;
      } else if (b && b.type === 'tool_result' && b.is_error === true) {
        const t = NEURON_IDS.get(b.tool_use_id);
        broadcastNeuron({ kind: 'neuron', act: 'error', tool: t ? t.tool : null, path: t ? t.path : null, notes: [], recall: null, skill: null, session: who.session, agent: who.agent, folder: who.folder, ts: Date.now() });
        n++;
      }
    }
  }
}

// POST /api/neurons — inject one neuron event (tests, hooks). Bounded body, whitelisted fields.
function postNeuron(req, res) {
  let body = '', big = false;
  req.on('data', (c) => { body += c; if (body.length > 4096) { big = true; req.destroy(); } });
  req.on('error', () => { if (!res.headersSent) sendJson(res, 400, { error: 'stream error' }); });
  req.on('end', () => {
    if (big) return sendJson(res, 413, { error: 'too large' });
    let p; try { p = JSON.parse(body || '{}'); } catch (e) { return sendJson(res, 400, { error: 'bad json' }); }
    const s = (v, n) => (v == null || v === '' ? null : String(v).slice(0, n));
    const ev = {
      kind: 'neuron',
      act: ['read', 'write', 'search', 'run', 'skill', 'spawn', 'error'].includes(p.act) ? p.act : 'run',
      tool: s(p.tool, 60), path: s(p.path, 400),
      notes: Array.isArray(p.notes) ? p.notes.slice(0, 12).map((x) => String(x).slice(0, 120)) : [],
      recall: s(p.recall, 120), skill: s(p.skill, 80),
      session: s(p.session, 12) || 'injected', agent: s(p.agent, 24),
      folder: ['ace', 'home', 'other'].includes(p.folder) ? p.folder : 'ace',
      injected: true, ts: Date.now(),
    };
    broadcastNeuron(ev);
    sendJson(res, 202, { ok: true, clients: neuronClients.size });
  });
}

// GET /brain, /brain/<file> — static files from ./brain (jailed, whitelisted types). GET
// /brain/brain-data.json?fresh=1 first re-runs brain/build-brain-data.mjs (async, single-flight,
// at most every 5 s, killed after 20 s) and then serves what it wrote.
const BRAIN_DIR = path.join(__dirname, 'brain');
const BRAIN_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml; charset=utf-8', '.webp': 'image/webp', '.jpg': 'image/jpeg' };
let brainBuild = null, brainBuiltAt = 0;
function runBrainBuild() {
  if (brainBuild) return brainBuild;
  if (Date.now() - brainBuiltAt < 5000) return Promise.resolve();
  brainBuild = new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; brainBuild = null; brainBuiltAt = Date.now(); resolve(); };
    let child;
    try { child = spawn(process.execPath, [path.join(BRAIN_DIR, 'build-brain-data.mjs')], { cwd: BRAIN_DIR, windowsHide: true, stdio: 'ignore' }); } catch (_) { return finish(); }
    child.on('exit', finish); child.on('error', finish);
    const kill = setTimeout(() => { try { child.kill(); } catch (_) {} finish(); }, 20000);
    if (kill && typeof kill.unref === 'function') kill.unref();
  });
  return brainBuild;
}
function sendBrainFile(res, rel) {
  const abs = path.resolve(BRAIN_DIR, rel);
  const ext = path.extname(abs).toLowerCase();
  if (!abs.startsWith(BRAIN_DIR + path.sep) || !BRAIN_TYPES[ext]) return sendJson(res, 404, { error: 'not found' });
  fs.readFile(abs, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': BRAIN_TYPES[ext], 'Cache-Control': 'no-store', 'Content-Length': data.length });
    res.end(data);
  });
}
function serveBrain(req, res, pathname, url) {
  if (pathname === '/brain') { res.writeHead(301, { Location: '/brain/' }); return res.end(); }
  let rel;
  try { rel = decodeURIComponent(pathname.slice('/brain/'.length)); } catch (_) { return sendJson(res, 400, { error: 'bad path' }); }
  if (!rel) rel = 'index.html';
  if (rel === 'brain-data.json' && url.searchParams.has('fresh')) {
    return runBrainBuild().then(() => sendBrainFile(res, rel), () => sendBrainFile(res, rel));
  }
  return sendBrainFile(res, rel);
}

// ---------------------------------------------------------------------------
// SITEMAP PAGE (/sitemap) - the owner's map of memory (Phase 5, 2026-10-10). Static files from ./sitemap
// (jailed like /brain), plus three routes over the memory dir:
//   GET  /api/sitemap          the _sitemap.json data (rebuilt through build-sitemap.mjs --json, async and
//                              single-flight, when a note or the sitemap registry is newer than the file)
//   GET  /api/note?id=<stem>   one note: its sitemap fields + its body rendered to HTML here (escape first)
//   POST /api/corrections      { id, text } -> one JSON line appended to <memory dir>/_corrections.jsonl
// The memory dir is the server's own (PATHS.memoryDir) unless MEMSYS_MEM_DIR / CLAUDE_MEM_DIR is set (the
// memory tools' own override order), so a second instance can run on fixture data.
// ---------------------------------------------------------------------------
const SITEMAP_DIR = path.join(__dirname, 'sitemap');
const SITEMAP_MEM = path.resolve(process.env.MEMSYS_MEM_DIR || process.env.CLAUDE_MEM_DIR || PATHS.memoryDir);
const SITEMAP_TOOLS = path.resolve(process.env.MEMSYS_TOOLS_DIR || path.join(ROOT, 'Code', 'memory-system'));
const SITEMAP_FILE = path.join(SITEMAP_MEM, '_sitemap.json');
const SITEMAP_REGISTRY = ['tree.json', 'placement.json', 'skills.json'].map((f) => path.join(SITEMAP_TOOLS, 'sitemap', f));
const CORRECTIONS_FILE = path.join(SITEMAP_MEM, '_corrections.jsonl');
const CORRECTION_MAX = 2000;

function sitemapNoteFiles() {
  // same name rule as lib/notes.mjs listNotes: top-level *.md except MEMORY.md, files only
  let names = [];
  try { names = fs.readdirSync(SITEMAP_MEM); } catch (_) { return []; }
  return names.filter((f) => f.toLowerCase().endsWith('.md') && f.toUpperCase() !== 'MEMORY.MD')
    .filter((f) => { try { return fs.statSync(path.join(SITEMAP_MEM, f)).isFile(); } catch (_) { return false; } });
}
function mtimeMs(p) { try { return fs.statSync(p).mtimeMs; } catch (_) { return 0; } }

// Newest input time (notes + registry), checked at most every 2 s.
let smInputs = { at: 0, newest: 0, count: 0 };
function sitemapInputs() {
  if (Date.now() - smInputs.at < 2000) return smInputs;
  let newest = 0; const files = sitemapNoteFiles();
  for (const f of files) newest = Math.max(newest, mtimeMs(path.join(SITEMAP_MEM, f)));
  for (const r of SITEMAP_REGISTRY) newest = Math.max(newest, mtimeMs(r));
  smInputs = { at: Date.now(), newest, count: files.length };
  return smInputs;
}

let smCache = null;   // { data, builtFor (newest input time it covers), count (notes it covers), fileSeen, source }
let smBuild = null;   // single-flight build promise
function runSitemapBuild() {
  if (smBuild) return smBuild;
  const p = new Promise((resolve) => {
    const tool = path.join(SITEMAP_TOOLS, 'build-sitemap.mjs');
    if (!fs.existsSync(tool)) return resolve({ error: 'build-sitemap.mjs not found' });
    const inp = sitemapInputs();
    const startedFor = inp.newest, startedCount = inp.count;
    let out = '', err = '', done = false, big = false;
    const finish = (r) => { if (done) return; done = true; smBuild = null; resolve(r); };
    let child;
    try {
      child = spawn(process.execPath, [tool, '--json'], {
        cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, { MEMSYS_MEM_DIR: SITEMAP_MEM }),
      });
    } catch (e) { return finish({ error: String(e.message || e) }); }
    child.stdout.on('data', (c) => { out += c; if (out.length > 64 * 1024 * 1024) { big = true; try { child.kill(); } catch (_) {} } });
    child.stderr.on('data', (c) => { if (err.length < 4000) err += c; });
    child.on('error', (e) => finish({ error: String(e.message || e) }));
    child.on('exit', (code) => {
      if (big) return finish({ error: 'build output too large' });
      if (code !== 0) return finish({ error: 'build-sitemap exited ' + code + ': ' + err.trim().slice(0, 300) });
      try {
        const data = JSON.parse(out);
        smCache = { data, builtFor: startedFor, count: startedCount, fileSeen: mtimeMs(SITEMAP_FILE), source: 'build' };
        finish({ ok: true });
      } catch (e) { finish({ error: 'build-sitemap printed bad JSON: ' + e.message }); }
    });
    const kill = setTimeout(() => { try { child.kill(); } catch (_) {} finish({ error: 'build-sitemap timed out' }); }, 30000);
    if (kill && typeof kill.unref === 'function') kill.unref();
  });
  // a promise that settled synchronously (tool missing, spawn threw) must not stay cached as "in flight"
  smBuild = p;
  p.then(() => { if (smBuild === p) smBuild = null; });
  return p;
}
function readSitemapFile() {
  const t = mtimeMs(SITEMAP_FILE);
  if (!t) return null;
  if (smCache && smCache.source === 'file' && smCache.fileMtime === t) return smCache;
  try {
    const data = JSON.parse(stripBom(fs.readFileSync(SITEMAP_FILE, 'utf8')));
    return { data, builtFor: t, fileMtime: t, source: 'file' };
  } catch (_) { return null; }
}
// Resolves to { data, source, stale, error }.
// A deleted, renamed or archived note does not raise the newest note time, so the note COUNT is checked too, and an
// in-memory build is dropped as soon as _sitemap.json is rewritten (the regen hook rebuilt it).
async function getSitemap() {
  const inp = sitemapInputs();
  const newest = inp.newest;
  if (smCache && smCache.source === 'build' && smCache.builtFor >= newest && smCache.count === inp.count && smCache.fileSeen === mtimeMs(SITEMAP_FILE)) return { data: smCache.data, source: 'build', stale: false };
  const file = readSitemapFile();
  if (file && file.fileMtime >= newest && file.data && file.data.noteCount === inp.count) { smCache = file; return { data: file.data, source: 'file', stale: false }; }
  const r = await runSitemapBuild();
  if (r && r.ok && smCache) return { data: smCache.data, source: 'build', stale: false };
  const fallback = file || smCache;
  if (fallback) return { data: fallback.data, source: fallback.source, stale: true, error: r && r.error };
  return { data: null, error: (r && r.error) || 'no sitemap data' };
}
function apiSitemap(res) {
  getSitemap().then((r) => {
    if (!r.data) return sendJson(res, 503, { error: r.error || 'no sitemap data' });
    const body = JSON.stringify(r.data);
    const h = { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Sitemap-Source': r.source };
    if (r.stale) { h['X-Sitemap-Stale'] = '1'; if (r.error) h['X-Sitemap-Error'] = String(r.error).replace(/[^\x20-\x7e]/g, ' ').slice(0, 200); }
    res.writeHead(200, h); res.end(body);
  }).catch((e) => sendJson(res, 500, { error: String(e && e.message || e) }));
}

// An id is valid only when <id>.md is, byte for byte, one of the note files listed in the memory dir. No path
// characters at all, so nothing outside the memory dir (and nothing in its subfolders) can be named.
function sitemapNoteFile(id) {
  if (typeof id !== 'string' || id.length < 1 || id.length > 200) return null;
  if (/[\\/\0:*?"<>|]/.test(id) || id === '.' || id === '..' || id.startsWith('.')) return null;
  const want = id + '.md';
  return sitemapNoteFiles().find((f) => f === want) || null;
}

// ---- the note renderer: escape HTML first, then a small, closed markdown subset ----
function mdEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function mdUnesc(s) {
  return String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function mdInline(raw, stems) {
  // raw is UNESCAPED text; escaping happens here, before any markup is added.
  const toks = [];
  const keep = (html) => '\u0001' + (toks.push(html) - 1) + '\u0002';
  let s = mdEsc(String(raw).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''));
  s = s.replace(/`([^`]+)`/g, (m, c) => keep('<code>' + c + '</code>'));
  s = s.replace(/\[\[([^\]]+?)\]\]/g, (m, inner) => {
    const bar = inner.indexOf('|');
    const target = (bar >= 0 ? inner.slice(0, bar) : inner).split('#')[0].trim();
    const label = (bar >= 0 ? inner.slice(bar + 1) : inner).trim() || target;
    const stem = stems.get(mdUnesc(target).toLowerCase());
    if (stem) return keep('<a class="wl" href="#/n/' + mdEsc(encodeURIComponent(stem)) + '">' + label + '</a>');
    return keep('<span class="wl missing" title="No note with this name">' + label + '</span>');
  });
  // no placeholder token inside a URL (a wikilink or code span there stays plain text)
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)\u0001\u0002]+)\)/g, (m, label, url) =>
    keep('<a class="ext" href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>'));
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>').replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>');
  s = s.replace(/(^|[^*\w])\*(?=[^\s*])([^*]*?[^\s*])\*(?![*\w])/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?![\w])/g, '$1<em>$2</em>');
  // tokens nest (a wikilink or code span inside a link label): expand until none is left (their HTML is escaped)
  for (let k = 0; k <= toks.length && /\u0001\d+\u0002/.test(s); k++) s = s.replace(/\u0001(\d+)\u0002/g, (m, i) => toks[Number(i)] || '');
  return s;
}
const MD_LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const MD_TSEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
function mdCells(line) {
  let t = line.trim().replace(/\\\|/g, '\u0003');
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.replace(/\u0003/g, '|').trim());
}
function mdBlocks(lines, stems, depth) {
  const out = [];
  let i = 0, para = [];
  const flush = () => { if (para.length) { out.push('<p>' + mdInline(para.join(' '), stems) + '</p>'); para = []; } };
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*(```|~~~)\s*([A-Za-z0-9_+-]*)/);
    if (fence) {
      flush();
      const buf = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) { buf.push(lines[i]); i++; }
      i++;
      out.push('<pre><code' + (fence[2] ? ' class="lang-' + mdEsc(fence[2].toLowerCase()) + '"' : '') + '>' + mdEsc(buf.join('\n')) + '</code></pre>');
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) { flush(); const lv = Math.min(6, h[1].length + 1); out.push('<h' + lv + '>' + mdInline(h[2], stems) + '</h' + lv + '>'); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
    if (line.trim().startsWith('|') && i + 1 < lines.length && MD_TSEP.test(lines[i + 1])) {
      flush();
      const head = mdCells(line); i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(mdCells(lines[i])); i++; }
      out.push('<div class="tbl"><table><thead><tr>' + head.map((c) => '<th>' + mdInline(c, stems) + '</th>').join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + head.map((_, k) => '<td>' + mdInline(r[k] || '', stems) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>');
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push('<blockquote>' + (depth < 4 ? mdBlocks(buf, stems, depth + 1) : '<p>' + mdInline(buf.join(' '), stems) + '</p>') + '</blockquote>');
      continue;
    }
    if (MD_LIST.test(line)) {
      flush();
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        const m = l.match(MD_LIST);
        if (m) { items.push({ ind: m[1].replace(/\t/g, '    ').length, ord: /\d/.test(m[2]), text: m[3] }); i++; continue; }
        if (l.trim() && /^\s+/.test(l) && items.length) { items[items.length - 1].text += ' ' + l.trim(); i++; continue; }
        break;
      }
      out.push(mdList(items, stems));
      continue;
    }
    para.push(line.trim()); i++;
  }
  flush();
  return out.join('\n');
}
function mdList(items, stems) {
  // nested by indentation: an item indented deeper than the current level opens a child list
  let html = ''; const stack = [];
  for (const it of items) {
    while (stack.length && it.ind < stack[stack.length - 1].ind) { html += '</li></' + stack.pop().tag + '>'; }
    const top = stack[stack.length - 1];
    if (!top || it.ind > top.ind) { const tag = it.ord ? 'ol' : 'ul'; stack.push({ ind: it.ind, tag }); html += '<' + tag + '>'; }
    else html += '</li>';
    html += '<li>' + mdInline(it.text, stems);
  }
  while (stack.length) html += '</li></' + stack.pop().tag + '>';
  return html;
}
function renderNoteHtml(md, stems) {
  return mdBlocks(String(md).replace(/\r\n?/g, '\n').split('\n'), stems, 0);
}
function noteBodyOf(text) {
  const t = stripBom(text).replace(/\r\n?/g, '\n');
  const m = t.match(/^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/);
  return m ? t.slice(m[0].length) : t;
}

function apiNote(res, id) {
  const file = sitemapNoteFile(id);
  if (!file) return sendJson(res, 404, { error: 'no such note' });
  let text;
  try { text = fs.readFileSync(path.join(SITEMAP_MEM, file), 'utf8'); } catch (_) { return sendJson(res, 404, { error: 'no such note' }); }
  getSitemap().then((r) => {
    const stems = new Map(sitemapNoteFiles().map((f) => { const s = f.replace(/\.md$/i, ''); return [s.toLowerCase(), s]; }));
    const fromData = (r.data && r.data.notes && r.data.notes[file]) || null;
    const meta = parseMemoryMeta(text);
    const fields = fromData ? Object.assign({}, fromData) : {
      id: file.replace(/\.md$/i, ''), title: meta.name || file.replace(/\.md$/i, ''), description: meta.desc || '',
      type: meta.type || 'note', typeLabel: '', home: '', homeSource: 'none', also: [], confidence: 'none',
      date: '', dateSource: '', links: [], linkedFrom: [],
    };
    fields.file = file;
    fields.inSitemap = !!fromData;
    fields.html = renderNoteHtml(noteBodyOf(text), stems);
    sendJson(res, 200, fields);
  }).catch((e) => sendJson(res, 500, { error: String(e && e.message || e) }));
}

// POST /api/corrections. The host check above already ran; this route adds the origin check (a page on another
// site posting to localhost carries its own Origin) and a JSON content type (which a cross-site form cannot send
// without a preflight this server never answers).
function postCorrection(req, res) {
  const origin = String(req.headers['origin'] || '').toLowerCase();
  if (origin && !['http://127.0.0.1:' + PORT, 'http://localhost:' + PORT, 'http://[::1]:' + PORT].includes(origin)) {
    return sendJson(res, 403, { error: 'bad origin' });
  }
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return sendJson(res, 415, { error: 'send application/json' });
  let body = '', big = false;
  req.on('data', (c) => { if (big) return; body += c; if (body.length > 16384) { big = true; body = ""; sendJson(res, 413, { error: "too large" }); } });
  req.on('error', () => { if (!res.headersSent) sendJson(res, 400, { error: 'stream error' }); });
  req.on('end', () => {
    if (big || res.headersSent) return;
    let p; try { p = JSON.parse(body || '{}'); } catch (_) { return sendJson(res, 400, { error: 'bad json' }); }
    if (!p || typeof p !== 'object') return sendJson(res, 400, { error: 'bad json' });
    const file = sitemapNoteFile(p.id);
    if (!file) return sendJson(res, 404, { error: 'no such note' });
    if (typeof p.text !== 'string') return sendJson(res, 400, { error: 'text required' });
    const text = p.text.replace(/\r\n?/g, '\n').trim();
    if (!text) return sendJson(res, 400, { error: 'text required' });
    if (text.length > CORRECTION_MAX) return sendJson(res, 413, { error: 'text over ' + CORRECTION_MAX + ' characters' });
    const line = JSON.stringify({ ts: new Date().toISOString(), id: file.replace(/\.md$/i, ''), text, status: 'open' }) + '\n';
    try {
      let lead = '';
      try { const st = fs.statSync(CORRECTIONS_FILE); if (st.size > 0) { const fd = fs.openSync(CORRECTIONS_FILE, 'r'); const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, st.size - 1); fs.closeSync(fd); if (b[0] !== 10) lead = '\n'; } } catch (_) { /* new file */ }
      fs.appendFileSync(CORRECTIONS_FILE, lead + line, 'utf8');
    } catch (e) { return sendJson(res, 500, { error: 'could not save: ' + e.message }); }
    sendJson(res, 201, { ok: true, saved: true });
  });
}

function sendSitemapFile(res, rel) {
  const abs = path.resolve(SITEMAP_DIR, rel);
  const ext = path.extname(abs).toLowerCase();
  if (!abs.startsWith(SITEMAP_DIR + path.sep) || !BRAIN_TYPES[ext]) return sendJson(res, 404, { error: 'not found' });
  fs.readFile(abs, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': BRAIN_TYPES[ext], 'Cache-Control': 'no-store', 'Content-Length': data.length });
    res.end(data);
  });
}
function serveSitemap(req, res, pathname) {
  if (pathname === '/sitemap') { res.writeHead(301, { Location: '/sitemap/' }); return res.end(); }
  let rel;
  try { rel = decodeURIComponent(pathname.slice('/sitemap/'.length)); } catch (_) { return sendJson(res, 400, { error: 'bad path' }); }
  if (!rel) rel = 'index.html';
  return sendSitemapFile(res, rel);
}

// GET /api/config — hand the page its chat token (loopback/tailnet-gated like every route).
// voice = browser speechSynthesis TTS is available (client-side, kept). sttFallback = server-side
// Whisper transcription is GONE in this fork (route cut) — the client should not offer it.
function apiConfig() { return { chatToken: CHAT_TOKEN, chatEnabled: chatEnabled(), voice: true, sttFallback: false }; }

const PROJECTS_DIR = path.join(USER_CLAUDE, 'projects');

const CHAT_ENABLE_FILE = path.join(__dirname, '.chat-enabled');
function chatEnabled() { try { return fs.existsSync(CHAT_ENABLE_FILE); } catch (_) { return false; } }
function postChat(req, res) {
  // OFF by default — claude -p is an RCE surface. Owner enables EXPLICITLY by creating
  // Code/os-dashboard/.chat-enabled. Until then this is a dead, read-only route.
  if (!chatEnabled()) return sendJson(res, 403, { error: 'chat disabled', note: 'voice/text chat (claude -p) is OFF by default for safety. To enable on YOUR machine: create the file Code/os-dashboard/.chat-enabled — then it runs behind the secret token + your Tailscale.' });
  if (!chatAuthed(req)) return sendJson(res, 401, { error: 'missing/invalid X-Chat-Token' });
  let body = '', big = false;
  req.on('data', (c) => { body += c; if (body.length > 16384) { big = true; req.destroy(); } });
  req.on('error', () => { if (!res.headersSent) sendJson(res, 400, { error: 'stream error' }); });
  req.on('end', () => {
    if (big) return sendJson(res, 413, { error: 'prompt too large' });
    let prompt; try { prompt = JSON.parse(body || '{}').prompt; } catch (e) { return sendJson(res, 400, { error: 'bad json' }); }
    if (typeof prompt !== 'string' || !prompt.trim()) return sendJson(res, 400, { error: 'body.prompt (non-empty string) required' });
    prompt = prompt.slice(0, 4000);
    try { broadcast({ kind: 'respond', text: prompt.slice(0, 120), seed: null, ts: Date.now() }); } catch (_) {}
    let child;
    // --strict-mcp-config + empty config = skip booting the heavy MCP servers (playwright/chrome/fal/shadcn),
    // which is most of the per-message latency. Conversation keeps CLAUDE.md + memory + skills context.
    try { child = spawn('claude', ['-p', prompt, '--model', 'opus', '--system-prompt', CHAT_PERSONA, '--effort', 'medium', '--permission-mode', 'bypassPermissions', '--disallowedTools', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'], { cwd: ROOT, windowsHide: true, shell: false }); }
    catch (e) { return sendJson(res, 500, { error: 'spawn failed: ' + e.message }); }
    let out = '', err = '', settled = false;
    const finish = (s, p) => { if (settled) return; settled = true; sendJson(res, s, p); };
    child.stdout.on('data', (d) => { if (out.length < TRIGGER_OUTPUT_CAP) out += d; });
    child.stderr.on('data', (d) => { if (err.length < TRIGGER_OUTPUT_CAP) err += d; });
    child.on('error', (e) => finish(500, { error: 'claude error: ' + e.message }));
    child.on('close', (code) => finish(200, { reply: out.trim().slice(0, TRIGGER_OUTPUT_CAP), exitCode: code, stderr: err.slice(-400) }));
    const kt = setTimeout(() => { try { child.kill(); } catch (_) {} finish(200, { reply: out.trim(), timedOut: true }); }, 180000);
    child.on('close', () => clearTimeout(kt));
  });
}

// Pull streamed text out of claude's stream-json events (robust across shapes).
function extractDelta(ev) {
  try {
    if (!ev || typeof ev !== 'object') return '';
    const e = ev.event || ev;
    if (e && e.type === 'content_block_delta' && e.delta) {
      if (typeof e.delta.text === 'string') return e.delta.text;
    }
    if (ev.delta && typeof ev.delta.text === 'string') return ev.delta.text;
  } catch (_) {}
  return '';
}

// Conversational persona — replaces the work-agent system prompt so the voice chat TALKS
// (brief, human, spoken) instead of writing structured "deliverable" reports with caveats.
const CHAT_PERSONA = "You are Ace OS, the user's personal AI operating system, having a casual out-loud voice conversation with them through their dashboard. Talk like a real person, not a written document. Be brief by default — usually 1 to 3 sentences, only go longer if they explicitly ask. Warm, direct, natural. NEVER use markdown, headings, bullet points, numbered lists, or bold. NEVER add scope caveats, 'this is unverified' disclaimers, or meta-commentary about your process — just talk. Give plain opinions when asked. You know the user's Ace OS workspace from context; reference it naturally when it's relevant. Sound human, like you're speaking out loud. TRACK THE CONVERSATION: remember what was already said this session and infer what the user means from context — never re-ask something they have already told you, and do not ask 'which thing do you mean' when it is clear from what you have been discussing. Be sharp and intent-reading, not forgetful or repetitive. You handle two kinds of moments. First, talk — small talk, opinions, questions you already know, thinking out loud: just answer directly and fast, no worker. Second, work — when the user clearly wants something built, changed, researched, fixed, or done: you do NOT do the heavy lifting yourself (you have no write, edit, or run tools), you hand it to a worker. When the request is CLEAR, do not stall — say one quick line like 'On it' and delegate: for a focused task call the Task tool with subagent_type 'os-worker'; for a big multi-part job, launch a Workflow. When the work returns, relay the outcome in 1 or 2 plain spoken sentences. Only ask a clarifying question when the request is genuinely ambiguous — you truly cannot tell what they want — or when it is destructive or irreversible, and then ask just ONE short question, not a string of them. A clear instruction is a green light, even on the very first message; never manufacture a back-and-forth for something obvious. Default to being quick, sharp, and conversational.";

// ---------------------------------------------------------------------------
// WARM conductor sessions — one persistent `claude --input-format stream-json`
// process per chat sessionId. The system prompt + CLAUDE.md + memory + skills load
// ONCE; follow-up turns are served from prompt cache (~2-3s time-to-first-token vs
// ~8-9s cold per message — measured). The process lives in the server, decoupled from
// any single HTTP request, so a client disconnect doesn't end the conversation.
// ---------------------------------------------------------------------------
// TERMINAL-GRADE persistence. HOT layer = live `claude` processes in WARM (RAM), capped.
// DURABLE layer = SESSIONS, persisted to sessions.json so a session survives a process death,
// a hot-cap demotion, AND a server restart. A respawn uses `--resume <sid>` so the conversation
// (the conductor's memory) continues from its transcript. A session ENDS ONLY on explicit
// /api/session-end (wrap-up / commit) — never on disconnect, idle, interrupt, or reload.
const WARM = new Map();                 // sid -> { proc, alive, busy, buf, cur, lastUsed }  (HOT, RAM)
const MAX_HOT_PROCS = 12;               // cap on LIVE conductor procs; over-cap demotes the LRU idle one to resumable-cold
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const SESSIONS = new Map();             // sid -> { id, title, status, createdAt, lastUsed }  (DURABLE)

function loadSessions() {
  try { const o = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); for (const r of (o.sessions || [])) if (r && r.id) SESSIONS.set(r.id, r); } catch (_) {}
}
function saveSessions() {
  try { const tmp = SESSIONS_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ sessions: [...SESSIONS.values()] })); fs.renameSync(tmp, SESSIONS_FILE); } catch (_) {}
}
function recordSession(sid, title) {
  const now = Date.now();
  let r = SESSIONS.get(sid);
  if (!r) { r = { id: sid, title: (title || 'Session').slice(0, 60), status: 'live', createdAt: now, lastUsed: now }; SESSIONS.set(sid, r); }
  else { if (title && (!r.title || r.title === 'Session')) r.title = title.slice(0, 60); r.lastUsed = now; if (r.status === 'cold') r.status = 'live'; }
  saveSessions();
}
loadSessions();

function conductorArgs(sid, resume) {
  return ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--verbose', '--include-partial-messages', '--model', 'opus', '--effort', 'high',
    (resume ? '--resume' : '--session-id'), sid,
    '--system-prompt', CHAT_PERSONA, '--permission-mode', 'bypassPermissions',
    '--disallowedTools', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
}

// Keep only MAX_HOT_PROCS live processes. Over the cap, demote the least-recently-used IDLE process:
// kill the PROCESS only — the durable SESSIONS record stays, so it is --resume'd on the next message.
// (Replaces the old idle reaper: a session NEVER ends on idle, only its hot process is freed.)
function trimHotProcs() {
  if (WARM.size <= MAX_HOT_PROCS) return;
  const idle = [...WARM.entries()].filter(([, s]) => !s.busy).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  for (const [sid, s] of idle) {
    if (WARM.size <= MAX_HOT_PROCS) break;
    try { s.proc.kill(); } catch (_) {} WARM.delete(sid);
    const r = SESSIONS.get(sid); if (r && r.status === 'live') { r.status = 'cold'; saveSessions(); }
  }
}

// Return a warm, IDLE conductor for this sid. (Re)spawn as needed, using --resume whenever the session
// already exists so the conversation + the conductor's memory survive interrupt / death / hot-cap
// demotion / server restart. null on spawn failure.
function getWarmConductor(sid) {
  let s = WARM.get(sid);
  if (s && s.alive && !s.busy) { s.lastUsed = Date.now(); return s; }
  if (s) { try { s.proc.kill(); } catch (_) {} if (WARM.get(sid) === s) WARM.delete(sid); }  // busy/interrupted -> respawn; --resume keeps context
  const resume = SESSIONS.has(sid);                                                          // an existing session is CONTINUED, never restarted
  let proc;
  try { proc = spawn('claude', conductorArgs(sid, resume), { cwd: ROOT, windowsHide: true, shell: false }); }
  catch (e) { return null; }
  s = { sid, proc, alive: true, busy: false, buf: '', cur: null, lastUsed: Date.now() };
  proc.stdout.on('data', (d) => {
    s.buf += d.toString();
    let nl;
    while ((nl = s.buf.indexOf('\n')) >= 0) {
      const line = s.buf.slice(0, nl); s.buf = s.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
      const cur = s.cur; if (!cur) continue;
      const t = extractDelta(ev);
      if (t) { cur.any = true; cur.write(t); }
      if (ev.type === 'result') { s.busy = false; s.cur = null; cur.end(); }
    }
  });
  proc.stderr.on('data', () => {});
  // die drops ONLY the hot entry; the durable SESSIONS record is untouched -> the session stays resumable.
  const die = () => { s.alive = false; const cur = s.cur; s.cur = null; s.busy = false; if (WARM.get(sid) === s) WARM.delete(sid); const r = SESSIONS.get(sid); if (r && r.status === 'live') { r.status = 'cold'; saveSessions(); } if (cur) cur.end('[conductor process ended]'); };
  proc.on('close', die);
  proc.on('error', die);
  WARM.set(sid, s);
  trimHotProcs();
  return s;
}

// ---- session reconnect APIs (terminal-grade: see + reattach alive sessions) -----------------
const SESS_PROJ_RE = new RegExp(ROOT_SLUG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
function sessionProjDirs() {
  const projRoot = path.join(String(process.env.USERPROFILE || os.homedir()), '.claude', 'projects');
  try { return fs.readdirSync(projRoot).filter((d) => SESS_PROJ_RE.test(d)).map((d) => path.join(projRoot, d)); } catch (_) { return []; }
}
// ALL Claude Code project dirs (not just /ace) — the roster shows every recent agent/terminal anywhere,
// so a session in your home dir or another repo also appears. (Chat reconnect still uses the /ace-scoped one.)
function allProjDirs() {
  const projRoot = path.join(String(process.env.USERPROFILE || os.homedir()), '.claude', 'projects');
  try { return fs.readdirSync(projRoot).map((d) => path.join(projRoot, d)); } catch (_) { return []; }
}
function sessionTranscriptPath(sid) {
  if (!/^[0-9a-fA-F-]{36}$/.test(sid)) return null;            // uuid only -> no path traversal
  for (const dir of sessionProjDirs()) { const fp = path.join(dir, sid + '.jsonl'); try { if (fs.existsSync(fp)) return fp; } catch (_) {} }
  return null;
}
// GET /api/sessions-list — alive (non-wrapped) sessions, newest first, with hot/cold state.
function apiSessionsList() {
  const out = [];
  for (const r of SESSIONS.values()) {
    if (r.status === 'wrapped') continue;
    const hot = WARM.has(r.id) && WARM.get(r.id).alive;
    // hotness (a live WARM proc) is the ONLY real-time signal; a non-hot session is cold regardless
    // of any stale persisted r.status (which can linger as 'live' after the proc died).
    out.push({ id: r.id, title: r.title || 'Session', status: hot ? 'live' : 'cold', hot, createdAt: r.createdAt, lastUsed: r.lastUsed });
  }
  out.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  return { sessions: out };
}

// ---------------------------------------------------------------------------
// /api/agents — the LIVE AGENT ROSTER (real telemetry: who is doing what RIGHT NOW).
// Turns the bare "claudeProcs:2" count into a per-agent view: it reads the ace project
// transcripts (main sessions + nested subagent/workflow transcripts) touched recently and
// pulls each one's last tool + target + age + ok/err + a stall verdict. The cockpit's spine —
// everything (roster, alerts, recovery) is downstream of this. Bounded by an mtime active-window.
// ---------------------------------------------------------------------------
const AGENT_ACTIVE_MS = 30 * 60 * 1000;   // transcript touched within 30 min = a live/recent agent (widened so a paused terminal lingers instead of vanishing)
const AGENT_STALL_MS = 45 * 1000;        // no new line in 45s -> "idle?"; 2x -> "stalled"
function scanAgentDir(dir, parent, kind, out, now) {
  let files;
  try { files = fs.readdirSync(dir); } catch (_) { return; }
  for (const f of files) {
    if (!/^agent-.*\.jsonl$/i.test(f)) continue;
    const fp = path.join(dir, f);
    try { const st = fs.statSync(fp); if (now - st.mtimeMs <= AGENT_ACTIVE_MS) out.push({ file: fp, mtime: st.mtimeMs, kind, id: f.replace(/\.jsonl$/i, ''), parent }); } catch (_) {}
  }
}
function listAgentTranscripts() {
  const out = [], now = Date.now();
  for (const dir of allProjDirs()) {
    let top;
    try { top = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const ent of top) {
      if (ent.isFile() && /^[0-9a-fA-F-]{36}\.jsonl$/.test(ent.name)) {
        const fp = path.join(dir, ent.name);
        try { const st = fs.statSync(fp); if (now - st.mtimeMs <= AGENT_ACTIVE_MS) out.push({ file: fp, mtime: st.mtimeMs, kind: 'session', id: ent.name.replace(/\.jsonl$/i, ''), parent: null }); } catch (_) {}
      } else if (ent.isDirectory() && /^[0-9a-fA-F-]{36}$/.test(ent.name)) {
        const sub = path.join(dir, ent.name, 'subagents');
        scanAgentDir(sub, ent.name, 'subagent', out, now);
        const wf = path.join(sub, 'workflows');
        try { for (const w of fs.readdirSync(wf)) scanAgentDir(path.join(wf, w), ent.name, 'workflow', out, now); } catch (_) {}
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
function tailAgentEvent(fp) {
  try {
    const st = fs.statSync(fp);
    const len = Math.min(16384, st.size);
    const fd = fs.openSync(fp, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, Math.max(0, st.size - len));
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
    // human identity (Claude's own ai-title / last-prompt / cwd are appended near the tail end)
    let title = null, prompt = null, cwd = null;
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 24; i--) {
      let ev; try { ev = JSON.parse(lines[i]); } catch (_) { continue; }
      if (!cwd && ev.cwd) cwd = ev.cwd;
      if (!title && ev.type === 'ai-title' && ev.aiTitle) title = String(ev.aiTitle);
      if (!prompt && ev.type === 'last-prompt' && ev.lastPrompt) prompt = String(ev.lastPrompt);
    }
    // most-recent tool + error (bounded: stop at the latest tool_use, like before)
    let tool = null, target = null, err = false;
    for (let i = lines.length - 1; i >= 0; i--) {
      let ev; try { ev = JSON.parse(lines[i]); } catch (_) { continue; }
      if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
        for (const b of ev.message.content) if (b && b.type === 'tool_result' && b.is_error) err = true;
      }
      if (!tool && ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
        for (let j = ev.message.content.length - 1; j >= 0; j--) {
          const b = ev.message.content[j];
          if (b && b.type === 'tool_use') { tool = b.name; const ip = b.input || {}; const pathish = ip.file_path || ip.notebook_path || ip.path; target = pathish ? String(pathish).replace(/\\/g, '/').split('/').pop() : String(ip.command || ip.pattern || ip.url || ip.description || ip.prompt || '').replace(/\s+/g, ' ').trim(); break; }
        }
      }
      if (tool) break;
    }
    return { tool, target: target ? String(target).slice(0, 52) : null, err,
      title: title ? title.slice(0, 60) : null, prompt: prompt ? prompt.replace(/\s+/g, ' ').slice(0, 80) : null, cwd: cwd || null };
  } catch (_) { return { tool: null, target: null, err: false, title: null, prompt: null, cwd: null }; }
}
function apiAgents() {
  return new Promise((resolve) => {
    const now = Date.now();
    let lockSid = null;
    try { if (fs.existsSync(PATHS.lock)) { const l = JSON.parse(readTextSafe(PATHS.lock).trim() || 'null'); lockSid = l && l.sessionId; } } catch (_) {}
    const tx = listAgentTranscripts().slice(0, 40);
    const rank = { error: 0, stalled: 1, idle: 2, working: 3 };
    const agents = tx.map((t) => {
      const ageMs = now - t.mtime;
      const ev = tailAgentEvent(t.file);
      const state = ev.err ? 'error' : ageMs > 2 * AGENT_STALL_MS ? 'stalled' : ageMs > AGENT_STALL_MS ? 'idle' : 'working';
      const sess = SESSIONS.get(t.id);
      const proj = ev.cwd ? String(ev.cwd).replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() : null;
      // human label: dashboard title -> Claude's own aiTitle -> last prompt -> (fallback) "<project> session" / short id.
      const title = (sess && sess.title) || ev.title || (ev.prompt ? ev.prompt.slice(0, 46) : null);
      const label = title
        || (t.kind === 'session' ? (proj ? proj + ' session' : t.id.slice(0, 8))
            : (ev.tool ? (ev.tool + (ev.target ? ' · ' + ev.target : '')) : (t.id.replace(/^agent-a?/, '') || t.id).slice(0, 10)));
      // owned = a dashboard-managed chat conductor (in SESSIONS) -> resumable/restartable here.
      // hot = its conductor process is currently alive. owned && !hot = dropped/cold but RESUMABLE.
      const owned = !!sess, hot = WARM.has(t.id) && !!(WARM.get(t.id) || {}).alive;
      return { id: t.id, kind: t.kind, parent: t.parent, label, title: title || null, proj: proj || null, tool: ev.tool, target: ev.target, ageMs, state, holdsLock: !!lockSid && t.id === lockSid, owned, hot };
    }).sort((a, b) => (rank[a.state] - rank[b.state]) || (a.ageMs - b.ageMs));
    claudeProcCount((procs) => { resolve({ agents, procs, lock: lockSid || null, ts: now }); });
  });
}

// POST /api/session-restart?id=<uuid> — force-respawn a DASHBOARD-OWNED chat conductor (kills the live
// proc if any, then re-spawns with --resume so the conversation continues). External Claude Code sessions
// are NOT owned by the dashboard (separate processes) and cannot be restarted from here — fail closed.
function apiSessionRestart(sid) {
  if (!/^[0-9a-fA-F-]{36}$/.test(sid || '')) return { ok: false, error: 'bad session id' };
  if (!SESSIONS.has(sid)) return { ok: false, error: 'not a dashboard-owned session — external agents cannot be restarted from the cockpit' };
  if ((SESSIONS.get(sid) || {}).status === 'wrapped') return { ok: false, error: 'session was ended (wrapped) — start a new session instead of resurrecting it' };
  try { const w = WARM.get(sid); if (w) { try { w.proc.kill(); } catch (_) {} WARM.delete(sid); } } catch (_) {}
  const s = getWarmConductor(sid);   // re-spawns; --resume because the session already exists
  return { ok: !!s, id: sid, hot: !!(s && s.alive) };
}

// ---- Live-pane (agent-tail v2) helpers. ALL fail-soft: a bad read returns null/[]
// and never throws out of apiAgentTail. READ-ONLY on ~/.claude state, like everything else. ----

// ~/.claude/sessions/*.json heartbeats ({pid,sessionId,name,status,updatedAt,...} — tiny files).
// Cached module-level for ~3s so pane polls don't re-read every file on each hit.
let SESSIONS_HB_CACHE = { ts: 0, list: [] };
function readSessionHeartbeats() {
  const now = Date.now();
  if (now - SESSIONS_HB_CACHE.ts < 3000) return SESSIONS_HB_CACHE.list;
  const list = [];
  try {
    const dir = USER_CLAUDE + '/sessions';
    for (const f of fs.readdirSync(dir)) {
      if (!/\.json$/i.test(f)) continue;
      try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (j && j.sessionId) list.push(j); } catch (_) {}
    }
  } catch (_) {}
  SESSIONS_HB_CACHE = { ts: now, list };
  return list;
}
// Is a PID currently alive? signal 0 is an existence probe (no signal sent). EPERM = the process
// exists but we may not signal it (still alive); ESRCH = gone. (Tiny recycled-PID risk: a dead
// claude PID reused by another process would read alive — acceptable for a status chip.)
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}
// busy info for one session id, or null (no heartbeat / process gone / unreadable).
function agentBusyInfo(id) {
  try {
    // Heartbeat files are named by PID, so SEVERAL can carry the same sessionId (e.g. a resumed
    // session leaves a stale sibling behind) — keep the FRESHEST record, not the readdir-first one.
    let hb = null, upd = 0;
    for (const s of readSessionHeartbeats()) {
      if (s.sessionId !== id) continue;
      const u = typeof s.updatedAt === 'number' ? s.updatedAt : (Date.parse(s.updatedAt) || 0);
      if (!hb || u > upd) { hb = s; upd = u; }
    }
    if (!hb) return null;
    // NOT a heartbeat-freshness gate: updatedAt does NOT refresh during a long tool call, so a
    // time window wrongly nulls a genuinely-busy session (live-verified). Trust process liveness —
    // if the PID is alive it's live; only drop it when the process is gone AND the heartbeat is stale.
    const alive = pidAlive(hb.pid);
    if (!alive && (!upd || Date.now() - upd > 5 * 60 * 1000)) return null;
    return { status: hb.status || null, pid: hb.pid || null, name: hb.name || null, updatedAtMs: upd, alive };
  } catch (_) { return null; }
}
// One workflow dir -> { id, started, done, lastWriteMs } or null (inactive/finished-long-ago/unreadable).
function wfDirInfo(dir, now) {
  try {
    let lastWriteMs = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!/^agent-.*\.jsonl$/i.test(f)) continue;
      try { const st = fs.statSync(path.join(dir, f)); if (st.mtimeMs > lastWriteMs) lastWriteMs = st.mtimeMs; } catch (_) {}
    }
    if (!lastWriteMs || now - lastWriteMs > AGENT_ACTIVE_MS) return null;   // old/dead workflow
    let started = 0, done = 0;
    try {   // journal.jsonl is tiny: {"type":"started"} / {"type":"result"} lines
      for (const line of fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
        if (ev && ev.type === 'started') started++;
        else if (ev && ev.type === 'result') done++;
      }
    } catch (_) {}
    // keep if in-flight OR just finished (within 2x stall) — lets the strip show completion
    if (!(done < started || now - lastWriteMs <= 2 * AGENT_STALL_MS)) return null;
    return { id: path.basename(dir), started, done, lastWriteMs };
  } catch (_) { return null; }
}
// ACTIVE workflows for a roster transcript. session -> its subagents/workflows/wf_* dirs;
// workflow -> its own dir; subagent -> [] (no journal). Newest-first, capped at 4.
function activeWorkflows(t, now) {
  try {
    if (t.kind === 'subagent') return [];
    if (t.kind === 'workflow') { const one = wfDirInfo(path.dirname(t.file), now); return one ? [one] : []; }
    const root = path.join(path.dirname(t.file), t.id, 'subagents', 'workflows');
    let names; try { names = fs.readdirSync(root); } catch (_) { return []; }
    const out = [];
    for (const n of names) {
      if (!/^wf_/i.test(n)) continue;
      const info = wfDirInfo(path.join(root, n), now);
      if (info) out.push(info);
    }
    return out.sort((a, b) => b.lastWriteMs - a.lastWriteMs).slice(0, 4);
  } catch (_) { return []; }
}

// GET /api/agent-tail?id=<id> — READ-ONLY recent activity for ANY roster agent (chat conductor, the
// operator's own Claude Code sessions, or a subagent/workflow): the last ~22 tool calls + text snippets.
// This is the "view what this agent is doing" verb; it never mutates and works for non-owned agents too.
// v2: also returns `live` { ageMs, state, busy, ctx, workflows } so the Zone-4 pane can poll it.
function apiAgentTail(id) {
  const tx = listAgentTranscripts();
  const t = tx.find((x) => x.id === id);
  if (!t) return { id, found: false, events: [] };
  const events = [];
  const now = Date.now();
  let mtimeMs = t.mtime;                      // refined by the statSync below; roster stat as fallback
  let lastUsage = null, lastModel = null;     // LAST assistant usage/model seen in the tail window (-> ctx)
  try {
    const st = fs.statSync(t.file);
    mtimeMs = st.mtimeMs;
    const len = Math.min(64 * 1024, st.size);
    const fd = fs.openSync(t.file, 'r'); const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, Math.max(0, st.size - len)); fs.closeSync(fd);
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
      const ts = ev.timestamp || null;
      if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
        if (ev.message.usage) { lastUsage = ev.message.usage; lastModel = ev.message.model || lastModel; }
        for (const b of ev.message.content) {
          if (b && b.type === 'tool_use') { const ip = b.input || {}; const tgt = ip.file_path || ip.path || ip.command || ip.pattern || ip.url || ip.description || ''; events.push({ ts, kind: 'tool', text: (b.name + (tgt ? ' · ' + String(tgt).replace(/\s+/g, ' ').slice(0, 80) : '')) }); }
          else if (b && b.type === 'text' && b.text) { const tx2 = String(b.text).replace(/\s+/g, ' ').trim(); if (tx2) events.push({ ts, kind: 'text', text: tx2.slice(0, 180) }); }
        }
      } else if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
        for (const b of ev.message.content) { if (b && b.type === 'tool_result' && b.is_error) events.push({ ts, kind: 'err', text: 'tool returned an error' }); }
      }
    }
  } catch (_) {}
  // ---- live enrichment (v2) — every branch fail-soft; a bad read yields null/[] fields ----
  const ageMs = Math.max(0, Math.round(now - mtimeMs));
  const workflows = activeWorkflows(t, now);
  // state: same rules as the roster (tail err -> error; 2x stall -> stalled; 1x -> idle; else working).
  // Roster semantics = only the MOST RECENT tool call erroring counts (tailAgentEvent stops at the
  // latest tool_use) — so flag error only when the last err event is NEWER than the last tool event;
  // an old failure the agent already recovered from must not pin the strip red for the whole tail.
  let lastToolIdx = -1, lastErrIdx = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i].kind === 'tool') lastToolIdx = i;
    else if (events[i].kind === 'err') lastErrIdx = i;
  }
  const sawErr = lastErrIdx > lastToolIdx;
  let state = sawErr ? 'error' : ageMs > 2 * AGENT_STALL_MS ? 'stalled' : ageMs > AGENT_STALL_MS ? 'idle' : 'working';
  // OVERRIDE: detached dynamic workflow — the main transcript is silent while wf agents write.
  // A workflow write within the stall window means this agent IS working right now.
  if (workflows.some((w) => now - w.lastWriteMs <= AGENT_STALL_MS)) state = 'working';
  // ctx: last assistant usage in the tail window; window rules mirror session-stats' formula
  // (SESSION_STATS_WIN_* / SESSION_STATS_1M_INFER — reused, not redefined). NOTE: session-stats
  // scans the whole file and stickily latches a 1M window; this sees only the last usage in the
  // 64KB tail, so a compacted-below-200k 1M session can read 200k here — a known tail-window trade-off.
  let ctx = null;
  if (lastUsage) {
    const used = (lastUsage.input_tokens || 0) + (lastUsage.cache_read_input_tokens || 0);
    const win = (/opus-4-8/i.test(lastModel || '') || used > SESSION_STATS_1M_INFER) ? SESSION_STATS_WIN_1M : SESSION_STATS_WIN_DEFAULT;
    ctx = { used, window: win, leftPct: Math.round(Math.max(0, win - used) / win * 1000) / 10, model: lastModel || null };
  }
  const busy = t.kind === 'session' ? agentBusyInfo(id) : null;   // heartbeat only exists for main sessions
  return { id, kind: t.kind, found: true, events: events.slice(-22),
    live: { ageMs, state, busy, ctx, workflows } };
}

// ---------------------------------------------------------------------------
// /api/usage — DERIVABLE token burn (honest). Sums real usage{} objects (verified shape:
// input/output/cache_creation/cache_read_input_tokens + a line `timestamp`) over the last 5 min
// across active transcripts -> tokens/min. The rate-limit WINDOW %/time-to-reset is NOT in local
// transcripts (it lives in API response headers), so we report it as unknown rather than fabricate it.
// ---------------------------------------------------------------------------
function usageBurn(fp, sinceMs) {
  // DEDUP by requestId: a single API request writes MANY transcript lines (one per streamed content
  // block) that all carry the SAME cumulative usage{} — summing every line inflates burn ~3-5x.
  // Keep one row (the largest-output = cumulative) per request, then sum across distinct requests.
  const byReq = new Map();   // requestId -> {out,in,cache,ts}
  try {
    const st = fs.statSync(fp);
    const len = Math.min(96 * 1024, st.size);
    const fd = fs.openSync(fp, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, Math.max(0, st.size - len));
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (const line of lines) {
      if (line.indexOf('"usage"') < 0) continue;
      let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
      const u = ev.message && ev.message.usage; if (!u) continue;
      const ts = ev.timestamp ? Date.parse(ev.timestamp) : 0;
      if (ts && ts < sinceMs) continue;
      const rid = ev.requestId || (ev.message && ev.message.id) || ('t' + ts);
      const row = { out: u.output_tokens || 0, in: u.input_tokens || 0, cache: (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), ts };
      const prev = byReq.get(rid);
      if (!prev || row.out >= prev.out) byReq.set(rid, row);
    }
  } catch (_) {}
  let out = 0, inp = 0, cache = 0, last = 0;
  for (const r of byReq.values()) { out += r.out; inp += r.in; cache += r.cache; if (r.ts > last) last = r.ts; }
  return { out, in: inp, cache, samples: byReq.size, last };
}
function apiUsage() {
  const now = Date.now(), WINDOW = 5 * 60 * 1000, since = now - WINDOW;
  const tx = listAgentTranscripts().slice(0, 40);   // cap synchronous tail-reads like apiAgents (don't block the loop under fan-out)
  let out = 0, inp = 0, cache = 0, samples = 0; const perAgent = [];
  for (const t of tx) {
    const u = usageBurn(t.file, since);
    if (u.samples) { out += u.out; inp += u.in; cache += u.cache; samples += u.samples; perAgent.push({ id: t.id, kind: t.kind, out: u.out, total: u.in + u.out + u.cache, samples: u.samples }); }
  }
  const mins = WINDOW / 60000;
  return {
    windowMin: mins, samples, activeAgents: perAgent.length,
    outPerMin: Math.round(out / mins), inPerMin: Math.round(inp / mins), cachePerMin: Math.round(cache / mins),
    totalPerMin: Math.round((inp + out + cache) / mins),
    outTok: out, totalTok: inp + out + cache,
    perAgent: perAgent.sort((a, b) => b.total - a.total).slice(0, 8),
    window: { state: 'unknown', note: 'rate-limit window %/reset not in local transcripts (API response headers only)' },
    ts: now
  };
}

// ---------------------------------------------------------------------------
// /api/limits — REAL rate-limit utilization from Anthropic API response HEADERS.
// The %used + reset-time for the 5h and 7d unified windows are NOT in local transcripts (apiUsage()
// reports them as unknown). They DO come back on the headers of any live API call. So we make ONE
// tiny probe (1 max_token "hi") with the owner's OAuth token and read the anthropic-ratelimit-* headers.
//   - Token is read FRESH from the creds file each call (Claude refreshes it on disk -> stays valid).
//   - Result is CACHED 60s in a module var so frequent dashboard polls => at most ~1 API call/min.
//   - On any failure (non-200 / 401 / expired token / network) we DEGRADE HONESTLY to status:'unknown'
//     and NEVER fabricate numbers (mirrors apiUsage's window:{state:'unknown'}).
//   - SECURITY: the access token is NEVER logged, printed, or returned in any field.
// ---------------------------------------------------------------------------
const CREDS_FILE = path.join(USER_CLAUDE, '.credentials.json');
let _limitsCache = { data: null, ts: 0 };
const LIMITS_TTL = 60 * 1000;

function readOauth() {
  // Returns { token, sub, tier } or null. Reads FRESH each call (no token caching on disk-stale risk).
  try {
    const raw = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    const o = raw && raw.claudeAiOauth;
    if (!o || !o.accessToken) return null;
    return { token: o.accessToken, sub: o.subscriptionType || null, tier: o.rateLimitTier || null };
  } catch (_) { return null; }
}

function probeLimits() {
  // Resolves to the shaped limits object. NEVER rejects (fail-closed -> status:'unknown').
  return new Promise((resolve) => {
    const ts = Date.now();
    const creds = readOauth();
    if (!creds) return resolve({ status: 'unknown', note: 'no OAuth token in creds file', ts });

    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001', max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const req = https.request({
      method: 'POST', hostname: 'api.anthropic.com', path: '/v1/messages',
      headers: {
        'authorization': 'Bearer ' + creds.token,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      timeout: 9000,
    }, (resp) => {
      // Drain the body (we only need the headers) so the socket frees, but cap it.
      let n = 0; resp.on('data', (c) => { n += c.length; if (n > 64 * 1024) resp.destroy(); });
      resp.on('end', () => finish(resp));
      resp.on('error', () => finish(resp));
      // Headers are available now; settle on 'end' to be safe across node versions.
      function finish(r) {
        if (r.statusCode !== 200) {
          return resolve({ status: 'unknown', note: 'probe HTTP ' + r.statusCode + (r.statusCode === 401 ? ' (token expired/invalid)' : ''), ts });
        }
        const h = r.headers || {};
        const numH = (k) => { const v = h[k]; const f = v == null ? NaN : parseFloat(v); return isFinite(f) ? f : null; };
        const intH = (k) => { const v = h[k]; const f = v == null ? NaN : parseInt(v, 10); return isFinite(f) ? f : null; };
        const u5 = numH('anthropic-ratelimit-unified-5h-utilization');
        const u7 = numH('anthropic-ratelimit-unified-7d-utilization');
        if (u5 == null && u7 == null) {
          return resolve({ status: 'unknown', note: 'probe ok but no anthropic-ratelimit-unified-* headers', ts });
        }
        const win = (util, resetK, statusK) => ({
          utilPct: util == null ? null : Math.round(util * 100),
          resetEpoch: intH(resetK),
          status: h[statusK] || null,
        });
        resolve({
          fivehour: win(u5, 'anthropic-ratelimit-unified-5h-reset', 'anthropic-ratelimit-unified-5h-status'),
          weekly: win(u7, 'anthropic-ratelimit-unified-7d-reset', 'anthropic-ratelimit-unified-7d-status'),
          tier: creds.tier,
          sub: creds.sub,
          unifiedStatus: h['anthropic-ratelimit-unified-status'] || null,
          ts, source: 'live-headers',
        });
      }
    });
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} });
    req.on('error', (e) => resolve({ status: 'unknown', note: 'network: ' + e.code || 'error', ts }));
    req.write(body);
    req.end();
  });
}

function apiLimits() {
  // 60s cache -> at most ~1 probe/min regardless of dashboard poll rate.
  const now = Date.now();
  if (_limitsCache.data && now - _limitsCache.ts < LIMITS_TTL) {
    return Promise.resolve({ ..._limitsCache.data, cached: true });
  }
  return probeLimits().then((data) => {
    // Cache successes AND honest 'unknown's (so a down API doesn't get hammered once a minute either).
    _limitsCache = { data, ts: Date.now() };
    return data;
  });
}

// ---------------------------------------------------------------------------
// GET /api/setup-status  (+ POST /api/setup-recheck) — onboarding readiness.
// 7 checks, each { id, label, status:'ok|missing|placeholder|error'(+login's 'present-unverified'),
// detail, fix }. `ready` = the CORE 5 all green (node, claude_cli, login, memory_brain, hooks_wired).
// SECURITY: never echoes a secret VALUE — only key names + booleans (placeholder yes/no).
// Background-cached ~60s (a probe/exec fan-out must NEVER sit on the request path — per-request scans
// hung this server twice historically). GET serves the cache; POST /api/setup-recheck forces a rebuild.
// ---------------------------------------------------------------------------
// the global hooks the Ace OS installer wires (generated from spec/wiring.json at build time)
const ACE_OS_HOOKS = ["inject-deterministic-contract.js","inject-memory-protocol.js","inject-memory-corrections.js","inject-ultracode-default.js","inject-first-run-onboarding.js","inject-anti-drift.js","inject-wrap-memory-directive.js","block-memory-md-too-large.js","block-undocumented-launch.js","block-memory-line-bloat.js","block-nonportable-path.js","block-commit-without-memory.js","block-shared-file-contention.js","block-git-add-sweep.js","block-memory-git-rewrite.js","block-unverified-completion.js","block-unfounded-boot-claim.js","block-doc-action-drift.js","block-premature-stop.js","block-unpersisted-memory.js","regen-memory-index.js","block-wrap-without-memory.js"];
const SETUP_TTL_MS = 60 * 1000;
let SETUP_CACHE = null, SETUP_AT = 0, SETUP_BUILDING = false;

// Promisified exec that NEVER rejects (fail-closed): resolves { err, stdout, stderr }.
function execP(cmd, timeout) {
  return new Promise((resolve) => {
    exec(cmd, { windowsHide: true, timeout: timeout || 6000, maxBuffer: 512 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function buildSetupStatus() {
  const checks = [];
  const push = (id, label, status, detail, fix) => checks.push({ id, label, status, detail: detail || '', fix: fix || '' });

  // 1) node — runtime version >= 18
  try {
    const major = parseInt(String(process.versions.node).split('.')[0], 10);
    push('node', 'Node.js runtime', major >= 18 ? 'ok' : 'error',
      'v' + process.versions.node + (major >= 18 ? '' : ' (need >= 18)'),
      major >= 18 ? '' : 'Install Node.js 18+ from nodejs.org');
  } catch (e) { push('node', 'Node.js runtime', 'error', e.message, 'Install Node.js 18+'); }

  // 2) claude_cli — `claude --version`, else `where/which claude`
  {
    const r = await execP('claude --version', 6000);
    if (!r.err && /\d+\.\d+/.test(r.stdout)) push('claude_cli', 'Claude Code CLI', 'ok', r.stdout.trim().slice(0, 60), '');
    else {
      const w = await execP(_IS_WIN ? 'where claude' : 'command -v claude', 4000);
      if (!w.err && w.stdout.trim()) push('claude_cli', 'Claude Code CLI', 'ok', 'found: ' + w.stdout.trim().split(/\r?\n/)[0], '');
      else push('claude_cli', 'Claude Code CLI', 'missing', '`claude` not found on PATH', 'Install Claude Code and ensure `claude` is on PATH');
    }
  }

  // 3) login — ~/.claude/.credentials.json present + reuse the limits OAuth probe (ok | present-unverified | missing)
  {
    if (!fs.existsSync(CREDS_FILE) && process.platform === 'darwin') {
      let inKeychain = false;
      try { require('child_process').execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials'], { stdio: 'ignore', timeout: 5000 }); inKeychain = true; } catch (_) {}
      if (inKeychain) push('login', 'Claude login (OAuth)', 'ok', 'found in the macOS Keychain (the dashboard does not read the token there)', '');
      else push('login', 'Claude login (OAuth)', 'missing', 'no Claude Code login found in the macOS Keychain', 'Run `claude` once and log in');
    }
    else if (!fs.existsSync(CREDS_FILE)) push('login', 'Claude login (OAuth)', 'missing', '~/.claude/.credentials.json not found', 'Run `claude` once and log in');
    else {
      let lim = null; try { lim = await apiLimits(); } catch (_) {}
      if (lim && lim.source === 'live-headers') push('login', 'Claude login (OAuth)', 'ok', 'OAuth token verified against the Anthropic API', '');
      else push('login', 'Claude login (OAuth)', 'present-unverified', 'credentials present but the probe could not verify: ' + ((lim && lim.note) || 'no probe result'), 'Re-run `claude` to refresh the token, or check network');
    }
  }

  // 4) mcp_keys — read ROOT/.mcp.json; flag placeholder sentinels by KEY NAME only (never the value)
  {
    const mcpPath = path.join(ROOT, '.mcp.json');
    if (!fs.existsSync(mcpPath)) push('mcp_keys', 'MCP server keys', 'missing', 'no .mcp.json at the workspace root (optional)', 'Optional: add MCP servers in a .mcp.json at the workspace root');
    else {
      try {
        const j = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
        const servers = (j && j.mcpServers) || {};
        const placeholders = [];
        for (const [name, cfg] of Object.entries(servers)) {
          const env = (cfg && cfg.env) || {};
          for (const k of Object.keys(env)) {
            if (/REPLACE-WITH|YOUR-/i.test(String(env[k] || ''))) placeholders.push(name + '.' + k);
          }
        }
        if (placeholders.length) push('mcp_keys', 'MCP server keys', 'placeholder', placeholders.length + ' key(s) still placeholder: ' + placeholders.join(', '), 'Replace the placeholder value(s) in .mcp.json');
        else push('mcp_keys', 'MCP server keys', 'ok', Object.keys(servers).length + ' server(s) configured, no placeholder keys', '');
      } catch (e) { push('mcp_keys', 'MCP server keys', 'error', '.mcp.json parse error: ' + e.message, 'Fix the JSON syntax in .mcp.json'); }
    }
  }

  // 7) memory_brain — MEMORY.md present + _manifest.json parses
  {
    if (!fs.existsSync(PATHS.memoryDir)) push('memory_brain', 'Memory brain', 'missing', 'memory dir not initialized for this workspace', 'Open a Claude session here / run Code/memory-system/build-manifest.mjs');
    else {
      const hasMem = fs.existsSync(PATHS.memoryFile);
      const manFile = path.join(PATHS.memoryDir, '_manifest.json');
      let manOk = false, manErr = '';
      try { JSON.parse(fs.readFileSync(manFile, 'utf8')); manOk = true; } catch (e) { manErr = e.message; }
      if (hasMem && manOk) push('memory_brain', 'Memory brain', 'ok', 'MEMORY.md + _manifest.json present and parse', '');
      else if (!hasMem) push('memory_brain', 'Memory brain', 'missing', 'MEMORY.md not found in the memory dir', 'Run the memory-system build (build-manifest.mjs)');
      else push('memory_brain', 'Memory brain', 'error', '_manifest.json parse error: ' + manErr, 'Regenerate with Code/memory-system/build-manifest.mjs');
    }
  }

  // 8) hooks_wired — every Ace OS global hook (ACE_OS_HOOKS, the installer's wiring list) is wired in ~/.claude/settings.json
  {
    const liveSettings = path.join(USER_CLAUDE, 'settings.json');
    let liveHooks = null;
    try { const s = JSON.parse(fs.readFileSync(liveSettings, 'utf8')); liveHooks = new Set(); collectHookCommandFilenames(s.hooks || {}, liveHooks); } catch (_) {}
    if (!liveHooks) push('hooks_wired', 'Enforcement hooks wired', 'missing', '~/.claude/settings.json missing or unparseable', 'Run the Ace OS installer (node installer/install.mjs in the release folder)');
    else {
      const missing = ACE_OS_HOOKS.filter((h) => !liveHooks.has(h));
      if (missing.length) push('hooks_wired', 'Enforcement hooks wired', 'error', missing.length + ' of ' + ACE_OS_HOOKS.length + ' Ace OS hook(s) not wired: ' + missing.slice(0, 6).join(', '), 'Re-run the Ace OS installer (it only adds missing entries)');
      else push('hooks_wired', 'Enforcement hooks wired', 'ok', ACE_OS_HOOKS.length + ' Ace OS hooks wired', '');
    }
  }

  // 11) chat_enabled — informational ONLY (never blocks ready). Off-by-default is the SAFE state.
  {
    const on = fs.existsSync(CHAT_ENABLE_FILE);
    push('chat_enabled', 'Voice/text chat (optional)', on ? 'ok' : 'missing',
      on ? '.chat-enabled present — chat (claude -p) is ON behind token + loopback' : 'off by default (safe) — chat disabled',
      on ? '' : 'Optional: create Code/os-dashboard/.chat-enabled to turn it on');
  }

  const CORE = ['node', 'claude_cli', 'login', 'memory_brain', 'hooks_wired'];
  const byId = {}; for (const c of checks) byId[c.id] = c;
  const ready = CORE.every((id) => byId[id] && byId[id].status === 'ok');
  const okCount = checks.filter((c) => c.status === 'ok').length;
  const score = Math.round((okCount / checks.length) * 100);
  return { ready, score, okCount, total: checks.length, core: CORE, checks, builtAt: Date.now() };
}

let SETUP_BUILD_PROMISE = null;
async function refreshSetupStatus() {
  if (SETUP_BUILDING) return SETUP_BUILD_PROMISE; // build in flight -> hand back the SAME promise so callers can await it (fixes the cold-boot race where a warm-timer build was in flight and a request returned empty)
  SETUP_BUILDING = true;
  SETUP_BUILD_PROMISE = (async () => {
    try { SETUP_CACHE = await buildSetupStatus(); SETUP_AT = Date.now(); }
    catch (e) { SETUP_CACHE = { ready: false, score: 0, error: e.message, checks: [], builtAt: Date.now() }; SETUP_AT = Date.now(); }
    finally { SETUP_BUILDING = false; }
  })();
  return SETUP_BUILD_PROMISE;
}

// GET responder: on a COLD cache (fresh boot, warm-timer build hasn't landed yet), await the build
// for THIS request so the wizard's first fetch gets the full 11 checks instead of an empty
// {building:true} snapshot; then the ~60s background refresh takes over. Warm cache -> instant.
async function respondSetupStatus(res) {
  try {
    if (!SETUP_CACHE) await refreshSetupStatus(); // cold cache: await the (possibly already-in-flight) build
    return sendJson(res, 200, apiSetupStatus());
  } catch (e) {
    return sendJson(res, 200, { ready: false, score: 0, checks: [], error: e.message });
  }
}

function apiSetupStatus() {
  const now = Date.now();
  if (!SETUP_CACHE) { refreshSetupStatus(); return { ready: false, score: 0, building: true, checks: [], note: 'building setup status…' }; }
  if (now - SETUP_AT > SETUP_TTL_MS && !SETUP_BUILDING) refreshSetupStatus(); // stale -> refresh in background, serve current
  return { ...SETUP_CACHE, cached: true, ageMs: now - SETUP_AT };
}

function postSetupRecheck(req, res) {
  req.resume();
  req.on('error', () => { if (!res.headersSent) sendJson(res, 400, { error: 'stream error' }); });
  req.on('end', async () => { try { await refreshSetupStatus(); return sendJson(res, 200, SETUP_CACHE || { ready: false, score: 0 }); } catch (e) { return sendJson(res, 500, { error: e.message }); } });
}

// ---------------------------------------------------------------------------
// /api/burn-history?hours=24  (also accepts from=<epochMs>&to=<epochMs>) — REAL token burn over a
// time range, bucketed by the owner's Pacific local hour, for the Burn card's line graph + searchable
// history. Reuses the SAME dedup-by-requestId rule as usageBurn() (one row per request, largest output =
// cumulative) so totals aren't inflated 3-5x by per-streamed-block lines.
//
// ARCHITECTURE (why an INDEX, not a per-request scan):
//   The OLD implementation read only the last BURN_HIST_TAIL (2 MB) of each transcript ON THE REQUEST
//   PATH. For a multi-day range (e.g. From=Jun20 To=Jun24) that tail covers only the most-recent few
//   hours of each file, so whole earlier days were DROPPED (showed ~nothing for Jun21/22/23) and the
//   result was permanently labelled "· partial". The naive fix — a FULL per-request scan of every
//   transcript — blocks the single-threaded event loop for seconds and HUNG the whole dashboard
//   ("localhost dead"). So instead we keep a BACKGROUND per-hour burn INDEX (Pacific hourly buckets)
//   over a rolling BURN_INDEX_WINDOW_DAYS window:
//     - built once shortly after startup + refreshed every BURN_INDEX_REFRESH_MS (~5 min) by setInterval,
//     - using the SAME non-blocking async-readline approach as refreshSkillLastRun() (readline yields to
//       the event loop between lines AND the build awaits per file, so requests are never hard-blocked),
//     - deduped by requestId across the whole build (one row per request, largest output = cumulative).
//   Then /api/burn-history just SLICES that in-memory index for the requested [from,to) — O(buckets),
//   no file I/O, instant + COMPLETE (Jun23 now appears at ~444M). Both the graph and the history list
//   read these same buckets, so both show every day in range.
//   "partial" is true ONLY when the requested range starts BEFORE the index window (older history the
//   rolling window no longer covers); otherwise it is dropped.
//   Memory is trivially bounded: hourly buckets for ~14 days = ~336 entries.
// ---------------------------------------------------------------------------
const BURN_INDEX_WINDOW_DAYS = 14;                       // rolling window the index covers
const BURN_INDEX_REFRESH_MS = 5 * 60 * 1000;            // ~5 min background refresh
const BURN_INDEX_MAX_FILES = 8000;                       // > current corpus; headroom, still bounded
const BURN_INDEX_MAX_TOTAL_BYTES = 6 * 1024 * 1024 * 1024; // total-bytes safety ceiling per build
const BURN_USAGE_MARK = '"usage"';                       // cheap pre-filter; JSON.parse only on usage lines

// In-memory index. `buckets` maps a Pacific-hour epoch (UTC instant of the start of that local hour)
// to its aggregated burn. `windowStartMs` is the rolling cutoff the build used. Readers see a complete
// map via an atomic swap (refresh builds into a fresh object, then assigns BURN_INDEX in one statement).
let BURN_INDEX = { buckets: new Map(), windowStartMs: 0, windowEndMs: 0, offsetMs: 0 };
let BURN_INDEX_META = { refreshedAt: 0, filesScanned: 0, requests: 0, building: false, capped: false, buildMs: 0 };

// Pacific-local hour bucket key (epoch ms of the START of that local hour, expressed as a UTC instant).
// The TZ offset is computed ONCE per build (passed in as offsetMs), so we never call toLocaleString
// per row (which would block the loop on big corpora).
function pacificHourFloor(ms, offsetMs) {
  // local wall-clock ms = utc ms - offsetMs(=utc-local); floor to the hour; convert back to a utc instant.
  const local = ms - offsetMs;
  const flooredLocal = local - (local % 3600000);
  return flooredLocal + offsetMs;
}

// Enumerate transcripts under ALL Claude project dirs whose mtime is within the rolling window, newest
// first, capped at BURN_INDEX_MAX_FILES (mirrors listSkillTranscripts — same shape, same caps).
function listBurnTranscripts(windowStartMs) {
  const out = [];
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try { const st = fs.statSync(full); if (st.mtimeMs >= windowStartMs) out.push({ full, mtimeMs: st.mtimeMs, size: st.size }); } catch { /* skip unreadable */ }
      }
    }
  };
  walk(PROJECTS_DIR);
  out.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first so the cap keeps the recent ones
  return out.slice(0, BURN_INDEX_MAX_FILES);
}

// Stream ONE transcript line-by-line (readline yields to the event loop) into byReq. Dedup by requestId:
// a single API request writes MANY lines (one per streamed block) all carrying the SAME cumulative
// usage{} — keep one row per request (largest-output = cumulative). Only rows at/after windowStartMs.
function scanBurnFileInto(file, byReq, windowStartMs) {
  return new Promise((resolve) => {
    let rl;
    try { rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity }); }
    catch { resolve(0); return; }
    let count = 0;
    rl.on('line', (line) => {
      if (line.indexOf(BURN_USAGE_MARK) < 0) return; // cheap pre-filter; JSON.parse only on usage lines
      let ev; try { ev = JSON.parse(line); } catch { return; }
      const u = ev.message && ev.message.usage; if (!u) return;
      const ts = ev.timestamp ? Date.parse(ev.timestamp) : 0;
      if (!ts || ts < windowStartMs) return;
      const rid = ev.requestId || (ev.message && ev.message.id) || ('t' + ts);
      const row = {
        out: u.output_tokens || 0, in: u.input_tokens || 0,
        cache: (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), ts,
      };
      const prev = byReq.get(rid);
      if (!prev || row.out >= prev.out) { byReq.set(rid, row); count++; }
    });
    rl.on('close', () => resolve(count));
    rl.on('error', () => resolve(count));
  });
}

// Rebuild the per-hour burn index. async + awaited per file so readline yields to the event loop between
// files — the build runs "in the background" without hard-blocking requests (same discipline as
// refreshSkillLastRun). Atomic swap of BURN_INDEX at the end so readers never see a half-built map.
async function refreshBurnIndex() {
  if (BURN_INDEX_META.building) return; // never overlap two builds
  BURN_INDEX_META.building = true;
  const t0 = Date.now();
  try {
    const now = Date.now();
    const TZ = DASH_TZ;
    const ref = new Date();
    // offsetMs = utc - local (same computation apiGates uses); add to a local-ms to get the utc instant.
    const offsetMs = new Date(ref.toLocaleString('en-US', { timeZone: 'UTC' })).getTime()
                   - new Date(ref.toLocaleString('en-US', { timeZone: TZ })).getTime();
    const windowStartMs = now - BURN_INDEX_WINDOW_DAYS * 86400000;

    let files;
    try { files = listBurnTranscripts(windowStartMs); } catch { files = []; }
    const byReq = new Map();
    let bytes = 0, scanned = 0, capped = false;
    for (const f of files) {
      if (bytes + f.size > BURN_INDEX_MAX_TOTAL_BYTES) { capped = true; break; }
      bytes += f.size; scanned++;
      try { await scanBurnFileInto(f.full, byReq, windowStartMs); } catch { /* fail-soft per file */ }
    }

    // Collapse dedup'd requests into Pacific-hour buckets.
    const buckets = new Map();   // hourEpoch -> {tokens,out,in,cache,requests}
    for (const r of byReq.values()) {
      const hour = pacificHourFloor(r.ts, offsetMs);
      const b = buckets.get(hour) || { tokens: 0, out: 0, in: 0, cache: 0, requests: 0 };
      b.tokens += r.in + r.out + r.cache; b.out += r.out; b.in += r.in; b.cache += r.cache; b.requests += 1;
      buckets.set(hour, b);
    }
    BURN_INDEX = { buckets, windowStartMs, windowEndMs: now, offsetMs }; // atomic swap
    BURN_INDEX_META = { refreshedAt: now, filesScanned: scanned, requests: byReq.size, building: false, capped, buildMs: Date.now() - t0 };
  } catch (_) {
    BURN_INDEX_META.building = false;
  }
}

// SLICE the in-memory index for [fromMs,toMs). Request-path: O(buckets), NO file I/O. `partial` is true
// only when the requested range starts BEFORE the index window (older history the rolling window dropped).
function apiBurnHistory(fromMs, toMs) {
  const TZ = DASH_TZ;
  const idx = BURN_INDEX;
  const buckets = [];
  for (const [hourEpoch, v] of idx.buckets) {
    if (hourEpoch < fromMs || hourEpoch >= toMs) continue;
    buckets.push({ hourEpoch, tokens: v.tokens, out: v.out, in: v.in, cache: v.cache, requests: v.requests });
  }
  buckets.sort((a, b) => a.hourEpoch - b.hourEpoch);
  let total = 0, requests = 0; for (const b of buckets) { total += b.tokens; requests += (b.requests || 0); }

  // partial = the request reaches earlier than the index covers. (windowStartMs===0 => index not yet
  // built; report partial so the UI doesn't imply completeness before the first build lands.)
  const partial = !idx.windowStartMs || fromMs < idx.windowStartMs;

  return {
    buckets, total, from: fromMs, to: toMs,
    requests, bucketCount: buckets.length,
    partial,                         // true ONLY if range predates the index window
    truncated: partial,              // back-compat: the UI reads `truncated` to show the "· partial" tag
    indexWindowStart: idx.windowStartMs, indexWindowEnd: idx.windowEndMs,
    indexRefreshedAt: BURN_INDEX_META.refreshedAt, indexRequests: BURN_INDEX_META.requests,
    tz: TZ, ts: Date.now(),
  };
}

// No per-request cache needed any more — slicing the in-memory index is already O(buckets) with no I/O.
// Kept as a thin pass-through so the route handler signature is unchanged.
function apiBurnHistoryCached(fromMs, toMs, _isDefault) {
  return apiBurnHistory(fromMs, toMs);
}

// ---------------------------------------------------------------------------
// /api/session-stats (PHASE 6) — the SESSIONS card list: each active/recent session's
// real name + time-since-start + open-duration + context-window-left + total-tokens.
//
// ARCHITECTURE (why a BACKGROUND index, not a per-request scan):
//   A per-request scan of every transcript jsonl blocks the single-threaded event loop and HUNG
//   this server twice (same lesson as the burn index + memory timeline). So this is built ONCE
//   shortly after listen + refreshed every SESSION_STATS_REFRESH_MS by setInterval, using the SAME
//   non-blocking async-readline approach (yields to the loop between lines AND awaits per file).
//   The request handler just returns the pre-built snapshot — O(rows), zero file I/O.
//
// SCOPE: a transcript is a "recent session" if its mtime is within SESSION_STATS_ACTIVE_MS (~30 min,
//   matches AGENT_ACTIVE_MS) OR it is a dashboard-owned conductor live in SESSIONS/WARM. We index only
//   top-level session transcripts under the /ace project dirs (uuid.jsonl) — the chat conductors +
//   the owner's own Claude Code sessions — not the nested subagent/workflow files (those are the roster).
//
// PER SESSION we compute:
//   - name: SESSIONS title -> Claude's own ai-title -> first REAL human user message (truncated)
//           -> short sid. (command/caveat/tool_result/system-reminder blocks are skipped.)
//   - startMs = first line timestamp; durationMs = last - first; sinceStartMs = now - first.
//   - totalTokens = usage summed DEDUPED BY requestId over the WHOLE file (usageBurn rule: one row per
//     request, largest output = cumulative; in + out + cache).
//   - model (last assistant message.model); contextWindow = 1,000,000 for claude-opus-4-8 (this
//     workspace runs the 1M variant), else 200,000. ALSO inferred: if the last message's
//     (input + cache_read) > 200,000 the window is treated as 1,000,000 regardless of model string.
//   - contextUsed = last assistant message (input_tokens + cache_read_input_tokens); this is the live
//     prompt size = what the model is currently "holding". contextLeft = max(0, window - used); pct.
//   - status: live (a hot WARM proc) | cold.
//   Sorted by lastUsed/recency (most-recent first). Bounded by file + byte caps; truncation noted.
// ---------------------------------------------------------------------------
const SESSION_STATS_REFRESH_MS = 45 * 1000;            // ~45s background refresh (per owner spec)
const SESSION_STATS_ACTIVE_MS = 30 * 60 * 1000;        // transcript mtime within 30 min = "recent" (matches roster)
const SESSION_STATS_MAX_FILES = 60;                    // cap scanned files per build (recent-first); plenty for a cockpit list
const SESSION_STATS_MAX_BYTES = 1.5 * 1024 * 1024 * 1024; // total-bytes safety ceiling per build
const SESSION_STATS_USAGE_MARK = '"usage"';            // cheap pre-filter
const SESSION_STATS_WIN_1M = 1000000;                  // opus-4-8 here is the 1M-context variant
const SESSION_STATS_WIN_DEFAULT = 200000;              // sonnet/haiku/others (and unknown) default
const SESSION_STATS_1M_INFER = 200000;                 // last-msg context above this implies a 1M window

let SESSION_STATS = { sessions: [], ts: 0 };
let SESSION_STATS_META = { refreshedAt: 0, filesScanned: 0, building: false, capped: false, buildMs: 0 };

// Pull the first REAL human prompt text out of a user line's content (skip slash-command / caveat /
// tool_result / system-reminder boilerplate so the name is the actual thing the human typed).
function sessionFirstHumanText(content) {
  let text = null;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    const parts = [];
    for (const b of content) {
      if (!b) continue;
      if (b.type === 'tool_result') return null;          // a tool result is never a human name
      if (b.type === 'text' && b.text) parts.push(b.text);
    }
    text = parts.join(' ');
  }
  if (!text) return null;
  text = String(text).trim();
  // Skip Claude Code's local-command / slash-command / reminder wrappers — not human-authored names.
  if (/^<(local-command-caveat|command-name|command-message|command-args|local-command-stdout|local-command-stderr|system-reminder|user-prompt-submit-hook)/i.test(text)) return null;
  if (text.startsWith('Caveat:')) return null;
  text = text.replace(/\s+/g, ' ').trim();
  return text || null;
}

// Scan ONE session transcript line-by-line (readline yields to the loop). Returns a stat row, or null
// if the file has no usable signal. NEVER throws (fail-soft per file).
function scanSessionStatsFile(fp, sid, now) {
  return new Promise((resolve) => {
    let rl;
    try { rl = readline.createInterface({ input: fs.createReadStream(fp, { encoding: 'utf8' }), crlfDelay: Infinity }); }
    catch { resolve(null); return; }

    const byReq = new Map();          // requestId -> {out,in,cache} (dedup; largest output = cumulative)
    let firstTs = 0, lastTs = 0;
    let aiTitle = null, firstHuman = null;
    let lastModel = null, lastCtxUsed = 0, lastInferWin = SESSION_STATS_WIN_DEFAULT;

    rl.on('line', (line) => {
      if (!line) return;
      let ev; try { ev = JSON.parse(line); } catch { return; }
      const ts = ev.timestamp ? Date.parse(ev.timestamp) : 0;
      if (ts) { if (!firstTs) firstTs = ts; lastTs = ts; }

      if (ev.type === 'ai-title' && ev.aiTitle && !aiTitle) aiTitle = String(ev.aiTitle);
      if (ev.type === 'user' && ev.message && firstHuman == null) {
        const t = sessionFirstHumanText(ev.message.content);
        if (t) firstHuman = t;
      }

      // usage rows (dedup by requestId) — only JSON we already parsed; pre-filter avoided re-parse cost.
      if (line.indexOf(SESSION_STATS_USAGE_MARK) >= 0 && ev.message && ev.message.usage) {
        const u = ev.message.usage;
        const rid = ev.requestId || (ev.message && ev.message.id) || ('t' + ts);
        const row = {
          out: u.output_tokens || 0, in: u.input_tokens || 0,
          cache: (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
        };
        const prev = byReq.get(rid);
        if (!prev || row.out >= prev.out) byReq.set(rid, row);
        // track the LAST assistant message's live context (input + cache_read = current prompt size).
        if (ev.type === 'assistant') {
          if (ev.message.model) lastModel = String(ev.message.model);
          const ctxUsed = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0);
          lastCtxUsed = ctxUsed;                                 // last wins (chronological order in file)
          if (ctxUsed > SESSION_STATS_1M_INFER) lastInferWin = SESSION_STATS_WIN_1M;
        }
      }
    });
    rl.on('error', () => resolve(null));
    rl.on('close', () => {
      let total = 0;
      for (const r of byReq.values()) total += r.in + r.out + r.cache;

      // Window: opus-4-8 (1M variant here) -> 1M; else default 200k; then OR-in the >200k inference.
      let contextWindow = SESSION_STATS_WIN_DEFAULT;
      if (lastModel && /opus-4-8/i.test(lastModel)) contextWindow = SESSION_STATS_WIN_1M;
      if (lastInferWin === SESSION_STATS_WIN_1M) contextWindow = SESSION_STATS_WIN_1M;

      const contextUsed = lastCtxUsed;
      const contextLeft = Math.max(0, contextWindow - contextUsed);
      const contextLeftPct = contextWindow > 0 ? Math.round((contextLeft / contextWindow) * 1000) / 10 : null;

      const sessRec = SESSIONS.get(sid);
      const hot = WARM.has(sid) && !!(WARM.get(sid) || {}).alive;
      const name = (sessRec && sessRec.title && sessRec.title !== 'Session' ? sessRec.title : null)
        || aiTitle
        || (firstHuman ? firstHuman.slice(0, 40) : null)
        || sid.slice(0, 8);

      resolve({
        id: sid,
        name,
        status: hot ? 'live' : 'cold',
        hot,
        startMs: firstTs || null,
        lastMs: lastTs || null,
        durationMs: (firstTs && lastTs) ? Math.max(0, lastTs - firstTs) : 0,
        sinceStartMs: firstTs ? Math.max(0, now - firstTs) : null,
        totalTokens: total,
        requests: byReq.size,
        model: lastModel || null,
        contextWindow,
        contextUsed,
        contextLeft,
        contextLeftPct,
      });
    });
  });
}

// Enumerate top-level session transcripts (uuid.jsonl) under the /ace project dirs whose mtime is within
// the active window, newest first, capped. Also force-include any dashboard-owned session (SESSIONS) whose
// transcript exists even if it just fell outside the window, so an owned chat never silently vanishes.
function listSessionStatsFiles(now) {
  const seen = new Map();   // sid -> { fp, mtime }
  for (const dir of sessionProjDirs()) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isFile()) continue;
      const m = /^([0-9a-fA-F-]{36})\.jsonl$/.exec(e.name);
      if (!m) continue;
      const fp = path.join(dir, e.name);
      let st; try { st = fs.statSync(fp); } catch { continue; }
      const sid = m[1];
      const owned = SESSIONS.has(sid) && (SESSIONS.get(sid) || {}).status !== 'wrapped';
      if (now - st.mtimeMs > SESSION_STATS_ACTIVE_MS && !owned) continue;
      const prev = seen.get(sid);
      if (!prev || st.mtimeMs > prev.mtime) seen.set(sid, { fp, mtime: st.mtimeMs, size: st.size });
    }
  }
  return [...seen.entries()]
    .map(([sid, v]) => ({ sid, ...v }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, SESSION_STATS_MAX_FILES);
}

// Rebuild the session-stats snapshot in the background (async + awaited per file => readline yields to the
// event loop between files, so requests are never hard-blocked). Atomic swap at the end.
async function refreshSessionStats() {
  if (SESSION_STATS_META.building) return;
  SESSION_STATS_META.building = true;
  const t0 = Date.now();
  try {
    const now = Date.now();
    let files; try { files = listSessionStatsFiles(now); } catch { files = []; }
    const rows = [];
    let bytes = 0, scanned = 0, capped = false;
    for (const f of files) {
      if (bytes + (f.size || 0) > SESSION_STATS_MAX_BYTES) { capped = true; break; }
      bytes += (f.size || 0); scanned++;
      let row = null;
      try { row = await scanSessionStatsFile(f.fp, f.sid, now); } catch { row = null; }
      if (row && (row.startMs || row.totalTokens)) {
        row.mtime = f.mtime;
        rows.push(row);
      }
    }
    // Sort by recency: hot first, then most-recent activity (lastMs/mtime).
    rows.sort((a, b) => (Number(b.hot) - Number(a.hot)) || ((b.lastMs || b.mtime || 0) - (a.lastMs || a.mtime || 0)));
    SESSION_STATS = { sessions: rows, ts: now };
    SESSION_STATS_META = { refreshedAt: now, filesScanned: scanned, building: false, capped, buildMs: Date.now() - t0 };
  } catch (_) {
    SESSION_STATS_META.building = false;
  }
}

// Request-path: return the pre-built snapshot (zero file I/O). `building` true until the first build lands.
function apiSessionStats() {
  return {
    sessions: SESSION_STATS.sessions,
    count: SESSION_STATS.sessions.length,
    capped: SESSION_STATS_META.capped,
    filesScanned: SESSION_STATS_META.filesScanned,
    refreshedAt: SESSION_STATS_META.refreshedAt,
    buildMs: SESSION_STATS_META.buildMs,
    building: !SESSION_STATS_META.refreshedAt,
    ts: Date.now(),
  };
}

// GET /api/session-history?id=<uuid> — prior conversation turns, parsed from the transcript jsonl.
function apiSessionHistory(sid) {
  const fp = sessionTranscriptPath(sid);
  if (!fp) return { turns: [] };
  let raw = ''; try { raw = fs.readFileSync(fp, 'utf8'); } catch (_) { return { turns: [] }; }
  const turns = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
    if (ev.type !== 'user' && ev.type !== 'assistant') continue;     // skip last-prompt/system/result lines
    const msg = ev.message; if (!msg) continue;
    let text = '';
    if (typeof msg.content === 'string') text = msg.content;          // user content can be a string
    else if (Array.isArray(msg.content)) text = msg.content.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text).join('');  // drop thinking/tool_use
    text = text.trim();
    if (!text) continue;
    turns.push({ role: ev.type, text: text.slice(0, 8000) });
  }
  return { turns: turns.slice(-80) };
}
// POST /api/session-end — the SOLE terminator (explicit wrap-up / commit). Kills the hot proc + marks wrapped.
function postSessionEnd(req, res) {
  if (!chatAuthed(req)) return sendJson(res, 401, { error: 'missing/invalid X-Chat-Token' });
  let body = ''; req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
  req.on('end', () => {
    let p = {}; try { p = JSON.parse(body || '{}'); } catch (_) {}
    const sid = p.sessionId;
    if (typeof sid !== 'string' || !sid) return sendJson(res, 400, { error: 'sessionId required' });
    const s = WARM.get(sid); if (s) { try { s.proc.kill(); } catch (_) {} WARM.delete(sid); }
    const r = SESSIONS.get(sid); if (r) { r.status = 'wrapped'; r.lastUsed = Date.now(); saveSessions(); }
    sendJson(res, 200, { ok: true, ended: sid });
  });
}

// POST /api/session-restart — RECOVERY: force-respawn a dashboard-owned chat conductor. Gated like chat
// (it spawns the claude -p conductor surface). External agents are rejected inside apiSessionRestart.
function postSessionRestart(req, res) {
  if (!chatEnabled()) return sendJson(res, 403, { error: 'chat disabled', note: 'create Code/os-dashboard/.chat-enabled' });
  if (!chatAuthed(req)) return sendJson(res, 401, { error: 'missing/invalid X-Chat-Token' });
  let body = ''; req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
  req.on('end', () => {
    let p = {}; try { p = JSON.parse(body || '{}'); } catch (_) {}
    const sid = p.sessionId;
    if (typeof sid !== 'string' || !sid) return sendJson(res, 400, { error: 'sessionId required' });
    sendJson(res, 200, apiSessionRestart(sid));
  });
}

// POST /api/chat-stream — streams the reply token-by-token from the WARM conductor for this sid.
function postChatStream(req, res) {
  if (!chatEnabled()) return sendJson(res, 403, { error: 'chat disabled', note: 'create Code/os-dashboard/.chat-enabled' });
  if (!chatAuthed(req)) return sendJson(res, 401, { error: 'missing/invalid X-Chat-Token' });
  let body = '', big = false;
  req.on('data', (c) => { body += c; if (body.length > 16384) { big = true; req.destroy(); } });
  req.on('error', () => { if (!res.headersSent) sendJson(res, 400, { error: 'stream error' }); });
  req.on('end', () => {
    if (big) return sendJson(res, 413, { error: 'prompt too large' });
    let pBody = {}; try { pBody = JSON.parse(body || '{}'); } catch (e) { return sendJson(res, 400, { error: 'bad json' }); }
    let prompt = pBody.prompt;
    if (typeof prompt !== 'string' || !prompt.trim()) return sendJson(res, 400, { error: 'body.prompt required' });
    prompt = prompt.slice(0, 4000);
    const isUuid = (x) => typeof x === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(x);
    const sid = isUuid(pBody.sessionId) ? pBody.sessionId : crypto.randomUUID();   // --session-id/--resume require a real uuid
    try { broadcast({ kind: 'respond', text: prompt.slice(0, 120), seed: null, ts: Date.now() }); } catch (_) {}

    const s = getWarmConductor(sid);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'X-Session-Id': sid });
    if (!s) { try { res.end('[error: could not start conductor]'); } catch (_) {} return; }

    let finished = false;
    const hb = setInterval(() => { if (!finished) { try { res.write(String.fromCharCode(0)); } catch (_) {} } }, 12000);
    const kt = setTimeout(() => { if (s.cur === cur) { s.cur = null; s.busy = false; } cur.end('\n[timed out after 30 min]'); }, 1800000);
    const cur = {
      any: false,
      write: (t) => { if (!finished) { try { res.write(t); } catch (_) {} } },
      end: (errMsg) => {
        clearInterval(hb); clearTimeout(kt);            // always release timers
        if (finished) return; finished = true;
        if (errMsg && !cur.any) { try { res.write(errMsg); } catch (_) {} }
        try { res.end(); } catch (_) {}
      }
    };
    s.busy = true; s.lastUsed = Date.now(); s.cur = cur;
    recordSession(sid, prompt.slice(0, 48));   // durable record (title = first message) -> survives restart + enables --resume
    // client disconnect: stop writing but DO NOT kill the process — let the turn finish so the
    // session stays warm + consistent (the conversation survives a dropped connection).
    res.on('close', () => { if (!finished) { finished = true; clearInterval(hb); } });
    // feed the user message into the warm process (newline-delimited stream-json)
    try { s.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }) + '\n'); }
    catch (e) { if (s.cur === cur) { s.cur = null; s.busy = false; } cur.end('[error: could not reach conductor]'); }
  });
}

// (Server-side STT cut in this build: the local faster-whisper transcription route was removed.
// Browser speechSynthesis TTS + the Web Speech API remain fully client-side and are untouched.)

// LIVE BRAIN — watch the ace session transcript(s) and fire the brain as Claude works.
// Server-side (fs.watch), so it adds ZERO latency to Claude's tools (vs a per-tool hook).
function watchTranscripts() {
  const projRoot = path.join(String(process.env.USERPROFILE || os.homedir()), '.claude', 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(projRoot).filter((d) => SESS_PROJ_RE.test(d)).map((d) => path.join(projRoot, d)); } catch (e) { return; }
  // Sessions started in the home folder (Windows Terminal "+" tab) do ace work too: watch them as well.
  const homeProj = path.join(projRoot, HOME_SLUG_N);
  if (!dirs.includes(homeProj) && fs.existsSync(homeProj)) dirs.push(homeProj);
  const lastSize = new Map();
  let lastFireAt = 0;
  const fireFromTail = (fp) => {
    try {
      const st = fs.statSync(fp);
      const prev = lastSize.has(fp) ? lastSize.get(fp) : st.size;
      lastSize.set(fp, st.size);
      if (st.size <= prev) return;                 // only on append/growth = Claude did something
      if (neuronClients.size) { try { emitNeurons(fp, prev, st.size); } catch (_) { /* fail-open */ } } // /brain stream: every tool call, unthrottled
      const now = Date.now();
      if (now - lastFireAt < 350) return;          // throttle so the brain pulses, not strobes
      const len = Math.min(8192, st.size - prev + 2048);
      const fd = fs.openSync(fp, 'r');
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, Math.max(0, st.size - len));
      fs.closeSync(fd);
      const text = buf.toString('utf8');
      let seed = null;
      const fileM = text.match(/"(?:file_path|path|pattern)"\s*:\s*"([^"]+)"/g);
      if (fileM && fileM.length) { const last = fileM[fileM.length - 1].match(/:\s*"([^"]+)"\s*$/); if (last) seed = last[1].split(/[\\/]/).pop(); }
      if (!seed) { const tM = text.match(/"name"\s*:\s*"([A-Za-z_]+)"/g); if (tM && tM.length) { const n = tM[tM.length - 1].match(/"([A-Za-z_]+)"\s*$/); seed = n ? n[1] : null; } }
      // content-aware: surface the tool NAME + originating agent (from the file path) + error, not just a blind seed.
      let tool = null; const tNm = text.match(/"name"\s*:\s*"([A-Za-z_]+)"/g); if (tNm && tNm.length) { const n = tNm[tNm.length - 1].match(/"([A-Za-z_]+)"\s*$/); tool = n ? n[1] : null; }
      const evErr = /"is_error"\s*:\s*true/.test(text);
      const agent = fp.split(/[\\/]/).pop().replace(/\.jsonl$/i, '').slice(0, 16);
      lastFireAt = now;
      broadcast({ kind: 'tool', agent, tool, err: evErr, text: ('claude · ' + (tool || seed || 'working')).slice(0, 120), seed: seed ? String(seed).slice(0, 80) : null, ts: now });
    } catch (e) { /* fail-open */ }
  };
  let watchers = 0;
  for (const dir of dirs) {
    // recursive:true so nested subagent/workflow transcripts
    // (subagents\workflows\wf_*\agent-*.jsonl) are seen, not just flat top-level .jsonl.
    // On recursive watch, `fn` is a sub-path RELATIVE to `dir` (e.g. "subagents\\workflows\\wf_x\\agent-y.jsonl"),
    // so join it onto the watched root rather than assuming a flat dir.
    try { fs.watch(dir, { persistent: false, recursive: true }, (ev, fn) => { if (fn && /\.jsonl$/i.test(fn)) fireFromTail(path.join(dir, fn)); }); watchers++; } catch (e) {}
  }
  return watchers;
}

const server = http.createServer((req, res) => {
  // Defense in depth: reject anything that didn't arrive on the loopback iface.
  const remote = req.socket.remoteAddress || '';
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('localhost only');
    return;
  }

  // D-3: DNS-rebinding defense — reject any request whose Host header is not our loopback origin.
  // A rebinding attack reaches the loopback socket but carries the attacker's hostname in Host; a
  // legitimate localhost client always sends 127.0.0.1 / localhost (+ our port). Empty Host (rare,
  // HTTP/1.0) is allowed since the loopback guard already covers it.
  const hostHeader = String(req.headers['host'] || '').toLowerCase();
  if (hostHeader) {
    const allowedHosts = new Set([
      '127.0.0.1:' + PORT, 'localhost:' + PORT, '[::1]:' + PORT,
      '127.0.0.1', 'localhost', '[::1]',
    ]);
    if (!allowedHosts.has(hostHeader)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('bad host');
      return;
    }
  }

  let url;
  try {
    url = new URL(req.url, `http://${HOST}:${PORT}`);
  } catch (e) {
    return sendJson(res, 400, { error: 'bad url' });
  }
  const pathname = url.pathname;
  const method = req.method || 'GET';

  // POST /trigger
  if (pathname === '/trigger') {
    if (method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
    return handleTrigger(req, res);
  }

  // POST /api/activity — append-only live-brain event (bounded, whitelist; spawns NOTHING).
  if (pathname === '/api/activity' && method === 'POST') return postActivity(req, res);
  // POST /api/neurons — inject one event into the /brain live stream (tests, hooks; whitelisted, spawns NOTHING).
  if (pathname === '/api/neurons' && method === 'POST') return postNeuron(req, res);
  // POST /api/corrections: the sitemap page's "This is wrong" box (origin + JSON checked; appends one line to _corrections.jsonl).
  if (pathname === '/api/corrections' && method === 'POST') return postCorrection(req, res);
  // POST /api/chat — token-gated voice/text conversation (spawns claude -p). (Server STT route cut in this fork.)
  if (pathname === '/api/chat' && method === 'POST') return postChat(req, res);
  if (pathname === '/api/chat-stream' && method === 'POST') return postChatStream(req, res);
  if (pathname === '/api/setup-recheck' && method === 'POST') return postSetupRecheck(req, res);  // force-rebuild the onboarding setup-status cache
  if (pathname === '/api/session-end' && method === 'POST') return postSessionEnd(req, res);   // sole session terminator
  if (pathname === '/api/session-restart' && method === 'POST') return postSessionRestart(req, res);   // recovery: force-respawn owned conductor

  // All remaining routes are GET.
  if (method !== 'GET') return sendJson(res, 405, { error: 'GET only' });

  // The 3D brain view and its files (jailed to ./brain).
  if (pathname === '/brain' || pathname.startsWith('/brain/')) return serveBrain(req, res, pathname, url);
  // The owner's sitemap page and its files (jailed to ./sitemap).
  if (pathname === '/sitemap' || pathname.startsWith('/sitemap/')) return serveSitemap(req, res, pathname);

  switch (pathname) {
    case '/':
    case '/index.html':
      return serveIndex(res);

    case '/api/sessions':
      return apiSessions()
        .then((r) => sendJson(res, 200, r))
        .catch((e) => sendJson(res, 200, { error: e.message }));

    case '/api/memory':
      return sendJson(res, 200, apiMemory());

    case '/api/memory-timeline':
      return sendJson(res, 200, apiMemoryTimeline());

    case '/api/hooks':
      return sendJson(res, 200, apiHooks());

    case '/api/skills':
      return sendJson(res, 200, apiSkills());

    case '/api/graph':
      return sendJson(res, 200, apiGraph());

    case '/api/gates':
      return sendJson(res, 200, apiGates());

    case '/api/gates-compare': {
      // Default: today vs yesterday (Pacific). ?day=YYYY-MM-DD → today vs that day.
      // ?aFrom&aTo&bFrom&bTo (epoch-ms) → arbitrary range comparison. Default path cached ~30s.
      const numQ = (k) => { const v = parseInt(url.searchParams.get(k) || '', 10); return isFinite(v) ? v : undefined; };
      const day = url.searchParams.get('day') || undefined;
      const opts = { day, aFrom: numQ('aFrom'), aTo: numQ('aTo'), bFrom: numQ('bFrom'), bTo: numQ('bTo') };
      const hasRange = [opts.aFrom, opts.aTo, opts.bFrom, opts.bTo].every((n) => typeof n === 'number');
      const isDefault = !day && !hasRange;
      return sendJson(res, 200, apiGatesCompareCached(opts, isDefault));
    }

    case '/api/gate-field':
      return sendJson(res, 200, apiGateField());

    case '/api/sessions-list':
      return sendJson(res, 200, apiSessionsList());

    case '/api/agents':
      return apiAgents().then((r) => sendJson(res, 200, r)).catch((e) => sendJson(res, 500, { error: e.message }));

    case '/api/usage':
      return sendJson(res, 200, apiUsage());

    case '/api/limits':
      // Async (makes a cached ~1/min probe to the Anthropic API for the real rate-limit headers).
      return apiLimits()
        .then((r) => sendJson(res, 200, r))
        .catch((e) => sendJson(res, 200, { status: 'unknown', note: e.message, ts: Date.now() }));

    case '/api/burn-history': {
      // ?hours=N (default 24) OR ?from=<epochMs>&to=<epochMs>. Slices the in-memory Pacific-hour burn
      // index (built/refreshed in the background) — instant + complete over the rolling window.
      const now = Date.now();
      const fromQ = parseInt(url.searchParams.get('from') || '', 10);
      const toQ = parseInt(url.searchParams.get('to') || '', 10);
      let fromMs, toMs, isDefault = false;
      if (isFinite(fromQ) && isFinite(toQ) && toQ > fromQ) {
        fromMs = fromQ; toMs = toQ;
      } else {
        let hours = parseInt(url.searchParams.get('hours') || '24', 10);
        if (!isFinite(hours) || hours <= 0) hours = 24;
        hours = Math.min(hours, 24 * 14);     // cap at 14 days of range
        toMs = now; fromMs = toMs - hours * 3600000;
        isDefault = (hours === 24);
      }
      return sendJson(res, 200, apiBurnHistoryCached(fromMs, toMs, isDefault));
    }

    case '/api/session-stats':
      // PHASE 6: the Sessions card list — names + since-start + duration + context-left + total-tokens.
      // Served from a background-built snapshot (refreshed ~45s); NEVER scans transcripts on the request path.
      return sendJson(res, 200, apiSessionStats());

    case '/api/session-history':
      return sendJson(res, 200, apiSessionHistory(url.searchParams.get('id') || ''));

    case '/api/agent-tail':
      return sendJson(res, 200, apiAgentTail(url.searchParams.get('id') || ''));

    case '/api/files':
      return sendJson(res, 200, apiFiles(url.searchParams.get('path') || ''));

    case '/api/file-read':
      return sendJson(res, 200, apiFileRead(url.searchParams.get('path') || ''));

    case '/api/setup-status':
      return respondSetupStatus(res);

    case '/favicon.ico':
      return serveFavicon(res);

    case '/api/ping':
      return sendJson(res, 200, { app: 'ace-os', name: 'Ace OS · Mission Control', port: PORT });

    case '/api/config':
      return sendJson(res, 200, apiConfig());

    case '/vendor/three.min.js':
      return serveVendorThree(res);

    case '/api/stars':
      return sendJson(res, 200, apiStars());

    case '/api/activity':
      return sseStream(req, res); // GET = SSE subscribe

    case '/api/sitemap':
      return apiSitemap(res);

    case '/api/note':
      return apiNote(res, url.searchParams.get('id'));

    case '/api/neurons':
      return sseNeurons(req, res); // GET = SSE subscribe (the /brain view's per-tool live stream)

    default:
      return sendJson(res, 404, { error: 'not found: ' + pathname });
  }
});

server.on('clientError', (err, socket) => {
  try {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  } catch (_) {}
});

server.listen(PORT, HOST, () => {
  const w = watchTranscripts();
  // eslint-disable-next-line no-console
  console.log(`Ace OS · Mission Control on http://${HOST}:${PORT} (localhost only) · live-brain watching ${w || 0} transcript dir(s)`);

  // PHASE 3: warm the per-skill lastRun cache shortly after listen (off the request
  // path so the first requests never wait on the transcript scan), then refresh on an
  // interval. Both calls are fire-and-forget; refreshSkillLastRun() guards against
  // overlapping scans and fails soft. unref() the interval so it never holds the process open.
  setTimeout(() => { refreshSkillLastRun().catch(() => {}); }, 1500);
  const _skillTimer = setInterval(() => { refreshSkillLastRun().catch(() => {}); }, SKILL_REFRESH_MS);
  if (_skillTimer && typeof _skillTimer.unref === 'function') _skillTimer.unref();

  // BURN INDEX: build the per-hour Pacific burn index over the rolling window once shortly after listen
  // (off the request path), then refresh on an interval. Same non-blocking async-readline build as the
  // skill cache; refreshBurnIndex() guards against overlap and fails soft. unref() so it never holds the
  // process open. Until the first build lands, /api/burn-history returns an empty (partial) slice.
  setTimeout(() => { refreshBurnIndex().catch(() => {}); }, 2500);
  const _burnTimer = setInterval(() => { refreshBurnIndex().catch(() => {}); }, BURN_INDEX_REFRESH_MS);
  if (_burnTimer && typeof _burnTimer.unref === 'function') _burnTimer.unref();

  // MEMORY TIMELINE (PHASE 5): build the recent-changes + correctness cache over the ~140-file
  // memory dir once shortly after listen (OFF the request path — a per-request scan hung this
  // server twice), then refresh on an interval. Synchronous fs but tiny + background-only.
  // unref() so it never holds the process open. Until the first build lands, the endpoint returns
  // an empty (building) snapshot honestly.
  setTimeout(() => { try { refreshMemoryTimeline(); } catch (_) {} }, 800);
  const _memTlTimer = setInterval(() => { try { refreshMemoryTimeline(); } catch (_) {} }, MEM_TL_REFRESH_MS);
  if (_memTlTimer && typeof _memTlTimer.unref === 'function') _memTlTimer.unref();

  // SESSION STATS (PHASE 6): build the Sessions-card snapshot (names + since-start + duration +
  // context-left + total-tokens) over recent session transcripts once shortly after listen (OFF the
  // request path — a per-request transcript scan hung this server twice), then refresh every ~45s.
  // Same non-blocking async-readline discipline; refreshSessionStats() guards overlap + fails soft.
  // unref() so it never holds the process open. Until the first build lands, the endpoint reports building:true.
  setTimeout(() => { refreshSessionStats().catch(() => {}); }, 2000);
  const _sessStatTimer = setInterval(() => { refreshSessionStats().catch(() => {}); }, SESSION_STATS_REFRESH_MS);
  if (_sessStatTimer && typeof _sessStatTimer.unref === 'function') _sessStatTimer.unref();

  // SETUP STATUS (onboarding readiness): build the 11-check snapshot (some checks exec/probe) once
  // shortly after listen (OFF the request path), then refresh every ~60s. refreshSetupStatus() guards
  // overlap + fails soft. unref() so it never holds the process open. Until the first build lands,
  // GET /api/setup-status returns { building:true } honestly; POST /api/setup-recheck forces a rebuild.
  setTimeout(() => { refreshSetupStatus().catch(() => {}); }, 1200);
  const _setupTimer = setInterval(() => { refreshSetupStatus().catch(() => {}); }, SETUP_TTL_MS);
  if (_setupTimer && typeof _setupTimer.unref === 'function') _setupTimer.unref();
});