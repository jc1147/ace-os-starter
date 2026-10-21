#!/usr/bin/env node
// recall.mjs — query the second brain. This is BOTH the agent's "what have we done like X?" retrieval verb AND
// the dedup check before writing a new note.
//   node recall.mjs "selling asset gate"            top 8 hits
//   node recall.mjs --top 20 selling asset gate     more hits
//   node recall.mjs --json "selling asset gate"     machine-readable
//   node recall.mjs --legacy "selling asset gate"   the old substring scorer over _manifest.json (RECALL_LEGACY=1
//                                                   does the same; kept for one week after the 2026-10 switch)
// Ranking: BM25F over the notes read straight from disk through lib/notes.mjs (so a note written since the last
// index rebuild is found): slug words + name (weight 3), description (2), full body (1). Whole-word tokens,
// stopwords dropped, light plural folding, de-duplicated query terms, k1 1.2, b 0.75, untuned. Aliases from
// aliases.json (e.g. a short name and the full name of the same client) add the group's other forms at a lower weight.
// Ties: score, then distinct query terms matched, then matches in name or slug, then date (newer first), then file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readAllNotes, resolveMemDir } from './lib/notes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- args ----------
const argv = process.argv.slice(2);
let TOP = 8; let LEGACY = process.env.RECALL_LEGACY === '1'; let JSON_OUT = false;
const words = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--legacy') { LEGACY = true; continue; }
  if (a === '--json') { JSON_OUT = true; continue; }
  if (a === '--top') { const n = parseInt(argv[i + 1], 10); if (n > 0) TOP = n; i++; continue; }
  if (/^--top=\d+$/.test(a)) { const n = parseInt(a.slice(6), 10); if (n > 0) TOP = n; continue; }
  words.push(a);
}
const q = (words.join(' ') || '').toLowerCase().trim();
if (!q) { console.error('usage: node recall.mjs [--top N] [--json] [--legacy] <query>'); process.exit(1); }

// The memory dir: env MEMSYS_MEM_DIR / CLAUDE_MEM_DIR first; else lib-workspace (the hooks' resolver: the ace git
// toplevel of CLAUDE_PROJECT_DIR or cwd, else the ace brain found structurally), so the advertised
// `node "$HOME/ace/Code/memory-system/recall.mjs"` searches the ace brain from ANY folder, a nested repo such as
// Code/<some-site> included (its own git toplevel would slug to an empty projects/<slug>/memory). Falls back to
// lib/notes.mjs resolveMemDir only when the hooks' lib cannot be loaded or finds no brain.
function loadWorkspaceLib() {
  const home = process.env.MEMSYS_TEST_HOME || os.homedir() || process.env.USERPROFILE || '';
  const req = createRequire(import.meta.url);
  const cands = [
    process.env.MEMSYS_HOOKS_DIR && path.join(process.env.MEMSYS_HOOKS_DIR, 'lib-workspace.js'),
    path.join(__dirname, '..', 'hooks', 'lib-workspace.js'),
    home && path.join(home, '.claude', 'hooks', 'lib-workspace.js'),
    path.join(__dirname, '..', '..', 'bootstrap', 'dotclaude', 'hooks', 'lib-workspace.js'),
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return req(c); } catch (_) { /* try the next copy */ } }
  return null;
}
function resolveRecallMemDir() {
  const o = process.env.MEMSYS_MEM_DIR || process.env.CLAUDE_MEM_DIR;
  if (o) return o.replace(/\\/g, '/');
  try {
    const lw = loadWorkspaceLib();
    const ws = lw && lw.resolveWorkspace({ cwd: process.cwd(), env: process.env });
    if (ws && ws.memDir) return String(ws.memDir).replace(/\\/g, '/');
  } catch (_) { /* fall back below */ }
  return resolveMemDir(__dirname);
}
const MEM = resolveRecallMemDir();

