#!/usr/bin/env node
// build-home-router.mjs - writes the HOME-folder MEMORY.md (HOME_MEM/MEMORY.md), the router Claude Code
// auto-loads when a session starts in the home folder, so those sessions see the ace brain too.
//
// Inside `<!-- @generated build-home-router: do not edit inside -->` ... `<!-- @end-generated -->` it writes:
//   - one line saying the session started outside ace, where the full memory lives, and the cd-safe recall
//     command;
//   - the ace router's "Always-on essentials" section, with relative note links rewritten to
//     ~/.claude/projects/<ace slug>/memory/<file>.md (forward slashes; wikilinks unchanged);
//   - the ace router's tree links.
// Everything outside the generated block is kept verbatim (a missing block is appended at the end).
// Router budgets (the ones block-memory-md-too-large.js enforces): 6,000 bytes, 22 lines starting `- [`,
// 220 characters per such line. A pin line that the longer link pushes past 220 characters keeps its first
// link, turns any later link into a wikilink ("text [[file]]"), and has its trailing description shortened
// at a word boundary with "..." (a link is never cut). If the result still
// breaks a budget, the old file is kept and the reason printed (exit 3).
// Atomic write (temp + rename). Unchanged content: only the file time is refreshed (so the regen hook's
// "ace router newer than home router" check settles).
//
//   node build-home-router.mjs [--print]
// Env: MEMSYS_MEM_DIR / CLAUDE_MEM_DIR / MEMSYS_ROOT (via lib-workspace), MEMSYS_HOME_MEM_DIR (target dir),
//      MEMSYS_TEST_HOME (test seam: replaces the home folder). A mem-dir from env with no explicit target
//      (MEMSYS_HOME_MEM_DIR or MEMSYS_TEST_HOME) never writes the real home router (prints only).
// Exit: 0 written / unchanged / printed, 1 error, 3 kept the old file (budget).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const normDir = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
const HOME = normDir(process.env.MEMSYS_TEST_HOME || os.homedir() || process.env.USERPROFILE || '');
// D3 slug rule (= Claude Code's projects/<slug> folder name): every character that is not [A-Za-z0-9] -> "-"
const repoSlug = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').replace(/[^A-Za-z0-9]/g, '-');

const BEGIN = '<!-- @generated build-home-router: do not edit inside -->';
const END = '<!-- @end-generated -->';
const BUDGET_BYTES = 6000, BUDGET_BULLETS = 22;
// Test seam, honored ONLY together with MEMSYS_TEST_HOME: a fixture home in a deep temp folder has a ~170-char
// memory path, so no pin line could ever fit 220 there. Production always uses 220.
const BUDGET_LINE = (process.env.MEMSYS_TEST_HOME && Number(process.env.MEMSYS_TEST_LINE_BUDGET)) || 220;

// lib-workspace.js lives with the hooks (CommonJS). Staging layout first, then the installed hooks, then the
// bootstrap seed copy. Inline fallback: this script's own repo.
function loadWorkspaceLib() {
  const cands = [
    process.env.MEMSYS_HOOKS_DIR && path.join(process.env.MEMSYS_HOOKS_DIR, 'lib-workspace.js'),
    path.join(HERE, '..', 'hooks', 'lib-workspace.js'),
    path.join(HOME, '.claude', 'hooks', 'lib-workspace.js'),
    path.join(HERE, '..', '..', 'bootstrap', 'dotclaude', 'hooks', 'lib-workspace.js'),
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return require(c); } catch (_) {} }
  return null;
}
function resolve() {
  const lib = loadWorkspaceLib();
  if (lib) return lib.resolveWorkspace({ cwd: process.cwd(), env: process.env });
  const aceRoot = normDir(process.env.MEMSYS_ROOT || path.resolve(HERE, '..', '..'));
  const memDir = normDir(process.env.MEMSYS_MEM_DIR || process.env.CLAUDE_MEM_DIR || `${HOME}/.claude/projects/${repoSlug(aceRoot)}/memory`);
  return { aceRoot, memDir, toolsDir: `${aceRoot}/Code/memory-system`, homeMemDir: `${HOME}/.claude/projects/${repoSlug(HOME)}/memory`, source: 'inline' };
}

// "~/..." display form of a path under the home folder (forward slashes)
const tilde = (p) => { const n = normDir(p); return n.toLowerCase().startsWith(HOME.toLowerCase() + '/') ? '~' + n.slice(HOME.length) : n; };

