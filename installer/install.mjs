#!/usr/bin/env node
// install.mjs - Ace OS Starter installer (Windows + macOS; Node 18+, standard library only).
//
//   node installer/install.mjs              install, or update an earlier install (safe to re-run)
//   node installer/install.mjs --dry-run    print the plan, change nothing
//   options: --no-dashboard-check (doctor skips booting the dashboard)   --port <n> (doctor's first port to try)
//            --no-doctor   --help
//
// What it does (each step prints OK / SKIP / WARN / FAIL):
//   1 preflight   OS, Node >= 18, git present, home folder, CLAUDE_CONFIG_DIR, release complete, settings.json readable
//   2 workspace   ~/ace: absent -> copy the workspace; present with our marker -> refresh tooling only
//                 (your notes, projects and edits stay); present without our marker -> stop. git init if possible.
//   3 global      hooks, skills and docs into ~/.claude (anything it would change is backed up first);
//                 the global CLAUDE.md gets a marked block (your own text is kept)
//   4 settings    merge the hook wiring into ~/.claude/settings.json (append-only, idempotent, atomic, backed up)
//   5 brain       ~/.claude/projects/<slug of ~/ace>/memory: seed notes that are not there yet, then reindex
//   6 username    ~/.claude_github_username when absent
//   7 launcher    "Start Ace OS" double-click file in ~/ace
//   8 doctor      runs doctor.mjs and prints its table; exit 1 on any FAIL
// It never walks your home folder, never runs npm, and touches nothing outside ~/ace, ~/.claude and
// ~/.claude_github_username.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from './lib/core.mjs';
import { cleanEnv, exists, isDir, sha, listFiles, copyFile, readJson, writeJsonAtomic, writeText, run, has } from './lib/sys.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RELEASE = path.resolve(HERE, '..');
const PAYLOAD = path.join(RELEASE, 'payload');
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const optVal = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const DRY = flag('--dry-run');

if (flag('--help') || flag('-h')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 22).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const fails = [], warns = [];
const OK = (m) => console.log(`  OK    ${m}`);
const SKIP = (m) => console.log(`  SKIP  ${m}`);
const WARN = (m) => { warns.push(m); console.log(`  WARN  ${m}`); };
const FAIL = (m) => { fails.push(m); console.log(`  FAIL  ${m}`); };
const PLAN = (m) => console.log(`  PLAN  would ${m}`);
const step = (n, t) => console.log(`\n[${n}/8] ${t}`);
function stop(msg, code = 2) {
  console.log(`\nSTOPPED: ${msg}\nThe installer stopped before changing anything in this step. It is safe to run again once this is fixed.`);
  process.exit(code);
}

const HOME = os.homedir();
const homeF = C.fwd(HOME);
const CLAUDE = path.join(HOME, '.claude');
const WS = path.join(HOME, 'ace');
const MEM = C.memDirFor(HOME);
const MARKER = path.join(WS, '.ace-os', 'install.json');
const MANIFEST = path.join(CLAUDE, '.aceos-starter.json');
const SETTINGS = path.join(CLAUDE, 'settings.json');
const RUN_STAMP = C.stamp();
const BACKUP = path.join(CLAUDE, 'backups', `aceos-starter-${RUN_STAMP}`);
const VERSION = exists(path.join(RELEASE, 'VERSION')) ? fs.readFileSync(path.join(RELEASE, 'VERSION'), 'utf8').trim() : '0.0.0';

console.log(`Ace OS Starter ${VERSION} installer${DRY ? '  (DRY RUN - nothing will be changed)' : ''}`);
console.log(`  home:      ${homeF}`);
console.log(`  workspace: ${C.fwd(WS)}`);
console.log(`  brain:     ${MEM}`);

// ---------------------------------------------------------------- 1 preflight
step(1, 'Preflight');
console.log(`  OK    OS ${process.platform} ${os.release()}`);
if (!['win32', 'darwin', 'linux'].includes(process.platform)) stop(`unsupported OS: ${process.platform}`);
if (process.platform === 'linux') WARN('Linux is not an officially tested platform (Windows and macOS are). Continuing.');
if (C.nodeMajor(process.version) < 18) stop(`Node ${process.version} is too old. Install Node.js 18 or newer (LTS from https://nodejs.org) and run again.`);
OK(`Node ${process.version}`);
const GIT = has('git');
if (GIT) OK('git found'); else WARN('git not found - the workspace will not be a git repo (install git later and run "git init" in ~/ace)');
{ const p = C.homeProblem(HOME); if (p) stop(p); }
OK(`home folder ${homeF}`);
{ const p = C.configDirProblem(process.env.CLAUDE_CONFIG_DIR, HOME, process.platform); if (p) stop(p); }
OK('CLAUDE_CONFIG_DIR is unset or points at ~/.claude');

