#!/usr/bin/env node
// block-memory-git-rewrite.js - memory upgrade Phase 0 (B1), GLOBAL layer. PreToolUse(Bash|PowerShell).
//
// Why: in a repo where `memory` is a JUNCTION (or symlink) to the live note store (~/.claude/projects/<slug>/memory) and
// git tracks the files under it. A checkout, hard reset, stash, restore or clean run in ace, by ANY session,
// rewrites or deletes live notes for EVERY session. This hook denies those git commands when they would change
// memory files, and allows everything else. Ace OS Starter keeps the brain in ~/.claude/projects/<slug>/memory and
// creates no such junction, so on a standard install this guard never engages.
//
// Which repo is guarded: one whose toplevel holds a `memory` entry that resolves (realpath) to a folder named
// `memory` directly under <home>/.claude/projects/<slug>/. Any other repo: allow.
//
// Deny classes (only when memory files would change):
//   checkout / switch to another branch, tag or commit  (git diff --name-only HEAD <target> -- memory)
//   checkout / switch with a force flag while memory has uncommitted tracked changes
//   checkout [<tree-ish>] -- <paths>, restore [--source=X] <paths>  (pathspec covers memory, and memory is
//     dirty under it or the source differs from HEAD under it)
//   reset --hard | --merge | --keep  (memory dirty, or the target differs from HEAD under memory)
//   stash [push|save]  (tracked memory changes; untracked with -u/-a; ignored with -a)
//   stash pop | apply | branch  (the stash touches memory: <s>^1..<s>, and <s>^3 for untracked)
//   clean with a force flag  (git clean -n with the same -d/-x/-X/-e flags, limited to memory, lists anything)
// Watch class (never denied, audit only): merge, rebase, pull, cherry-pick, revert, am -> a WOULD-BLOCK line
// when memory has uncommitted tracked changes.
//
// Escape hatch: the command holds `MEMORY_GIT_OK=1` (bash env prefix), `$env:MEMORY_GIT_OK` (PowerShell) or a
// `# memory-git-ok` comment. Allowed and audited.
//
// Failure mode: an error while analysing a deny-class git command (a git query that fails or times out, a
// directory that cannot be resolved) means DENY ("could not verify that memory is safe"). Any other error:
// allow. Each git query has a 5 s timeout. One `[memory-git-guard]` audit line per analysed decision; commands
// with no deny-class or watch-class git invocation are allowed silently.
//
// Test seams: env MEMSYS_TEST_HOME replaces os.homedir() (the guarded store and `~`); env
// MEMORY_GIT_GUARD_AUDIT_LOG redirects the audit file.

'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const IS_WIN = process.platform === 'win32';
const HOME = path.resolve(process.env.MEMSYS_TEST_HOME || os.homedir() || process.env.USERPROFILE || '.');
const AUDIT = process.env.MEMORY_GIT_GUARD_AUDIT_LOG || path.join(os.homedir() || HOME, '.claude', 'hook-audit.log');
const TAG = '[memory-git-guard]';
const GIT_TIMEOUT_MS = 5000;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_LIST = 10;

const DENY_CLASSES = new Set(['checkout', 'switch', 'restore', 'reset', 'stash', 'clean']);
const WATCH_CLASSES = new Set(['merge', 'rebase', 'pull', 'cherry-pick', 'revert', 'am']);
// Builtins that never need an alias lookup (git forbids aliases that shadow builtins).
const BUILTINS = new Set(('add status log diff show commit push fetch branch tag remote config ls-files rev-parse ' +
  'cat-file blame grep describe shortlog reflog notes mv rm init clone help version gc fsck worktree submodule ' +
  'bisect apply format-patch archive ls-tree ls-remote for-each-ref show-ref symbolic-ref update-index ' +
  'merge-base name-rev count-objects var whatchanged range-diff difftool mergetool maintenance sparse-checkout ' +
  'lfs gui citool bundle credential hash-object check-ignore check-attr rerere update-ref read-tree ' +
  'checkout-index write-tree commit-tree mktree diff-tree diff-index diff-files rev-list prune repack ' +
  'pack-objects unpack-objects verify-pack request-pull send-email instaweb gitk scalar annotate ' +
  'interpret-trailers mailinfo mailsplit column backfill replay').split(/\s+/));