// lines of a "## <title>" section (up to the next "## " heading), without trailing blank lines
function section(lines, re) {
  const i = lines.findIndex((l) => re.test(l));
  if (i < 0) return null;
  const out = [];
  for (let j = i + 1; j < lines.length && !/^##\s/.test(lines[j]); j++) out.push(lines[j]);
  while (out.length && !out[out.length - 1].trim()) out.pop();
  while (out.length && !out[0].trim()) out.shift();
  return out;
}

// relative note link "](file.md)" or "](file.md#x)" -> "](<memPrefix>/file.md...)"; wikilinks and links with a
// scheme, an absolute path, ~ or a folder are left alone.
function rewriteLinks(line, memPrefix) {
  return line.replace(/\]\(([^()\s/\\:~#][^()\s/\\:]*\.md(?:#[^()\s]*)?)\)/g, (m, f) => `](${memPrefix}/${f})`);
}

// shorten a `- [` line over the per-line budget: cut the text after the last link at a word boundary.
function fitLine(line0) {
  let line = line0;
  if (!line.startsWith('- [') || line.length <= BUDGET_LINE) return line;
  // second and later links on a pin line become wikilinks ("text [[file]]"): shorter, still resolvable
  let k = 0;
  line = line.replace(/\[([^\]]*)\]\(([^()]*?)([^()/]+)\.md(?:#[^()]*)?\)/g, (m, txt, dir, stem) => (k++ === 0 ? m : `${txt} [[${stem}]]`));
  if (line.length <= BUDGET_LINE) return line;
  let lastLinkEnd = 0;
  const re = /\]\([^()]*\)|\[\[[^\]]*\]\]/g; let m; // markdown links AND the [[wikilinks]] made above
  while ((m = re.exec(line)) !== null) lastLinkEnd = m.index + m[0].length;
  const room = BUDGET_LINE - 3;
  // a link past the cut point: shorten the TEXT before it instead (a link is never cut); else the budget check reports it
  if (lastLinkEnd > room) return shrinkText(line) || line;
  let cut = line.lastIndexOf(' ', room);
  if (cut < lastLinkEnd) cut = room;
  return line.slice(0, cut).replace(/[\s,;:.\u00b7\u2014\u2013-]+$/, '') + '...';
}

// Shorten the plain-text spans of a pin line (longest first, at a word boundary, ending in "...") until it fits,
// leaving every link and wikilink whole. null when it cannot fit that way.
function shrinkText(line) {
  const parts = []; const re = /\[[^\]]*\]\([^()]*\)|\[\[[^\]]*\]\]/g; let last = 0; let m;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) parts.push({ t: line.slice(last, m.index), keep: false });
    parts.push({ t: m[0], keep: true }); last = m.index + m[0].length;
  }
  if (last < line.length) parts.push({ t: line.slice(last), keep: false });
  let over = line.length - BUDGET_LINE;
  for (let guard = 0; over > 0 && guard < 20; guard++) {
    const x = parts.filter((p) => !p.keep && p.t.trim().length > 12).sort((a, b) => b.t.length - a.t.length)[0];
    if (!x) return null;
    const lead = x.t.match(/^\s*/)[0]; const trail = x.t.match(/\s*$/)[0]; const core = x.t.trim();
    // text right before a link is that link's label ("STOP, no offers [[...]]"): keep its last words, cut the middle
    const beforeLink = parts.indexOf(x) < parts.length - 1;
    let tailKeep = '';
    if (beforeLink && core.length > 60) { const at = core.lastIndexOf(' ', core.length - 25); if (at > 0) tailKeep = core.slice(at + 1); }
    const head = core.slice(0, core.length - tailKeep.length).trim();
    const want = Math.max(4, head.length - over - 3);
    let cut = head.lastIndexOf(' ', want); if (cut < 4) cut = want;
    const nc = head.slice(0, cut).replace(/[\s,;:.\u00b7\u2014\u2013-]+$/, '') + '...' + (tailKeep ? ` ${tailKeep}` : '');
    if (nc.length >= core.length) return null;
    over -= core.length - nc.length; x.t = lead + nc + trail;
  }
  return over > 0 ? null : parts.map((p) => p.t).join('');
}

function budgetProblems(text) {
  const probs = [];
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > BUDGET_BYTES) probs.push(`${bytes} bytes > ${BUDGET_BYTES}`);
  const bullets = text.split('\n').filter((l) => l.startsWith('- ['));
  if (bullets.length > BUDGET_BULLETS) probs.push(`${bullets.length} lines starting "- [" > ${BUDGET_BULLETS}`);
  for (const l of bullets) if (l.length > BUDGET_LINE) probs.push(`a "- [" line is ${l.length} chars > ${BUDGET_LINE}: ${l.slice(0, 70)}...`);
  return probs;
}

