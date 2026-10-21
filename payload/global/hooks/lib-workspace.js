'use strict';
// lib-workspace.js - ONE answer to "where is the brain?" for every memory hook and tool, from ANY cwd.
//
//   resolveWorkspace({ cwd, env }) -> { aceRoot, memDir, toolsDir, homeMemDir, source } | null
//
// Order (first hit wins, per field):
//   1. explicit env: CLAUDE_MEM_DIR / MEMSYS_MEM_DIR (memDir), MEMSYS_ROOT (aceRoot)
//   2. the git toplevel of CLAUDE_PROJECT_DIR, then of cwd, when it holds Code/memory-system/build-manifest.mjs
//      (git toplevel, never a walk-up: a nested project with its own .claude + CLAUDE.md must not stop us)
//   3. the ace brain found structurally: ~/.claude/projects/*-ace/memory whose ace root (a candidate path
//      whose slug equals the folder name) holds Code/memory-system
//   else null.
// Home-folder sessions, and sessions in any other folder, therefore resolve to the ace brain.
// Test seam: env MEMSYS_TEST_HOME replaces os.homedir(). Never throws (returns null on internal error).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const normDir = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
// canonical repoSlug: abs path (any slashes) -> Claude Code projects/<slug> folder name (every char that is not
// [A-Za-z0-9] becomes '-', the rule Claude Code itself uses; safe for homes with spaces or dots)
const repoSlug = (p) => String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, '').replace(/[^A-Za-z0-9]/g, '-');

function homeOf(env) {
  return normDir((env && env.MEMSYS_TEST_HOME) || os.homedir() || (env && env.USERPROFILE) || '');
}

function gitTop(dir) {
  if (!dir) return '';
  try {
    if (!fs.existsSync(dir)) return '';
    const top = cp.execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim();
    return top ? normDir(top) : '';
  } catch (_) { return ''; }
}

const isAceRoot = (root) => { try { return !!root && fs.existsSync(path.join(root, 'Code', 'memory-system', 'build-manifest.mjs')); } catch (_) { return false; } };
const hasTools = (root) => { try { return !!root && fs.existsSync(path.join(root, 'Code', 'memory-system')); } catch (_) { return false; } };

// structural: projects/<slug>/memory folders whose slug ends in -ace, matched to a candidate ace root.
function structural(home) {
  const projects = `${home}/.claude/projects`;
  let dirs = [];
  try { dirs = fs.readdirSync(projects).filter((d) => /(?:^|-)ace$/i.test(d)); } catch (_) { return null; }
  const candidates = [`${home}/ace`];
  for (const d of dirs.sort()) {
    const memDir = `${projects}/${d}/memory`;
    if (!fs.existsSync(memDir)) continue;
    for (const root of candidates) {
      if (repoSlug(root).toLowerCase() === d.toLowerCase() && hasTools(root)) return { aceRoot: root, memDir };
    }
  }
  return null;
}

function resolveWorkspace(opts) {
  try {
    const o = opts || {};
    const env = o.env || process.env;
    const home = homeOf(env);
    if (!home) return null;
    const memEnv = normDir(env.CLAUDE_MEM_DIR || env.MEMSYS_MEM_DIR || '');
    const rootEnv = normDir(env.MEMSYS_ROOT || '');

    let aceRoot = '', memDir = '', source = '';
    if (rootEnv) { aceRoot = rootEnv; source = 'env'; }
    if (!aceRoot) {
      for (const d of [env.CLAUDE_PROJECT_DIR, o.cwd]) {
        const top = gitTop(normDir(d || ''));
        if (top && isAceRoot(top)) { aceRoot = top; source = 'git'; break; }
      }
    }
    if (memEnv) { memDir = memEnv; source = source || 'env'; if (source !== 'env') source = `${source}+env`; }
    else if (aceRoot) {
      const derived = `${home}/.claude/projects/${repoSlug(aceRoot)}/memory`;
      if (fs.existsSync(derived)) memDir = derived;
    }
    if (!aceRoot || !memDir) {
      const s = structural(home);
      if (s) {
        if (!aceRoot) aceRoot = s.aceRoot;
        if (!memDir) memDir = s.memDir;
        source = source ? `${source}+structural` : 'structural';
      }
    }
    if (!aceRoot || !memDir) return null;
    return {
      aceRoot,
      memDir,
      toolsDir: `${aceRoot}/Code/memory-system`,
      homeMemDir: `${home}/.claude/projects/${repoSlug(home)}/memory`,
      source,
    };
  } catch (_) { return null; }
}

module.exports = { resolveWorkspace, repoSlug, normDir, homeOf };
