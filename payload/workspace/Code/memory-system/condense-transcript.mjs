#!/usr/bin/env node
// condense-transcript.mjs — make huge session transcripts (10-90MB of tool I/O) mineable. Strips to the
// actual CONVERSATION (user text prompts + assistant text blocks; drops tool_use/tool_result bulk), keeps
// the kickoff (goal) + the tail (where lessons/conclusions crystallize), caps each digest. Writes to
// logs/temp/_mine-digests/<sid8>.txt for the mining workflow to read.
//   node condense-transcript.mjs [N=12]   (condenses the N largest ace past-session transcripts)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = (os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
// D3 slug rule (= Claude Code's projects/<slug> folder name): every character that is not [A-Za-z0-9] -> "-"
const repoSlug = (p = process.cwd()) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').replace(/[^A-Za-z0-9]/g, '-');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Portable repo-root resolution (no hardcoded ${HOME}/ace).
// Order: env overrides (tests/hooks stay authoritative) > git toplevel > marker walk-up > script ../..
// git BEFORE the marker walk-up: nested workspaces (e.g. a Code/<site> folder carrying BOTH .claude/settings.json
// and CLAUDE.md) stop the walk-up early at a subdir; the git root is the real repo root.
function findRepoRoot() {
  if (process.env.MEMSYS_ROOT) return process.env.MEMSYS_ROOT.replace(/\\/g, '/');
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR.replace(/\\/g, '/');
  try {
    const top = cp.execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (top) return top.replace(/\\/g, '/');
  } catch (_) { /* not a git repo / git missing -> fall through */ }
  let d = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(d, '.claude', 'settings.json')) && fs.existsSync(path.join(d, 'CLAUDE.md'))) {
      return d.replace(/\\/g, '/');
    }
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return path.resolve(__dirname, '..', '..').replace(/\\/g, '/');
}

const PROJ = `${HOME}/.claude/projects`;
const ROOT = findRepoRoot();
const OUT = `${ROOT}/logs/temp/_mine-digests`;
// This repo's transcript dirs under ~/.claude/projects: the exact slug of the resolved repo root
// (root-launched sessions) plus <slug>-* (sessions launched from a subdir, e.g. <repo-slug>-Code-...).
// NEVER a bare substring match (/ace/i also matched e.g. *facebook* project dirs).
const SLUG = repoSlug(ROOT);
// Exclude the current session, if known. Derive from env/argv; if unknown, don't exclude anything.
const SELF = (process.env.CLAUDE_SESSION_ID || process.argv[3] || '').trim();
const N = parseInt(process.argv[2] || '12', 10);
fs.mkdirSync(OUT, { recursive: true });

let files = [];
for (const d of fs.readdirSync(PROJ)) {
  if (d !== SLUG && !d.startsWith(SLUG + '-')) continue;
  const dir = path.join(PROJ, d);
  let e = []; try { e = fs.readdirSync(dir); } catch (_) { continue; }
  for (const f of e) { if (f.endsWith('.jsonl') && !(SELF && f.includes(SELF))) { try { files.push({ p: path.join(dir, f), size: fs.statSync(path.join(dir, f)).size }); } catch (_) {} } }
}
files.sort((a, b) => b.size - a.size);
files = files.slice(0, N);

for (const { p, size } of files) {
  const sid = path.basename(p).replace(/\.jsonl$/, '').slice(0, 8);
  let raw = ''; try { raw = fs.readFileSync(p, 'utf8'); } catch (_) { continue; }
  const out = [];
  for (const ln of raw.split('\n')) {
    if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch (_) { continue; }
    if (o.type === 'user' && o.message) {
      const c = o.message.content; let t = '';
      if (typeof c === 'string') t = c;
      else if (Array.isArray(c)) t = c.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ');
      t = (t || '').replace(/\s+/g, ' ').trim();
      if (t && !/^\s*\[/.test(t)) out.push('USER: ' + t.slice(0, 900));
    } else if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
      const t = o.message.content.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text).join(' ').replace(/\s+/g, ' ').trim();
      if (t) out.push('AI: ' + t.slice(0, 1400));
    }
  }
  let digest = out.join('\n');
  if (digest.length > 60000) digest = digest.slice(0, 5000) + '\n...[middle elided]...\n' + digest.slice(-55000);
  fs.writeFileSync(`${OUT}/${sid}.txt`, digest);
  console.log(`${sid}: ${(size / 1048576).toFixed(0)}MB raw -> ${out.length} msgs, ${Math.round(digest.length / 1024)}KB digest`);
}
console.log(`condensed ${files.length} transcripts -> ${OUT}`);
