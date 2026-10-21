// sys.mjs - small filesystem / process helpers shared by the installer scripts (Node stdlib only).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { stripBom } from './core.mjs';

// Env for every child we run: none of the variables that would point a tool at a different brain or project.
export function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDE_PROJECT_DIR' || k === 'CLAUDE_MEM_DIR' || k.startsWith('MEMSYS_')) delete env[k];
  }
  return { ...env, ...extra };
}

export const exists = (p) => { try { fs.accessSync(p); return true; } catch (_) { return false; } };
export const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } };
export const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
export const sameFile = (a, b) => exists(a) && exists(b) && sha(a) === sha(b);

// every file under dir (relative, '/'-separated). Bounded to dir; never follows symlinks.
export function listFiles(dir) {
  const out = [];
  if (!isDir(dir)) return out;
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(abs, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
}

export function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

// read a JSON file, tolerating a UTF-8 BOM. -> {exists, data, bom, error}
export function readJson(p) {
  if (!exists(p)) return { exists: false, data: null, bom: false, error: null };
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch (e) { return { exists: true, data: null, bom: false, error: e.message }; }
  const bom = raw.charCodeAt(0) === 0xfeff;
  const text = stripBom(raw);
  if (!text.trim()) return { exists: true, data: {}, bom, error: null };
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { exists: true, data: null, bom, error: 'top level is not a JSON object' };
    return { exists: true, data, bom, error: null };
  } catch (e) { return { exists: true, data: null, bom, error: e.message }; }
}

// write JSON atomically (temp file + rename), never with a BOM, then re-parse to prove it
export function writeJsonAtomic(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  JSON.parse(fs.readFileSync(tmp, 'utf8'));
  fs.renameSync(tmp, p);
}

export function writeText(p, text, { crlf = false, mode } = {}) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let t = String(text).replace(/\r\n/g, '\n');
  if (crlf) t = t.replace(/\n/g, '\r\n');
  fs.writeFileSync(p, t, 'utf8');
  if (mode) { try { fs.chmodSync(p, mode); } catch (_) {} }
}

// run a command, capture output, never throw. -> {ok, status, stdout, stderr}
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 120000, ...opts });
  return { ok: r.status === 0, status: r.status, stdout: r.stdout || '', stderr: (r.stderr || '') + (r.error ? String(r.error.message) : '') };
}

export const has = (cmd) => run(cmd, ['--version'], { timeout: 15000, shell: false }).ok;