function audit(line) {
  try {
    fs.mkdirSync(path.dirname(AUDIT), { recursive: true });
    fs.appendFileSync(AUDIT, `[${new Date().toISOString()}] ${TAG} ${line}\n`);
  } catch (_) { /* never let logging break the hook */ }
}
function oneLine(s, n) { return String(s).replace(/\s+/g, ' ').trim().slice(0, n || 160); }
function allowExit() { process.exit(0); }
function denyExit(reason, auditLine) {
  audit(`DENY ${auditLine}`);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------------------
// Tokenizer: shell-ish split into segments (on && || ; | & newline, ( ) and $( ), each a list of unquoted words.
// Bash mode: backslash escapes outside single quotes. PowerShell mode: backtick escapes, '' inside '...'.
// Comments (# at word start) are dropped. Redirections (2>&1, > file, 2>$null) are dropped with their target.
// ---------------------------------------------------------------------------------------------------------
// Command substitutions ($(...) and bash backticks): the outer word gets the placeholder SUBST (it holds `$`, so
// the analysis treats that argument as known only at run time), and the inner command is tokenized too and
// emitted BEFORE the outer segment (it runs first), wrapped in SUB_OPEN / SUB_CLOSE marker segments. A bash
// ( ... ) subshell is wrapped the same way, so a `cd` inside it does not leak out of it.
const SUB_OPEN = '\u0001(';
const SUB_CLOSE = '\u0001)';
const SUBST = '$(\u0001)';
// index of the `)` that closes the `(` at s[open], or -1. Quoted text is skipped.
function closeParen(s, open, ps) {
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    const c = s[j];
    if (c === "'") { const k = s.indexOf("'", j + 1); if (k < 0) return -1; j = k; continue; }
    if (c === '"') {
      let k = j + 1;
      while (k < s.length && s[k] !== '"') k += (s[k] === (ps ? '`' : '\\')) ? 2 : 1;
      if (k >= s.length) return -1;
      j = k; continue;
    }
    if (c === (ps ? '`' : '\\')) { j++; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return j; }
  }
  return -1;
}
// index of the bash backtick closing the one at s[open], or -1
function closeTick(s, open) {
  for (let j = open + 1; j < s.length; j++) { if (s[j] === '\\') { j++; continue; } if (s[j] === '`') return j; }
  return -1;
}
function tokenize(cmd, ps) {
  const segs = [];
  let words = [];
  let cur = null;
  let dropNext = false;
  let pending = [];
  const pushWord = () => {
    if (cur === null) return;
    if (dropNext) { dropNext = false; cur = null; return; }
    words.push(cur); cur = null;
  };
  const endSeg = () => {
    pushWord(); dropNext = false;
    for (const p of pending) segs.push(p);
    pending = [];
    if (words.length) segs.push(words); words = [];
  };
  const s = String(cmd);
  const n = s.length;
  const subst = (from, to) => { pending.push([SUB_OPEN], ...tokenize(s.slice(from, to), ps), [SUB_CLOSE]); };
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === "'") {
      let j = i + 1; let t = '';
      while (j < n) {
        if (s[j] === "'") { if (ps && s[j + 1] === "'") { t += "'"; j += 2; continue; } break; }
        t += s[j]; j++;
      }
      cur = (cur || '') + t; i = j + 1; continue;
    }
    if (c === '"') {
      let j = i + 1; let t = '';
      const esc = ps ? '`' : '\\';
      while (j < n && s[j] !== '"') {
        if (s[j] === esc && j + 1 < n) {
          const d = s[j + 1];
          if (ps) t += d; else t += ('"\\$`\n'.includes(d) ? d : '\\' + d);
          j += 2; continue;
        }
        if (s[j] === '$' && s[j + 1] === '(') {
          const k = closeParen(s, j + 1, ps);
          if (k > 0) { subst(j + 2, k); t += SUBST; j = k + 1; continue; }
        }
        if (!ps && s[j] === '`') {
          const k = closeTick(s, j);
          if (k > 0) { subst(j + 1, k); t += SUBST; j = k + 1; continue; }
        }
        t += s[j]; j++;
      }
      cur = (cur || '') + t; i = j + 1; continue;
    }
    if (!ps && c === '\\' && i + 1 < n) {
      if (s[i + 1] === '\n') { i += 2; continue; }
      cur = (cur || '') + s[i + 1]; i += 2; continue;
    }
    if (ps && c === '`' && i + 1 < n) {
      if (s[i + 1] === '\n' || s[i + 1] === '\r') { i += 2; continue; }
      cur = (cur || '') + s[i + 1]; i += 2; continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { pushWord(); i++; continue; }
    if (c === '\n' || c === ';') { endSeg(); i++; continue; }
    if (c === '#' && cur === null) { while (i < n && s[i] !== '\n') i++; continue; }
    if (c === '&' && s[i + 1] === '>') { // bash &> file, &>> file
      pushWord(); i += 2; if (s[i] === '>') i++; dropNext = true; continue;
    }
    if (c === '|' || c === '&') { endSeg(); i++; if (s[i] === c) i++; continue; }
    if (c === '>' || c === '<') {
      if (cur !== null && /^\d+$/.test(cur)) cur = null; else pushWord();
      i++; if (s[i] === '>') i++;
      if (s[i] === '&') { i++; while (i < n && /[0-9-]/.test(s[i])) i++; continue; }
      dropNext = true; continue;
    }
    if (c === '$' && s[i + 1] === '(') {
      const k = closeParen(s, i + 1, ps);
      if (k > 0) { subst(i + 2, k); cur = (cur || '') + SUBST; i = k + 1; continue; }
      endSeg(); i += 2; continue;
    }
    if (!ps && c === '`') {
      const k = closeTick(s, i);
      if (k > 0) { subst(i + 1, k); cur = (cur || '') + SUBST; i = k + 1; continue; }
      endSeg(); i++; continue;
    }
    if (c === '(' || c === ')') { endSeg(); segs.push([c === '(' ? SUB_OPEN : SUB_CLOSE]); i++; continue; }
    cur = (cur || '') + c; i++;
  }
  endSeg();
  return segs;
}

// ---------------------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------------------
function normKey(p) {
  let s = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  if (IS_WIN) s = s.toLowerCase();
  return s;
}
// The home folder written as a variable: bash $HOME / ${HOME} / $USERPROFILE / ${USERPROFILE}, PowerShell
// $env:USERPROFILE / $env:HOME. expandPath replaces them; isDynamic does not count them as run-time values.
const HOME_VAR_RE = /\$\{(?:HOME|USERPROFILE)\}|\$(?:HOME|USERPROFILE)\b|\$env:(?:USERPROFILE|HOME)\b/gi;
function expandPath(p) {
  if (p == null) return null;
  let s = String(p);
  s = s.replace(/^~(?=$|[\\/])/, HOME);
  s = s.replace(HOME_VAR_RE, () => HOME);
  if (/\$|%[A-Za-z_]+%/.test(s)) return null; // a variable we cannot expand
  const m = /^\/([a-zA-Z])(\/.*)?$/.exec(s);
  if (m && IS_WIN) s = m[1].toUpperCase() + ':' + (m[2] || '/');
  return s;
}
function resolveDir(base, p) {
  const e = expandPath(p);
  if (e === null) return null;
  if (path.isAbsolute(e)) return path.resolve(e);
  if (base === null) return null;
  return path.resolve(base, e);
}
function realNative(p) { try { return fs.realpathSync.native(p); } catch (_) { return null; } }

// ---------------------------------------------------------------------------------------------------------
// git runner (every query: no shell, 5 s timeout)
// ---------------------------------------------------------------------------------------------------------
let execFileSync = null;
function git(args) {
  if (!execFileSync) execFileSync = require('node:child_process').execFileSync;
  try {
    const out = execFileSync('git', ['--no-pager', ...args], {
      encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }),
    });
    return { code: 0, out };
  } catch (err) {
    if (err && (err.code === 'ETIMEDOUT' || err.signal)) throw new Error(`git ${args.slice(0, 4).join(' ')} timed out or was killed`);
    if (err && typeof err.status === 'number') return { code: err.status, out: String(err.stdout || ''), errText: String(err.stderr || '') };
    throw new Error(`git could not run: ${err && err.message}`);
  }
}
function gitOk(args) {
  const r = git(args);
  if (r.code !== 0) throw new Error(`git ${args.slice(0, 5).join(' ')} exited ${r.code}: ${oneLine(r.errText || '', 120)}`);
  return r.out;
}
function splitZ(out) { return out.split('\0').filter(Boolean); }