function main() {
  const PRINT = process.argv.includes('--print');
  const ws = resolve();
  if (!ws) { console.error('[build-home-router] no ace workspace resolved'); return 1; }
  const memDir = normDir(ws.memDir);
  const targetDir = normDir(process.env.MEMSYS_HOME_MEM_DIR || ws.homeMemDir);
  const target = `${targetDir}/MEMORY.md`;
  if (targetDir.toLowerCase() === memDir.toLowerCase()) { console.error('[build-home-router] home memory dir is the ace memory dir: nothing to do'); return 0; }
  const memFromEnv = !!(process.env.MEMSYS_MEM_DIR || process.env.CLAUDE_MEM_DIR);
  const targetExplicit = !!(process.env.MEMSYS_HOME_MEM_DIR || process.env.MEMSYS_TEST_HOME);
  const writeAllowed = !memFromEnv || targetExplicit;

  let aceRouter;
  try { aceRouter = fs.readFileSync(`${memDir}/MEMORY.md`, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'); }
  catch (e) { console.error(`[build-home-router] cannot read the ace router ${memDir}/MEMORY.md: ${e.message}`); return 1; }
  const lines = aceRouter.split('\n');
  const essentials = section(lines, /^##\s+Always-on essentials/i);
  const tree = section(lines, /^##\s+The tree/i);
  if (!essentials || !tree) { console.error('[build-home-router] the ace router has no "## Always-on essentials" or "## The tree" section: kept the old file'); return 3; }

  const memPrefix = tilde(memDir);
  const ess = essentials.map((l) => fitLine(rewriteLinks(l, memPrefix)));
  const treeLines = tree.filter((l) => /^\s*-\s/.test(l));
  const block = [
    BEGIN,
    `This session started outside ace. The full memory lives in ace: notes in \`${memPrefix}/\`, tree MOCs in \`${tilde(ws.aceRoot)}/_MOC-*.md\`. Recall from any folder: \`node "$HOME/ace/Code/memory-system/recall.mjs" "<topic>"\`.`,
    '',
    '## Always-on essentials (from the ace router)',
    ...ess,
    '',
    '## The tree (ace)',
    ...treeLines,
    END,
  ].join('\n');

  let old = '';
  try { old = fs.readFileSync(target, 'utf8'); } catch (_) { old = ''; }
  const eol = /\r\n/.test(old) ? '\r\n' : '\n';
  const blockOut = block.replace(/\n/g, eol);
  let next;
  const bi = old.indexOf(BEGIN), ei = old.indexOf(END);
  if (bi >= 0 && ei > bi) next = old.slice(0, bi) + blockOut + old.slice(ei + END.length);
  else if (old.length) next = old + (old.endsWith('\n') ? '' : eol) + eol + blockOut + eol;
  else next = blockOut + eol;

  const probs = budgetProblems(next.replace(/\r\n/g, '\n'));
  const bytes = Buffer.byteLength(next, 'utf8');
  const nLines = next.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length;
  const bullets = next.replace(/\r\n/g, '\n').split('\n').filter((l) => l.startsWith('- [')).length;
  const stats = `${bytes} bytes, ${nLines} lines, ${bullets} lines starting "- [" (budgets ${BUDGET_BYTES} / ${BUDGET_BULLETS} / ${BUDGET_LINE} chars per line)`;

  if (PRINT) {
    process.stdout.write(next);
    console.log(`\n[build-home-router] --print: target ${target}; ${stats}; ws=${ws.source}${probs.length ? '; WOULD KEEP THE OLD FILE: ' + probs.join('; ') : ''}`);
    return 0;
  }
  if (probs.length) { console.error(`[build-home-router] kept the old file ${target}: ${probs.join('; ')}`); return 3; }
  if (!writeAllowed) { console.error(`[build-home-router] mem-dir comes from env and no target was named (MEMSYS_HOME_MEM_DIR / MEMSYS_TEST_HOME): not writing the real home router`); return 0; }
  fs.mkdirSync(targetDir, { recursive: true });
  if (next === old) {
    const now = new Date(); try { fs.utimesSync(target, now, now); } catch (_) {}
    console.log(`[build-home-router] unchanged: ${target} (${stats})`);
    return 0;
  }
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, target);
  console.log(`[build-home-router] wrote ${target} (${stats})`);
  return 0;
}

let code = 1;
try { code = main(); } catch (e) { console.error(`[build-home-router] error: ${e && e.message}`); code = 1; }
process.exit(code);
