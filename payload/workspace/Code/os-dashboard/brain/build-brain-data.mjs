// build-brain-data.mjs - the WHOLE ace brain as data for the dashboard brain view (/brain).
// The dashboard server runs this on demand (GET /brain/brain-data.json?fresh=1) and serves the JSON it writes.
//
// Reads the memory notes, the project skills and the map files the same way the dashboard's
// apiGraph() does (Code/os-dashboard/server.js), but with NO 600-node cap, and adds what the concepts
// need: created/updated dates and where each date came from, the session (and the folder it was
// started in) that made each note, and brain-health counts. Marks which nodes the live dashboard's
// 600-node cap drops (cut600).
//
// Lobes: the lobes are your sitemap SECTIONS, read from MEM/_sitemap.json
// (written by Code/memory-system/build-sitemap.mjs), in the tree's order, with fixed names and colours.
// Each note sits in its home section, grouped by its home topic; skills sit in their section as its
// playbooks. Map nodes are _SITEMAP and the section maps only (the type MOCs and the retired June maps
// are not drawn). Only when the sitemap file is missing or unreadable do the lobes fall back to the
// link clusters (Louvain) used before, and the data says so (layout: 'clusters', layoutNote), so the
// page can say so on screen.
//
// Writes brain-data.js (window.BRAIN_DATA = ...) and brain-data.json next to itself (or to BRAIN_OUT_DIR).
// Read-only on everything else (notes, sitemap, skills, transcripts, git).
// env (tests): BRAIN_MEM_DIR (memory dir), BRAIN_SITEMAP (sitemap file), BRAIN_MAP_DIR (where the map
//   files are), BRAIN_ACE_DIR (the workspace root), BRAIN_OUT_DIR (where to write), BRAIN_NO_FRESH=1 (never
//   re-run build-sitemap for a stale sitemap).
// usage: node build-brain-data.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// the workspace root: the nearest folder above this file that holds Code/os-dashboard (live: brain -> os-dashboard -> Code -> ace)
function findAce() {
  if (process.env.BRAIN_ACE_DIR) return path.resolve(process.env.BRAIN_ACE_DIR);
  let d = HERE;
  for (let k = 0; k < 8; k++) { if (fs.existsSync(path.join(d, 'Code', 'os-dashboard'))) return d; const up = path.dirname(d); if (up === d) break; d = up; }
  return path.resolve(HERE, '..', '..', '..');
}
const ACE = findAce();
const OUT_DIR = process.env.BRAIN_OUT_DIR ? path.resolve(process.env.BRAIN_OUT_DIR) : HERE;
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const slug = (p) => String(p).replace(/[^A-Za-z0-9]/g, '-'); // Claude Code's rule: every char outside [A-Za-z0-9] -> '-'
const MEM = process.env.BRAIN_MEM_DIR || path.join(PROJECTS, slug(ACE), 'memory');
const ACE_SLUG = slug(ACE), HOME_SLUG = slug(os.homedir());
// file dates are trusted; set BRAIN_TRUST_FILE_DATES_FROM=<ISO date> if a bulk copy/checkout restamped the files before that date
const RECENT_FILE_DATES = (process.env.BRAIN_TRUST_FILE_DATES_FROM && Date.parse(process.env.BRAIN_TRUST_FILE_DATES_FROM)) || 0;