// One guarded repo context: cached queries against the repo toplevel.
function makeRepo(top, gitOpts) {
  const base = [...gitOpts, '-C', top];
  const cache = {};
  const R = {
    top,
    q: (args) => git([...base, ...args]),
    ok: (args) => gitOk([...base, ...args]),
    commit(rev) {
      const k = 'c:' + rev;
      if (!(k in cache)) { const r = R.q(['rev-parse', '--verify', '--quiet', rev + '^{commit}']); cache[k] = r.code === 0 ? r.out.trim() : null; }
      return cache[k];
    },
    tree(rev) {
      const k = 't:' + rev;
      if (!(k in cache)) { const r = R.q(['rev-parse', '--verify', '--quiet', rev + '^{tree}']); cache[k] = r.code === 0 ? r.out.trim() : null; }
      return cache[k];
    },
    head() { return R.commit('HEAD') || EMPTY_TREE; },
    status() {
      if (!cache.status) {
        const out = R.ok(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules', '--', 'memory']);
        const parts = splitZ(out);
        const tracked = []; const untracked = [];
        for (let i = 0; i < parts.length; i++) {
          const xy = parts[i].slice(0, 2); const file = parts[i].slice(3);
          if (xy === '??') untracked.push(file);
          else { tracked.push(file); if (xy[0] === 'R' || xy[0] === 'C') { tracked.push(parts[i + 1]); i++; } }
        }
        cache.status = { tracked, untracked };
      }
      return cache.status;
    },
    trackedDirtyCheap() {
      const out = R.ok(['status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules', '--', 'memory']);
      return splitZ(out).map((e) => e.slice(3));
    },
    ignored() {
      const out = R.ok(['status', '--porcelain=v1', '-z', '--ignored', '--untracked-files=all', '--ignore-submodules', '--', 'memory']);
      return splitZ(out).filter((e) => e.startsWith('!!')).map((e) => e.slice(3));
    },
    diff(a, b) {
      return splitZ(R.ok(['diff', '--name-only', '--no-renames', '--no-ext-diff', '-z', a, b, '--', 'memory']));
    },
    lsTree(rev) { return splitZ(R.ok(['ls-tree', '-r', '--name-only', '-z', rev, '--', 'memory'])); },
  };
  return R;
}

// Is this toplevel the guarded kind (its `memory` resolves into <home>/.claude/projects/<slug>/memory)?
function guardedMemory(top) {
  const mem = path.join(top, 'memory');
  try { fs.lstatSync(mem); } catch (_) { return null; }
  const real = realNative(mem);
  if (!real) return null;
  const projects = realNative(path.join(HOME, '.claude', 'projects')) || path.join(HOME, '.claude', 'projects');
  if (path.basename(real).toLowerCase() !== 'memory') return null;
  if (normKey(path.dirname(path.dirname(real))) !== normKey(projects)) return null;
  return real;
}

// ---------------------------------------------------------------------------------------------------------
// Pathspecs: which user pathspecs could touch `memory/...`, and does a file match them.
// ---------------------------------------------------------------------------------------------------------
function normRel(p) {
  const parts = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return null; parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('/');
}
// -> list of { pat, glob, icase } relative to the repo top; null pat = outside the repo.
function toTopSpecs(specs, prefix, top) {
  const out = [];
  let positive = 0;
  for (const raw of specs) {
    let s = String(raw); let magicTop = false; let icase = false; let glob = null; let exclude = false;
    if (s.startsWith(':(')) {
      const end = s.indexOf(')');
      const magic = s.slice(2, end).split(',');
      s = s.slice(end + 1);
      if (magic.includes('top')) magicTop = true;
      if (magic.includes('icase')) icase = true;
      if (magic.includes('exclude')) exclude = true;
      if (magic.includes('literal')) glob = false;
      if (magic.includes('glob')) glob = true;
    } else if (s.startsWith(':/')) { magicTop = true; s = s.slice(2); }
    else if (s.startsWith(':!') || s.startsWith(':^')) { exclude = true; s = s.slice(2); }
    else if (s.startsWith(':')) { s = s.slice(1); }
    if (exclude) continue; // conservative: excludes can only shrink coverage
    positive++;
    let rel;
    const exp = expandPath(s);
    if (exp !== null && path.isAbsolute(exp)) {
      const realTop = realNative(top) || top;
      let realP = realNative(exp);
      if (!realP) { const d = realNative(path.dirname(exp)); realP = d ? path.join(d, path.basename(exp)) : exp; }
      rel = normRel(path.relative(realTop, realP));
    } else {
      rel = normRel(magicTop ? s : (prefix || '') + s);
    }
    if (rel === null) continue;
    if (glob === null) glob = /[*?[]/.test(rel);
    out.push({ pat: rel, glob, icase: icase || IS_WIN });
  }
  if (positive === 0 && specs.length) out.push({ pat: '', glob: false, icase: IS_WIN }); // only excludes = everything else
  return out;
}
function globRe(pat, icase) {
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') { const j = pat.indexOf(']', i + 1); if (j > i) { re += '[' + pat.slice(i + 1, j).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'; i = j; } else re += '\\['; }
    else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '(/.*)?$', icase ? 'i' : '');
}
function specMatches(file, spec) {
  if (spec.pat === '') return true;
  if (spec.glob) return globRe(spec.pat, spec.icase).test(file);
  const f = spec.icase ? file.toLowerCase() : file; const p = spec.icase ? spec.pat.toLowerCase() : spec.pat;
  return f === p || f.startsWith(p + '/');
}
function specCoversMemory(spec) {
  const p = spec.icase ? spec.pat.toLowerCase() : spec.pat;
  if (p === '') return true;
  if (spec.glob) {
    const pre = p.split(/[*?[]/)[0];
    return 'memory/'.startsWith(pre) || pre.startsWith('memory/') || pre === 'memory';
  }
  return p === 'memory' || p.startsWith('memory/') || 'memory/'.startsWith(p + '/');
}
function filterBy(files, specs) {
  if (specs === 'ALL') return files;
  return files.filter((f) => specs.some((s) => specMatches(f, s)));
}
function uniq(a) { return [...new Set(a)]; }

// ---------------------------------------------------------------------------------------------------------
// Per-class analysis. Each returns null (allow) or { cls, files } (deny).
// ---------------------------------------------------------------------------------------------------------
function longOpt(a) { const k = a.indexOf('='); return k < 0 ? [a, undefined] : [a.slice(0, k), a.slice(k + 1)]; }

function pathForm(R, cls, specsRaw, prefix, source, opts) {
  const specs = specsRaw === 'ALL' ? 'ALL' : toTopSpecs(specsRaw, prefix, R.top);
  if (specs !== 'ALL' && !specs.some(specCoversMemory)) return null;
  let files = filterBy(R.status().tracked, specs);
  if (source) {
    const t = R.tree(source);
    if (!t) return null; // git itself will refuse an invalid source
    files = files.concat(filterBy(R.diff(R.head(), t), specs));
  }
  if (opts && opts.untracked) files = files.concat(filterBy(R.status().untracked, specs));
  files = uniq(files);
  return files.length ? { cls, files } : null;
}

function branchForm(R, cls, targetSha, force) {
  let files = R.diff(R.head(), targetSha);
  let why = cls;
  if (!files.length && force) { files = R.status().tracked; why = cls + ' with a force flag while memory has uncommitted changes'; }
  return files.length ? { cls: why, files } : null;
}

function dwimRemote(R, name) {
  if (/[*?[\]]/.test(name)) return null;
  const r = R.q(['for-each-ref', '--format=%(refname)', `refs/remotes/*/${name}`]);
  if (r.code !== 0) return null;
  const refs = r.out.split(/\r?\n/).filter(Boolean);
  return refs.length === 1 ? R.commit(refs[0]) : null;
}

function analyseCheckout(R, sub, args, prefix) {
  let force = false; let newBranch = false; let orphan = false; let fromFile = false; let noGuess = false;
  const positionals = []; let paths = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (paths) { paths.push(a); continue; }
    if (a === '--') { paths = []; continue; }
    if (a === '-') { positionals.push('@{-1}'); continue; }
    if (a.startsWith('--')) {
      const [k, v] = longOpt(a);
      if (k === '--force' || k === '--discard-changes') force = true;
      else if (k === '--orphan') { orphan = true; if (v === undefined) i++; }
      else if (k === '--create' || k === '--force-create') { newBranch = true; if (v === undefined) i++; }
      else if (k === '--pathspec-from-file') { fromFile = true; if (v === undefined) i++; }
      else if (k === '--no-guess') noGuess = true;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      const letters = a.slice(1);
      for (let k = 0; k < letters.length; k++) {
        const ch = letters[k];
        if (ch === 'f') force = true;
        else if (ch === 'b' || ch === 'B' || ((ch === 'c' || ch === 'C') && sub === 'switch')) {
          newBranch = true; if (k === letters.length - 1) i++; break;
        }
      }
      continue;
    }
    positionals.push(a);
  }
  const label = `git ${sub}`;
  if (sub === 'switch') {
    if (orphan) return branchForm(R, `${label} --orphan (empties the work tree)`, EMPTY_TREE, force);
    const target = positionals[0] || 'HEAD';
    let sha = R.commit(target);
    if (!sha && !newBranch && !noGuess) sha = dwimRemote(R, target);
    if (!sha) return null; // git will refuse
    return branchForm(R, `${label} ${positionals[0] || ''}`.trim(), sha, force);
  }
  // checkout
  if (fromFile) return pathForm(R, `${label} --pathspec-from-file`, 'ALL', prefix, positionals[0] && R.tree(positionals[0]) ? positionals[0] : null);
  if (paths !== null) {
    const src = positionals[0] || null;
    if (src && !R.tree(src)) return null; // git will refuse
    const specs = positionals.slice(1).concat(paths);
    return pathForm(R, `${label} ${src ? src + ' ' : ''}-- <paths>`, specs, prefix, src);
  }
  if (!positionals.length) return branchForm(R, label, R.head(), force);
  const first = positionals[0];
  let sha = R.commit(first);
  if (sha) {
    if (positionals.length > 1) return pathForm(R, `${label} ${first} <paths>`, positionals.slice(1), prefix, first);
    return branchForm(R, `${label} ${first}`, sha, force);
  }
  if (R.tree(first) && positionals.length > 1) return pathForm(R, `${label} ${first} <paths>`, positionals.slice(1), prefix, first);
  if (newBranch || orphan) return null; // invalid start point: git will refuse
  if (positionals.length === 1 && !noGuess) {
    sha = dwimRemote(R, first);
    if (sha) return branchForm(R, `${label} ${first}`, sha, force);
  }
  return pathForm(R, `${label} <paths>`, positionals, prefix, null);
}

