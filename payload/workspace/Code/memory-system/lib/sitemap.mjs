// lib/sitemap.mjs - the sitemap model shared by build-sitemap.mjs (writes it) and sitemap-audit.mjs (checks it).
// Read-only: it reads the tree, the placement registry, the skills list and the notes; it never writes.
// Exports:
//   resolvePaths(scriptDir)  { ACE, MEM, memFromEnv, dataDir, mapDir, mode, skillsDir }
//   loadSitemapInputs(p)     { tree, registry, skillRows, skillDirs }
//   buildModel(opts)         { data, problems, warnings }   data = the _sitemap.json contract (version 1)
//   renderSitemapMd(data, tree), renderSectionMd(data, section)   generated text only (no owner blocks)
//   mergeOwnerBlocks(oldText, generatedText)   rewrites only the generated block; all owner text outside it is kept
//   firstSeen(memDir, file, today)             the day a note file first appeared (inbox "since")
//   GEN_OPEN, GEN_CLOSE, USER_OPEN, USER_CLOSE, clip, TYPE_LABEL
import fs from 'node:fs';
import path from 'node:path';
import { findRepoRoot, memDirOverride, resolveMemDir, readAllNotes, localToday } from './notes.mjs';

export const GEN_OPEN = '<!-- @generated build-sitemap: do not edit inside -->';
export const GEN_CLOSE = '<!-- @end-generated -->';
export const USER_OPEN = '<!-- @user -->';
export const USER_CLOSE = '<!-- @end-user -->';
export const TYPE_LABEL = { feedback: 'Your rule', project: 'Project', reference: 'How-to', user: 'About you', note: 'Note' };
const TYPES = new Set(Object.keys(TYPE_LABEL));
const fwd = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');

// Same root and memory-dir resolution and the same sandbox guard as build-mocs.mjs: a memory dir overridden by
// env (fixture/test) WITHOUT an explicit MEMSYS_ROOT writes the maps next to the memory dir (<mem>/_mocs-out),
// never into a guessed (live) repo root.
export function resolvePaths(scriptDir) {
  const ACE = fwd(findRepoRoot(scriptDir));
  const memFromEnv = !!memDirOverride();
  const MEM = fwd(resolveMemDir(scriptDir));
  const sandboxed = memFromEnv && !process.env.MEMSYS_ROOT;
  const mapDir = sandboxed ? `${MEM}/_mocs-out` : ACE;
  const dataDir = fwd(process.env.MEMSYS_SITEMAP_DIR || path.join(scriptDir, 'sitemap'));
  const skillsDir = fwd(process.env.MEMSYS_SKILLS_DIR || `${ACE}/.claude/skills`);
  return { ACE, MEM, memFromEnv, dataDir, mapDir, mode: sandboxed ? 'sandboxed' : 'rooted', skillsDir };
}

export function loadSitemapInputs(p) {
  const tree = JSON.parse(fs.readFileSync(`${p.dataDir}/tree.json`, 'utf8'));
  const registry = JSON.parse(fs.readFileSync(`${p.dataDir}/placement.json`, 'utf8'));
  let skillRows = [];
  try { skillRows = JSON.parse(fs.readFileSync(`${p.dataDir}/skills.json`, 'utf8')); } catch (_) { skillRows = []; }
  let skillDirs = null; // null = the skills folder is not there (keep every listed skill)
  try {
    skillDirs = fs.readdirSync(p.skillsDir).filter((d) => { try { return fs.statSync(path.join(p.skillsDir, d, 'SKILL.md')).isFile(); } catch (_) { return false; } }).sort();
  } catch (_) { skillDirs = null; }
  return { tree, registry, skillRows, skillDirs };
}

