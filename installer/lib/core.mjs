// core.mjs - the pure (no side effects) building blocks shared by install.mjs, uninstall.mjs, doctor.mjs
// and the e2e test. Everything here takes its inputs as arguments so it can be unit-tested with Windows
// AND POSIX inputs on any machine.

export const PRODUCT = 'aceos-starter';
export const BLOCK_BEGIN = '<!-- aceos-starter:begin -->';
export const BLOCK_END = '<!-- aceos-starter:end -->';

// Files the dashboard writes at runtime. They never ship and an update never overwrites them.
export const RUNTIME_FILES = new Set(['.chat-token', '.chat-enabled', 'brain-data.js', 'brain-data.json']);

// Workspace paths an UPDATE refreshes (everything else in ~/ace belongs to the user and is left alone).
export const TOOLING_PREFIXES = [
  'Code/memory-system/',
  'Code/os-dashboard/',
  '.claude/hooks/',
  '.claude/agents/',
  '.claude/rules/',
  '.claude/skills/memory/',
  '.claude/skills/wrap-up/',
];
// Inside the tooling paths, these hold the user's own data: copied when absent, never overwritten.
export const USER_DATA_PREFIXES = ['Code/memory-system/sitemap/', 'Code/memory-system/aliases.json'];

export const fwd = (p) => String(p || '').replace(/\\/g, '/');
export const stripBom = (t) => (t && t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);

// Claude Code names ~/.claude/projects/<slug> by replacing EVERY character that is not [A-Za-z0-9] with '-'.
// (a Windows drive colon and each backslash become '-', so do spaces and dots: /Users/jane.doe/ace -> -Users-jane-doe-ace)
export function projectSlug(absPath) {
  return fwd(absPath).replace(/\/+$/, '').replace(/[^A-Za-z0-9]/g, '-');
}

// joins with '/', keeping a Windows drive or a POSIX root as given
export const joinFwd = (...parts) => parts.map((p, i) => (i === 0 ? fwd(p).replace(/\/+$/, '') : fwd(p).replace(/^\/+|\/+$/g, ''))).filter((p, i) => i === 0 || p).join('/');

export function workspaceDir(home) { return joinFwd(home, 'ace'); }
export function memDirFor(home) { return joinFwd(home, '.claude', 'projects', projectSlug(workspaceDir(home)), 'memory'); }

// the command string written into settings.json for one hook file
//   nodeCmd: 'node' when node is on the PATH the hooks run with, else the absolute node binary
export function hookCommand(home, file, nodeCmd = 'node') {
  const n = nodeCmd === 'node' ? 'node' : `"${fwd(nodeCmd)}"`;
  return `${n} "${joinFwd(home, '.claude', 'hooks', file)}"`;
}

// macOS: Claude Code started from the Dock or Finder gets launchd's minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin),
// where a Homebrew, nvm or Volta node is missing, and every hook would then fail open without a word. So on macOS the
// hooks call an ABSOLUTE node: the first of these that exists and is Node 18+, preferring the links that survive a
// Node upgrade (Homebrew, the nodejs.org installer, Volta) over the running binary (an nvm path moves on upgrade).
export function macNodeCandidates(home, execPath) {
  return ['/opt/homebrew/bin/node', '/usr/local/bin/node', joinFwd(home, '.volta', 'bin', 'node'), fwd(execPath)];
}
// Rewrite a bare `node ` at the start of OUR hook commands to the absolute node. isOurs(command) decides which
// commands are ours; every other command is left exactly as it is. Returns how many commands changed.
export function pinNodeInCommands(settings, isOurs, nodeCmd) {
  if (!nodeCmd || nodeCmd === 'node') return 0;
  let n = 0;
  for (const arr of Object.values((settings && settings.hooks) || {})) {
    for (const e of Array.isArray(arr) ? arr : []) {
      for (const h of entryHooks(e)) {
        if (h && typeof h.command === 'string' && /^node\s/.test(h.command) && isOurs(h.command)) {
          h.command = h.command.replace(/^node\s+/, `"${fwd(nodeCmd)}" `);
          n++;
        }
      }
    }
  }
  return n;
}
// the node a hook command starts with: 'node' (bare, found on PATH) or the absolute path inside the leading quotes
export function nodeOfCommand(command) {
  const m = String(command || '').match(/^"([^"]+)"\s/);
  return m ? m[1] : (/^node\s/.test(String(command || '')) ? 'node' : '');
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// does this hook command run <file> from a .claude/hooks folder?
export function commandRunsHook(command, file) {
  return new RegExp(`[\\\\/]\\.claude[\\\\/]hooks[\\\\/]${esc(file)}(?![A-Za-z0-9._-])`).test(String(command || ''));
}
const entryHooks = (entry) => (entry && Array.isArray(entry.hooks) ? entry.hooks : []);
export const eventHasHook = (arr, file) => (arr || []).some((e) => entryHooks(e).some((h) => commandRunsHook(h && h.command, file)));

