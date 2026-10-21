#!/usr/bin/env node
// corrections.mjs - your correction inbox. The sitemap page's "This is wrong" box appends one JSON line
// per correction to <memory dir>/_corrections.jsonl: { ts, id, text, status: "open" }.
//
//   node corrections.mjs --list            the open corrections, numbered by their line in the file
//   node corrections.mjs --list --all      every correction, open and done
//   node corrections.mjs --done <n> "<what was changed>"
//                                          marks line <n> done (status "done", doneAt, change); never deletes
//   --json                                 with --list: print the entries as JSON
//
// Memory dir: MEMSYS_MEM_DIR / CLAUDE_MEM_DIR, else the one lib/notes.mjs resolves for this repo.
// Writes only the corrections file, atomically (temp file + rename), and only on --done.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE_NAME = '_corrections.jsonl';
const args = process.argv.slice(2);
const has = (k) => args.includes(k);

async function memDir() {
  const o = process.env.MEMSYS_MEM_DIR || process.env.CLAUDE_MEM_DIR;
  if (o) return o.replace(/\\/g, '/');
  // installed: ./lib/notes.mjs; staged copy (one folder deeper): the installed lib two levels up
  for (const p of [path.join(HERE, 'lib', 'notes.mjs'), path.resolve(HERE, '..', '..', 'lib', 'notes.mjs')]) {
    if (fs.existsSync(p)) { const lib = await import(pathToFileURL(p).href); return lib.resolveMemDir(HERE); }
  }
  throw new Error('cannot find the memory dir: set MEMSYS_MEM_DIR');
}

function readLines(file) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { raw: '', lines: [] }; throw e; }
  return { raw, lines: raw.split('\n') };
}
function entries(lines) {
  const out = [];
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    let o = null; try { o = JSON.parse(l); } catch (_) { /* a broken line is shown, never dropped */ }
    out.push({ n: i + 1, ok: !!(o && typeof o === 'object'), e: o || { text: l, status: 'unreadable' } });
  });
  return out;
}
const oneLine = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 3) + '...' : t; };

async function main() {
  const dir = await memDir();
  const file = path.join(dir, FILE_NAME);
  if (has('--done')) {
    const i = args.indexOf('--done');
    const n = Number(args[i + 1]);
    const what = args.slice(i + 2).filter((a) => !a.startsWith('--')).join(' ').trim();
    if (!Number.isInteger(n) || n < 1) { console.error('usage: --done <line number> "<what was changed>"'); process.exit(2); }
    if (!what) { console.error('say what was changed: --done ' + n + ' "<what was changed>"'); process.exit(2); }
    const { raw, lines } = readLines(file);
    const line = lines[n - 1];
    if (line == null || !line.trim()) { console.error(`no correction on line ${n} of ${file}`); process.exit(1); }
    let o; try { o = JSON.parse(line); } catch (_) { console.error(`line ${n} is not readable JSON; fix it by hand`); process.exit(1); }
    if (o.status === 'done') { console.log(`line ${n} is already done (${o.doneAt}): ${oneLine(o.change, 120)}`); return; }
    o.status = 'done'; o.doneAt = new Date().toISOString(); o.change = what.slice(0, 2000);
    lines[n - 1] = JSON.stringify(o);
    const next = lines.join('\n');
    // re-read right before the rename: if the page appended meanwhile, keep its lines
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, next, 'utf8');
    const now = fs.readFileSync(file, 'utf8');
    if (now !== raw) { fs.rmSync(tmp, { force: true }); console.error('the corrections file changed while marking; run the command again'); process.exit(1); }
    fs.renameSync(tmp, file);
    console.log(`marked line ${n} done: ${oneLine(o.id, 80)} -> ${oneLine(what, 120)}`);
    return;
  }
  // --list (the default)
  const all = has('--all');
  const list = entries(readLines(file).lines).filter((x) => all || x.e.status === 'open' || !x.ok);
  if (has('--json')) { console.log(JSON.stringify(list.map((x) => Object.assign({ line: x.n }, x.e)), null, 1)); return; }
  if (!list.length) { console.log(all ? `no corrections in ${file}` : 'no open corrections'); return; }
  const open = list.filter((x) => x.e.status === 'open').length;
  console.log(`${open} open correction${open === 1 ? '' : 's'}${all ? ` (${list.length} in all)` : ''} in ${file}`);
  for (const x of list) {
    console.log(`#${x.n} [${x.e.status}] ${String(x.e.ts || '').slice(0, 16).replace('T', ' ')} ${x.e.id || '(no note)'}`);
    console.log(`    ${oneLine(x.e.text, 300)}`);
    if (x.e.status === 'done') console.log(`    done ${String(x.e.doneAt || '').slice(0, 10)}: ${oneLine(x.e.change, 200)}`);
  }
  console.log('Close one: node Code/memory-system/corrections.mjs --done <#> "<what was changed>"');
}
main().catch((e) => { console.error('corrections: ' + (e && e.message || e)); process.exit(1); });
