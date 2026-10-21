#!/usr/bin/env node
// AUTO-REGEN memory index — Stop/SubagentStop. Keeps the DERIVED index (_manifest.json + _MOC-*.md) in sync
// with the note corpus so recall.mjs, the MOCs, and the dashboard graph are always current — no manual steps.
//
// SAFE BY CONSTRUCTION: it ONLY runs build-manifest.mjs + build-mocs.mjs, which are READ-ONLY on note files
// (verified: they readdir/readFile/stat notes and write ONLY _manifest.json + _MOC-*.md), and then
// build-home-router.mjs, which writes ONLY the generated block of the home-folder MEMORY.md. It therefore
// CANNOT lose, move, or jumble a note — notes are the source of truth; the index is regenerable. Non-blocking,
// fail-OPEN, idempotent. Regenerates ONLY when the index is stale: a note was added/removed (count differs)
// or edited/added (a note is newer than the manifest). On a fresh index it does nothing (zero overhead),
// except that the home router is rebuilt when the ace MEMORY.md is newer than the home one.
//
// Phase 3 (2026-10-10): after build-mocs it runs build-sitemap.mjs (when installed), which reads the notes and
// writes ONLY _sitemap.json in the memory dir plus _SITEMAP.md and _MOC-<section>.md (generated block; owner
// @user text kept), then logs the sitemap-audit verdict line. Also stale when TOOLS/sitemap/tree.json or
// placement.json is newer than _sitemap.json, a note is newer than it, or its noteCount differs from the notes.
//
// TOOLS and MEM come from lib-workspace (2026-10-10, Phase 2): no CLAUDE_PROJECT_DIR dependency, so a session
// started in the home folder (or any other folder) rebuilds the ace index too. Before, it skipped (1,192 skips).

