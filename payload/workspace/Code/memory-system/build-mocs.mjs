#!/usr/bin/env node
// build-mocs.mjs — generate the complete, never-stale category indexes (area MOCs) from _manifest.json.
// These are the GROWABLE index layer: MEMORY.md stays a lean curated top-map, the MOCs + manifest hold the
// complete (uncapped) per-note index, and recall.mjs queries it. Re-run after any note add/distill.
//   node build-mocs.mjs
// One MOC per note type: feedback, project, reference, user (_MOC-user.md is new: the user notes had no MOC).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepoRoot, memDirOverride, resolveMemDir } from './lib/notes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Portable repo-root resolution (no hardcoded ${HOME}/ace), shared with the other tools via lib/notes.mjs.
// Order: env overrides (tests/hooks stay authoritative) > git toplevel > marker walk-up > the script's repo.
const ACE = findRepoRoot(__dirname);
// Derive the memory dir from the RESOLVED REPO ROOT, never process.cwd() — a hook may invoke this
// with an arbitrary cwd (multi-session/workflow contexts), and a cwd-derived slug would point at the
// wrong/empty manifest and regenerate the MOCs with 0 notes. repoSlug(ACE) is cwd-independent.
const MEM_OVERRIDE = memDirOverride();
const MEM = resolveMemDir(__dirname);

// MOC output dir guard (the incomplete-hotfix class that gutted the live MOCs): when the mem-dir was
// overridden by env (fixture/test) but MEMSYS_ROOT was NOT explicitly set, ACE is a walked-up/guessed
// root — almost certainly the LIVE repo — and writing _MOC-*.md there would rewrite the live MOCs from
// fixture data. Sandbox instead: write the MOCs NEXT TO the mem-dir (<memdir>/_mocs-out). MOCs land at
// a repo root ONLY when that root was explicitly given (MEMSYS_ROOT) or the mem-dir was derived from it.
let MOC_DIR;
if (MEM_OVERRIDE && !process.env.MEMSYS_ROOT) {
  MOC_DIR = `${MEM}/_mocs-out`;
  fs.mkdirSync(MOC_DIR, { recursive: true });
  console.log(`[build-mocs] mode=sandboxed (mem-dir env override, no MEMSYS_ROOT) -> MOCs to ${MOC_DIR}`);
} else {
  MOC_DIR = ACE;
  console.log(`[build-mocs] mode=rooted -> MOCs to ${MOC_DIR}`);
}
const man = JSON.parse(fs.readFileSync(`${MEM}/_manifest.json`, 'utf8'));

// Atomic write: write to a pid-scoped temp then rename over the target.
function atomicWrite(target, data) {
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, target);
}

const TYPES = {
  feedback: 'Feedback — your durable corrections & standards',
  project: 'Project — initiative state & decisions',
  reference: 'Reference — reusable patterns, specs & external pointers',
  user: 'User: who you are, your setup and how you work',
};
let total = 0;
for (const [t, desc] of Object.entries(TYPES)) {
  const notes = man.notes.filter((n) => n.type === t).sort((a, b) => a.name.localeCompare(b.name));
  total += notes.length;
  let md = `---\ntitle: _MOC-${t}\nnode_type: moc\ntype: memory\ngenerated: build-mocs.mjs — do not hand-edit the list below\n---\n\n`;
  md += `# MOC — ${desc}\n\n`;
  md += `> Auto-generated from \`memory/_manifest.json\` (**${notes.length}** notes). Complete category index — the leaf notes carry the detail. Query any topic: \`node Code/memory-system/recall.mjs "<topic>"\`.\n\n`;
  for (const n of notes) md += `- [[${n.file.replace(/\.md$/, '')}]] — ${(n.description || n.excerpt.slice(0, 120)).trim()}\n`;
  md += `\n**Up:** [[_SITEMAP]]\n`; // Phase 3: the sitemap replaces the June maps (_MOC-memory, _INDEX) as the parent
  atomicWrite(`${MOC_DIR}/_MOC-${t}.md`, md);
  console.log(`_MOC-${t}.md: ${notes.length} notes`);
}
console.log(`total indexed across type-MOCs: ${total} (manifest count ${man.count})`);
