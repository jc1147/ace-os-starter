// lib/notes.mjs - the ONE shared note reader for every memory tool (build-manifest, build-mocs, recall).
// Read-only: it lists and parses notes, it never writes. Exports:
//   listNotes(memDir)      top-level *.md except MEMORY.md (any case); subfolders (_sunset, _gaphunt) skipped
//   readNote(path)         { file, id, name, description, type, metadata, home, body, links, bytes, mtime,
//                            date, dateSource, problems }
//   parseFrontmatter(raw)  { fm, metadata, body, problems } (tolerant: takes what parses, reports the rest)
//   findRepoRoot(dir), resolveMemDir(dir), repoSlug(p), HOME   (the tools' shared root/memory-dir resolution)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';

export const HOME = (os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
// D3 slug rule (= Claude Code's projects/<slug> folder name): every character that is not [A-Za-z0-9] -> "-"
export const repoSlug = (p = process.cwd()) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').replace(/[^A-Za-z0-9]/g, '-');

// Repo root resolution (cwd-independent: a hook may run a tool from any cwd). Same order as the tools used
// before this lib: env overrides (tests/hooks stay authoritative) > git toplevel > marker walk-up > the script's
// own repo. git BEFORE the marker walk-up: nested workspaces (a Code/<site> folder carrying BOTH .claude/settings.json
// and CLAUDE.md) stop the walk-up early at a subdir; the git root is the real repo root.
// The last step walks up from the calling script's folder to the first folder holding Code/memory-system (for an
// installed tool that is exactly <script>/../.., as before; for a staged copy one level deeper it is still the
// repo), falling back to <script>/../.. when no such folder exists.
export function findRepoRoot(scriptDir) {
  if (process.env.MEMSYS_ROOT) return process.env.MEMSYS_ROOT.replace(/\\/g, '/');
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR.replace(/\\/g, '/');
  try {
    const top = cp.execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString().trim();
    if (top) return top.replace(/\\/g, '/');
  } catch (_) { /* not a git repo / git missing -> fall through */ }
  let d = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(d, '.claude', 'settings.json')) && fs.existsSync(path.join(d, 'CLAUDE.md'))) return d.replace(/\\/g, '/');
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  if (scriptDir) {
    let s = path.resolve(scriptDir);
    for (;;) {
      try { if (fs.statSync(path.join(s, 'Code', 'memory-system')).isDirectory()) return s.replace(/\\/g, '/'); } catch (_) { /* keep walking */ }
      const parent = path.dirname(s);
      if (parent === s) break;
      s = parent;
    }
    return path.resolve(scriptDir, '..', '..').replace(/\\/g, '/');
  }
  return process.cwd().replace(/\\/g, '/');
}

// Memory dir: explicit MEMSYS_MEM_DIR / CLAUDE_MEM_DIR win; else derived from the RESOLVED repo root, never from
// process.cwd() (a cwd-derived slug silently resolves an empty brain).
export function memDirOverride() {
  return process.env.MEMSYS_MEM_DIR || process.env.CLAUDE_MEM_DIR || '';
}
export function resolveMemDir(scriptDir) {
  const o = memDirOverride();
  if (o) return o.replace(/\\/g, '/');
  return `${HOME}/.claude/projects/${repoSlug(findRepoRoot(scriptDir))}/memory`;
}

export function listNotes(memDir) {
  // Same name rule as the regen hook's staleness count (so counts agree); a folder that happens to end in .md
  // is skipped (statSync follows links, so a linked note file still counts).
  return fs.readdirSync(memDir)
    .filter((f) => f.toLowerCase().endsWith('.md') && f.toUpperCase() !== 'MEMORY.MD')
    .filter((f) => { try { return fs.statSync(path.join(memDir, f)).isFile(); } catch (_) { return false; } })
    .sort();
}

