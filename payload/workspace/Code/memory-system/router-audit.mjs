#!/usr/bin/env node
// router-audit.mjs — one-command health check for MEMORY.md router discipline.
// Prints bytes / % of budgets / bullet count / longest pin line; exit 0 = within budgets,
// exit 1 = over at least one budget (the same limits block-memory-md-too-large.js enforces
// at write time — keep the four constants in sync with that hook).
//   node Code/memory-system/router-audit.mjs            (resolves mem-dir from the git repo)
//   node Code/memory-system/router-audit.mjs <MEMORY.md path>
import fs from 'node:fs';
import os from 'node:os';
import cp from 'node:child_process';

const HARD_CAP_BYTES = 24400;
const ROUTER_BUDGET_BYTES = 6000;
const MAX_BULLET_LINES = 22;
const MAX_PIN_LINE_CHARS = 220;

const HOME = (os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
// D3 slug rule (= Claude Code's projects/<slug> folder name): every character that is not [A-Za-z0-9] -> "-"
const repoSlug = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').replace(/[^A-Za-z0-9]/g, '-');

let file = process.argv[2];
if (!file) {
  try {
    const top = cp.execFileSync('git', ['rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().replace(/\\/g, '/');
    file = `${HOME}/.claude/projects/${repoSlug(top)}/memory/MEMORY.md`;
  } catch (_) { /* fall through */ }
}
if (!file || !fs.existsSync(file)) {
  console.error(`router-audit: MEMORY.md not found${file ? ` at ${file}` : ' (not a git repo; pass the path)'}`);
  process.exit(1);
}

const text = fs.readFileSync(file, 'utf8');
const bytes = Buffer.byteLength(text, 'utf8');
const lines = text.split(/\r?\n/);
let bullets = 0, longest = 0, longestLine = '';
for (const l of lines) {
  if (/^- \[/.test(l)) {
    bullets++;
    if (l.length > longest) { longest = l.length; longestLine = l; }
  }
}

const overs = [];
if (bytes > ROUTER_BUDGET_BYTES) overs.push(`bytes ${bytes} > router budget ${ROUTER_BUDGET_BYTES}`);
if (bullets > MAX_BULLET_LINES) overs.push(`bullets ${bullets} > ${MAX_BULLET_LINES}`);
if (longest > MAX_PIN_LINE_CHARS) overs.push(`longest pin ${longest} chars > ${MAX_PIN_LINE_CHARS}`);

console.log(`MEMORY.md: ${bytes} bytes (${(bytes / HARD_CAP_BYTES * 100).toFixed(1)}% of hard cap, budget ${ROUTER_BUDGET_BYTES}) · ${bullets}/${MAX_BULLET_LINES} bullets · longest pin ${longest}/${MAX_PIN_LINE_CHARS} chars`);
if (overs.length) {
  console.log(`OVER BUDGET: ${overs.join(' · ')}`);
  if (longest > MAX_PIN_LINE_CHARS) console.log(`  longest: ${longestLine.slice(0, 100)}…`);
  console.log('Rotate: merge themed pins into a hub note · one-in-one-out · soft-archive stale pins to _sunset/.');
  process.exit(1);
}
console.log('within budgets');
process.exit(0);
