#!/usr/bin/env node
// doctor.mjs - checks an Ace OS Starter install and prints a PASS / FAIL table. Changes nothing except
// rebuilding the memory index (the same thing the Stop hook does) and a dashboard it starts and stops itself.
//
//   node installer/doctor.mjs                  every check, incl. booting the dashboard on a free port
//   node installer/doctor.mjs --no-dashboard   skip the dashboard boot
//   node installer/doctor.mjs --port 7790      first port to try for the dashboard boot (default: any free port)
//   node installer/doctor.mjs --json           machine-readable result
// Exit 0 when nothing FAILs, 1 otherwise.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as C from './lib/core.mjs';
import { cleanEnv, exists, readJson, run, listFiles } from './lib/sys.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const optVal = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const JSON_OUT = flag('--json');

const HOME = os.homedir();
const CLAUDE = path.join(HOME, '.claude');
const WS = path.join(HOME, 'ace');
const MEM = C.memDirFor(HOME);
const rows = [];
const row = (name, status, detail = '') => rows.push({ name, status, detail: String(detail) });
const PASS = (n, d) => row(n, 'PASS', d), FAIL = (n, d) => row(n, 'FAIL', d), WARN = (n, d) => row(n, 'WARN', d);

const WIRING = JSON.parse(fs.readFileSync(path.join(HERE, 'wiring.json'), 'utf8'));
const WIRED = C.wiredFiles(WIRING);
const ITEMS = C.wiringItems(WIRING);

// 1 node
(C.nodeMajor(process.version) >= 18 ? PASS : FAIL)('node version', `${process.version} (need 18+)`);
// 2 config dir
{ const p = C.configDirProblem(process.env.CLAUDE_CONFIG_DIR, HOME, process.platform); (p ? FAIL : PASS)('CLAUDE_CONFIG_DIR', p || 'unset or ~/.claude'); }

// 3 hook files exist and parse
{
  const bad = [];
  for (const f of WIRED) {
    const p = path.join(CLAUDE, 'hooks', f);
    if (!exists(p)) { bad.push(`${f} missing`); continue; }
    const r = run(process.execPath, ['--check', p], { timeout: 30000 });
    if (!r.ok) bad.push(`${f} fails node --check`);
  }
  (bad.length ? FAIL : PASS)('hook files', bad.length ? bad.join('; ') : `${WIRED.length}/${WIRED.length} present, node --check ok`);
  const support = ['lib-workspace.js', 'lib-concurrency.js'].filter((f) => !exists(path.join(CLAUDE, 'hooks', f)));
  (support.length ? FAIL : PASS)('hook support libraries', support.length ? `missing ${support.join(', ')}` : 'present');
}

// 4 settings
let settings = null;
{
  const s = readJson(path.join(CLAUDE, 'settings.json'));
  if (!s.exists) FAIL('settings.json', 'missing');
  else if (s.error) FAIL('settings.json', `not valid JSON: ${s.error}`);
  else {
    settings = s.data;
    if (s.bom) WARN('settings.json', 'parses, but starts with a byte-order mark (re-run the installer to remove it)');
    else PASS('settings.json', 'parses');
    const st = C.wiringStatus(settings, WIRING);
    const miss = st.filter((x) => !x.ok);
    (miss.length ? FAIL : PASS)('hook wiring', miss.length ? `${st.length - miss.length}/${st.length}; missing ${miss.map((m) => `${m.event}:${m.file}`).join(', ')}` : `${st.length}/${st.length} entries`);
    // the node our hook commands call must exist (macOS wires an absolute path, and an nvm upgrade can move it)
    const nodes = new Set();
    for (const arr of Object.values(settings.hooks || {})) {
      for (const e of Array.isArray(arr) ? arr : []) {
        for (const h of (e && Array.isArray(e.hooks)) ? e.hooks : []) {
          if (h && WIRED.some((f) => C.commandRunsHook(h.command, f))) nodes.add(C.nodeOfCommand(h.command));
        }
      }
    }
    const abs = [...nodes].filter((n) => n && n !== 'node');
    const gone = abs.filter((n) => !exists(n));
    if (gone.length) FAIL('node used by hooks', `missing ${gone.join(', ')} (Node moved or was upgraded: re-run the installer)`);
    else if (process.platform === 'darwin' && nodes.has('node')) WARN('node used by hooks', 'bare "node": sessions started from the Dock or Finder may not find it (re-run the installer)');
    else PASS('node used by hooks', abs.length ? abs.join(', ') : 'node (on PATH)');
  }
}