'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const HOME = (process.env.MEMSYS_TEST_HOME || os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
const normDir = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
const AUDIT = `${HOME}/.claude/hook-audit.log`;
function audit(l) { try { fs.appendFileSync(AUDIT, `[${new Date().toISOString()}] [mem-regen] ${l}\n`); } catch (_) {} }

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  try {
    let input = {}; try { input = JSON.parse(data || '{}'); } catch (_) { input = {}; }
    let LW = null; try { LW = require('./lib-workspace.js'); } catch (_) {}
    if (!LW) { audit('skip: lib-workspace.js not found'); return process.exit(0); }
    const ws = LW.resolveWorkspace({ cwd: normDir(input.cwd || process.cwd()), env: process.env });
    if (!ws) { audit('skip: no ace workspace resolved (not this machine)'); return process.exit(0); }
    const TOOLS = normDir(ws.toolsDir);
    const MEM = normDir(ws.memDir);
    const memFromEnv = !!(process.env.CLAUDE_MEM_DIR || process.env.MEMSYS_MEM_DIR);
    if (!fs.existsSync(`${TOOLS}/build-manifest.mjs`) || !fs.existsSync(`${TOOLS}/build-mocs.mjs`)) { audit('skip: memory-system tools not found (not this machine)'); return process.exit(0); }
    if (!fs.existsSync(MEM)) { audit('skip: memory dir not found'); return process.exit(0); }
    let notes = [];
    try { notes = fs.readdirSync(MEM).filter((f) => f.toLowerCase().endsWith('.md') && f.toUpperCase() !== 'MEMORY.MD'); } catch (_) { return process.exit(0); }
    const manPath = `${MEM}/_manifest.json`;
    let stale = false, reason = '';
    if (!fs.existsSync(manPath)) { stale = true; reason = 'no manifest'; }
    else {
      let man = null;
      try { man = JSON.parse(fs.readFileSync(manPath, 'utf8')); } catch (_) { stale = true; reason = 'manifest unreadable'; }
      if (!stale && man) {
        const manMtime = fs.statSync(manPath).mtimeMs;
        let newest = 0;
        for (const f of notes) { try { const m = fs.statSync(path.join(MEM, f)).mtimeMs; if (m > newest) newest = m; } catch (_) {} }
        if ((man.count || 0) !== notes.length) { stale = true; reason = `note count ${man.count} -> ${notes.length}`; }
        else if (newest > manMtime) { stale = true; reason = 'a note is newer than the manifest'; }
      }
    }
    // home router: also rebuilt when the ace MEMORY.md is newer than the home one (index may be fresh).
    // Only when the home router may be written: the mem-dir was derived here (not an env override), or a
    // test seam names the home (MEMSYS_TEST_HOME / MEMSYS_HOME_MEM_DIR). A fixture mem-dir never rewrites the
    // real home router.
    const homeRouterAllowed = !memFromEnv || !!process.env.MEMSYS_TEST_HOME || !!process.env.MEMSYS_HOME_MEM_DIR;
    const HOME_MEM = normDir(process.env.MEMSYS_HOME_MEM_DIR || ws.homeMemDir);
    const homeRouterTool = `${TOOLS}/build-home-router.mjs`;
    let routerStale = false;
    // back-off: when build-home-router kept the old file (exit 3, e.g. over a budget), the home router stays older
    // than the ace one; without this marker EVERY later Stop would re-run it and log home-router=fail. The marker
    // holds the ace MEMORY.md time of the failed attempt; a changed ace router retries.
    const BACKOFF = `${HOME_MEM}/_home-router.backoff.json`;
    let aceM = 0;
    if (homeRouterAllowed && fs.existsSync(homeRouterTool) && normDir(HOME_MEM).toLowerCase() !== MEM.toLowerCase()) {
      try {
        aceM = fs.statSync(`${MEM}/MEMORY.md`).mtimeMs;
        let homeM = 0; try { homeM = fs.statSync(`${HOME_MEM}/MEMORY.md`).mtimeMs; } catch (_) { homeM = 0; }
        routerStale = aceM > homeM;
        if (routerStale) { try { const b = JSON.parse(fs.readFileSync(BACKOFF, 'utf8')); if (b && b.aceMtime === aceM) routerStale = false; } catch (_) { /* no marker */ } }
      } catch (_) { routerStale = false; }
    }
    // Phase 3 (2026-10-10): the sitemap. It is stale when _sitemap.json is missing, or the tree or the placement
    // registry (TOOLS/sitemap/) is newer than it; a stale manifest also rebuilds it (a note changed). Only when
    // build-sitemap.mjs is installed beside the other tools.
    const sitemapTool = `${TOOLS}/build-sitemap.mjs`;
    const sitemapOn = fs.existsSync(sitemapTool);
    let sitemapStale = false, sitemapReason = '';
    if (sitemapOn) {
      try {
        let smM = 0; try { smM = fs.statSync(`${MEM}/_sitemap.json`).mtimeMs; } catch (_) { smM = 0; }
        if (!smM) { sitemapStale = true; sitemapReason = 'no _sitemap.json'; }
        else {
          for (const f of ['tree.json', 'placement.json']) {
            let m = 0; try { m = fs.statSync(`${TOOLS}/sitemap/${f}`).mtimeMs; } catch (_) { m = 0; }
            if (m > smM) { sitemapStale = true; sitemapReason = `sitemap/${f} is newer than _sitemap.json`; break; }
          }
          // a manifest-only rebuild by hand (build-manifest.mjs alone) leaves the manifest fresh and the sitemap
          // behind: so the sitemap is also stale when a note is newer than it, or its note count differs
          if (!sitemapStale) {
            // a note whose file time is ahead of the clock (copied from another machine) is ignored here, or it
            // would rebuild the sitemap at every Stop until the clock catches up
            let newest = 0; const cap = Date.now() + 60000;
            for (const f of notes) { try { const m = fs.statSync(path.join(MEM, f)).mtimeMs; if (m > newest && m <= cap) newest = m; } catch (_) {} }
            if (newest > smM) { sitemapStale = true; sitemapReason = 'a note is newer than _sitemap.json'; }
          }
          if (!sitemapStale) {
            // noteCount sits in the first bytes of the file (tool, version, built, noteCount): no full parse
            let head = '';
            try { const fd = fs.openSync(`${MEM}/_sitemap.json`, 'r'); try { const b = Buffer.alloc(512); head = b.toString('utf8', 0, fs.readSync(fd, b, 0, 512, 0)); } finally { fs.closeSync(fd); } } catch (_) { head = ''; }
            const mc = head.match(/"noteCount"\s*:\s*(\d+)/);
            if (mc && Number(mc[1]) !== notes.length) { sitemapStale = true; sitemapReason = `sitemap note count ${mc[1]} -> ${notes.length}`; }
          }
        }
      } catch (_) { sitemapStale = false; }
    }
    if (!stale && !routerStale && !sitemapStale) { audit(`current: ${notes.length} notes, index fresh — no regen`); return process.exit(0); }
    // Q8: pin the builders to THIS hook's resolution. Inherited env alone lets the builders re-derive
    // a DIFFERENT mem-dir/root from their own cwd/marker walk (divergence = index regenerated against
    // the wrong corpus). MEMSYS_ROOT is passed only when MEM was derived here (CLAUDE_MEM_DIR unset):
    // an env-overridden mem-dir paired with a guessed root is the exact fixture-guts-live-MOCs class —
    // build-mocs then sandboxes its MOC output next to the mem-dir (a fixture caller that WANTS rooted
    // output sets MEMSYS_ROOT itself; the spread passes it through).
    const spawnEnv = { ...process.env, MEMSYS_MEM_DIR: MEM };
    if (!memFromEnv) spawnEnv.MEMSYS_ROOT = normDir(ws.aceRoot);
    if (homeRouterAllowed && process.env.MEMSYS_HOME_MEM_DIR === undefined) spawnEnv.MEMSYS_HOME_MEM_DIR = HOME_MEM;
    const run = (s) => { try { cp.execFileSync('node', [`${TOOLS}/${s}`], { timeout: 20000, stdio: 'pipe', env: spawnEnv }); return true; } catch (e) { audit(`regen ${s} FAILED: ${e && e.message}`); return false; } };
    const doRegen = () => {
      let a = true, b = true;
      if (stale) {
        a = run('build-manifest.mjs');         // manifest first (build-mocs reads it)
        b = a && run('build-mocs.mjs');
      }
      // the sitemap after build-mocs and before build-home-router; then the audit's one-line verdict (the audit
      // exits 1 on a hard failure, which is a verdict here, not a failed regen)
      let sm = 'skip';
      if (sitemapOn && (stale || sitemapStale)) {
        sm = run('build-sitemap.mjs') ? 'ok' : 'fail';
        if (sm === 'ok' && fs.existsSync(`${TOOLS}/sitemap-audit.mjs`)) {
          let verdict = '';
          try { verdict = cp.execFileSync('node', [`${TOOLS}/sitemap-audit.mjs`, '--verdict'], { timeout: 20000, stdio: 'pipe', env: spawnEnv }).toString(); }
          catch (e) { verdict = String((e && e.stdout) || '') || `sitemap-audit: no verdict (${e && e.message})`; }
          audit(String(verdict).trim().split(/\r?\n/).pop().slice(0, 300));
        }
      }
      let h = 'skip';
      if (homeRouterAllowed && fs.existsSync(homeRouterTool)) h = run('build-home-router.mjs') ? 'ok' : 'fail';
      if (h === 'fail' && aceM) { try { fs.writeFileSync(BACKOFF, JSON.stringify({ aceMtime: aceM, ts: Date.now() })); h = 'fail (backing off until the ace router changes)'; } catch (_) { /* fail-open */ } }
      else if (h === 'ok') { try { fs.rmSync(BACKOFF, { force: true }); } catch (_) { /* fail-open */ } }
      audit(`REGEN (${stale ? reason : (sitemapStale ? sitemapReason : 'home router older than the ace router')}): manifest=${stale ? (a ? 'ok' : 'fail') : 'fresh'} mocs=${stale ? (b ? 'ok' : 'fail') : 'fresh'} sitemap=${sm} home-router=${h} notes=${notes.length} mem=${MEM} root=${spawnEnv.MEMSYS_ROOT || '(sandboxed MOC output)'} ws=${ws.source}`);
    };
    // Serialize concurrent sessions' regens under ONE lock (regen is idempotent -> lock+skip is correct).
    // reindex.mjs takes the SAME lock file. fail-OPEN: if the lib is unavailable, regen directly.
    let lc = null; try { lc = require('./lib-concurrency.js'); } catch (_) {}
    if (lc && typeof lc.withLock === 'function') {
      const res = lc.withLock(`${MEM}/_regen.lock`, 90000, doRegen);
      if (res === 'held') { audit('regen skipped: lock held'); return process.exit(0); }
    } else {
      doRegen();
    }
    process.exit(0);
  } catch (e) { audit(`error (fail-open): ${e && e.message}`); process.exit(0); }
});