function analyseRestore(R, args, prefix) {
  let source = null; let staged = false; let worktree = false; let fromFile = false;
  const specs = []; let dd = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (dd) { specs.push(a); continue; }
    if (a === '--') { dd = true; continue; }
    if (a.startsWith('--')) {
      const [k, v] = longOpt(a);
      if (k === '--source') { source = v !== undefined ? v : args[++i]; }
      else if (k === '--staged') staged = true;
      else if (k === '--worktree') worktree = true;
      else if (k === '--pathspec-from-file') { fromFile = true; if (v === undefined) i++; }
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      const letters = a.slice(1);
      for (let k = 0; k < letters.length; k++) {
        const ch = letters[k];
        if (ch === 'S') staged = true;
        else if (ch === 'W') worktree = true;
        else if (ch === 's') { source = k < letters.length - 1 ? letters.slice(k + 1) : args[++i]; break; }
      }
      continue;
    }
    specs.push(a);
  }
  if (staged && !worktree) return null; // index only: no memory file in the work tree changes
  if (!specs.length && !fromFile) return null; // git refuses without a pathspec
  return pathForm(R, `git restore${source ? ' --source=' + source : ''} <paths>`, fromFile ? 'ALL' : specs, prefix, source);
}

function analyseReset(R, args) {
  let mode = 'mixed'; const pos = [];
  for (const a of args) {
    if (a === '--hard' || a === '--merge' || a === '--keep' || a === '--soft' || a === '--mixed') { mode = a.slice(2); continue; }
    if (a === '--') break;
    if (a.startsWith('-')) continue;
    pos.push(a);
  }
  if (mode !== 'hard' && mode !== 'merge' && mode !== 'keep') return null;
  const target = pos[0] || 'HEAD';
  const sha = R.commit(target);
  if (!sha) return null; // git will refuse
  const files = uniq(R.status().tracked.concat(R.diff(R.head(), sha)));
  return files.length ? { cls: `git reset --${mode} ${target}`, files } : null;
}