// ---------- legacy scorer (the pre-2026-10 recall.mjs, unchanged) ----------
if (LEGACY) {
  let man;
  try { man = JSON.parse(fs.readFileSync(`${MEM}/_manifest.json`, 'utf8')); }
  catch (_) { console.error('no _manifest.json — run build-manifest.mjs first'); process.exit(1); }
  const terms = q.split(/\s+/);
  const score = (n) => {
    const hay = (n.name + ' ' + n.type + ' ' + n.description + ' ' + n.excerpt + ' ' + (n.links || []).join(' ')).toLowerCase();
    let s = 0; for (const t of terms) { if (hay.includes(t)) s += (n.name.toLowerCase().includes(t) ? 3 : 1); }
    return s;
  };
  const hits = man.notes.map((n) => ({ n, s: score(n) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, TOP);
  if (!hits.length) { console.log(`no matches for: "${q}"  (likely a NEW topic — safe to write)`); process.exit(0); }
  console.log(`recall "${q}" -> ${hits.length} hit(s):\n`);
  for (const { n, s } of hits) {
    console.log(`[${n.type}] ${n.name}  (score ${s})`);
    console.log(`   ${n.file}`);
    console.log(`   ${(n.description || n.excerpt).slice(0, 150)}\n`);
  }
  process.exit(0);
}

// ---------- text ----------
// Stopwords: the STOP set of the 2026-10-09 audit's eval-retrieval.mjs, unchanged.
const STOP = new Set('a an and are as at be been but by can did do does for from had has have he her him his how i if in into is it its just me my no not of on or our out so than that the their them then there these they this to too up us was we were what when where which who why will with you your yours it\'s i\'m dont don\'t its was were also via per vs each any all more most very only now then here'.split(/\s+/));
let ALIAS = { weight: 0.5, normalize: {}, groups: [] };
try { ALIAS = { ...ALIAS, ...JSON.parse(fs.readFileSync(path.join(__dirname, 'aliases.json'), 'utf8')) }; } catch (_) { /* no alias table: plain BM25F */ }
const NORMALIZE = Object.entries(ALIAS.normalize || {}).sort((a, b) => b[0].length - a[0].length);
function normText(s) {
  let t = String(s || '').toLowerCase();
  for (const [from, to] of NORMALIZE) if (t.includes(from)) t = t.split(from).join(` ${to} `);
  return t;
}
// Light plural folding that leaves short words (and anything with a digit) alone.
function fold(t) {
  if (t.length < 5 || /\d/.test(t)) return t;
  if (t.endsWith('ies') && t.length >= 6) return t.slice(0, -3) + 'y';
  if (t.endsWith('sses')) return t.slice(0, -2);
  if (t.endsWith('s') && !/(?:ss|us|is)$/.test(t)) return t.slice(0, -1);
  return t;
}
// Whole-word tokens. A hyphenated compound also yields its joined form ("fan-out" -> fan, out, fanout), so the
// slug spelling (agent_fanout_...) and the prose spelling (fan-out) meet. One regex pass; the per-word stopword
// and folding decision is memoized (the vocabulary repeats heavily across 700+ notes).
const WORD = new Map(); // raw lowercase word -> folded token, or '' when dropped
function word(x) {
  let v = WORD.get(x);
  if (v === undefined) { v = (x.length > 1 && !STOP.has(x)) ? fold(x) : ''; WORD.set(x, v); }
  return v;
}
function tokenize(s) {
  const t = normText(s);
  const out = [];
  for (const m of t.matchAll(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu)) {
    const w = m[0];
    if (w.indexOf('-') < 0) { const v = word(w); if (v) out.push(v); continue; }
    for (const part of w.split('-')) { const v = word(part); if (v) out.push(v); }
    const j = word(w.replace(/-/g, '')); if (j) out.push(j);
  }
  return out;
}

// Alias forms, tokenized like the text; indexed by first token. A matched form emits the group token "~<id>".
const FORMS = new Map();
for (const g of ALIAS.groups || []) {
  for (const f of g.forms || []) {
    const toks = tokenize(f);
    if (!toks.length) continue;
    if (!FORMS.has(toks[0])) FORMS.set(toks[0], []);
    FORMS.get(toks[0]).push({ id: g.id, toks });
  }
}
function aliasTokens(toks, onlyIds) {
  const out = [];
  if (!FORMS.size) return out;
  for (let i = 0; i < toks.length; i++) {
    const cands = FORMS.get(toks[i]); if (!cands) continue;
    for (const c of cands) {
      if (onlyIds && !onlyIds.has(c.id)) continue;
      let ok = true; for (let k = 1; k < c.toks.length; k++) if (toks[i + k] !== c.toks[k]) { ok = false; break; }
      if (ok) out.push('~' + c.id);
    }
  }
  return out;
}

// ---------- query terms ----------
const qToks = [...new Set(tokenize(q))];
const qTerms = new Map(); // term -> weight (1 for the query's own words; the alias weight for a matched group)
for (const t of qToks) qTerms.set(t, 1);
const qAliasIds = new Set(aliasTokens(tokenize(q)).map((a) => a.slice(1)));
for (const id of qAliasIds) if (!qTerms.has('~' + id)) qTerms.set('~' + id, Number(ALIAS.weight) || 0.5);

// ---------- index (only the query's terms are counted; field lengths count every token) ----------
let notes;
try { notes = readAllNotes(MEM); }
catch (e) { console.error(`no memory dir at ${MEM} (${e && e.code ? e.code : 'unreadable'})`); process.exit(1); }
// An existing but EMPTY memory dir is the wrong brain, not a new topic: never answer "safe to write" from it.
if (!notes.length) {
  console.error(`no notes in ${MEM} (wrong memory dir? set MEMSYS_MEM_DIR, or run from the ace repo)`);
  process.exit(1);
}
const W = [3, 2, 1]; // slug+name, description, body
const K1 = 1.2; const B = 0.75;
const docs = notes.map((n) => {
  const fields = [`${n.id.replace(/[_-]+/g, ' ')} ${n.name}`, n.description, n.body].map((txt) => {
    const toks = tokenize(txt);
    const tf = new Map();
    for (const t of toks) if (qTerms.has(t)) tf.set(t, (tf.get(t) || 0) + 1);
    if (qAliasIds.size) for (const a of aliasTokens(toks, qAliasIds)) tf.set(a, (tf.get(a) || 0) + 1);
    return { tf, len: toks.length };
  });
  return { n, fields };
});
const N = docs.length;
const avg = [0, 1, 2].map((f) => (docs.reduce((a, d) => a + d.fields[f].len, 0) / Math.max(1, N)) || 1);

// ---------- score ----------
const df = new Map();
for (const t of qTerms.keys()) { let c = 0; for (const d of docs) if (d.fields.some((f) => f.tf.has(t))) c++; df.set(t, c); }
const idf = (t) => Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));

