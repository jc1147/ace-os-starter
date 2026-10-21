'use strict';
// lib-concurrency.js — dependency-free, fail-OPEN concurrency primitives shared by the deterministic-hook
// layer (WS-D). CommonJS, node builtins only. Every export swallows its own errors and returns a safe,
// non-blocking value (fail-open) so a lock/lease infra problem NEVER stops a hook or a session.
//
//   normPath(p)                    canonical path string (slash/case/git-bash + junction realpath)
//   liveSessions(cwd, excludeSid)  session_ids with a fresh (<30 min) co-resident heartbeat
//   acquireLease(filePath, sid)    sha1-keyed file lease; returns a LIVE holder's sid, else null (acquired)
//   withLock(lockFile, staleMs,fn) O_EXCL lock + staleness; runs fn under the lock, returns 'held' if busy

const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const HOME = (os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
// heartbeat files <sid>.beat {ts, cwd}. Ace OS Starter ships no heartbeat writer, so out of the box every session
// counts as solo and the parallel-session gates stay dormant (they log only, and only when beats exist).
const BEATS = `${HOME}/.claude/session-beats`;
const LOCKS_FILES = `${HOME}/.claude/locks/files`;
const LIVE_MS = 30 * 60 * 1000; // a beat younger than 30 min = a live session
const LEASE_MS = 120 * 1000;    // a lease younger than 120s can hold (if its sid is also live)

// mkdir -p ~/.claude/locks/files at load if absent (guarded — fail-open)
try { fs.mkdirSync(LOCKS_FILES, { recursive: true }); } catch (_) {}

// ---- normPath ---------------------------------------------------------------
// Lexical normalization: backslash->slash, git-bash /c/ -> c:/, lowercase drive, collapse dup slashes,
// strip trailing slash. Then junction-canonicalize via realpathSync.native, falling back to lexical on error.
function lexical(p) {
  let s = String(p == null ? '' : p).replace(/\\/g, '/');
  s = s.replace(/^\/([a-zA-Z])\//, (m, d) => `${d.toLowerCase()}:/`); // git-bash /c/... -> c:/...
  s = s.replace(/^([a-zA-Z]):/, (m, d) => `${d.toLowerCase()}:`);     // lowercase drive letter
  s = s.replace(/\/{2,}/g, '/');                                       // collapse duplicate slashes
  if (s.length > 1) s = s.replace(/\/+$/, '');                         // strip trailing slash
  return s;
}
function normPath(p) {
  const lex = lexical(p);
  try {
    return lexical(fs.realpathSync.native(lex)); // junction/symlink canonicalization
  } catch (_) {
    return lex; // path may not exist yet, or realpath unsupported — lexical form is canonical enough
  }
}

// ---- liveness ---------------------------------------------------------------
// A sid is LIVE iff its own .beat (mtime OR embedded ts, whichever is newer) is younger than 30 min.
// NOTE: a .done file does NOT mean dead — a heartbeat writer may stamp .done on every Stop/SubagentStop turn.
// Heartbeat time = the beat's embedded ts (authoritative — what the session actually stamped); file mtime
// is only a fallback for a malformed/legacy beat with no numeric ts.
function beatTs(bp, beat) {
  if (beat && typeof beat.ts === 'number') return beat.ts;
  try { return fs.statSync(bp).mtimeMs; } catch (_) { return -Infinity; }
}
function beatAgeMs(sid) {
  try {
    const bp = `${BEATS}/${sid}.beat`;
    if (!fs.existsSync(bp)) return Infinity;
    let beat = null;
    try { beat = JSON.parse(fs.readFileSync(bp, 'utf8')); } catch (_) { beat = null; }
    return Date.now() - beatTs(bp, beat);
  } catch (_) { return Infinity; }
}
function sidLive(sid) { return beatAgeMs(sid) < LIVE_MS; }

// Two paths share a workspace root if one is equal to, or a path-prefix of, the other.
function sharesRoot(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.startsWith(b + '/') || b.startsWith(a + '/');
}

// liveSessions(cwd, excludeSid): sids with a fresh, co-resident (shared workspace root) beat.
function liveSessions(cwd, excludeSid) {
  try {
    const me = normPath(cwd);
    const out = [];
    let files = [];
    try { files = fs.readdirSync(BEATS); } catch (_) { return []; }
    for (const f of files) {
      if (!f.endsWith('.beat')) continue;
      const sid = f.slice(0, -('.beat'.length));
      if (!sid || sid === excludeSid) continue;
      const bp = `${BEATS}/${f}`;
      let beat = {};
      try { beat = JSON.parse(fs.readFileSync(bp, 'utf8')) || {}; } catch (_) { beat = {}; }
      const age = Date.now() - beatTs(bp, beat);          // heartbeat time (embedded ts; mtime fallback)
      if (age >= LIVE_MS) continue;                       // stale beat — session not live (regardless of .done)
      if (!sharesRoot(normPath(beat.cwd || ''), me)) continue; // not co-resident with this workspace
      out.push(sid);
    }
    return out;
  } catch (_) { return []; } // fail-open
}

// ---- acquireLease -----------------------------------------------------------
// sha1(normPath(filePath).toLowerCase()) -> lease file {sid,path,ts}. If a DIFFERENT sid holds a lease that
// is younger than 120s AND that sid is live -> return the holder sid (caller must back off). Otherwise write
// our own lease (tmp+rename atomic) and return null (acquired).
function acquireLease(filePath, sid) {
  try {
    const norm = normPath(filePath).toLowerCase();
    const key = crypto.createHash('sha1').update(norm).digest('hex').slice(0, 16);
    const leaseFile = `${LOCKS_FILES}/${key}.json`;
    try {
      const cur = JSON.parse(fs.readFileSync(leaseFile, 'utf8'));
      if (cur && cur.sid && cur.sid !== sid &&
          typeof cur.ts === 'number' && (Date.now() - cur.ts) < LEASE_MS &&
          sidLive(cur.sid)) {
        return cur.sid; // held by a live, recent, different session
      }
    } catch (_) { /* no readable existing lease -> we acquire */ }
    const body = JSON.stringify({ sid, path: normPath(filePath), ts: Date.now() });
    const tmp = `${leaseFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, leaseFile); // atomic replace
    return null; // acquired
  } catch (_) { return null; } // fail-open: never block on lease infra failure
}

// ---- withLock ---------------------------------------------------------------
// O_EXCL ('wx') lock file {pid,ts}. On EEXIST: read it; if older than staleMs, unlink + retry ONCE; else
// (or if the retry still collides) return 'held' without running fn. When acquired, run fn() and ALWAYS
// unlink our own lock in finally. Non-EEXIST write failures (e.g. missing parent dir) fail-OPEN: run fn unlocked.
function withLock(lockFile, staleMs, fn) {
  let acquired = false;
  try {
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' });
    acquired = true;
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      let stale = false;
      try {
        const cur = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        stale = !cur || typeof cur.ts !== 'number' || (Date.now() - cur.ts) > staleMs;
      } catch (_) { stale = true; } // unreadable/corrupt lock treated as stale
      if (!stale) return 'held';
      try { fs.unlinkSync(lockFile); } catch (_) {}
      try {
        fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' });
        acquired = true;
      } catch (_) { return 'held'; } // someone else won the retry race
    } else {
      return fn(); // fail-open: lock infra unavailable, do the work anyway (unlocked)
    }
  }
  try {
    return fn();
  } finally {
    if (acquired) { try { fs.unlinkSync(lockFile); } catch (_) {} }
  }
}

module.exports = { normPath, liveSessions, acquireLease, withLock };