function analyseStash(R, args, prefix) {
  let action = 'push'; let rest = args;
  if (args.length && !args[0].startsWith('-')) { action = args[0]; rest = args.slice(1); }
  if (['list', 'show', 'drop', 'clear', 'create', 'store'].includes(action)) return null;
  if (action === 'pop' || action === 'apply' || action === 'branch') {
    const pos = rest.filter((a) => !a.startsWith('-'));
    let ref = action === 'branch' ? pos[1] : pos[0];
    if (!ref) ref = 'stash@{0}';
    if (/^\d+$/.test(ref)) ref = `stash@{${ref}}`;
    const sha = R.commit(ref);
    if (!sha) return null; // no such stash: git will refuse
    let files = R.commit(`${sha}^1`) ? R.diff(`${sha}^1`, sha) : [];
    if (R.commit(`${sha}^3`)) files = files.concat(R.lsTree(`${sha}^3`));
    files = uniq(files);
    return files.length ? { cls: `git stash ${action} ${ref}`, files } : null;
  }
  if (action !== 'push' && action !== 'save') return null; // unknown stash subcommand: git refuses
  let untracked = false; let all = false; let fromFile = false; const specs = []; let dd = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (dd) { specs.push(a); continue; }
    if (a === '--') { dd = true; continue; }
    if (a.startsWith('--')) {
      const [k, v] = longOpt(a);
      if (k === '--include-untracked') untracked = true;
      else if (k === '--no-include-untracked') untracked = false;
      else if (k === '--all') all = true;
      else if (k === '--message' && v === undefined) i++;
      else if (k === '--pathspec-from-file') { fromFile = true; if (v === undefined) i++; }
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      const letters = a.slice(1);
      for (let k = 0; k < letters.length; k++) {
        const ch = letters[k];
        if (ch === 'u') untracked = true;
        else if (ch === 'a') all = true;
        else if (ch === 'm') { if (k === letters.length - 1) i++; break; }
      }
      continue;
    }
    if (action === 'push') specs.push(a); // `save` takes a message, not pathspecs
  }
  const specSet = fromFile || !specs.length ? 'ALL' : toTopSpecs(specs, prefix, R.top);
  if (specSet !== 'ALL' && !specSet.some(specCoversMemory)) return null;
  let files = filterBy(R.status().tracked, specSet);
  if (untracked || all) files = files.concat(filterBy(R.status().untracked, specSet));
  if (all) files = files.concat(filterBy(R.ignored(), specSet));
  files = uniq(files);
  const flags = all ? ' --all' : untracked ? ' -u' : '';
  return files.length ? { cls: `git stash ${action}${flags}`, files } : null;
}

function analyseClean(R, args, prefix) {
  let force = false; let dry = false; let interactive = false; const keep = []; const specs = []; let dd = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (dd) { specs.push(a); continue; }
    if (a === '--') { dd = true; continue; }
    if (a.startsWith('--')) {
      const [k, v] = longOpt(a);
      if (k === '--force') force = true;
      else if (k === '--dry-run') dry = true;
      else if (k === '--interactive') interactive = true;
      else if (k === '--exclude') keep.push('-e', v !== undefined ? v : args[++i]);
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      const letters = a.slice(1);
      for (let k = 0; k < letters.length; k++) {
        const ch = letters[k];
        if (ch === 'f') force = true;
        else if (ch === 'n') dry = true;
        else if (ch === 'i') interactive = true;
        else if (ch === 'd' || ch === 'x' || ch === 'X') keep.push('-' + ch);
        else if (ch === 'e') { keep.push('-e', k < letters.length - 1 ? letters.slice(k + 1) : args[++i]); break; }
      }
      continue;
    }
    specs.push(a);
  }
  if (dry) return null;
  if (!force && !interactive) {
    const r = R.q(['config', '--type=bool', '--get', 'clean.requireForce']);
    if (!(r.code === 0 && r.out.trim() === 'false')) return null; // git refuses without -f
  }
  // No pathspec: git clean works from the current folder down, so the cwd prefix is the pathspec.
  const specSet = specs.length ? toTopSpecs(specs, prefix, R.top) : (prefix ? toTopSpecs(['.'], prefix, R.top) : 'ALL');
  if (specSet !== 'ALL' && !specSet.some(specCoversMemory)) return null;
  const out = R.ok(['clean', '-n', ...keep, '--', 'memory']);
  let files = out.split(/\r?\n/).map((l) => (/^Would (?:remove|skip repository) (.*)$/.exec(l) || [])[1])
    .filter(Boolean).map((f) => f.replace(/^"(.*)"$/, '$1').replace(/\/$/, ''));
  files = filterBy(files, specSet);
  return files.length ? { cls: `git clean ${args.join(' ')}`.trim(), files } : null;
}

// ---------------------------------------------------------------------------------------------------------
// Command walk: find each git invocation with the directory it runs in.
// ---------------------------------------------------------------------------------------------------------
const PREFIX_WORDS = new Set(['sudo', 'command', 'exec', 'nohup', 'time', 'env', 'builtin', 'then', 'do', 'else',
  'elif', '{', '}', '!', '.', 'if', 'while', 'until']);