// the release must be complete, and we must not be running from inside the workspace we are about to create
const WIRING_PATH = path.join(HERE, 'wiring.json');
if (!exists(WIRING_PATH)) stop(`installer/wiring.json is missing - this release folder is incomplete (${C.fwd(RELEASE)}).`);
const WIRING = JSON.parse(fs.readFileSync(WIRING_PATH, 'utf8'));
const WIRED = C.wiredFiles(WIRING);
const missing = [];
for (const f of WIRED) if (!exists(path.join(PAYLOAD, 'global', 'hooks', f))) missing.push(`payload/global/hooks/${f}`);
for (const f of ['global/CLAUDE.md', 'workspace', 'memory-seed']) if (!exists(path.join(PAYLOAD, f))) missing.push(`payload/${f}`);
if (missing.length) stop(`this release folder is incomplete; missing: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ` (+${missing.length - 8} more)` : ''}`);
OK(`release complete (${WIRED.length} hook files, ${C.wiringItems(WIRING).length} wirings)`);
{
  const rel = path.relative(WS, RELEASE);
  if (!rel || (!rel.startsWith('..') && !path.isAbsolute(rel))) stop(`this installer folder is inside ${C.fwd(WS)}. Move the downloaded folder somewhere else (for example ~/aceos-starter) and run it from there.`);
}
const settingsRead = readJson(SETTINGS);
if (settingsRead.error) stop(`${C.fwd(SETTINGS)} is not valid JSON (${settingsRead.error}). Fix or move that file, then run again - the installer will not overwrite it.`);
OK(settingsRead.exists ? `settings.json readable${settingsRead.bom ? ' (has a byte-order mark; it will be removed on write)' : ''}` : 'no settings.json yet (it will be created)');

let mode;
if (!exists(WS)) mode = 'fresh';
else if (!isDir(WS)) stop(`${C.fwd(WS)} exists and is not a folder. Rename it and run again.`);
else if (exists(MARKER)) mode = 'update';
else stop(`${C.fwd(WS)} already exists and was not created by this installer. Rename that folder (for example to ace-old) and run again; nothing was changed.`);
OK(`workspace mode: ${mode}`);

// ---------------------------------------------------------------- 2 workspace
step(2, `Workspace ${C.fwd(WS)} (${mode})`);
const wsSrc = path.join(PAYLOAD, 'workspace');
const wsFiles = listFiles(wsSrc).filter((r) => !C.RUNTIME_FILES.has(r.split('/').pop()));
const prevMarker = mode === 'update' ? (readJson(MARKER).data || {}) : {};
const prevHashes = prevMarker.files || {};
const newHashes = {};
let wsCopied = 0, wsSame = 0, wsBacked = 0, wsKept = 0;
const wsBackupDir = path.join(WS, '.ace-os', 'backups', RUN_STAMP);
for (const rel of wsFiles) {
  const src = path.join(wsSrc, rel), dest = path.join(WS, rel);
  const tooling = C.underAny(rel, C.TOOLING_PREFIXES);
  const userData = C.underAny(rel, C.USER_DATA_PREFIXES);
  if (tooling && !userData) newHashes[rel] = sha(src);
  if (mode === 'update') {
    if (!tooling && exists(dest)) { wsKept++; continue; }        // the user's own files (CLAUDE.md, projects...) stay
    if (userData && exists(dest)) { wsKept++; continue; }        // the sitemap registry is the user's data
    if (exists(dest)) {
      const cur = sha(dest);
      if (cur === newHashes[rel]) { wsSame++; continue; }
      if (prevHashes[rel] !== cur) {                              // edited since we installed it: keep a copy
        if (DRY) PLAN(`back up your edited ${rel}`);
        else copyFile(dest, path.join(wsBackupDir, rel));
        wsBacked++;
      }
    }
  }
  if (!DRY) copyFile(src, dest);
  wsCopied++;
}
if (DRY) PLAN(`${mode === 'fresh' ? 'create the workspace with' : 'refresh'} ${wsCopied} file(s) (${wsSame} already current, ${wsKept} of yours left alone, ${wsBacked} edited file(s) backed up first)`);
else OK(`${wsCopied} file(s) written, ${wsSame} already current, ${wsKept} of yours left alone${wsBacked ? `, ${wsBacked} edited file(s) backed up to ${C.fwd(wsBackupDir)}` : ''}`);
if (!DRY) {
  const now = new Date().toISOString();
  writeJsonAtomic(MARKER, { product: C.PRODUCT, version: VERSION, installedAt: prevMarker.installedAt || now, updatedAt: now, files: { ...prevHashes, ...newHashes } });
  writeText(path.join(WS, '.ace-os', '.gitignore'), 'backups/\n');
  OK(`marker ${C.fwd(MARKER)}`);
} else PLAN(`write the marker ${C.fwd(MARKER)}`);
if (GIT) {
  if (exists(path.join(WS, '.git'))) SKIP('already a git repo');
  else if (DRY) PLAN('git init the workspace (no commit)');
  else { const r = run('git', ['init', '-q'], { cwd: WS, env: cleanEnv() }); if (r.ok) OK('git init (no commit made)'); else WARN(`git init failed: ${r.stderr.trim().split('\n')[0]}`); }
}

