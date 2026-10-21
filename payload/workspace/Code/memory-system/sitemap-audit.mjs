#!/usr/bin/env node
// sitemap-audit.mjs - checks the memory sitemap that build-sitemap.mjs wrote. Read-only.
// Hard failures (exit 1):
//   - a home that is not in the tree (in _sitemap.json, or a note's own metadata.home, or the registry)
//   - counts that do not add up to the note total (sections + inbox = noteCount = the notes on disk; every
//     section = its topics; every note in exactly one topic or the inbox)
//   - a duplicate slug (tree or _sitemap.json)
//   - a map wikilink that does not resolve (_SITEMAP.md and the section maps; a missing map counts too)
//   - _sitemap.json missing or unreadable
// Warnings (exit 0, listed): a topic over 40 notes, an inbox note older than 14 days, more than 10 inbox notes,
// a skill with no section, an empty section, plus the model's own notes (dropped also-topics, registry rows
// without a note, listed skills without a folder).
//   node sitemap-audit.mjs              the list, then the one-line verdict (last line)
//   node sitemap-audit.mjs --verdict    only the one-line verdict
// Same root, memory-dir and map-dir resolution as build-sitemap.mjs (lib/sitemap.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listNotes, localToday } from './lib/notes.mjs';
import { resolvePaths, loadSitemapInputs, buildModel } from './lib/sitemap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERDICT_ONLY = process.argv.includes('--verdict');
const P = resolvePaths(HERE);
const hard = []; const warn = [];
const TOPIC_MAX = 40; const INBOX_MAX = 10; const INBOX_AGE_DAYS = 14;

function finish(extra = '') {
  if (!VERDICT_ONLY) {
    for (const h of hard) console.log(`HARD  ${h}`);
    for (const w of warn) console.log(`WARN  ${w}`);
  }
  const v = `sitemap-audit: ${hard.length ? 'FAIL' : 'PASS'} ${extra}${hard.length} hard, ${warn.length} warning(s)`;
  console.log(v);
  process.exit(hard.length ? 1 : 0);
}

let data = null;
try { data = JSON.parse(fs.readFileSync(`${P.MEM}/_sitemap.json`, 'utf8')); }
catch (e) { hard.push(`_sitemap.json missing or unreadable in ${P.MEM}: ${e.message}`); finish(); }
let inputs = null;
try { inputs = loadSitemapInputs(P); } catch (e) { hard.push(`sitemap data unreadable in ${P.dataDir}: ${e.message}`); finish(); }

// ---- the tree ----
const INBOX = (inputs.tree.inbox && inputs.tree.inbox.slug) || 'unsorted/needs-a-home';
const topics = new Set(); const seen = new Set();
for (const s of inputs.tree.sections) {
  for (const slug of [s.slug, ...s.topics.map((t) => t.slug)]) { if (seen.has(slug)) hard.push(`duplicate slug in tree.json: ${slug}`); seen.add(slug); }
  for (const t of s.topics) topics.add(t.slug);
}
// ---- the sources (note metadata.home, the registry), through the same model the builder uses ----
const model = buildModel({ memDir: P.MEM, inputs });
for (const p of model.problems) hard.push(p);
for (const w of model.warnings) warn.push(w);

// ---- the written data ----
const seen2 = new Set();
for (const s of data.sections || []) {
  for (const slug of [s.slug, ...(s.topics || []).map((t) => t.slug)]) { if (seen2.has(slug)) hard.push(`duplicate slug in _sitemap.json: ${slug}`); seen2.add(slug); }
}
const files = Object.keys(data.notes || {});
const disk = listNotes(P.MEM);
for (const [f, n] of Object.entries(data.notes || {})) if (!topics.has(n.home) && n.home !== INBOX) hard.push(`home not in the tree: ${f} -> ${n.home}`);
const placedIn = new Map();
let secSum = 0;
for (const s of data.sections || []) {
  let tSum = 0;
  for (const t of s.topics || []) {
    if ((t.notes || []).length !== t.count) hard.push(`topic ${t.slug}: count ${t.count} but ${t.notes.length} notes listed`);
    tSum += t.count;
    for (const f of t.notes || []) {
      if (placedIn.has(f)) hard.push(`note listed twice: ${f} (${placedIn.get(f)} and ${t.slug})`);
      placedIn.set(f, t.slug);
      if (!data.notes[f] || data.notes[f].home !== t.slug) hard.push(`note ${f} listed under ${t.slug} but its home is ${data.notes[f] ? data.notes[f].home : '(missing)'}`);
    }
    if (t.count > TOPIC_MAX) warn.push(`topic over ${TOPIC_MAX} notes: ${t.slug} (${t.count})`);
  }
  if (tSum !== s.count) hard.push(`section ${s.slug}: count ${s.count} but its topics add up to ${tSum}`);
  if (s.count === 0) warn.push(`empty section: ${s.slug}`);
  secSum += s.count;
}
for (const x of data.inbox || []) { if (placedIn.has(x.file)) hard.push(`inbox note also listed in a topic: ${x.file}`); placedIn.set(x.file, INBOX); }
const inboxN = (data.inbox || []).length;
if (secSum + inboxN !== data.noteCount) hard.push(`sections (${secSum}) + inbox (${inboxN}) = ${secSum + inboxN}, not the note total ${data.noteCount}`);
if (files.length !== data.noteCount) hard.push(`notes listed ${files.length}, not the note total ${data.noteCount}`);
if (disk.length !== data.noteCount) hard.push(`notes on disk ${disk.length}, not the note total ${data.noteCount} (stale _sitemap.json: run build-sitemap.mjs)`);
for (const f of files) if (!placedIn.has(f)) hard.push(`note in no topic and not in the inbox: ${f}`);
// ---- warnings on the data ----
if (inboxN > INBOX_MAX) warn.push(`inbox holds ${inboxN} notes (more than ${INBOX_MAX})`);
const today = localToday();
const ageDays = (ymd) => Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(String(ymd).slice(0, 10) + 'T00:00:00Z')) / 86400000);
for (const x of data.inbox || []) if (ageDays(x.since) > INBOX_AGE_DAYS) warn.push(`inbox note older than ${INBOX_AGE_DAYS} days: ${x.file} (since ${x.since})`);
for (const k of data.skills || []) if (!k.section) warn.push(`skill with no section: ${k.skill}`);

// ---- the maps ----
const stems = new Set(disk.map((f) => f.replace(/\.md$/i, '').toLowerCase()));
const mapNames = ['_SITEMAP', ...(data.sections || []).map((s) => `_MOC-${s.slug}`)];
const mapSet = new Set(mapNames.map((m) => m.toLowerCase()));
let linkCount = 0;
for (const m of mapNames) {
  let text;
  try { text = fs.readFileSync(`${P.mapDir}/${m}.md`, 'utf8'); } catch (_) { hard.push(`map missing: ${P.mapDir}/${m}.md`); continue; }
  const re = /\[\[([^\]]+)\]\]/g; let x;
  while ((x = re.exec(text)) !== null) {
    linkCount++;
    const t = x[1].split('|')[0].split('#')[0].trim().toLowerCase();
    if (!stems.has(t) && !mapSet.has(t)) hard.push(`map wikilink does not resolve: ${m}.md -> [[${x[1]}]]`);
  }
}
finish(`${data.noteCount} notes, ${(data.sections || []).length} sections, inbox ${inboxN}, review ${(data.needsReview || []).length}, ${linkCount} map links (${P.mode}); `);