const CD_WORDS = new Set(['cd', 'chdir', 'set-location', 'sl', 'pushd', 'push-location']);
const POPD_WORDS = new Set(['popd', 'pop-location']);

function baseName(w) { return String(w).replace(/\\/g, '/').split('/').pop().toLowerCase(); }
function isGitWord(w) { const b = baseName(w); return b === 'git' || b === 'git.exe'; }

// A word whose value is only known at run time: a variable ($B, ${B}, $env:X, PowerShell $b) other than the
// home forms expandPath understands, a command substitution (SUBST holds `$`), or a find/xargs `{}` slot.
function isDynamic(w) { const s = String(w); return s === '{}' || s.replace(HOME_VAR_RE, '').includes('$'); }
// Words that only print or search their arguments: a `git` word after them is text, not a command.
const NON_EXEC = new Set(['echo', 'printf', 'write-host', 'write-output', 'write-error', 'write-verbose', 'grep',
  'egrep', 'fgrep', 'rg', 'findstr', 'select-string', 'sls', 'man', 'which', 'where', 'get-command', 'gcm', 'type',
  'cat', 'less', 'more', 'head', 'tail', 'get-help', 'help', 'mkdir', 'md', 'new-item', 'ls', 'dir', 'get-childitem']);
// Commands that run their argument TEXT as a command.
const EVAL_WORDS = new Set(['eval', 'iex', 'invoke-expression']);
// Wrappers that add arguments read at run time to the command they run.
const ARGS_FROM_INPUT = new Set(['xargs', 'parallel']);
// The git subcommands that can rewrite memory, as plain words (for commands built at run time).
const DENY_WORD_RE = /(?:^|[^\w-])(checkout|switch|restore|reset|stash|clean)(?![\w-])/i;
let WHOLE_CMD = ''; // the tool command under analysis (set in main)
function dynInv(dir, text) { return { dir, gitOpts: [], sub: '<run-time command>', args: [], text, dynamic: true }; }
function dirExists(d) { try { return fs.statSync(d).isDirectory(); } catch (_) { return false; } }

function findInvocations(cmd, ps, startDir, depth, out) {
  if (depth > 3) { out.push(dynInv(startDir, String(cmd))); return; } // nested too deep to read: treat as unknown
  let curDir = startDir;
  const stack = [];
  // run `text` (a command string) as a nested command. A text that is ONE run-time word (`iex $c`,
  // `eval "$CMD"`, `bash -c "$CMD"`) is unknown; a longer text is read word by word like any command.
  const nested = (text, nps) => {
    const t = String(text).trim();
    if (/^\S+$/.test(t) && isDynamic(t)) out.push(dynInv(curDir, t));
    findInvocations(text, nps, curDir, depth + 1, out);
  };
  for (const seg of tokenize(cmd, ps)) {
    if (seg.length === 1 && seg[0] === SUB_OPEN) { stack.push(curDir); continue; }
    if (seg.length === 1 && seg[0] === SUB_CLOSE) {
      // a bash subshell / substitution ends: its `cd` is undone. PowerShell (...) and $(...) share the session's
      // location, so a Set-Location inside them stays in force.
      const saved = stack.pop();
      if (!ps && saved !== undefined) curDir = saved;
      continue;
    }
    let w = seg.slice();
    while (w.length) {
      const h = w[0];
      if (!ps && /^[A-Za-z_][A-Za-z0-9_]*=/.test(h)) { w.shift(); continue; }
      if (PREFIX_WORDS.has(h.toLowerCase())) { w.shift(); continue; }
      break;
    }
    if (!w.length) continue;
    const b = baseName(w[0]).replace(/\.exe$/, '');
    if (CD_WORDS.has(w[0].toLowerCase())) {
      let target; const rest = w.slice(1);
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (/^-(path|literalpath)$/i.test(a)) { target = rest[i + 1]; break; }
        if (a === '-') { target = null; break; }
        if (/^-/.test(a) || /^\/d$/i.test(a)) continue;
        target = a; break;
      }
      const next = target === undefined ? HOME : target === null ? null : resolveDir(curDir, target);
      // A cd / Set-Location to a folder that does not exist fails and the shell STAYS where it was (bash with
      // `;`, and PowerShell 5.1, where a failed Set-Location does not stop a `;` chain): keep the current folder.
      if (next === null || dirExists(next)) curDir = next;
      continue;
    }
    if (POPD_WORDS.has(w[0].toLowerCase())) { curDir = null; continue; }
    if (['bash', 'sh', 'zsh', 'dash'].includes(b)) {
      const i = w.findIndex((a, k) => k > 0 && /^-[a-z]*c[a-z]*$/.test(a));
      if (i > 0 && w[i + 1] !== undefined) nested(w[i + 1], false);
      continue;
    }
    if (b === 'powershell' || b === 'pwsh') {
      const i = w.findIndex((a, k) => k > 0 && /^-(c|co|com|comm|comma|comman|command|e|ec|en|enc|encodedcommand)$/i.test(a));
      if (i > 0) {
        const flag = w[i].toLowerCase();
        let text = w.slice(i + 1).join(' ');
        if (/^-e/.test(flag)) { try { text = Buffer.from(w[i + 1] || '', 'base64').toString('utf16le'); } catch (_) { text = ''; } }
        nested(text, true);
      }
      continue;
    }
    if (b === 'cmd') {
      const i = w.findIndex((a, k) => k > 0 && /^\/[ck]$/i.test(a));
      if (i > 0) nested(w.slice(i + 1).join(' '), true);
      continue;
    }
    if (EVAL_WORDS.has(w[0].toLowerCase())) {
      const rest = w.slice(1).filter((a, k) => !(k === 0 && /^-command$/i.test(a)));
      if (rest.length) nested(rest.join(' '), ps);
      continue;
    }
    let dynamicArgs = false;
    if (!isGitWord(w[0])) {
      // the command word itself is only known at run time (`$GIT checkout x`, PowerShell `& $g checkout x`),
      // and not a PowerShell assignment (`$b = "x"`): unknown when the segment names a rewriting subcommand
      if (isDynamic(w[0]) && w[1] !== '=' && !/^[-+*/]?=$/.test(w[1] || '') && w.slice(1).some((a) => DENY_WORD_RE.test(` ${a} `))) {
        out.push(dynInv(curDir, w.join(' ')));
        continue;
      }
      // a git word behind a wrapper the walk does not know (timeout 60 git ..., nice -n 5 git ..., env -i git ...,
      // xargs git ..., find -exec git ...): analyse it from that word on. Printing / searching words are text.
      if (NON_EXEC.has(b)) continue;
      const g = w.findIndex((a, k) => k > 0 && isGitWord(a));
      if (g < 0) continue;
      dynamicArgs = w.slice(0, g).some((a) => ARGS_FROM_INPUT.has(baseName(a).replace(/\.exe$/, '')));
      w = w.slice(g);
    }
    // git global options
    let dir = curDir; const gitOpts = []; let sub = null; let k = 1;
    for (; k < w.length; k++) {
      const a = w[k];
      if (a === '-C') { dir = resolveDir(dir, w[k + 1] === undefined ? '' : w[k + 1]); k++; continue; }
      if (a === '-c') { k++; continue; }
      const m = /^--(git-dir|work-tree)(?:=(.*))?$/.exec(a);
      if (m) {
        let v = m[2]; if (v === undefined) { v = w[k + 1]; k++; }
        const r = resolveDir(dir, v);
        gitOpts.push(`--${m[1]}=${r === null ? v : r}`);
        if (r === null) dir = null;
        continue;
      }
      if (/^--(namespace|config-env|attr-source|exec-path|super-prefix|list-cmds)$/.test(a)) { k++; continue; }
      if (a.startsWith('-')) continue;
      sub = a; break;
    }
    if (!sub) continue;
    out.push({ dir, gitOpts, sub, args: w.slice(k + 1), text: w.join(' '), dynamicArgs });
  }
}

