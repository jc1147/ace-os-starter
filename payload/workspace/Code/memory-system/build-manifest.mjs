#!/usr/bin/env node
// build-manifest.mjs — the retrieval INDEX + dedup substrate for the second brain.
// Scans every atomic note, parses frontmatter + body, and emits _manifest.json in the memory dir:
// a single queryable index (name/type/description/tags/links/excerpt/path) that a `recall` step can
// grep instantly, and that an embedding layer can later attach vectors to. Read-only except the manifest.
//   node build-manifest.mjs
// Notes are read through lib/notes.mjs (the one shared reader): proper frontmatter parsing, so descriptions
// are YAML-unquoted and `type` comes from metadata.type (never the first `type:` found anywhere). Added fields:
// date + dateSource (metadata.modified > newest past date in the note > file time) and home (when present).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readNote, listNotes, resolveMemDir } from './lib/notes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Derive the memory dir from the RESOLVED REPO ROOT, never process.cwd() (a cwd-derived slug would
// scan the wrong/empty dir and emit an empty manifest). Explicit MEMSYS_MEM_DIR/CLAUDE_MEM_DIR win.
const MEM = resolveMemDir(__dirname);
const OUT = `${MEM}/_manifest.json`;

const files = listNotes(MEM);
const notes = [];
for (const f of files) {
  const n = readNote(path.join(MEM, f));
  const excerpt = n.body.replace(/\s+/g, ' ').trim().slice(0, 280);
  const row = {
    file: n.file,
    name: n.name,
    type: n.type,
    description: n.description,
    links: n.links, outdeg: n.links.length,
    bytes: n.bytes,
    mtime: n.mtime,
    excerpt,
    date: n.date,
    dateSource: n.dateSource,
  };
  if (n.home) row.home = n.home;
  notes.push(row);
}
notes.sort((a, b) => (a.type + a.name).localeCompare(b.type + b.name));
const byType = notes.reduce((o, n) => { o[n.type] = (o[n.type] || 0) + 1; return o; }, {});
const manifest = { tool: 'build-manifest', count: notes.length, byType, notes };
const OUT_TMP = `${OUT}.${process.pid}.tmp`;
fs.writeFileSync(OUT_TMP, JSON.stringify(manifest, null, 2));
fs.renameSync(OUT_TMP, OUT);
console.log(`manifest: ${notes.length} notes -> ${OUT}`);
console.log(`byType: ${JSON.stringify(byType)}`);
console.log(`orphans (0 outbound links): ${notes.filter((n) => n.outdeg === 0).length}`);
console.log(`total index size: ${Math.round(fs.statSync(OUT).size / 1024)}KB`);
