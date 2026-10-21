#!/usr/bin/env node
// uninstall.mjs - removes what the Ace OS Starter installer put into ~/.claude:
//   the hook wiring it added to settings.json (your other settings and hooks stay, in order),
//   its hook / skill / doc files (a file that was yours before the install is restored from its backup),
//   and its marked block in ~/.claude/CLAUDE.md (your own text stays).
// Your workspace (~/ace) and your brain (the memory folder) are KEPT unless you ask explicitly:
//   node installer/uninstall.mjs                     remove the global layer only
//   node installer/uninstall.mjs --purge-workspace   also delete ~/ace (only if this installer created it)
//   node installer/uninstall.mjs --purge-brain       also delete the memory folder (your notes - cannot be undone)
//   node installer/uninstall.mjs --dry-run           print what would happen, change nothing
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from './lib/core.mjs';
import { exists, isDir, sha, readJson, writeJsonAtomic, writeText, copyFile } from './lib/sys.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const PURGE_WS = argv.includes('--purge-workspace');
const PURGE_BRAIN = argv.includes('--purge-brain');
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 11).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const HOME = os.homedir();
{ const p = C.homeProblem(HOME); if (p) { console.log(`STOPPED: ${p}`); process.exit(2); } }
{ const p = C.configDirProblem(process.env.CLAUDE_CONFIG_DIR, HOME, process.platform); if (p) { console.log(`STOPPED: ${p}`); process.exit(2); } }
const CLAUDE = path.join(HOME, '.claude');
const WS = path.join(HOME, 'ace');
const MEM = C.memDirFor(HOME);
const MANIFEST = path.join(CLAUDE, '.aceos-starter.json');
const SETTINGS = path.join(CLAUDE, 'settings.json');
const BACKUP = path.join(CLAUDE, 'backups', `aceos-starter-uninstall-${C.stamp()}`);
const WIRING = JSON.parse(fs.readFileSync(path.join(HERE, 'wiring.json'), 'utf8'));
const OK = (m) => console.log(`  OK    ${m}`), SKIP = (m) => console.log(`  SKIP  ${m}`), PLAN = (m) => console.log(`  PLAN  would ${m}`);
let problems = 0;
const FAIL = (m) => { problems++; console.log(`  FAIL  ${m}`); };

console.log(`Ace OS Starter uninstall${DRY ? '  (DRY RUN - nothing will be changed)' : ''}  home: ${C.fwd(HOME)}`);
const man = readJson(MANIFEST);
const manifest = man.data || null;
if (!manifest) SKIP('no install manifest in ~/.claude (global layer not installed, or already removed)');

// 1 settings
console.log('\n[1/4] Hook wiring');
{
  const s = readJson(SETTINGS);
  if (!s.exists) SKIP('no settings.json');
  else if (s.error) FAIL(`settings.json is not valid JSON (${s.error}); not touching it`);
  else {
    // only the wirings this installer added (a wiring that was there before the install stays)
    const targets = manifest ? manifest.wiringAdded || [] : C.wiringItems(WIRING).map(({ event, file }) => ({ event, file }));
    const { settings, removed } = C.unwire(s.data, targets);
    if (!removed) SKIP('none of our wirings present');
    else if (DRY) PLAN(`remove ${removed} hook command(s); every other setting stays`);
    else {
      copyFile(SETTINGS, path.join(BACKUP, 'settings.json'));
      writeJsonAtomic(SETTINGS, settings);
      OK(`removed ${removed} hook command(s); other settings untouched (backup ${C.fwd(BACKUP)})`);
    }
  }
}

// 2 files
console.log('\n[2/4] Hook, skill and doc files');
if (manifest) {
  let removed = 0, restored = 0, keptEdited = 0;
  for (const [rel, info] of Object.entries(manifest.files || {})) {
    const dest = path.join(CLAUDE, rel);
    const orig = info && info.originalBackup ? path.join(CLAUDE, info.originalBackup) : null;
    if (orig && exists(orig)) {
      if (DRY) PLAN(`restore your original ${rel}`);
      else copyFile(orig, dest);
      restored++;
      continue;
    }
    if (!exists(dest)) continue;
    if (info && info.sha && sha(dest) !== info.sha) {          // edited after install: keep a copy before removing
      if (!DRY) copyFile(dest, path.join(BACKUP, rel));
      keptEdited++;
    }
    if (!DRY) fs.rmSync(dest, { force: true });
    removed++;
  }
  // test fixtures the hook self-test leaves, and folders we emptied
  const fix = path.join(CLAUDE, 'hooks', '_testfix');
  if (isDir(fix) && !DRY) fs.rmSync(fix, { recursive: true, force: true });
  if (!DRY) for (const d of ['skills/memory', 'skills/wrap-up']) { const p = path.join(CLAUDE, d); try { if (isDir(p) && !fs.readdirSync(p).length) fs.rmdirSync(p); } catch (_) {} }
  const tail = `${keptEdited ? `, ${keptEdited} edited file(s) copied to the backup first` : ''}`;
  if (DRY) PLAN(`remove ${removed} file(s) and restore ${restored} original(s)${tail}`);
  else OK(`removed ${removed} file(s), restored ${restored} original(s)${tail}`);
} else SKIP('no manifest - files left in place');

// 3 CLAUDE.md block
console.log('\n[3/4] ~/.claude/CLAUDE.md block');
{
  const p = path.join(CLAUDE, 'CLAUDE.md');
  const t = exists(p) ? fs.readFileSync(p, 'utf8') : '';
  if (!C.countBlocks(t)) SKIP('no Ace OS block');
  else {
    const next = C.removeBlock(t);
    if (DRY) PLAN('remove the marked Ace OS block (your own text stays)');
    else {
      copyFile(p, path.join(BACKUP, 'CLAUDE.md'));
      if (!next.trim() && manifest && manifest.claudeMdCreated) { fs.rmSync(p, { force: true }); OK('removed ~/.claude/CLAUDE.md (the installer created it)'); }
      else { writeText(p, next); OK('block removed; your text kept'); }
    }
  }
}
if (!DRY && manifest) fs.rmSync(MANIFEST, { force: true });

// 4 purge (explicit only)
console.log('\n[4/4] Workspace and brain');
if (PURGE_WS) {
  if (!isDir(WS)) SKIP('~/ace not present');
  else if (!exists(path.join(WS, '.ace-os', 'install.json'))) FAIL('~/ace has no Ace OS install marker - not deleting a folder this installer did not create');
  else if (DRY) PLAN(`delete ${C.fwd(WS)}`);
  else { fs.rmSync(WS, { recursive: true, force: true }); OK(`deleted ${C.fwd(WS)}`); }
} else SKIP(`workspace kept (${C.fwd(WS)}); add --purge-workspace to delete it`);
if (PURGE_BRAIN) {
  if (!isDir(MEM)) SKIP('memory folder not present');
  else if (DRY) PLAN(`delete ${MEM}`);
  else { fs.rmSync(MEM, { recursive: true, force: true }); OK(`deleted ${MEM}`); }
} else SKIP(`brain kept (${MEM}); add --purge-brain to delete it`);

console.log(problems ? `\nUNINSTALL FINISHED WITH ${problems} PROBLEM(S)` : `\nUNINSTALL ${DRY ? 'DRY RUN ' : ''}OK. Open a new Claude Code session for the change to take effect.`);
process.exit(problems ? 1 : 0);