// "also" as the note writes it: a flow list "[a, b]", a comma list "a, b", or a YAML block list under metadata
// (the shared frontmatter reader does not parse lists, so a block list is read from the raw frontmatter here).
function noteAlso(note, memDir) {
  const has = (o) => o && Object.prototype.hasOwnProperty.call(o, 'also');
  if (!has(note.metadata)) return null;
  let v = note.metadata.also;
  if (typeof v === 'string' && v.trim() !== '') {
    return v.replace(/^\s*\[|\]\s*$/g, '').split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  try {
    const raw = fs.readFileSync(path.join(memDir, note.file), 'utf8').replace(/^﻿/, '');
    const fm = (raw.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '';
    const m = fm.match(/^([ \t]+)also:[ \t]*\r?\n((?:\1[ \t]*-[ \t]+.*(?:\r?\n|$))+)/m);
    if (m) return m[2].split(/\r?\n/).map((l) => l.replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  } catch (_) { /* unreadable: no also */ }
  return [];
}

const PREFIX_RE = /^(feedback|project|reference|user)[_-]/i;
export function readableTitle(name, id) {
  const n = String(name || '').trim();
  if (n && n !== id && /\s/.test(n)) return n;
  let s = id.replace(PREFIX_RE, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) s = id;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const DASHES = new RegExp('\\s*[' + String.fromCharCode(0x2013, 0x2014) + ']\\s*', 'g'); // en and em dash
// the local day a note file first appeared: the earlier of its birth and change times, capped at today
export function firstSeen(memDir, file, today = localToday()) {
  try {
    const st = fs.statSync(path.join(memDir, file));
    const ts = [st.birthtimeMs, st.mtimeMs].filter((x) => Number.isFinite(x) && x > 0);
    if (!ts.length) return today;
    const d = localToday(new Date(Math.min(...ts)));
    return d < today ? d : today;
  } catch (_) { return today; }
}
export function clip(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').replace(DASHES, ', ').replace(/\\"/g, '"').trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 3).replace(/\s+\S*$/, '');
  return (cut || s.slice(0, n - 3)) + '...';
}

function shiftDay(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + days * 86400000);
  return t.toISOString().slice(0, 10);
}

// The model. `now` is injectable for tests; `today` is the local calendar day of `now`.
export function buildModel({ memDir, inputs, now = new Date() }) {
  const { tree, registry, skillRows, skillDirs } = inputs;
  const today = localToday(now);
  const weekStart = shiftDay(today, -6); // the last 7 calendar days, today included
  const problems = []; const warnings = [];
  const INBOX = (tree.inbox && tree.inbox.slug) || 'unsorted/needs-a-home';
  const topicSection = new Map(); const slugs = [];
  for (const s of tree.sections) { slugs.push(s.slug); for (const t of s.topics) { slugs.push(t.slug); topicSection.set(t.slug, s.slug); } }
  const seenSlug = new Set();
  for (const s of slugs) { if (seenSlug.has(s)) problems.push(`duplicate slug in tree: ${s}`); seenSlug.add(s); }

  const notes = readAllNotes(memDir, { today, onError: (f, e) => problems.push(`unreadable note ${f}: ${e && e.message}`) });
  const byLower = new Map(notes.map((n) => [n.id.toLowerCase(), n.file]));
  const out = {};
  const inbox = [];
  for (const n of notes) {
    const reg = registry[n.file];
    let home = ''; let homeSource = ''; let confidence = 'none'; let also = [];
    const own = (n.home || '').trim();
    if (own) {
      if (topicSection.has(own) || own === INBOX) { home = own; homeSource = own === INBOX ? 'inbox' : 'note'; confidence = own === INBOX ? 'none' : (reg && reg.home === own ? reg.confidence : 'high'); }
      else problems.push(`note home not in the tree: ${n.file} -> ${own}`);
    }
    if (!home && reg) {
      if (topicSection.has(reg.home)) { home = reg.home; homeSource = 'registry'; confidence = reg.confidence || 'medium'; }
      else if (reg.home === INBOX) { home = INBOX; homeSource = 'inbox'; }
      else problems.push(`registry home not in the tree: ${n.file} -> ${reg.home}`);
    }
    if (!home) { home = INBOX; homeSource = 'inbox'; confidence = 'none'; }
    const ownAlso = noteAlso(n, memDir);
    if (ownAlso) also = ownAlso;
    else if (reg && reg.home === home && Array.isArray(reg.also)) also = reg.also.slice();
    also = [...new Set(also)].filter((a) => {
      if (!topicSection.has(a)) { warnings.push(`also-topic not in the tree, dropped: ${n.file} -> ${a}`); return false; }
      return a !== home;
    });
    if (also.length > 2) warnings.push(`more than two also-topics: ${n.file} (${also.length})`);
    // "since" = when the note arrived (registry placedAt, else the earliest of its file's birth and change times,
    // never after today), NOT n.date: that is the newest date written in its text, which may be older than the note
    if (home === INBOX) inbox.push({ file: n.file, since: (reg && reg.home === INBOX && reg.placedAt) || firstSeen(memDir, n.file, today) });
    if (!['high', 'medium', 'low', 'none'].includes(confidence)) { warnings.push(`unknown confidence for ${n.file}: ${confidence}`); confidence = 'medium'; }
    const links = [...new Set(n.links.map((t) => byLower.get(String(t).split(/[\\/]/).pop().replace(/\.md$/i, '').trim().toLowerCase())).filter((f) => f && f !== n.file))].sort();
    const type = TYPES.has(n.type) ? n.type : 'note';
    out[n.file] = {
      id: n.id, title: readableTitle(n.name, n.id), description: n.description, type, typeLabel: TYPE_LABEL[type],
      home, homeSource, also, confidence, date: n.date, dateSource: n.dateSource, links, linkedFrom: [],
    };
  }
  for (const [f, v] of Object.entries(out)) for (const l of v.links) out[l].linkedFrom.push(f);
  for (const v of Object.values(out)) v.linkedFrom.sort();
  for (const f of Object.keys(registry)) if (!out[f]) warnings.push(`registry entry without a note (deleted?): ${f}`);

  // skills: the listed rows whose folder still exists, plus folders not listed (no section)
  const listed = new Set(skillRows.map((r) => r.skill));
  const skills = [];
  for (const r of skillRows) {
    if (skillDirs && !skillDirs.includes(r.skill)) { warnings.push(`listed skill has no folder now: ${r.skill}`); continue; }
    const ok = r.topic && topicSection.has(r.topic);
    skills.push({ skill: r.skill, section: ok ? topicSection.get(r.topic) : null, topic: ok ? r.topic : null });
  }
  for (const d of skillDirs || []) if (!listed.has(d)) skills.push({ skill: d, section: null, topic: null });
  skills.sort((a, b) => (a.skill < b.skill ? -1 : a.skill > b.skill ? 1 : 0));

  const fileSort = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const sections = tree.sections.map((s) => {
    const topics = s.topics.map((t) => {
      const homeNotes = Object.keys(out).filter((f) => out[f].home === t.slug).sort(fileSort);
      const alsoNotes = Object.keys(out).filter((f) => out[f].also.includes(t.slug)).sort(fileSort);
      return { slug: t.slug, name: t.name, scope: t.scope, count: homeNotes.length, notes: homeNotes, also: alsoNotes };
    });
    const secNotes = topics.flatMap((t) => t.notes);
    const changed = secNotes.filter((f) => ['metadata', 'note-text'].includes(out[f].dateSource) && out[f].date >= weekStart && out[f].date <= today).length;
    return { slug: s.slug, name: s.name, scope: s.scope, count: secNotes.length, changedThisWeek: changed, topics,
      skills: skills.filter((k) => k.section === s.slug).map((k) => k.skill) };
  });
  const notesSorted = {};
  for (const f of Object.keys(out).sort(fileSort)) notesSorted[f] = out[f];
  inbox.sort((a, b) => fileSort(a.file, b.file));
  const data = {
    tool: 'build-sitemap', version: 1, built: now.toISOString(), noteCount: notes.length,
    sections, notes: notesSorted, inbox,
    needsReview: Object.keys(notesSorted).filter((f) => notesSorted[f].confidence === 'low'),
    skills,
  };
  return { data, problems, warnings, today };
}

// ---------- markdown ----------
const stem = (f) => f.replace(/\.md$/i, '');
// A description may itself hold [[wikilinks]] (some spelled differently from the file); a map line carries only
// its own link, so description links are shown as plain text.
const unlink = (s) => String(s || '').replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, a, b) => (b || a).trim());
// "<!--" in a description is neutralised: a quoted @user or @generated marker must never become a real one
const noComment = (s) => String(s).replace(/<!--/g, '&lt;!--');
const noteLine = (data, f) => { const n = data.notes[f]; return `- [[${stem(f)}]] (${n.typeLabel}) ${noComment(clip(unlink(n.description || n.title), 150))}`; };

export function renderSitemapMd(data, tree) {
  const topicsN = data.sections.reduce((a, s) => a + s.topics.length, 0);
  const L = [];
  L.push('---', 'title: _SITEMAP', 'node_type: sitemap', 'type: memory', 'generated: build-sitemap.mjs (owner text goes between the @user markers at the end)', '---', '');
  L.push(GEN_OPEN, '# Memory sitemap', '');
  L.push(`Every memory note has one home: a section, then a topic. **${data.noteCount}** notes in ${data.sections.length} sections and ${topicsN} topics. Open a section's map to see its notes. To file a note, pick the topic whose scope fits and read that topic's notes first (update beats create); if nothing fits, it goes to "Needs a home". Search any topic: \`node "$HOME/ace/Code/memory-system/recall.mjs" "<topic>"\`.`, '');
  L.push(`**Needs a home:** ${data.inbox.length} · **Needs a second look:** ${data.needsReview.length}`, '');
  for (const s of data.sections) {
    L.push(`## ${s.name} (${s.count}): [[_MOC-${s.slug}]]`, s.scope, '');
    for (const t of s.topics) L.push(`- \`${t.slug}\` ${t.name} (${t.count}): ${t.scope}`);
    L.push('');
  }
  const ib = tree.inbox || {};
  L.push(`## ${ib.name || 'Needs a home'} (${data.inbox.length})`, ib.scope || '', '');
  for (const x of data.inbox) L.push(`- [[${stem(x.file)}]] since ${x.since}`);
  if (data.inbox.length) L.push('');
  L.push('The same notes listed by note type (feedback, project, reference, user) are in the type maps _MOC-feedback, _MOC-project, _MOC-reference and _MOC-user at the ace root.');
  L.push(GEN_CLOSE);
  return L.join('\n') + '\n';
}

export function renderSectionMd(data, s) {
  const L = [];
  L.push('---', `title: _MOC-${s.slug}`, 'node_type: section-map', 'type: memory', `section: ${s.slug}`, 'generated: build-sitemap.mjs (owner text goes between the @user markers at the end)', '---', '');
  L.push(GEN_OPEN, `# ${s.name}`, '', s.scope, '');
  L.push(`**Up:** [[_SITEMAP]] · ${s.count} notes in ${s.topics.length} topics`, '');
  for (const t of s.topics) {
    L.push(`## ${t.name} (${t.count})`, `\`${t.slug}\`: ${t.scope}`, '');
    if (t.notes.length) { for (const f of t.notes) L.push(noteLine(data, f)); }
    else L.push('_No notes yet._');
    L.push('');
    if (t.also.length) L.push(`Also relevant here: ${t.also.map((f) => `[[${stem(f)}]]`).join(', ')}`, '');
  }
  if (s.skills.length) L.push(`**Playbooks (skills):** ${s.skills.join(', ')}`, '');
  L.push(GEN_CLOSE);
  return L.join('\n') + '\n';
}

// Owner text survives rebuilds (contract S1.4: only the generated block is rewritten). The new file is: the new
// frontmatter, then whatever the owner wrote between the old frontmatter and the generated block (verbatim), then
// the new generated block, then everything after the old generated block (verbatim: @user blocks and any other
// owner text). A new file gets one empty owner block after the generated block. Only text OUTSIDE the old
// generated block counts as the owner's, so markers quoted inside it are never copied out.
const FRONT = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
export function userBlocks(text) {
  const out = []; const re = /<!-- @user -->[\s\S]*?<!-- @end-user -->/g; let m;
  const t = String(text || '');
  const a = t.indexOf(GEN_OPEN), b = a >= 0 ? t.indexOf(GEN_CLOSE, a) : -1;
  const outside = a >= 0 && b >= 0 ? t.slice(0, a) + '\n' + t.slice(b + GEN_CLOSE.length) : t;
  while ((m = re.exec(outside)) !== null) out.push(m[0]);
  return out;
}
export function mergeOwnerBlocks(oldText, generated) {
  const old = String(oldText || '');
  const a = old.indexOf(GEN_OPEN), b = a >= 0 ? old.indexOf(GEN_CLOSE, a) : -1;
  const ga = generated.indexOf(GEN_OPEN);
  if (old && a >= 0 && b >= 0 && ga >= 0) {
    const genFront = generated.slice(0, ga);
    const genBlock = generated.slice(ga);   // GEN_OPEN ... GEN_CLOSE + '\n'
    const fm = old.slice(0, a).match(FRONT);
    const above = (fm ? old.slice(fm[0].length, a) : old.slice(0, a)).replace(/^\s*\n/, '');
    const below = old.slice(b + GEN_CLOSE.length).replace(/^\r?\n/, '');
    return genFront.replace(/\n*$/, '\n') + (above.trim() ? '\n' + above.replace(/\s*$/, '\n') + '\n' : '\n') + genBlock + below;
  }
  const blocks = userBlocks(old);
  const keep = blocks.length ? blocks : [`${USER_OPEN}\n${USER_CLOSE}`];
  return generated + '\n' + keep.join('\n\n') + '\n';
}
export function isGeneratedFile(text) { return String(text || '').includes(GEN_OPEN); }