const readSafe = (p) => { try { return fs.readFileSync(p, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n'); } catch { return ''; } };
const clip = (s, n = 200) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; };
const norm = (x) => String(x || '').toLowerCase().trim().replace(/\.md$/, '').replace(/[\s_]+/g, '-').replace(/-+/g, '-');
const strip = (k) => k.replace(/^(feedback|project|reference|user|note)-/i, '');
const prettify = (id) => { const s = String(id).replace(/^(feedback|project|reference|user|note)[_-]/i, '').replace(/[_-]+/g, ' ').trim(); return s ? s[0].toUpperCase() + s.slice(1) : String(id); };
const iso = (t) => (t == null || isNaN(t) ? null : new Date(t).toISOString());

function parseNote(raw) {
  let fm = '', body = raw;
  if (raw.startsWith('---')) { const end = raw.indexOf('\n---', 3); if (end > 0) { fm = raw.slice(3, end); body = raw.slice(end + 4); } }
  const get = (re) => { const m = fm.match(re); return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''; };
  return {
    body,
    name: get(/^name:[ \t]*(.*)$/m),
    desc: get(/^description:[ \t]*(.*)$/m),
    type: (get(/^[ \t]+type:[ \t]*([A-Za-z]+)/m) || get(/^type:[ \t]*([A-Za-z]+)/m)).toLowerCase(),
    origin: get(/originSessionId:[ \t]*([0-9a-f-]{36})/),
    last: get(/lastSessionId:[ \t]*([0-9a-f-]{36})/),
    modified: get(/^[ \t]*modified:[ \t]*(\S+)/m),
  };
}

// ---------- nodes ----------
const nodes = [], byId = new Map(), alias = new Map(), bodies = new Map();
const reg = (key, id) => { if (!key) return; if (!alias.has(key)) alias.set(key, id); const st = strip(key); if (st && !alias.has(st)) alias.set(st, id); };
function add(n, body) { if (byId.has(n.id)) return byId.get(n.id); n.i = nodes.length; nodes.push(n); byId.set(n.id, n); if (body != null) bodies.set(n.id, body); reg(norm(n.id), n.id); return n; }

const VALID = new Set(['feedback', 'project', 'reference', 'user']);
const memFiles = (fs.existsSync(MEM) ? fs.readdirSync(MEM) : []).filter((f) => f.toLowerCase().endsWith('.md')); // same order the dashboard reads them
for (const f of memFiles) {
  const id = f.replace(/\.md$/i, ''), full = path.join(MEM, f), raw = readSafe(full), st = fs.statSync(full);
  if (f.toUpperCase() === 'MEMORY.MD') {
    add({ id: 'MEMORY', label: 'Memory index', type: 'core', desc: 'The router: links to the category maps (MOCs) and the always-on essentials. Every note is reachable from here.', file: f, birth: st.birthtimeMs, mtime: st.mtimeMs }, raw);
    continue;
  }
  const m = parseNote(raw);
  const type = VALID.has(m.type) ? m.type : ((id.match(/^(feedback|project|reference|user)[_-]/i) || [])[1] || 'note').toLowerCase();
  const label = m.name && /\s/.test(m.name) ? m.name : prettify(m.name || id);
  // earliest plausible date written in the note itself: a fallback creation estimate for notes whose only git date is a bulk import
  const bodyDates = ((m.desc || '') + ' ' + m.body).match(/\b20\d\d-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g) || [];
  const bodyFirst = bodyDates.length ? Math.min(...bodyDates.map((d) => Date.parse(d + 'T12:00:00Z'))) : null;
  const n = add({ id, label, name: m.name || id, type, desc: clip(m.desc), file: f, origin: m.origin || null, last: m.last || null, fmModified: m.modified || null, bodyFirst, birth: st.birthtimeMs, mtime: st.mtimeMs, bytes: st.size }, m.body);
  if (m.name) reg(norm(m.name), n.id);
}

// ---------- the sitemap: the owner's sections (Phase 5) ----------
// MEM/_sitemap.json (build-sitemap.mjs). When a note, the tree or the registry is newer than the file, the generator
// is asked for fresh data (--json writes nothing); when that fails, the file as it stands is used.
const TOOLS = path.join(ACE, 'Code', 'memory-system');
const SITEMAP_FILE = process.env.BRAIN_SITEMAP || path.join(MEM, '_sitemap.json');
const newestNote = nodes.reduce((t, n) => Math.max(t, n.mtime || 0), 0);
function validSitemap(d) { return !!(d && Array.isArray(d.sections) && d.sections.length && d.sections.every((s) => s && s.slug && s.name && Array.isArray(s.topics)) && d.notes && typeof d.notes === 'object'); }
function loadSitemap() {
  let st = null; try { st = fs.statSync(SITEMAP_FILE); } catch { /* missing */ }
  if (!st) return { data: null, source: 'missing', note: 'The sitemap file (_sitemap.json) was not found, so the lobes are link clusters, not your sections.' };
  let data = null; try { data = JSON.parse(readSafe(SITEMAP_FILE)); } catch { /* unreadable */ }
  const regFiles = [path.join(TOOLS, 'sitemap', 'tree.json'), path.join(TOOLS, 'sitemap', 'placement.json')];
  const newestInput = Math.max(newestNote, ...regFiles.map((p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } }));
  const gen = path.join(TOOLS, 'build-sitemap.mjs');
  if ((!validSitemap(data) || newestInput > st.mtimeMs + 1000) && !process.env.BRAIN_NO_FRESH && fs.existsSync(gen)) {
    try {
      const txt = execFileSync(process.execPath, [gen, '--json'], { cwd: TOOLS, encoding: 'utf8', timeout: 9000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: Object.assign({}, process.env, { MEMSYS_MEM_DIR: MEM }) });
      const fresh = JSON.parse(txt.slice(txt.indexOf('{')));
      if (validSitemap(fresh)) return { data: fresh, source: 'fresh', note: null };
    } catch { /* keep the file */ }
  }
  if (!validSitemap(data)) return { data: null, source: 'unreadable', note: 'The sitemap file (_sitemap.json) could not be read, so the lobes are link clusters, not your sections.' };
  return { data, source: newestInput > st.mtimeMs + 1000 ? 'file-stale' : 'file', note: null };
}
const SM = loadSitemap();
const SITEMAP = SM.data;
const SECTIONS = !!SITEMAP;
// section colours: this palette handed out in the sitemap's section order (deterministic for a given tree); past its end a
// stable colour from the section slug. The inbox lobe keeps its muted violet.
const SECTION_PALETTE = ['#c98bff', '#55cfe6', '#7fdc6a', '#5aa2ff', '#f2876b', '#ff9ec7', '#e8c15a', '#4fe0b0', '#a593ff', '#ff8de0', '#ffb36b', '#bcaaff', '#6be3ff', '#a9bdd1', '#ffd76b', '#ff6b8b'];
const INBOX_COLOR = '#8b7fb4';
function hueColor(s) {
  let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  const hue = (h >>> 0) % 360, l = 0.68, c = (1 - Math.abs(2 * l - 1)) * 0.85, x = c * (1 - Math.abs(((hue / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return '#' + [r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('');
}
const INBOX_SLUG = 'unsorted', INBOX_TOPIC = 'unsorted/needs-a-home';
const sections = [], topicSec = new Map();
if (SECTIONS) {
  SITEMAP.sections.forEach((s, i) => sections.push({ i, slug: String(s.slug), name: String(s.name), scope: String(s.scope || ''), color: String(s.slug) === 'unsorted' ? INBOX_COLOR : (i < SECTION_PALETTE.length ? SECTION_PALETTE[i] : hueColor(String(s.slug))),
    topics: s.topics.map((t) => ({ slug: String(t.slug), name: String(t.name || t.slug), scope: String(t.scope || '') })), inbox: false }));
  sections.forEach((s) => s.topics.forEach((t) => topicSec.set(t.slug, s.i)));
  // the inbox lobe: what the sitemap has not placed in a section (its inbox, notes newer than the file, a home not in the tree)
  sections.push({ i: sections.length, slug: INBOX_SLUG, name: 'Needs a home', scope: 'Notes and playbooks the sitemap has not placed in a section yet.', color: INBOX_COLOR, topics: [{ slug: INBOX_TOPIC, name: 'Needs a home', scope: '' }], inbox: true });
}
const INBOX_I = SECTIONS ? sections.length - 1 : -1;
// a note's home as the sitemap gives it (build-sitemap already lets a note's own metadata.home win over the registry)
function homeOf(n) {
  const e = SITEMAP.notes[n.file];
  if (!e) return { section: INBOX_I, topic: INBOX_TOPIC, homeSource: 'not-in-sitemap', confidence: 'none' };
  const t = String(e.home || ''), si = topicSec.get(t);
  if (si == null || e.homeSource === 'inbox') return { section: INBOX_I, topic: INBOX_TOPIC, homeSource: e.homeSource === 'inbox' ? 'inbox' : 'home-not-in-tree', confidence: e.confidence || 'none' };
  return { section: si, topic: t, homeSource: e.homeSource || 'registry', confidence: e.confidence || null, also: Array.isArray(e.also) ? e.also : [] };
}
const skillHome = new Map(); // norm(skill name) -> { section, topic }
if (SECTIONS) for (const s of Array.isArray(SITEMAP.skills) ? SITEMAP.skills : []) {
  if (!s || !s.skill) continue;
  const si = topicSec.get(String(s.topic || ''));
  if (si != null) skillHome.set(norm(s.skill), { section: si, topic: String(s.topic) });
  else { const k = sections.findIndex((x) => !x.inbox && x.slug === s.section); if (k >= 0) skillHome.set(norm(s.skill), { section: k, topic: sections[k].topics[0].slug }); }
}
if (SECTIONS) nodes.forEach((n) => { if (n.type !== 'core') { const h = homeOf(n); Object.assign(n, { section: h.section, home: h.topic, homeSource: h.homeSource, confidence: h.confidence, also: h.also || [] }); } });

const domHub = {}, skillDom = {};
const SDIR = path.join(ACE, '.claude', 'skills');
for (const d of fs.existsSync(SDIR) ? fs.readdirSync(SDIR) : []) {
  const sp = path.join(SDIR, d, 'SKILL.md');
  if (!fs.existsSync(sp)) continue;
  const raw = readSafe(sp);
  const dm = ((raw.match(/\ndomain:\s*([a-z-]+)/i) || [])[1] || 'ops').toLowerCase();
  const nm = ((raw.match(/\nname:\s*(.+)/) || [])[1] || d).trim().replace(/^["']|["']$/g, '');
  let desc = '';
  const dM = raw.match(/\ndescription:[ \t]*(.*)(?:\n([ \t]+\S.*))?/);
  if (dM) { const v = (dM[1] || '').trim().replace(/^["']|["']$/g, ''); desc = /^[|>][+-]?$/.test(v) || !v ? (dM[2] || '').trim() : v; }
  const sid = 'skill:' + d;
  const sn = add({ id: sid, label: nm, type: 'skill', desc: clip(desc), file: '.claude/skills/' + d + '/SKILL.md' }, null);
  reg(norm(d), sid); reg(norm(nm), sid); reg(norm('skill-' + d), sid);
  if (SECTIONS) {
    // skills sit in their section as its playbooks: no domain hubs and no separate skills lobe
    const h = skillHome.get(norm(nm)) || skillHome.get(norm(d));
    Object.assign(sn, h ? { section: h.section, home: h.topic, homeSource: 'registry' } : { section: INBOX_I, home: INBOX_TOPIC, homeSource: 'not-in-sitemap' });
    continue;
  }
  skillDom[sid] = dm;
  if (!domHub[dm]) { add({ id: 'domain:' + dm, label: dm.toUpperCase(), type: 'domain', desc: 'Skill domain: ' + dm }, null); reg(norm(dm), 'domain:' + dm); domHub[dm] = 'domain:' + dm; }
}

// map nodes. Sections: _SITEMAP and one map per section (_MOC-<section slug>.md) from the map folder. A map not on disk
// yet is drawn from the sitemap data (what build-sitemap writes into it: the section's notes and its "Also relevant
// here" notes; _SITEMAP links every section map). The type MOCs and the retired June maps are not drawn.
// Clusters (no sitemap): every _INDEX.md / _MOC-*.md at the root, as before.
function mapDir() {
  if (process.env.BRAIN_MAP_DIR) return path.resolve(process.env.BRAIN_MAP_DIR);
  if (process.env.BRAIN_MEM_DIR) { const sb = path.join(MEM, '_mocs-out'); if (fs.existsSync(path.join(sb, '_SITEMAP.md'))) return sb; }
  return ACE;
}
const MAPS = mapDir();
let synthMaps = 0;
if (SECTIONS) {
  const secs = sections.filter((s) => !s.inbox);
  const smPath = path.join(MAPS, '_SITEMAP.md'), smOn = fs.existsSync(smPath);
  if (!smOn) synthMaps++;
  add({ id: '_SITEMAP', label: 'Sitemap', type: 'moc', section: -1, desc: 'The sitemap: your sections and their topics, with one map per section.', file: '_SITEMAP.md', synth: !smOn },
    smOn ? readSafe(smPath) : secs.map((s) => '[[_MOC-' + s.slug + ']]').join('\n'));
  reg(norm('sitemap'), '_SITEMAP');
  for (const s of secs) {
    const id = '_MOC-' + s.slug, f = id + '.md', fp = path.join(MAPS, f), on = fs.existsSync(fp);
    let body;
    if (on) body = readSafe(fp);
    else {
      synthMaps++;
      const src = SITEMAP.sections.find((x) => x.slug === s.slug) || { topics: [] }, stems = new Set();
      src.topics.forEach((t) => (t.notes || []).concat(t.also || []).forEach((nf) => stems.add(String(nf).replace(/\.md$/i, ''))));
      body = [...stems].map((x) => '[[' + x + ']]').join('\n');
    }
    add({ id, label: 'Map: ' + s.name, type: 'moc', section: s.i, desc: 'Section map. ' + s.scope, file: f, synth: !on }, body);
    reg(norm(id.replace(/^_+/, '')), id);
  }
} else {
  for (const f of fs.readdirSync(ACE).filter((x) => /^_(?:INDEX|MOC-.+)\.md$/i.test(x))) {
    const id = f.replace(/\.md$/i, ''), label = id.replace(/^_/, '').replace(/-/g, ' ');
    add({ id, label, type: 'moc', desc: /^_INDEX/i.test(id) ? 'Whole-workspace read-layer root: skills, code projects, business, memory.' : 'Map of content: the generated routing index for one branch of the brain.', file: f }, readSafe(path.join(ACE, f)));
    reg(norm(label), id); reg(norm(id.replace(/^_+/, '')), id);
  }
}

// The live dashboard stops adding nodes at 600, in this same order (server.js apiGraph).
nodes.forEach((n) => { n.cut600 = n.i >= 600; });

// ---------- links ----------
const linkKey = new Map(); const links = [];
const unresolved = new Map(); // target text -> count
function pushLink(a, b, kind) {
  if (!a || !b || a === b) return;
  const A = byId.get(a), B = byId.get(b); if (!A || !B) return;
  const lo = Math.min(A.i, B.i), hi = Math.max(A.i, B.i), k = lo + '|' + hi;
  const dirBit = A.i === lo ? 1 : 2; // 1 = lo->hi written, 2 = hi->lo written
  if (linkKey.has(k)) { const L = links[linkKey.get(k)]; L[3] |= dirBit; return; }
  linkKey.set(k, links.length); links.push([lo, hi, kind, dirBit]);
}
const resolve = (t) => { const k = norm(t); if (alias.has(k)) return alias.get(k); const st = strip(k); if (alias.has(st)) return alias.get(st); return null; };
for (const [id, body] of bodies) {
  const src = byId.get(id); src.refs = 0; src.unresolved = 0;
  const re = /\[\[([^\]]+)\]\]/g; let m;
  while ((m = re.exec(body)) !== null) {
    const t = m[1].split('|')[0].split('#')[0].trim(); if (!t) continue;
    src.refs++;
    const tid = resolve(t);
    if (tid) pushLink(id, tid, 0); else { src.unresolved++; unresolved.set(t, (unresolved.get(t) || 0) + 1); }
  }
  const md = /\]\(([^)\s]+?\.md)(?:#[^)]*)?\)/g; let mm;
  while ((mm = md.exec(body)) !== null) { const tid = resolve(mm[1].split(/[\\/]/).pop()); if (tid) pushLink(id, tid, 0); }
}
for (const sid in skillDom) pushLink(sid, domHub[skillDom[sid]], 1);
const mocSkills = resolve('_MOC-skills'); if (mocSkills) for (const dm in domHub) pushLink(domHub[dm], mocSkills, 2);

const adj = nodes.map(() => []);
for (const [a, b] of links) { adj[a].push(b); adj[b].push(a); }
nodes.forEach((n) => { n.deg = adj[n.i].length; });
const mocIdx = new Set(nodes.filter((n) => n.type === 'moc' || n.type === 'core').map((n) => n.i));

// ---------- dates ----------
// session id -> first timestamp + launch folder, from the first line(s) of every transcript
const sessions = new Map();
for (const dir of fs.existsSync(PROJECTS) ? fs.readdirSync(PROJECTS) : []) {
  const p = path.join(PROJECTS, dir); let files = [];
  try { files = fs.readdirSync(p).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
  for (const f of files) {
    let head = '', tail = '';
    try {
      const fd = fs.openSync(path.join(p, f), 'r'); const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(8192); const n = fs.readSync(fd, buf, 0, buf.length, 0); head = buf.slice(0, n).toString('utf8');
      const tb = Buffer.alloc(8192); const tn = fs.readSync(fd, tb, 0, tb.length, Math.max(0, size - tb.length)); tail = tb.slice(0, tn).toString('utf8');
      fs.closeSync(fd);
    } catch { continue; }
    const t = (head.match(/"timestamp":"([^"]+)"/) || [])[1];
    const ends = tail.match(/"timestamp":"([^"]+)"/g) || [];
    const e = ends.length ? Date.parse(ends[ends.length - 1].slice(13, -1)) : NaN;
    sessions.set(f.slice(0, -6), { start: t ? Date.parse(t) : null, end: isNaN(e) ? null : e, folder: dir === ACE_SLUG ? 'ace' : dir === HOME_SLUG ? 'home' : 'other' });
  }
}
// git: first commit that added each memory file (bulk commits are only an upper bound)
const gitFirst = new Map(); const commitAdds = new Map();
try {
  const log = execFileSync('git', ['log', '--diff-filter=A', '--format=@%h|%cI', '--name-only', '--', 'memory'], { cwd: ACE, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  let cur = null; const rows = [];
  for (const line of log.split('\n')) {
    if (line.startsWith('@')) { const [h, d] = line.slice(1).split('|'); cur = { h, t: Date.parse(d) }; continue; }
    const f = line.trim(); if (!cur || !f.endsWith('.md')) continue;
    rows.push([path.basename(f), cur]); commitAdds.set(cur.h, (commitAdds.get(cur.h) || 0) + 1);
  }
  for (const [f, c] of rows) gitFirst.set(f, c); // log is newest first, so the last write is the oldest add
} catch { /* not a git checkout: git dates stay empty */ }

for (const n of nodes) {
  if (n.type === 'skill' || n.type === 'domain' || n.type === 'moc') continue;
  const s = n.origin ? sessions.get(n.origin) : null;
  const g = gitFirst.get(n.file);
  const gBulk = g ? (commitAdds.get(g.h) || 0) > 150 : false;
  let created = null, src = null;
  // An edit saves a new copy of the file, so its creation time moves to the last edit. Trust it only
  // when nothing says the note existed earlier: git already had it, or it was born after the session
  // that made it had ended (36 h after the start when the end is unknown).
  const sEnd = s && s.start ? (s.end || s.start + 36 * 3600e3) : null;
  const birthOk = n.birth >= RECENT_FILE_DATES
    && !(g && g.t < n.birth - 3600e3)
    && !(sEnd && n.birth > sEnd + 3600e3);
  if (birthOk) { created = n.birth; src = 'file'; }
  else if (s && s.start) { created = s.start; src = 'session-start'; }
  else if (g && !gBulk) { created = g.t; src = 'git'; }
  else if (n.bodyFirst && (!g || n.bodyFirst <= g.t)) { created = n.bodyFirst; src = 'earliest-date-in-note'; }
  else if (g) { created = g.t; src = 'git-bulk-upper-bound'; }
  else if (n.birth) { created = n.birth; src = 'file-approx'; }
  const fmMod = n.fmModified ? Date.parse(n.fmModified) : NaN;
  const updated = Math.max(isNaN(fmMod) ? 0 : fmMod, n.mtime >= RECENT_FILE_DATES ? n.mtime : 0) || null;
  n.created = iso(created); n.createdSource = src; n.updated = iso(updated);
  n.originFolder = n.origin ? (s ? s.folder : 'not-on-this-machine') : null;
}

// ---------- topics (readable, keyword based) ----------
const TOPICS = [
  ['dashboard', 'Dashboard & Ace OS', /dashboard|ace_?os|cockpit|brain_view|mission_control/],
  ['brain', 'Memory & the brain', /memory|wrap_?up|gap_?hunt|recall|manifest|moc_|second_brain|sitemap/],
  ['agents', 'Agents, workflows & hooks', /workflow|agent|fanout|fan_out|subagent|ultracode|effort|hook|gate|contract|skill/],
  ['machines', 'Machines & setup', /migration|laptop|desktop|machine|portab|restart|terminal|windows|powershell|macos|install/],
  ['business', 'Business & clients', /client|customer|business|finance|invoice|sales|marketing|pricing/],
];
for (const n of nodes) {
  if (SECTIONS) { n.topic = n.type === 'moc' || n.type === 'core' ? 'structure' : n.home; continue; } // sections: the note's home topic
  if (n.type === 'skill' || n.type === 'domain') { n.topic = 'skills'; continue; }
  if (n.type === 'moc' || n.type === 'core') { n.topic = 'structure'; continue; }
  const hay = (n.id + ' ' + (n.name || '')).toLowerCase().replace(/[-\s]/g, '_');
  const hit = TOPICS.find(([, , re]) => re.test(hay));
  n.topic = hit ? hit[0] : (n.type === 'feedback' ? 'working' : 'misc');
}
const topicLabels = SECTIONS
  ? Object.fromEntries([...sections.flatMap((s) => s.topics.map((t) => [t.slug, t.name])), ['structure', 'Sitemap & section maps']])
  : Object.fromEntries([...TOPICS.map(([k, l]) => [k, l]), ['skills', 'Skills & domains'], ['structure', 'Index & maps'], ['working', 'How you want the work done'], ['misc', 'Other references']]);

// ---------- communities (Louvain, deterministic) ----------
function louvain(n, edgeList) {
  let A = Array.from({ length: n }, () => new Map());
  for (const [a, b] of edgeList) { A[a].set(b, (A[a].get(b) || 0) + 1); A[b].set(a, (A[b].get(a) || 0) + 1); }
  let member = Array.from({ length: n }, (_, i) => i); // original node -> current super-node
  for (let level = 0; level < 8; level++) {
    const N = A.length; const k = A.map((m) => { let s = 0; for (const w of m.values()) s += w; return s; });
    const m2 = k.reduce((s, x) => s + x, 0); if (!m2) break;
    const c = Array.from({ length: N }, (_, i) => i), tot = k.slice();
    let moved = true, any = false, pass = 0;
    while (moved && pass++ < 30) {
      moved = false;
      for (let i = 0; i < N; i++) {
        const ci = c[i], ki = k[i]; const wc = new Map();
        for (const [j, w] of A[i]) if (j !== i) wc.set(c[j], (wc.get(c[j]) || 0) + w);
        tot[ci] -= ki;
        let best = ci, bestGain = (wc.get(ci) || 0) - (tot[ci] * ki) / m2;
        for (const [cc, w] of wc) { const g = w - (tot[cc] * ki) / m2; if (g > bestGain + 1e-12 || (Math.abs(g - bestGain) <= 1e-12 && cc < best)) { best = cc; bestGain = g; } }
        tot[best] += ki; if (best !== ci) { c[i] = best; moved = true; any = true; }
      }
    }
    if (!any) break;
    const relabel = new Map(); c.forEach((x) => { if (!relabel.has(x)) relabel.set(x, relabel.size); });
    const B = Array.from({ length: relabel.size }, () => new Map());
    for (let i = 0; i < N; i++) for (const [j, w] of A[i]) { const a = relabel.get(c[i]), b = relabel.get(c[j]); B[a].set(b, (B[a].get(b) || 0) + w); }
    member = member.map((x) => relabel.get(c[x]));
    A = B;
  }
  return member;
}
// Communities come from the MEANING links only: the index files (MOCs, MEMORY.md) link to nearly every
// note, so their routing links would pull the clusters toward note type instead of subject.
const isStructural = (n) => n.type === 'moc' || n.type === 'core';
const comm = SECTIONS ? null : louvain(nodes.length, links.filter(([a, b, kind]) => kind !== 2 && !isStructural(nodes[a]) && !isStructural(nodes[b])).map(([a, b]) => [a, b]));
const STOP = new Set('the and for with not but from into over this that when what how why are was use used using its his him owner our you your via per one two all any new old more less than then only must does did can cannot dont about after before between each every just like make made need needs note notes file files run runs ace claude session sessions 2026 rule rules work'.split(' '));
const tokensOf = (n) => [...new Set(String(n.id).toLowerCase().replace(/^(feedback|project|reference|user|skill|domain)[_:-]/, '').split(/[_\-:\s]+/).filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !STOP.has(w)))];
const docFreq = new Map(); nodes.forEach((n) => tokensOf(n).forEach((w) => docFreq.set(w, (docFreq.get(w) || 0) + 1)));
const groups = new Map();
if (!SECTIONS) nodes.forEach((n, i) => {
  const c = isStructural(n) ? 'structure' : comm[i];
  if (!groups.has(c)) groups.set(c, []); groups.get(c).push(n);
});
// clusters of 1-3 notes have no meaning links of their own: pool them as "linked only through the index"
const loose = [];
for (const [c, mem] of [...groups.entries()]) if (c !== 'structure' && mem.length < 4) { loose.push(...mem); groups.delete(c); }
if (loose.length) groups.set('loose', loose);
const ordered = [...groups.entries()].sort((a, b) => (a[0] === 'structure' || a[0] === 'loose' ? 1 : 0) - (b[0] === 'structure' || b[0] === 'loose' ? 1 : 0) || b[1].length - a[1].length);
const communities = [];
if (SECTIONS) {
  // sections: one "community" per section, in the tree's order (the page draws one lobe per entry, same order)
  sections.forEach((s) => {
    const mem = nodes.filter((n) => n.section === s.i && n.type !== 'moc' && n.type !== 'core');
    const anchor = mem.slice().sort((a, b) => b.deg - a.deg || a.id.localeCompare(b.id))[0];
    const types = {}; mem.forEach((n) => { types[n.type] = (types[n.type] || 0) + 1; });
    s.size = mem.length; s.notes = mem.filter((n) => n.type !== 'skill').length; s.playbooks = mem.length - s.notes;
    s.topics.forEach((t) => { t.size = mem.filter((n) => n.home === t.slug && n.type !== 'skill').length; });
    communities.push({ id: s.i, key: 'sec:' + s.slug, label: s.name, keywords: s.topics.map((t) => t.name), anchor: anchor ? anchor.id : null, anchorLabel: anchor ? anchor.label : '', size: mem.length, types });
    mem.forEach((n) => { n.community = s.i; });
  });
  nodes.forEach((n) => { if (n.community == null) n.community = -1; });
}
ordered.forEach(([key, mem], rank) => {
  const tok = new Map();
  for (const n of mem) for (const w of tokensOf(n)) tok.set(w, (tok.get(w) || 0) + 1);
  // distinctive words: frequent in this cluster, rare elsewhere (tf-idf on note names)
  const scored = [...tok.entries()].filter(([, c]) => c >= 2).map(([w, c]) => [w, c * Math.log(nodes.length / docFreq.get(w))]).sort((a, b) => b[1] - a[1]);
  const top = scored.slice(0, 3).map(([w]) => w[0].toUpperCase() + w.slice(1));
  const anchor = mem.slice().sort((a, b) => b.deg - a.deg)[0];
  const types = {}; mem.forEach((n) => { types[n.type] = (types[n.type] || 0) + 1; });
  const label = key === 'structure' ? 'Index & maps' : key === 'loose' ? 'Linked only through the index' : (top.join(' · ') || anchor.label);
  communities.push({ id: rank, key: typeof key === 'string' ? key : 'cluster', label, keywords: top, anchor: anchor.id, anchorLabel: anchor.label, size: mem.length, types });
  mem.forEach((n) => { n.community = rank; });
});

// section pairs: one entry per pair of sections with the number of note links between them (the page draws one arc each)
const sectionLinks = [];
if (SECTIONS) {
  const pc = new Map();
  for (const [a, b] of links) {
    const A = nodes[a], B = nodes[b];
    if (A.type === 'moc' || A.type === 'core' || B.type === 'moc' || B.type === 'core' || A.section == null || B.section == null || A.section === B.section) continue;
    const k = Math.min(A.section, B.section) + '|' + Math.max(A.section, B.section); pc.set(k, (pc.get(k) || 0) + 1);
  }
  [...pc.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).forEach(([k, c]) => { const [a, b] = k.split('|').map(Number); sectionLinks.push([a, b, c]); });
}

// ---------- health ----------
const noteNodes = nodes.filter((n) => VALID.has(n.type) || n.type === 'note');
const inMoc = new Set(); for (const [a, b] of links) { if (mocIdx.has(a)) inMoc.add(b); if (mocIdx.has(b)) inMoc.add(a); }
const weekOf = (t) => { const d = new Date(t); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day); return d.toISOString().slice(0, 10); };
const perWeek = {};
for (const n of noteNodes) { if (!n.created) continue; const w = weekOf(Date.parse(n.created)); perWeek[w] = perWeek[w] || { total: 0 }; perWeek[w].total++; perWeek[w][n.type] = (perWeek[w][n.type] || 0) + 1; }
const byFolder = {}; noteNodes.forEach((n) => { const k = n.originFolder || 'no-session-stamp'; byFolder[k] = (byFolder[k] || 0) + 1; });
const bySource = {}; noteNodes.forEach((n) => { const k = n.createdSource || 'unknown'; bySource[k] = (bySource[k] || 0) + 1; });
let lastCommit = null, uncommitted = null;
try { lastCommit = execFileSync('git', ['log', '-1', '--format=%h|%cI|%s', '--', 'memory'], { cwd: ACE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim(); } catch { /* no git */ }
try { uncommitted = execFileSync('git', ['status', '--porcelain', '--', 'memory'], { cwd: ACE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).split('\n').filter(Boolean).length; } catch { /* no git */ }
const now = Date.now(), DAY = 86400000;
const health = {
  notes: noteNodes.length,
  byType: nodes.reduce((o, n) => { o[n.type] = (o[n.type] || 0) + 1; return o; }, {}),
  links: links.length,
  wikilinkRefs: nodes.reduce((s, n) => s + (n.refs || 0), 0),
  unresolvedRefs: [...unresolved.values()].reduce((s, x) => s + x, 0),
  unresolvedTop: [...unresolved.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([t, c]) => ({ target: t, count: c })),
  orphans: nodes.filter((n) => n.deg === 0).map((n) => n.id),
  notesNotInAnyMoc: noteNodes.filter((n) => !inMoc.has(n.i)).length,
  createdLast7Days: noteNodes.filter((n) => n.created && now - Date.parse(n.created) < 7 * DAY).length,
  createdLast30Days: noteNodes.filter((n) => n.created && now - Date.parse(n.created) < 30 * DAY).length,
  createdPerWeek: Object.fromEntries(Object.entries(perWeek).sort()),
  createdSource: bySource,
  createdBySessionFolder: byFolder,
  topHubs: nodes.slice().sort((a, b) => b.deg - a.deg).slice(0, 15).map((n) => ({ id: n.id, label: n.label, deg: n.deg })),
  dashboardCap: { cap: 600, total: nodes.length, dropped: nodes.filter((n) => n.cut600).length, droppedByType: nodes.filter((n) => n.cut600).reduce((o, n) => { o[n.type] = (o[n.type] || 0) + 1; return o; }, {}), linksTouchingDropped: links.filter(([a, b]) => nodes[a].cut600 || nodes[b].cut600).length },
  lastMemoryCommit: lastCommit,
  uncommittedMemoryPaths: uncommitted,
  sitemap: SECTIONS ? { source: SM.source, built: SITEMAP.built || null, noteCount: SITEMAP.noteCount == null ? null : SITEMAP.noteCount, inboxNotes: noteNodes.filter((n) => n.section === INBOX_I).length,
    notInSitemap: noteNodes.filter((n) => n.homeSource === 'not-in-sitemap').length, needsReview: Array.isArray(SITEMAP.needsReview) ? SITEMAP.needsReview.length : 0, mapsDrawnFromData: synthMaps } : { source: SM.source },
};

const TYPE_COLORS = { core: '#ffffff', user: '#ffffff', feedback: '#f6b74a', project: '#a78bfa', reference: '#49c7ff', note: '#6d5dbf', skill: '#8b5cf6', domain: '#c4b5fd', moc: '#d24bff' };
const out = {
  generatedAt: new Date().toISOString(),
  source: { memoryDir: 'the ace project memory folder (~/.claude/projects/<ace slug>/memory)', skillsDir: '.claude/skills', mocDir: SECTIONS ? 'ace root (_SITEMAP.md, _MOC-<section>.md)' : 'ace root (_INDEX.md, _MOC-*.md)', sitemap: SECTIONS ? 'memory folder _sitemap.json (' + SM.source + ')' : null, note: 'Same reading rules as Code/os-dashboard/server.js apiGraph(), without its 600-node cap.' },
  // 'sections': lobes are the sitemap's sections (sections[], in order); 'clusters': no usable sitemap, lobes are link clusters (layoutNote says why)
  layout: SECTIONS ? 'sections' : 'clusters',
  layoutNote: SECTIONS ? null : SM.note,
  sections: sections.map((s) => ({ i: s.i, slug: s.slug, name: s.name, scope: s.scope, color: s.color, inbox: s.inbox, size: s.size || 0, notes: s.notes || 0, playbooks: s.playbooks || 0, topics: s.topics.map((t) => ({ slug: t.slug, name: t.name, size: t.size || 0 })) })),
  sectionLinks, // [sectionA, sectionB, note links between them], sectionA < sectionB
  palette: { bg: '#05030b', void: '#060410', accent: '#a78bfa', accentDeep: '#7c3aed', accentBright: '#bfa6ff', magenta: '#d24bff', cyan: '#49c7ff', amber: '#f6b74a', ink0: '#f2edff', ink1: '#c3b6e8', ink2: '#8b7fb4', ink3: '#5f5686', line: 'rgba(167,139,250,.34)', lineSoft: 'rgba(167,139,250,.16)', types: TYPE_COLORS },
  topics: Object.entries(topicLabels).map(([id, label]) => ({ id, label, size: nodes.filter((n) => n.topic === id).length })).filter((t) => t.size),
  communities,
  nodes: nodes.map((n) => ({
    i: n.i, id: n.id, label: n.label, type: n.type, desc: n.desc || '', topic: n.topic, community: n.community, deg: n.deg,
    created: n.created || null, createdSource: n.createdSource || null, updated: n.updated || null,
    originSession: n.origin || null, originFolder: n.originFolder || null, lastSession: n.last || null,
    unresolvedLinks: n.unresolved || 0, cut600: n.cut600, file: n.file || null,
    ...(SECTIONS ? { section: n.section == null ? -1 : n.section, home: n.home || null, homeSource: n.homeSource || null, also: n.also && n.also.length ? n.also : undefined, synth: n.synth || undefined } : {}),
  })),
  links, // [lowIndex, highIndex, kind (0 note link, 1 skill->domain, 2 domain->skills map), dir (1 low->high written, 2 high->low, 3 both)]
  health,
};
// write-then-rename, so the dashboard server (which serves brain-data.json) never reads a half-written file
const writeAtomic = (name, text) => { const tmp = path.join(OUT_DIR, name + '.tmp'); fs.writeFileSync(tmp, text); fs.renameSync(tmp, path.join(OUT_DIR, name)); };
writeAtomic('brain-data.json', JSON.stringify(out));
writeAtomic('brain-data.js', '// generated by build-brain-data.mjs; do not edit by hand\nwindow.BRAIN_DATA = ' + JSON.stringify(out) + ';\n');
console.log(JSON.stringify({ layout: out.layout, layoutNote: out.layoutNote, sitemap: health.sitemap, sections: out.sections.map((s) => s.slug + ':' + s.size).join(' '), sectionPairs: sectionLinks.length, nodes: nodes.length, byType: health.byType, links: links.length, communities: communities.length, topComm: communities.slice(0, 14).map((c) => c.label + ' (' + c.size + ')'), topics: out.topics.map((t) => t.id + ':' + t.size).join(' '), createdSource: bySource, createdBySessionFolder: byFolder, unresolvedRefs: health.unresolvedRefs, orphans: health.orphans.length, notesNotInAnyMoc: health.notesNotInAnyMoc, cap: health.dashboardCap, last7: health.createdLast7Days, last30: health.createdLast30Days, lastCommit: health.lastMemoryCommit, uncommitted: health.uncommittedMemoryPaths, kb: Math.round(fs.statSync(path.join(OUT_DIR, 'brain-data.js')).size / 1024) }, null, 1));