function expandAlias(inv) {
  // Resolve `git <alias>` (non-shell aliases) up to 5 levels; shell aliases are analysed as a command.
  for (let n = 0; n < 5; n++) {
    if (inv.dynamic || isDynamic(inv.sub)) return [inv];
    if (DENY_CLASSES.has(inv.sub) || WATCH_CLASSES.has(inv.sub) || BUILTINS.has(inv.sub)) return [inv];
    if (inv.dir === null) return [inv];
    const r = git([...inv.gitOpts, '-C', inv.dir, 'config', '--get', `alias.${inv.sub}`]);
    if (r.code !== 0) return [inv];
    const val = r.out.trim();
    if (val.startsWith('!')) {
      const more = [];
      findInvocations(val.slice(1) + ' ' + inv.args.join(' '), false, inv.dir, 2, more);
      return more;
    }
    const words = (tokenize(val, false)[0] || []);
    if (!words.length) return [inv];
    inv = Object.assign({}, inv, { sub: words[0], args: words.slice(1).concat(inv.args) });
  }
  return [inv];
}

// Analyse one invocation. Returns { decision: 'deny'|'allow'|'watch'|'skip', ... }.
// Is this invocation one that may rewrite memory (so an analysis failure denies)? The deny classes, a
// subcommand only known at run time, and a command built at run time that names a rewriting subcommand.
function isDenyish(inv) {
  // the whole tool command, not only the run-time word: `$c = "git checkout x"; iex $c` builds it earlier
  if (inv.dynamic) return DENY_WORD_RE.test(` ${inv.text} `) || DENY_WORD_RE.test(` ${WHOLE_CMD} `);
  return DENY_CLASSES.has(inv.sub) || isDynamic(inv.sub);
}
// The first argument the analysis cannot know before the command runs, or null. Stash messages are text.
function unknownArg(inv) {
  if (isDynamic(inv.sub)) return inv.sub;
  const args = inv.args;
  let from = 0; let action = '';
  if (inv.sub === 'stash' && args.length && !args[0].startsWith('-')) {
    action = args[0]; from = 1;
    if (['list', 'show', 'drop', 'clear', 'create', 'store'].includes(action)) return null;
  }
  // forms that never touch the work tree, whatever the run-time value is
  if (inv.sub === 'restore') {
    const short = args.filter((a) => /^-[a-zA-Z]+$/.test(a)).join('');
    const staged = args.includes('--staged') || short.includes('S');
    const worktree = args.includes('--worktree') || short.includes('W');
    if (staged && !worktree) return null;
  }
  const dd = args.indexOf('--');
  if (inv.sub === 'reset') {
    const head = dd < 0 ? args : args.slice(0, dd);
    if (head.includes('--soft') || head.includes('--mixed')) return null;
  }
  for (let i = from; i < args.length; i++) {
    const a = args[i];
    if (inv.sub === 'reset' && dd >= 0 && i > dd) break; // `git reset [<rev>] -- <paths>` only resets the index
    if ((inv.sub === 'checkout' || inv.sub === 'switch') && (dd < 0 || i < dd)) {
      // the NEW branch name after -b / -B / --orphan (and -c / -C / --create for switch) is not a target
      if (/^--(create|force-create|orphan)=/.test(a)) continue;
      if (a === '--orphan' || a === '--create' || a === '--force-create' || /^-[a-zA-Z]*[bB]$/.test(a)
        || (inv.sub === 'switch' && /^-[a-zA-Z]*[cC]$/.test(a))) { i++; continue; }
    }
    if (inv.sub === 'stash') {
      if (a === '--message' || /^-[a-zA-Z]*m$/.test(a)) { i++; continue; }
      if (/^--message=/.test(a) || /^-[a-zA-Z]*m./.test(a)) continue;
      if (action === 'save' && !a.startsWith('-')) continue; // `stash save` positionals are the message
    }
    if (isDynamic(a)) return a;
  }
  if (inv.dynamicArgs) return '(arguments read from input at run time, e.g. by xargs)';
  return null;
}