// ---------- frontmatter ----------
// Enough YAML for these notes: top-level scalars; double-quoted strings with escapes; single-quoted strings with
// ''; plain scalars (a value may hold ': ' and quote marks); plain multi-line continuation; > and | block
// scalars; the one-level `metadata:` map. Never throws: anything it cannot read is listed in `problems`.
const DQ_ESC = { '"': '"', '\\': '\\', '/': '/', n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '0': '\0', ' ': ' ' };
function parseScalar(v, problems, key) {
  const s = v.trim();
  if (s.startsWith('"')) {
    let out = '';
    for (let i = 1; i < s.length; i++) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length) {
        const n = s[i + 1];
        if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) { out += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16)); i += 5; continue; }
        if (n === 'x' && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 2, i + 4))) { out += String.fromCharCode(parseInt(s.slice(i + 2, i + 4), 16)); i += 3; continue; }
        out += Object.prototype.hasOwnProperty.call(DQ_ESC, n) ? DQ_ESC[n] : '\\' + n; i++; continue;
      }
      if (c === '"') {
        const rest = s.slice(i + 1).trim();
        if (rest && !rest.startsWith('#')) { problems.push(`${key}: text after the closing double quote (kept as written)`); return s; }
        return out;
      }
      out += c;
    }
    problems.push(`${key}: unterminated double-quoted string`);
    return out;
  }
  if (s.startsWith("'")) {
    let out = '';
    for (let i = 1; i < s.length; i++) {
      const c = s[i];
      if (c === "'") {
        if (s[i + 1] === "'") { out += "'"; i++; continue; }
        const rest = s.slice(i + 1).trim();
        if (rest && !rest.startsWith('#')) { problems.push(`${key}: text after the closing single quote (kept as written)`); return s; }
        return out;
      }
      out += c;
    }
    problems.push(`${key}: unterminated single-quoted string`);
    return out;
  }
  return s;
}
const KEY_RE = /^([A-Za-z_][\w.-]*)[ \t]*:(?:[ \t]+(.*)|[ \t]*)$/;
// Read one key's value starting at line i (value text `v`, indent of the key `ind`). Returns [value, nextIndex].
function readValue(lines, i, v, ind, problems, key) {
  const t = (v || '').trim();
  const childIndent = (l) => (l.match(/^[ \t]*/)[0].length);
  if (/^[>|][+-]?\d*$/.test(t)) { // block scalar
    const folded = t[0] === '>';
    const buf = []; let j = i + 1;
    while (j < lines.length && (lines[j].trim() === '' || childIndent(lines[j]) > ind)) { buf.push(lines[j].trim()); j++; }
    while (buf.length && buf[buf.length - 1] === '') buf.pop();
    return [folded ? buf.join(' ').replace(/\s+/g, ' ').trim() : buf.join('\n'), j];
  }
  // plain or quoted, with continuation lines indented deeper than the key (that are not themselves keys of a map)
  let raw = t; let j = i + 1;
  if (t !== '') {
    while (j < lines.length && lines[j].trim() !== '' && childIndent(lines[j]) > ind && !KEY_RE.test(lines[j].trim())) {
      raw += ' ' + lines[j].trim(); j++;
    }
  }
  return [parseScalar(raw, problems, key), j];
}
export function parseFrontmatter(rawIn) {
  const problems = [];
  const raw = String(rawIn || '').replace(/^\uFEFF/, '');
  const m = raw.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) {
    if (raw.startsWith('---')) problems.push('frontmatter: no closing ---');
    else problems.push('frontmatter: none');
    return { fm: {}, metadata: {}, body: raw.replace(/^\s+/, ''), problems };
  }
  const fm = {}; const metadata = {};
  const lines = m[1].split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || /^\s*#/.test(line)) { i++; continue; }
    if (/^[ \t]/.test(line)) { problems.push(`frontmatter line ${i + 1}: unexpected indent`); i++; continue; }
    const km = line.match(KEY_RE);
    if (!km) { problems.push(`frontmatter line ${i + 1}: not a key`); i++; continue; }
    const key = km[1]; const v = km[2] || '';
    if (v.trim() === '' && i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1]) && !KEY_RE.test(lines[i + 1].trim())) {
      // an empty key followed by indented plain text = a multi-line plain scalar
      const buf = []; let j = i + 1;
      while (j < lines.length && /^[ \t]+\S/.test(lines[j])) { buf.push(lines[j].trim()); j++; }
      if (!(key in fm)) fm[key] = parseScalar(buf.join(' '), problems, key); else problems.push(`${key}: duplicate key`);
      i = j; continue;
    }
    if (v.trim() === '' && i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1])) {
      // a nested map (metadata:) - one level
      const map = {}; let j = i + 1;
      while (j < lines.length && (lines[j].trim() === '' || /^[ \t]+/.test(lines[j]))) {
        const l = lines[j];
        if (l.trim() === '' || /^\s*#/.test(l)) { j++; continue; }
        const ind = l.match(/^[ \t]*/)[0].length;
        const cm = l.trim().match(KEY_RE);
        if (!cm) { problems.push(`frontmatter line ${j + 1}: not a key under ${key}`); j++; continue; }
        const [val, nx] = readValue(lines, j, cm[2] || '', ind, problems, `${key}.${cm[1]}`);
        if (!(cm[1] in map)) map[cm[1]] = val; else problems.push(`${key}.${cm[1]}: duplicate key`);
        j = nx;
      }
      if (key === 'metadata') Object.assign(metadata, map); else fm[key] = map;
      i = j; continue;
    }
    const [val, nx] = readValue(lines, i, v, 0, problems, key);
    if (!(key in fm)) fm[key] = val; else problems.push(`${key}: duplicate key`);
    i = nx;
  }
  const body = raw.slice(m[0].length).replace(/^\s+/, '');
  return { fm, metadata, body, problems };
}