// 5 global docs + skills
{
  const need = ['deterministic-contract.md', 'memory-protocol.md', 'HOOKS.md', 'skills/memory/SKILL.md', 'skills/wrap-up/SKILL.md'];
  const miss = need.filter((f) => !exists(path.join(CLAUDE, f)));
  (miss.length ? FAIL : PASS)('global docs + skills', miss.length ? `missing ${miss.join(', ')}` : `${need.length}/${need.length}`);
  const md = exists(path.join(CLAUDE, 'CLAUDE.md')) ? fs.readFileSync(path.join(CLAUDE, 'CLAUDE.md'), 'utf8') : '';
  const n = C.countBlocks(md);
  (n === 1 ? PASS : FAIL)('global CLAUDE.md block', n === 1 ? 'present once' : `found ${n} Ace OS block(s)`);
}

// 6 workspace
{
  const marker = readJson(path.join(WS, '.ace-os', 'install.json'));
  (marker.data && marker.data.product === C.PRODUCT ? PASS : FAIL)('workspace ~/ace', marker.data ? `installed ${marker.data.version}` : 'missing or no install marker');
  const need = ['CLAUDE.md', '.claude/settings.json', 'Code/memory-system/reindex.mjs', 'Code/memory-system/recall.mjs', 'Code/os-dashboard/server.js'];
  const miss = need.filter((f) => !exists(path.join(WS, f)));
  (miss.length ? FAIL : PASS)('workspace files', miss.length ? `missing ${miss.join(', ')}` : `${need.length}/${need.length}`);
  const L = C.launcherFor(process.platform);
  (exists(path.join(WS, L.name)) ? PASS : FAIL)('Start Ace OS launcher', L.name);
  const u = path.join(HOME, '.claude_github_username');
  (exists(u) && fs.readFileSync(u, 'utf8').trim() ? PASS : WARN)('username cache', exists(u) ? fs.readFileSync(u, 'utf8').trim() : 'missing (~/.claude_github_username)');
}

// 7 brain
const childEnv = cleanEnv();
{
  const hasMem = exists(MEM) && exists(path.join(MEM, 'MEMORY.md'));
  (hasMem ? PASS : FAIL)('memory folder + MEMORY.md', MEM);
  const reindex = path.join(WS, 'Code', 'memory-system', 'reindex.mjs');
  if (exists(reindex)) {
    let r = run(process.execPath, [reindex], { cwd: WS, env: childEnv });
    if (r.status === 75) { await new Promise((res) => setTimeout(res, 3000)); r = run(process.execPath, [reindex], { cwd: WS, env: childEnv }); }
    (r.ok ? PASS : FAIL)('reindex', r.ok ? 'exit 0' : `exit ${r.status}: ${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' | ')}`);
  } else FAIL('reindex', 'reindex.mjs missing');
  // a seed note carries `seed: aceos-starter` in its frontmatter (MEMORY.md is the router, not a note)
  const seedNotes = hasMem ? listFiles(MEM).filter((f) => !f.includes('/') && f.endsWith('.md') && f.toUpperCase() !== 'MEMORY.MD' && /^\s*seed:\s*ace-?os-starter\b/m.test(fs.readFileSync(path.join(MEM, f), 'utf8'))) : [];
  const recall = path.join(WS, 'Code', 'memory-system', 'recall.mjs');
  if (!seedNotes.length) FAIL('recall finds a seed note', 'no seed notes (metadata.seed: aceos-starter) in the memory folder');
  else if (!exists(recall)) FAIL('recall finds a seed note', 'recall.mjs missing');
  else {
    const r = run(process.execPath, [recall, 'wrap-up'], { cwd: WS, env: childEnv });
    // recall prints each hit's file name (<stem>.md) on its own line
    const hit = seedNotes.find((f) => r.stdout.split(/\r?\n/).some((l) => l.trim() === f));
    (r.ok && hit ? PASS : FAIL)('recall finds a seed note', hit ? `recall "wrap-up" -> ${hit}` : `exit ${r.status}; none of ${seedNotes.length} seed notes in the output`);
  }
}