// ---------------------------------------------------------------- 3 global
step(3, 'Global Claude Code layer ~/.claude (hooks, skills, docs)');
const manifest = readJson(MANIFEST).data || {};
const mFiles = manifest.files || {};
const gSrc = path.join(PAYLOAD, 'global');
let backupUsed = false;
const backup = (absFile, rel) => {
  const to = path.join(BACKUP, rel);
  if (!DRY) { copyFile(absFile, to); backupUsed = true; }
  return C.fwd(path.relative(CLAUDE, to));
};
let gCopied = 0, gSame = 0, gBacked = 0;
const nextFiles = {};
for (const rel of listFiles(gSrc)) {
  if (rel === 'CLAUDE.md') continue;
  const src = path.join(gSrc, rel), dest = path.join(CLAUDE, rel);
  const prev = mFiles[rel] || null;
  const entry = { sha: sha(src), originalBackup: prev ? prev.originalBackup || null : null };
  if (exists(dest)) {
    if (sha(dest) === entry.sha) { gSame++; nextFiles[rel] = entry; continue; }
    const b = backup(dest, rel);
    if (!prev) entry.originalBackup = b;   // a file that was yours before we ever installed: restored on uninstall
    gBacked++;
  }
  if (!DRY) copyFile(src, dest);
  gCopied++;
  nextFiles[rel] = entry;
}
if (DRY) PLAN(`copy ${gCopied} file(s) into ~/.claude (${gSame} already current; ${gBacked} existing file(s) backed up first)`);
else OK(`${gCopied} file(s) copied, ${gSame} already current${gBacked ? `, ${gBacked} backed up to ${C.fwd(BACKUP)}` : ''}`);
// global CLAUDE.md as a marked block
const gmdPath = path.join(CLAUDE, 'CLAUDE.md');
const gmdHad = exists(gmdPath);
const gmdOld = gmdHad ? fs.readFileSync(gmdPath, 'utf8') : '';
const gmdNew = C.insertBlock(C.stripBom(gmdOld), fs.readFileSync(path.join(gSrc, 'CLAUDE.md'), 'utf8'));
if (gmdNew === gmdOld) SKIP('~/.claude/CLAUDE.md block already current');
else if (DRY) PLAN(`${gmdHad ? 'update the marked Ace OS block in' : 'create'} ~/.claude/CLAUDE.md${gmdHad ? ' (your own text is kept; backed up first)' : ''}`);
else {
  if (gmdHad) backup(gmdPath, 'CLAUDE.md');
  writeText(gmdPath, gmdNew);
  OK(`~/.claude/CLAUDE.md ${gmdHad ? 'block inserted/updated (your text kept)' : 'created'}`);
}