// wiring.json -> flat list [{event, file, matcher?}] in file order
export function wiringItems(wiring) {
  const out = [];
  for (const [event, items] of Object.entries((wiring && wiring.events) || {})) for (const it of items) out.push({ event, file: it.file, matcher: it.matcher });
  return out;
}
export const wiredFiles = (wiring) => [...new Set(wiringItems(wiring).map((i) => i.file))];

// Merge our wiring into a settings object. Idempotent by hook filename per event; appends only;
// never removes or reorders anything already there. Returns a NEW object.
export function mergeWiring(settings, wiring, cmdFor) {
  const out = JSON.parse(JSON.stringify(settings || {}));
  if (out.hooks == null) out.hooks = {};
  if (typeof out.hooks !== 'object' || Array.isArray(out.hooks)) throw new Error('settings.json "hooks" is not an object - refusing to merge');
  const added = [], present = [];
  for (const it of wiringItems(wiring)) {
    if (out.hooks[it.event] == null) out.hooks[it.event] = [];
    const arr = out.hooks[it.event];
    if (!Array.isArray(arr)) throw new Error(`settings.json hooks.${it.event} is not an array - refusing to merge`);
    if (eventHasHook(arr, it.file)) { present.push({ event: it.event, file: it.file }); continue; }
    const entry = {};
    if (it.matcher) entry.matcher = it.matcher;
    entry.hooks = [{ type: 'command', command: cmdFor(it.file) }];
    arr.push(entry);
    added.push({ event: it.event, file: it.file });
  }
  return { settings: out, added, present };
}

// Remove the given {event,file} wirings. Only hook commands that run one of those files are removed;
// an entry left with no hooks is dropped, an event left empty is dropped. Everything else is untouched.
export function unwire(settings, targets) {
  const out = JSON.parse(JSON.stringify(settings || {}));
  let removed = 0;
  if (!out.hooks || typeof out.hooks !== 'object') return { settings: out, removed };
  for (const { event, file } of targets) {
    const arr = out.hooks[event];
    if (!Array.isArray(arr)) continue;
    const next = [];
    for (const entry of arr) {
      const hs = entryHooks(entry);
      const keep = hs.filter((h) => !commandRunsHook(h && h.command, file));
      removed += hs.length - keep.length;
      if (hs.length && !keep.length) continue;
      next.push(keep.length === hs.length ? entry : { ...entry, hooks: keep });
    }
    if (next.length) out.hooks[event] = next; else delete out.hooks[event];
  }
  if (out.hooks && !Object.keys(out.hooks).length) delete out.hooks;
  return { settings: out, removed };
}

// which wirings are present -> [{event,file,ok}]
export function wiringStatus(settings, wiring) {
  const hooks = (settings && settings.hooks) || {};
  return wiringItems(wiring).map((it) => ({ event: it.event, file: it.file, ok: eventHasHook(hooks[it.event], it.file) }));
}