// 8 dashboard
const freePort = (start) => new Promise((resolve) => {
  const tryPort = (p, left) => {
    const s = net.createServer();
    s.once('error', () => (left > 0 ? tryPort(p + 1, left - 1) : resolve(0)));
    s.listen(p, '127.0.0.1', () => { const got = s.address().port; s.close(() => resolve(got)); });
  };
  tryPort(start, start === 0 ? 0 : 40);
});
const get = (port, p, { sse = false, timeout = 60000 } = {}) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: p, timeout }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (d) => {
      body += d;
      if (sse && /"kind"\s*:\s*"hello"/.test(body)) { resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body }); req.destroy(); }
    });
    res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body }));
  });
  req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '', error: 'timeout' }); });
  req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
});
async function dashboard() {
  const dir = path.join(WS, 'Code', 'os-dashboard');
  if (!exists(path.join(dir, 'server.js'))) { FAIL('dashboard boots', 'server.js missing'); return; }
  const port = await freePort(parseInt(optVal('--port') || '0', 10) || 0);
  if (!port) { FAIL('dashboard boots', 'no free port'); return; }
  const child = spawn(process.execPath, [path.join(dir, 'server.js')], { cwd: dir, env: { ...childEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  let exited = false; child.on('exit', () => { exited = true; });
  try {
    let up = null;
    for (let i = 0; i < 80 && !exited; i++) {
      const r = await get(port, '/', { timeout: 3000 });
      if (r.status === 200) { up = r; break; }
      await new Promise((res) => setTimeout(res, 500));
    }
    if (!up) { FAIL('dashboard boots', `no answer on port ${port}${exited ? ' (server exited)' : ''}: ${log.trim().split('\n').slice(-3).join(' | ')}`); return; }
    PASS('dashboard boots', `http://127.0.0.1:${port}/`);
    for (const p of ['/brain/', '/sitemap/']) { const r = await get(port, p); (r.status === 200 ? PASS : FAIL)(`GET ${p}`, `HTTP ${r.status}${r.error ? ' ' + r.error : ''}`); }
    {
      const r = await get(port, '/brain/brain-data.json?fresh=1', { timeout: 120000 });
      let ok = r.status === 200, why = `HTTP ${r.status}`;
      if (ok) { try { JSON.parse(r.body); why += ', JSON ok'; } catch (e) { ok = false; why += `, not JSON: ${e.message}`; } }
      (ok ? PASS : FAIL)('GET /brain/brain-data.json?fresh=1', why);
    }
    {
      const r = await get(port, '/api/neurons', { sse: true, timeout: 10000 });
      const ok = r.status === 200 && /"kind"\s*:\s*"hello"/.test(r.body);
      (ok ? PASS : FAIL)('GET /api/neurons (live stream)', ok ? 'hello received' : `HTTP ${r.status} ${r.error || ''}`);
    }
  } finally {
    if (!exited) { child.kill(); await new Promise((res) => { const t = setTimeout(res, 5000); child.once('exit', () => { clearTimeout(t); res(); }); }); }
  }
}
if (flag('--no-dashboard')) WARN('dashboard boots', 'skipped (--no-dashboard)');
else await dashboard();

// report
const failed = rows.filter((r) => r.status === 'FAIL').length;
if (JSON_OUT) console.log(JSON.stringify({ pass: failed === 0, home: C.fwd(HOME), memDir: MEM, rows }, null, 2));
else {
  const w = Math.max(...rows.map((r) => r.name.length));
  console.log('\nAce OS Starter doctor');
  for (const r of rows) console.log(`  ${r.status.padEnd(4)}  ${r.name.padEnd(w)}  ${r.detail}`);
  console.log(`\ndoctor: ${rows.length - failed}/${rows.length} ok${failed ? `, ${failed} FAIL` : ''} -> ${failed ? 'FAIL' : 'PASS'}`);
}
process.exit(failed ? 1 : 0);