// ---------------------------------------------------------------- 4 settings
step(4, 'Hook wiring in ~/.claude/settings.json');
let nodeCmd = 'node';
if (process.platform === 'darwin') {
  // see C.macNodeCandidates: sessions started from the Dock/Finder do not have Homebrew/nvm/Volta on PATH
  for (const c of C.macNodeCandidates(HOME, process.execPath)) {
    if (!exists(c)) continue;
    const v = run(c, ['-v'], { timeout: 15000 });
    if (v.ok && C.nodeMajor(v.stdout.trim()) >= 18) { nodeCmd = c; break; }
  }
  if (nodeCmd === 'node') nodeCmd = process.execPath;
  OK(`hooks will call ${C.fwd(nodeCmd)} (an absolute path, so sessions started from the Dock or Finder find Node too)`);
} else if (process.platform !== 'win32') {
  const r = run('/bin/sh', ['-c', 'command -v node'], { timeout: 15000 });
  if (!r.ok || !r.stdout.trim()) { nodeCmd = process.execPath; WARN(`node is not on the default shell PATH; hooks will call ${C.fwd(nodeCmd)} directly`); }
}
const OUR_GLOBAL = (cmd) => C.wiredFiles(WIRING).some((f) => C.commandRunsHook(cmd, f));
const before = settingsRead.data || {};
let merged;
try { merged = C.mergeWiring(before, WIRING, (f) => C.hookCommand(HOME, f, nodeCmd)); }
catch (e) { stop(e.message); }
// an earlier install may have wired a bare `node`; point those (and only ours) at the absolute node too
const pinned = C.pinNodeInCommands(merged.settings, OUR_GLOBAL, nodeCmd);
if (pinned) OK(`${pinned} existing Ace OS hook command(s) now call ${C.fwd(nodeCmd)}`);
// the workspace's own 3 hooks (~/ace/.claude/settings.json) get the same absolute node
{
  const wsSettings = path.join(WS, '.claude', 'settings.json');
  const ws = exists(wsSettings) ? readJson(wsSettings) : null;
  if (ws && ws.data && !ws.error) {
    const OUR_WS = (cmd) => /[\\/]\.claude[\\/]hooks[\\/](session-init|prompt-check|block-unkeyed-temp-log)\.js\b/.test(cmd);
    const n = C.pinNodeInCommands(ws.data, OUR_WS, nodeCmd);
    if (n && DRY) PLAN(`point ${n} workspace hook command(s) at ${C.fwd(nodeCmd)}`);
    else if (n) { writeJsonAtomic(wsSettings, ws.data); OK(`${n} workspace hook command(s) now call ${C.fwd(nodeCmd)}`); }
  }
}
if (!merged.added.length && !pinned && !settingsRead.bom && settingsRead.exists) SKIP(`all ${merged.present.length} wirings already present`);
else if (DRY) PLAN(`add ${merged.added.length} wiring(s) (${merged.present.length} already present); every other setting is kept as is`);
else {
  if (settingsRead.exists) backup(SETTINGS, 'settings.json');
  writeJsonAtomic(SETTINGS, merged.settings);
  OK(`${merged.added.length} wiring(s) added, ${merged.present.length} already present; your other settings untouched`);
}
// manifest of what we own in ~/.claude (uninstall reads it)
if (!DRY) {
  const added = [...(manifest.wiringAdded || [])];
  for (const a of merged.added) if (!added.some((x) => x.event === a.event && x.file === a.file)) added.push(a);
  writeJsonAtomic(MANIFEST, {
    product: C.PRODUCT, version: VERSION,
    installedAt: manifest.installedAt || new Date().toISOString(), updatedAt: new Date().toISOString(),
    files: { ...mFiles, ...nextFiles },
    wiringAdded: added,
    claudeMdCreated: manifest.claudeMdCreated != null ? manifest.claudeMdCreated : !gmdHad,
    settingsCreated: manifest.settingsCreated != null ? manifest.settingsCreated : !settingsRead.exists,
  });
  if (backupUsed) OK(`backups of replaced files: ${C.fwd(BACKUP)}`);
}