function analyseInvocation(inv) {
  const deny = isDenyish(inv); const watch = !inv.dynamic && WATCH_CLASSES.has(inv.sub);
  if (!deny && !watch) return { decision: 'skip' };
  if (inv.dir === null) throw new Error('the directory this git command runs in could not be resolved');
  const r = git([...inv.gitOpts, '-C', inv.dir, 'rev-parse', '--show-toplevel', '--show-prefix']);
  if (r.code !== 0) return { decision: 'allow', note: `not a git repo (${oneLine(inv.dir, 80)})` };
  const lines = r.out.split(/\r?\n/);
  const top = path.resolve(lines[0].trim()); const prefix = (lines[1] || '').trim();
  if (!guardedMemory(top)) return { decision: 'allow', note: `not the guarded repo (${oneLine(top, 80)})` };
  if (inv.dynamic) throw new Error(`a command built at run time (\`${oneLine(inv.text, 80)}\`) may run a git command that rewrites memory`);
  if (deny) {
    const u = unknownArg(inv);
    if (u) throw new Error(`\`${oneLine(u, 60)}\` is only known when the command runs`);
  }
  const R = makeRepo(top, inv.gitOpts);
  if (watch) {
    const dirty = R.trackedDirtyCheap();
    return dirty.length ? { decision: 'watch', top, files: dirty } : { decision: 'allow', note: `${inv.sub}: memory clean` };
  }
  let res = null;
  if (inv.sub === 'checkout' || inv.sub === 'switch') res = analyseCheckout(R, inv.sub, inv.args, prefix);
  else if (inv.sub === 'restore') res = analyseRestore(R, inv.args, prefix);
  else if (inv.sub === 'reset') res = analyseReset(R, inv.args);
  else if (inv.sub === 'stash') res = analyseStash(R, inv.args, prefix);
  else if (inv.sub === 'clean') res = analyseClean(R, inv.args, prefix);
  if (!res) return { decision: 'allow', note: `${inv.sub}: no memory file would change` };
  return { decision: 'deny', top, cls: res.cls, files: res.files };
}

function wayForward(ps) {
  const hatch = ps
    ? '`$env:MEMORY_GIT_OK=1; git ...`'
    : '`MEMORY_GIT_OK=1 git ...`';
  return 'Way forward: commit the memory changes first, or take a snapshot ' +
    '(node "$HOME/Backups/memory-snapshots/snapshot.mjs"), then re-run. Only if rewriting memory is truly intended, ' +
    `re-run with the escape hatch: ${hatch} (or add a \`# memory-git-ok\` comment).`;
}

function denyReason(res, inv, ps) {
  const n = res.files.length;
  const shown = res.files.slice(0, MAX_LIST).join(', ') + (n > MAX_LIST ? `, and ${n - MAX_LIST} more` : '');
  return `memory-git-guard: \`${oneLine(inv.text, 120)}\` (${res.cls}) would change ${n} memory file(s) in ${res.top}. ` +
    `memory/ there is a junction to the LIVE note store shared by every session. Files: ${shown}. ` + wayForward(ps);
}

// ---------------------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------------------
let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  // Fast path: no `git` anywhere in the payload -> nothing to check.
  if (!/git/i.test(data)) return allowExit();
  let input;
  try { input = JSON.parse(data || '{}'); } catch (_) { return allowExit(); }
  const tool = (input && input.tool_name) || '';
  if (tool !== 'Bash' && tool !== 'PowerShell') return allowExit();
  const cmd = String((input.tool_input && input.tool_input.command) || '');
  if (!/\bgit\b/i.test(cmd)) return allowExit();
  const ps = tool === 'PowerShell';
  const sid8 = String(input.session_id || '').slice(0, 8) || '-';
  try {
    if (/\bMEMORY_GIT_OK=1\b|\$env:MEMORY_GIT_OK\b|#\s*memory-git-ok\b/i.test(cmd)) {
      audit(`ALLOW escape-hatch sid=${sid8} cmd=${oneLine(cmd)}`);
      return allowExit();
    }
    const cwd = resolveDir(null, input.cwd || process.cwd()) || process.cwd();
    const invs = [];
    WHOLE_CMD = cmd;
    findInvocations(cmd, ps, cwd, 0, invs);
    const notes = [];
    for (const inv0 of invs) {
      let list;
      try { list = expandAlias(inv0); } catch (_) { list = [inv0]; }
      for (const inv of list) {
        let res;
        try {
          res = analyseInvocation(inv);
        } catch (err) {
          if (isDenyish(inv)) {
            const reason = `memory-git-guard: could not verify that memory is safe for \`${oneLine(inv.text, 120)}\` ` +
              `(${oneLine(err && err.message, 160)}). Denied to protect the live memory store. ` + wayForward(ps);
            return denyExit(reason, `could-not-verify sid=${sid8} sub=${inv.sub} err=${oneLine(err && err.message, 120)} cmd=${oneLine(cmd)}`);
          }
          audit(`ALLOW error (fail-open, ${inv.sub}) sid=${sid8} err=${oneLine(err && err.message, 120)} cmd=${oneLine(cmd)}`);
          continue;
        }
        if (res.decision === 'deny') {
          return denyExit(denyReason(res, inv, ps),
            `sid=${sid8} class="${res.cls}" n=${res.files.length} first=${res.files.slice(0, 3).join(',')} cmd=${oneLine(cmd)}`);
        }
        if (res.decision === 'watch') {
          audit(`WOULD-BLOCK sid=${sid8} ${inv.sub} with ${res.files.length} uncommitted memory change(s) in ${res.top} cmd=${oneLine(cmd)}`);
        } else if (res.decision === 'allow') {
          notes.push(res.note);
        }
      }
    }
    if (notes.length) audit(`ALLOW sid=${sid8} ${oneLine(notes.join('; '), 200)} cmd=${oneLine(cmd)}`);
    return allowExit();
  } catch (err) {
    // Unexpected error outside a single invocation's analysis.
    if (/\bgit\b[\s\S]*\b(checkout|switch|restore|reset|stash|clean)\b/i.test(cmd)) {
      return denyExit(`memory-git-guard: could not verify that memory is safe (${oneLine(err && err.message, 160)}). ` + wayForward(ps),
        `could-not-verify (outer) sid=${sid8} err=${oneLine(err && err.message, 120)} cmd=${oneLine(cmd)}`);
    }
    audit(`ALLOW error (fail-open) sid=${sid8} err=${oneLine(err && err.message, 120)}`);
    return allowExit();
  }
});