// marked block in a CLAUDE.md: replace in place when present, else append
export function insertBlock(existing, body) {
  const block = `${BLOCK_BEGIN}\n${String(body).replace(/\r\n/g, '\n').trim()}\n${BLOCK_END}`;
  const text = String(existing || '');
  const b = text.indexOf(BLOCK_BEGIN), e = text.indexOf(BLOCK_END);
  if (b >= 0 && e > b) return text.slice(0, b) + block + text.slice(e + BLOCK_END.length);
  const base = text.replace(/\s+$/, '');
  return (base ? base + '\n\n' : '') + block + '\n';
}
export function removeBlock(existing) {
  const text = String(existing || '');
  const b = text.indexOf(BLOCK_BEGIN), e = text.indexOf(BLOCK_END);
  if (b < 0 || e < b) return text;
  const before = text.slice(0, b).replace(/\s+$/, ''), after = text.slice(e + BLOCK_END.length).replace(/^\s+/, '');
  if (!before) return after;
  return before + '\n' + (after ? '\n' + after : '');
}
export const countBlocks = (text) => String(text || '').split(BLOCK_BEGIN).length - 1;

// a username safe for temp-log file names: [A-Za-z0-9-] only
export function sanitizeUsername(s) {
  return String(s || '').trim().replace(/[^A-Za-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 39);
}

// double-click launcher written into the workspace (calls the dashboard's own start script)
export function launcherFor(platform) {
  if (platform === 'win32') {
    return {
      name: 'Start Ace OS.cmd', crlf: true, mode: undefined,
      text: [
        '@echo off',
        'REM Start Ace OS: runs the dashboard and opens it in your browser.',
        'REM Keep the window that opens; closing it stops Ace OS.',
        'call "%~dp0Code\\os-dashboard\\start.cmd" %*',
        '',
      ].join('\n'),
    };
  }
  return {
    name: 'Start Ace OS.command', crlf: false, mode: 0o755,
    text: [
      '#!/bin/bash',
      '# Start Ace OS: runs the dashboard and opens it in your browser.',
      '# Keep this Terminal window open; closing it stops Ace OS.',
      'HERE="$(cd "$(dirname "$0")" && pwd)"',
      'exec bash "$HERE/Code/os-dashboard/start.sh" "$@"',
      '',
    ].join('\n'),
  };
}

// a filesystem-safe timestamp for backup folder names
export const stamp = (d = new Date()) => d.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');

// is rel inside one of the prefixes (a prefix ending in '/' is a folder, otherwise an exact file)
export const underAny = (rel, prefixes) => prefixes.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p));

// semver-ish major of a node version string
export const nodeMajor = (v) => parseInt(String(v || '').replace(/^v/, '').split('.')[0], 10) || 0;

// CLAUDE_CONFIG_DIR must be unset or point at <home>/.claude
export function configDirProblem(envValue, home, platform) {
  if (!envValue) return null;
  const norm = (p) => { let s = fwd(p).replace(/\/+$/, ''); if (platform === 'win32') s = s.toLowerCase(); return s; };
  if (norm(envValue) === norm(joinFwd(home, '.claude'))) return null;
  return `CLAUDE_CONFIG_DIR is set to "${envValue}". Ace OS Starter installs into <home>/.claude only. Unset CLAUDE_CONFIG_DIR (or point it at your home .claude folder) and run again.`;
}

// a home folder the installer is willing to work in: absolute, not a filesystem root
export function homeProblem(home) {
  const h = fwd(home);
  if (!h) return 'could not determine your home folder';
  if (!/^([A-Za-z]:)?\//.test(h)) return `home folder is not an absolute path: ${home}`;
  if (/^([A-Za-z]:)?\/*$/.test(h)) return `home folder is a filesystem root (${home}) - refusing`;
  return null;
}