// ---------------------------------------------------------------- 5 brain
step(5, 'Brain (memory folder)');
const seedSrc = path.join(PAYLOAD, 'memory-seed');
let seeded = 0, seedKept = 0;
for (const rel of listFiles(seedSrc)) {
  const dest = path.join(MEM, rel);
  if (exists(dest)) { seedKept++; continue; }
  if (!DRY) copyFile(path.join(seedSrc, rel), dest);
  seeded++;
}
if (DRY) PLAN(`add ${seeded} seed file(s) to ${MEM} (${seedKept} already there are never overwritten), then rebuild the index`);
else {
  OK(`${seeded} seed file(s) added, ${seedKept} already there (never overwritten)`);
  const reindex = path.join(WS, 'Code', 'memory-system', 'reindex.mjs');
  if (!exists(reindex)) FAIL(`missing ${C.fwd(reindex)}`);
  else {
    let r = run(process.execPath, [reindex], { cwd: WS, env: cleanEnv() });
    if (r.status === 75) { await new Promise((res) => setTimeout(res, 3000)); r = run(process.execPath, [reindex], { cwd: WS, env: cleanEnv() }); }
    if (r.ok) OK('memory index rebuilt (reindex.mjs exit 0)');
    else FAIL(`reindex.mjs exit ${r.status}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ')}`);
  }
}

// ---------------------------------------------------------------- 6 username
step(6, 'Username for session logs');
const UFILE = path.join(HOME, '.claude_github_username');
if (exists(UFILE) && fs.readFileSync(UFILE, 'utf8').trim()) SKIP(`~/.claude_github_username already set (${fs.readFileSync(UFILE, 'utf8').trim()})`);
else {
  let name = '', via = '';
  if (has('gh')) { const r = run('gh', ['api', 'user', '--jq', '.login'], { timeout: 15000, env: cleanEnv() }); if (r.ok) { name = C.sanitizeUsername(r.stdout); via = 'GitHub CLI'; } }
  if (!name && GIT) { const r = run('git', ['config', 'user.name'], { timeout: 15000, env: cleanEnv() }); if (r.ok) { name = C.sanitizeUsername(r.stdout); via = 'git config'; } }
  if (!name) { try { name = C.sanitizeUsername(os.userInfo().username); via = 'OS account'; } catch (_) {} }
  if (!name) { name = 'user'; via = 'default'; }
  if (DRY) PLAN(`write ~/.claude_github_username = ${name} (from ${via})`);
  else { writeText(UFILE, name + '\n'); OK(`~/.claude_github_username = ${name} (from ${via})`); }
}

// ---------------------------------------------------------------- 7 launcher
step(7, 'Start Ace OS launcher');
{
  const L = C.launcherFor(process.platform);
  const dest = path.join(WS, L.name);
  if (DRY) PLAN(`write ${C.fwd(dest)}`);
  else { writeText(dest, L.text, { crlf: L.crlf, mode: L.mode }); OK(`${C.fwd(dest)} (double-click it to open Ace OS)`); }
}

// ---------------------------------------------------------------- 8 doctor
step(8, 'Doctor');
if (DRY) { PLAN('run installer/doctor.mjs'); console.log('\nDRY RUN complete: nothing was changed. Run again without --dry-run to install.'); process.exit(0); }
if (flag('--no-doctor')) { SKIP('--no-doctor given'); }
else {
  const dargs = [path.join(HERE, 'doctor.mjs')];
  if (flag('--no-dashboard-check')) dargs.push('--no-dashboard');
  if (optVal('--port')) dargs.push('--port', optVal('--port'));
  const r = run(process.execPath, dargs, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 });
  process.stdout.write(r.stdout);
  if (r.stderr.trim()) process.stdout.write(r.stderr);
  if (!r.ok) FAIL(`doctor reported a problem (exit ${r.status})`);
}

console.log('');
if (fails.length) {
  console.log(`INSTALL FINISHED WITH ${fails.length} PROBLEM(S):`);
  for (const f of fails) console.log(`  - ${f}`);
  console.log('Fix the problem above and run the installer again (it is safe to re-run).');
  process.exit(1);
}
console.log(`INSTALL OK (Ace OS Starter ${VERSION})${warns.length ? `  with ${warns.length} warning(s)` : ''}`);
console.log('Next: open a NEW Claude Code session in ~/ace and type "start here".');
console.log(`      Double-click "${C.launcherFor(process.platform).name}" in ~/ace to open Ace OS. End each session with /wrap-up.`);
process.exit(0);