// ---------- dates ----------
// Optional: the day a bulk git checkout restamped your tracked files (file times lie on that day). Unset = off.
const RESTAMP_DAY = process.env.MEMSYS_RESTAMP_DAY || '';
const DATE_RE = /\b(20\d\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g;
export function localToday(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}
export function noteDate(metadata, raw, mtimeIso, today = localToday()) {
  const mod = String((metadata && metadata.modified) || '').trim().match(/^(20\d\d-\d\d-\d\d)/);
  if (mod) return { date: mod[1], dateSource: 'metadata' };
  let best = '';
  for (const x of String(raw || '').matchAll(DATE_RE)) { const d = x[0]; if (d <= today && d > best) best = d; }
  if (best) return { date: best, dateSource: 'note-text' };
  return { date: mtimeIso, dateSource: mtimeIso === RESTAMP_DAY ? 'mtime-restamped' : 'mtime' };
}

// ---------- one note ----------
export function readNote(fp, opts = {}) {
  const file = path.basename(fp);
  const id = file.replace(/\.md$/i, '');
  const rawFile = fs.readFileSync(fp, 'utf8');
  const st = fs.statSync(fp);
  const { fm, metadata, body, problems } = parseFrontmatter(rawFile);
  const str = (x) => (typeof x === 'string' ? x : '');
  const typeRaw = str(metadata.type) || str(fm.type);
  const type = (typeRaw.trim().toLowerCase().match(/^[a-z]+/) || ['note'])[0];
  const links = [...body.matchAll(/\[\[([^\]\|#]+)/g)].map((x) => x[1].trim());
  const mtime = new Date(st.mtimeMs).toISOString().slice(0, 10);
  const { date, dateSource } = noteDate(metadata, rawFile, mtime, opts.today);
  const home = str(metadata.home) || str(fm.home) || '';
  const note = {
    file, id,
    name: str(fm.name).trim() || id,
    description: str(fm.description).trim(),
    type, metadata, body, links,
    bytes: st.size, mtime, date, dateSource, problems,
  };
  if (home) note.home = home;
  return note;
}

export function readAllNotes(memDir, opts = {}) {
  const today = opts.today || localToday();
  const out = [];
  for (const f of listNotes(memDir)) {
    try { out.push(readNote(path.join(memDir, f), { today })); }
    catch (e) { if (opts.onError) opts.onError(f, e); }
  }
  return out;
}
