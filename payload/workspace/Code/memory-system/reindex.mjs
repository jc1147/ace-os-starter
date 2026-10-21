#!/usr/bin/env node
// reindex.mjs - ONE cross-shell command that does what the regen hook (regen-memory-index.js) does:
// build-manifest.mjs, build-mocs.mjs, build-sitemap.mjs (then the sitemap-audit verdict line), then
// build-home-router.mjs, under the SAME lock file the hook takes
// (MEM/_regen.lock, lib-concurrency withLock), so a manual rebuild never races the hook.
//
//   node "$HOME/ace/Code/memory-system/reindex.mjs"          (bash and PowerShell 5.1, from any folder)
//
// The memory dir and the ace root come from lib-workspace (env MEMSYS_MEM_DIR / CLAUDE_MEM_DIR / MEMSYS_ROOT
// first). Like the hook (the Q8 rule), MEMSYS_ROOT is pinned for the builders only when the mem-dir was
// derived here, never when it came from env (then build-mocs sandboxes its MOC output next to the mem-dir).
// The builders run from THIS script's folder (the tools beside it). Unlike the hook it always rebuilds
// (no staleness check) and prints each builder's output. Exit 0 ok, 1 a builder failed, 2 nothing resolved,
// 75 lock held by another rebuild (try again in a moment).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const normDir = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
const HOME = normDir(process.env.MEMSYS_TEST_HOME || os.homedir() || process.env.USERPROFILE || '');
// D3 slug rule (= Claude Code's projects/<slug> folder name): every character that is not [A-Za-z0-9] -> "-"
const repoSlug = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').replace(/[^A-Za-z0-9]/g, '-');

// the hooks' CommonJS libs: staging layout first, then the installed hooks, then the bootstrap seed copy
function loadHookLib(name) {
  const cands = [
    process.env.MEMSYS_HOOKS_DIR && path.join(process.env.MEMSYS_HOOKS_DIR, name),
    path.join(HERE, '..', 'hooks', name),
    path.join(HOME, '.claude', 'hooks', name),
    path.join(HERE, '..', '..', 'bootstrap', 'dotclaude', 'hooks', name),
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return require(c); } catch (_) {} }
  return null;
}

// same O_EXCL lock as lib-concurrency.withLock (used only if that lib cannot be loaded)
function withLockInline(lockFile, staleMs, fn) {
  let acquired = false;
  try { fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' }); acquired = true; }
  catch (e) {
    if (e && e.code === 'EEXIST') {
      let stale = false;
      try { const cur = JSON.parse(fs.readFileSync(lockFile, 'utf8')); stale = !cur || typeof cur.ts !== 'number' || (Date.now() - cur.ts) > staleMs; } catch (_) { stale = true; }
      if (!stale) return 'held';
      try { fs.unlinkSync(lockFile); } catch (_) {}
      try { fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' }); acquired = true; } catch (_) { return 'held'; }
    } else return fn();
  }
  try { return fn(); } finally { if (acquired) { try { fs.unlinkSync(lockFile); } catch (_) {} } }
}

function main() {
  const lw = loadHookLib('lib-workspace.js');
  let ws = lw ? lw.resolveWorkspace({ cwd: process.cwd(), env: process.env }) : null;
  if (!ws) {
    // inline fallback: this script's own repo
    const aceRoot = normDir(process.env.MEMSYS_ROOT || path.resolve(HERE, '..', '..'));
    const memDir = normDir(process.env.MEMSYS_MEM_DIR || process.env.CLAUDE_MEM_DIR || `${HOME}/.claude/projects/${repoSlug(aceRoot)}/memory`);
    if (fs.existsSync(memDir)) ws = { aceRoot, memDir, toolsDir: normDir(HERE), homeMemDir: `${HOME}/.claude/projects/${repoSlug(HOME)}/memory`, source: 'inline' };
  }
  if (!ws || !fs.existsSync(ws.memDir)) { console.error('[reindex] no memory dir resolved (set MEMSYS_MEM_DIR, or run on a machine with the ace brain)'); return 2; }
  const MEM = normDir(ws.memDir);
  const memFromEnv = !!(process.env.MEMSYS_MEM_DIR || process.env.CLAUDE_MEM_DIR);
  const env = { ...process.env, MEMSYS_MEM_DIR: MEM };
  if (!memFromEnv) env.MEMSYS_ROOT = normDir(ws.aceRoot);
  const homeRouterAllowed = !memFromEnv || !!process.env.MEMSYS_TEST_HOME || !!process.env.MEMSYS_HOME_MEM_DIR;
  if (homeRouterAllowed && !process.env.MEMSYS_HOME_MEM_DIR) env.MEMSYS_HOME_MEM_DIR = normDir(ws.homeMemDir);

  console.log(`[reindex] mem=${MEM} root=${env.MEMSYS_ROOT || '(sandboxed MOC output)'} ws=${ws.source}`);
  // Phase 3: build-sitemap runs after build-mocs and before build-home-router; its audit's one-line verdict is
  // printed after it. The sitemap and the home router are not on the critical path: a failure there is counted
  // but the remaining steps still run (manifest and type MOCs first, as before).
  const steps = ['build-manifest.mjs', 'build-mocs.mjs', 'build-sitemap.mjs'];
  if (homeRouterAllowed) steps.push('build-home-router.mjs');
  const NONCRITICAL = new Set(['build-sitemap.mjs', 'build-home-router.mjs']);
  let failed = 0, warned = 0;
  const run = () => {
    for (const s of steps) {
      const p = path.join(HERE, s);
      if (!fs.existsSync(p)) { console.error(`[reindex] missing ${p}`); if (NONCRITICAL.has(s)) { warned++; console.error(`[reindex] WARN: optional step ${s} did not finish; the brain index is still complete`); continue; } failed++; return; }
      const r = cp.spawnSync(process.execPath, [p], { env, encoding: 'utf8', timeout: 60000 });
      if (r.stdout) process.stdout.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
      if (r.status !== 0) { console.error(`[reindex] ${s} exited ${r.status === null ? 'by timeout/signal' : r.status}`); if (NONCRITICAL.has(s)) { warned++; console.error(`[reindex] WARN: optional step ${s} did not finish; the brain index is still complete`); continue; } failed++; return; }
      if (s === 'build-sitemap.mjs') {
        const ap = path.join(HERE, 'sitemap-audit.mjs');
        if (!fs.existsSync(ap)) { console.error(`[reindex] missing ${ap}`); continue; }
        const a = cp.spawnSync(process.execPath, [ap, '--verdict'], { env, encoding: 'utf8', timeout: 60000 });
        const line = String(a.stdout || '').trim().split(/\r?\n/).pop() || `sitemap-audit: no verdict (exit ${a.status})`;
        console.log(`[reindex] ${line}`);
      }
    }
  };
  const lc = loadHookLib('lib-concurrency.js');
  const lock = `${MEM}/_regen.lock`;
  const res = (lc && typeof lc.withLock === 'function') ? lc.withLock(lock, 90000, run) : withLockInline(lock, 90000, run);
  if (res === 'held') { console.error(`[reindex] another rebuild holds ${lock}: try again in a moment`); return 75; }
  console.log(failed ? `[reindex] FAILED (${failed} step(s))` : `[reindex] ok${warned ? ` (${warned} optional step(s) warned)` : ''}`);
  return failed ? 1 : 0;
}

let code = 1;
try { code = main(); } catch (e) { console.error(`[reindex] error: ${e && e.message}`); code = 1; }
process.exit(code);