const scored = [];
for (const d of docs) {
  let s = 0; const matched = []; let titleHits = 0; let distinct = 0;
  for (const [t, qw] of qTerms) {
    if (!df.get(t)) continue;
    let tfw = 0;
    for (let f = 0; f < 3; f++) {
      const tf = d.fields[f].tf.get(t) || 0;
      if (tf) tfw += W[f] * tf / (1 - B + B * d.fields[f].len / avg[f]);
    }
    if (tfw <= 0) continue;
    const c = qw * idf(t) * tfw / (K1 + tfw);
    s += c; matched.push({ t, c });
    if (!t.startsWith('~')) { distinct++; if (d.fields[0].tf.has(t)) titleHits++; }
  }
  if (s > 0) scored.push({ d, s, matched: matched.sort((a, b) => b.c - a.c), distinct, titleHits });
}
scored.sort((a, b) => (b.s - a.s) || (b.distinct - a.distinct) || (b.titleHits - a.titleHits)
  || String(b.d.n.date).localeCompare(String(a.d.n.date)) || a.d.n.file.localeCompare(b.d.n.file));
const shown = scored.slice(0, TOP);

// ---------- why: the matched words in context ----------
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const groupForms = (id) => ((ALIAS.groups || []).find((g) => g.id === id) || { forms: [] }).forms;
function findIn(text, t) {
  const pats = t.startsWith('~')
    ? groupForms(t.slice(1)).map((f) => esc(f).replace(/\s+/g, '[\\s_-]+'))
    : [esc(t), t.length > 4 ? esc(t.slice(0, -1)) : null].filter(Boolean);
  for (const p of pats) {
    const m = new RegExp(`(?<![\\p{L}\\p{N}])${p}`, 'iu').exec(text);
    if (m) return m.index;
  }
  return -1;
}
function why(x) {
  const n = x.d.n;
  const label = (t) => (t.startsWith('~') ? `alias:${t.slice(1)}` : t);
  const terms = x.matched.map((m) => label(m.t)).join(', ');
  let snip = '';
  const top = x.matched[0] && x.matched[0].t;
  if (top) {
    for (const text of [n.description, n.body]) {
      const flat = String(text || '').replace(/\s+/g, ' ');
      const at = findIn(flat, top);
      if (at >= 0) {
        const a = Math.max(0, at - 50); const b = Math.min(flat.length, at + 90);
        snip = `${a > 0 ? '...' : ''}${flat.slice(a, b).trim()}${b < flat.length ? '...' : ''}`;
        break;
      }
    }
    if (!snip && findIn(`${n.id} ${n.name}`.replace(/[_-]+/g, ' '), top) >= 0) snip = '(in the name)';
  }
  return `why: ${terms}${snip ? ` | "${snip}"` : ''}`;
}
const intScore = (s) => Math.max(1, Math.round(s));

if (JSON_OUT) {
  console.log(JSON.stringify({
    query: q, memDir: MEM, notes: N, matched: scored.length, shown: shown.length,
    hits: shown.map((x) => ({ file: x.d.n.file, name: x.d.n.name, type: x.d.n.type, score: +x.s.toFixed(3), date: x.d.n.date, dateSource: x.d.n.dateSource, description: x.d.n.description, why: why(x) })),
  }, null, 2));
  process.exit(0);
}
if (!shown.length) { console.log(`no matches for: "${q}"  (likely a NEW topic — safe to write)`); process.exit(0); }
console.log(`recall "${q}" -> ${shown.length} hit(s):\n`);
for (const x of shown) {
  const n = x.d.n;
  console.log(`[${n.type}] ${n.name}  (score ${intScore(x.s)})`);
  console.log(`   ${n.file}`);
  console.log(`   ${(n.description || n.body.replace(/\s+/g, ' ').trim()).slice(0, 150)}`);
  console.log(`   ${why(x).slice(0, 260)}\n`);
}
if (scored.length > shown.length) console.log(`+${scored.length - shown.length} more (use --top <n>)`);
