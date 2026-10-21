#!/usr/bin/env node
// e2e-sandbox.mjs - the Ace OS Starter release test. Installs, checks, updates and uninstalls in throwaway
// HOME folders (never your real home), against the release this file sits in.
//
//   node installer/test/e2e-sandbox.mjs [--sandbox <dir>] [--port 7790] [--keep] [--json]
//     --sandbox  folder for the throwaway homes (default: a new folder in the OS temp dir)
//     --port     first port the doctor tries for its dashboard boot (default 7790)
//     --keep     leave the sandbox on disk afterwards
// Payload parts that are not built yet are replaced by minimal stubs in the sandbox copy of the release;
// the report says which checks ran against real parts and which against stubs. Exit 0 = every check passed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REL = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const optVal = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const KEEP = argv.includes('--keep');
const PORT = optVal('--port') || '7790';
const REAL_HOME = os.homedir();
const C = await import(pathToFileURL(path.join(REL, 'installer', 'lib', 'core.mjs')).href);

const SB = path.resolve(optVal('--sandbox') || fs.mkdtempSync(path.join(os.tmpdir(), 'aoss-e2e-')));
{
  // the sandbox must not BE the real home or CONTAIN it
  const up = path.relative(SB, REAL_HOME);
  if (path.resolve(SB) === path.resolve(REAL_HOME) || (up && !up.startsWith('..') && !path.isAbsolute(up))) { console.error('refusing: the sandbox would contain the real home'); process.exit(2); }
}
fs.mkdirSync(SB, { recursive: true });
console.log(`e2e sandbox: ${C.fwd(SB)}`);

// ------------------------------------------------------------------ results
const results = [];
let currentDeps = [];
const parts = {};
function check(name, ok, detail = '') {
  const against = currentDeps.length ? currentDeps.map((d) => `${d}:${parts[d] || '?'}`).join(',') : 'installer';
  results.push({ name, ok: !!ok, detail: String(detail), against });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${String(detail).slice(0, 300)})` : ''}  [${against}]`);
  return !!ok;
}
const deps = (...d) => { currentDeps = d; };
const tryCheck = (name, fn) => { try { const r = fn(); return check(name, r === undefined ? true : r.ok, r && r.detail); } catch (e) { return check(name, false, e.message); } };

// ------------------------------------------------------------------ assemble the release under test
const R = path.join(SB, 'release');
fs.rmSync(R, { recursive: true, force: true });
const copyTree = (src, dest) => fs.cpSync(src, dest, { recursive: true });
const w = (p, t, mode) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); if (mode) try { fs.chmodSync(p, mode); } catch (_) {} };
copyTree(path.join(REL, 'installer'), path.join(R, 'installer'));
for (const f of ['VERSION', 'install.sh', 'install.command', 'install.cmd']) if (fs.existsSync(path.join(REL, f))) fs.copyFileSync(path.join(REL, f), path.join(R, f));
const WIRING = JSON.parse(fs.readFileSync(path.join(REL, 'installer', 'wiring.json'), 'utf8'));
const WIRED = C.wiredFiles(WIRING);
const P = (...x) => path.join(REL, 'payload', ...x);
const allExist = (...ps) => ps.every((p) => fs.existsSync(p));

parts.installer = 'real';
parts.global = allExist(P('global', 'CLAUDE.md'), P('global', 'hooks', '_test-hooks.mjs'), P('global', 'hooks', 'lib-workspace.js'), ...WIRED.map((f) => P('global', 'hooks', f))) ? 'real' : 'stub';
parts.workspace = allExist(P('workspace', 'CLAUDE.md'), P('workspace', '.claude', 'settings.json'), P('workspace', 'Code', 'memory-system', 'reindex.mjs'), P('workspace', 'Code', 'memory-system', 'recall.mjs'), P('workspace', 'Code', 'memory-system', 'verify-memory-pass.mjs')) ? 'real' : 'stub';
parts.dashboard = allExist(P('workspace', 'Code', 'os-dashboard', 'server.js'), P('workspace', 'Code', 'os-dashboard', 'brain', 'index.html')) ? 'real' : 'stub';
parts.seed = allExist(P('memory-seed', 'MEMORY.md'), P('workspace', 'Code', 'memory-system', 'sitemap')) ? 'real' : 'stub';
console.log(`parts: ${Object.entries(parts).map(([k, v]) => `${k}=${v}`).join(' ')}`);

const RP = (...x) => path.join(R, 'payload', ...x);
// stubs: the smallest thing that lets the installer, doctor and uninstaller run end to end
const STUB_SLUG = `const os=require('os');const fwd=(p)=>String(p).split(String.fromCharCode(92)).join('/');const home=fwd(os.homedir());const MEM=process.env.MEMSYS_MEM_DIR||(home+'/.claude/projects/'+(home+'/ace').replace(/[^A-Za-z0-9]/g,'-')+'/memory');`;
if (parts.global === 'real') copyTree(P('global'), RP('global'));
else {
  for (const f of WIRED) w(RP('global', 'hooks', f), "// stub hook (e2e)\nprocess.stdin.resume();process.stdin.on('end',()=>process.exit(0));\n");
  for (const f of ['lib-workspace.js', 'lib-concurrency.js']) w(RP('global', 'hooks', f), 'module.exports = {};\n');
  w(RP('global', 'hooks', '_test-hooks.mjs'), "console.log('PASS  stub\\n\\nALL PASS (1/1)');\n");
  w(RP('global', 'CLAUDE.md'), '# Ace OS global rules (stub)\n');
  for (const f of ['deterministic-contract.md', 'memory-protocol.md', 'HOOKS.md']) w(RP('global', f), `# ${f} (stub)\n`);
  for (const s of ['memory', 'wrap-up']) w(RP('global', 'skills', s, 'SKILL.md'), `---\nname: ${s}\n---\nstub\n`);
}
if (parts.workspace === 'real') {
  copyTree(P('workspace'), RP('workspace'));
  if (parts.dashboard !== 'real') fs.rmSync(RP('workspace', 'Code', 'os-dashboard'), { recursive: true, force: true });
} else {
  w(RP('workspace', 'CLAUDE.md'), '# Ace workspace (stub)\n');
  w(RP('workspace', 'README.md'), '# Ace (stub)\n');
  w(RP('workspace', '.claude', 'settings.json'), '{}\n');
  w(RP('workspace', '.claude', 'agents', 'start-here.md'), '---\nname: start-here\n---\nstub\n');
  w(RP('workspace', '.claude', 'rules', '01-session-logging.md'), 'stub\n');
  w(RP('workspace', '.claude', 'hooks', 'session-init.js'), '// stub\n');
  for (const s of ['memory', 'wrap-up']) w(RP('workspace', '.claude', 'skills', s, 'SKILL.md'), `---\nname: ${s}\n---\nstub\n`);
  const ms = (...x) => RP('workspace', 'Code', 'memory-system', ...x);
  const head = `import { createRequire } from 'node:module';const require=createRequire(import.meta.url);const fs=require('fs');`;
  w(ms('reindex.mjs'), `${head}${STUB_SLUG}if(!fs.existsSync(MEM)){console.error('no mem dir '+MEM);process.exit(2);}fs.writeFileSync(MEM+'/_manifest.json',JSON.stringify(fs.readdirSync(MEM).filter(f=>f.endsWith('.md'))));console.log('stub reindex ok');\n`);
  w(ms('recall.mjs'), `${head}${STUB_SLUG}const q=process.argv.slice(2).join(' ').toLowerCase();const hits=fs.readdirSync(MEM).filter(f=>f.endsWith('.md')&&f!=='MEMORY.md'&&fs.readFileSync(MEM+'/'+f,'utf8').toLowerCase().includes(q));console.log('recall "'+q+'" -> '+hits.length+' hit(s):');for(const h of hits)console.log('   '+h);\n`);
  w(ms('verify-memory-pass.mjs'), `${head}const a=process.argv.slice(2);const v=(k)=>a[a.indexOf(k)+1];const sid=v('--sid'),dir=v('--mem-dir'),since=Number(v('--since'));const ok=fs.readdirSync(dir).some(f=>f.endsWith('.md')&&fs.statSync(dir+'/'+f).mtimeMs>=since&&fs.readFileSync(dir+'/'+f,'utf8').includes('originSessionId: '+sid));process.exit(ok?0:1);\n`);
}
if (parts.dashboard === 'real') { if (parts.workspace !== 'real') copyTree(P('workspace', 'Code', 'os-dashboard'), RP('workspace', 'Code', 'os-dashboard')); }
else {
  const d = (...x) => RP('workspace', 'Code', 'os-dashboard', ...x);
  w(d('server.js'), `const http=require('http');const port=+process.env.PORT||7790;http.createServer((q,s)=>{const u=q.url.split('?')[0];if(u==='/api/neurons'){s.writeHead(200,{'Content-Type':'text/event-stream'});s.write('data: '+JSON.stringify({kind:'hello',ts:Date.now()})+'\\n\\n');return;}if(u==='/brain/brain-data.json'){s.writeHead(200,{'Content-Type':'application/json'});return s.end('{}');}if(['/','/brain/','/sitemap/'].includes(u)){s.writeHead(200,{'Content-Type':'text/html'});return s.end('<!doctype html><title>Ace OS stub</title>');}s.writeHead(404);s.end();}).listen(port,'127.0.0.1');\n`);
  w(d('brain', 'index.html'), '<!doctype html><title>stub</title>\n');
  w(d('start.cmd'), '@echo off\r\nnode "%~dp0server.js"\r\n');
  w(d('start.sh'), '#!/bin/bash\nexec node "$(dirname "$0")/server.js"\n', 0o755);
}
if (parts.seed === 'real') {
  copyTree(P('memory-seed'), RP('memory-seed'));
  if (parts.workspace !== 'real') copyTree(P('workspace', 'Code', 'memory-system', 'sitemap'), RP('workspace', 'Code', 'memory-system', 'sitemap'));
} else {
  w(RP('memory-seed', 'MEMORY.md'), '# Memory index (stub seed)\n- [[seed_wrap_up_saves_lessons]]\n');
  w(RP('memory-seed', 'seed_wrap_up_saves_lessons.md'), '---\nname: seed_wrap_up_saves_lessons\ndescription: How wrap-up saves a session\'s lessons to the brain (stub seed note)\nmetadata:\n  type: reference\n  seed: aceos-starter\n---\n\nEnd each session with /wrap-up; it records atomic notes and reindexes the brain.\n');
  if (!fs.existsSync(RP('workspace', 'Code', 'memory-system', 'sitemap'))) w(RP('workspace', 'Code', 'memory-system', 'sitemap', 'tree.json'), '{"sections":[]}\n');
}

// ------------------------------------------------------------------ sandbox runner
function envFor(home, extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (['CLAUDE_PROJECT_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_MEM_DIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'GH_TOKEN', 'GITHUB_TOKEN'].includes(k) || k.startsWith('MEMSYS_')) delete env[k];
  }
  return {
    ...env, HOME: home, USERPROFILE: home,
    GH_CONFIG_DIR: path.join(home, '.gh-config'), XDG_CONFIG_HOME: path.join(home, '.config'),
    APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    GIT_CONFIG_NOSYSTEM: '1', ACE_OS_NO_PAUSE: '1', ...extra,
  };
}
const same = (a, b) => (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
function node(home, args, { cwd = R, extra = {}, timeout = 600000 } = {}) {
  const r = spawnSync(process.execPath, args, { cwd, env: envFor(home, extra), encoding: 'utf8', timeout, windowsHide: true });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') + (r.error ? String(r.error.message) : '') };
}
function newHome(name) {
  const h = path.join(SB, name);
  fs.rmSync(h, { recursive: true, force: true });
  fs.mkdirSync(h, { recursive: true });
  const r = node(h, ['-e', "process.stdout.write(require('os').homedir())"]);
  if (!same(r.out, h) || same(r.out, REAL_HOME)) { console.error(`SAFETY: child homedir is ${r.out}, expected the sandbox ${h} - aborting`); process.exit(2); }
  return h;
}
const INSTALL = path.join(R, 'installer', 'install.mjs');
const UNINSTALL = path.join(R, 'installer', 'uninstall.mjs');
const DOCTOR = path.join(R, 'installer', 'doctor.mjs');
const readJ = (p) => JSON.parse(C.stripBom(fs.readFileSync(p, 'utf8')));
const tail = (s, n = 6) => s.trim().split('\n').slice(-n).join(' | ');
const countWiring = (settings, event, file) => ((settings.hooks || {})[event] || []).reduce((n, e) => n + (e.hooks || []).filter((h) => C.commandRunsHook(h.command, file)).length, 0);

// ================================================================== H1: full flow (space AND dot in the path)
const H1 = newHome('Home Dir.v1');
deps();
check('sandbox: child os.homedir() is the sandbox, not the real home', true, C.fwd(H1).replace(C.fwd(SB), '<sandbox>'));
const CL = path.join(H1, '.claude');
const WS = path.join(H1, 'ace');
const MEM = C.memDirFor(H1);
const FOREIGN = {
  model: 'opus',
  permissions: { allow: ['Bash(ls:*)'], deny: [] },
  env: { MY_VAR: '1' },
  statusLine: { type: 'command', command: 'echo hi' },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "/opt/foreign/guard.js"' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'echo foreign-stop' }] }],
  },
};
const FOREIGN_MD = '# My own rules\n- keep answers short\n';
const FOREIGN_CONTRACT = '# my own contract (pre-existing)\n';
w(path.join(CL, 'settings.json'), '\uFEFF' + JSON.stringify(FOREIGN, null, 2));   // with a BOM on purpose
w(path.join(CL, 'CLAUDE.md'), FOREIGN_MD);
w(path.join(CL, 'deterministic-contract.md'), FOREIGN_CONTRACT);
const settingsBytes0 = fs.readFileSync(path.join(CL, 'settings.json'));

// dry run
{
  const r = node(H1, [INSTALL, '--dry-run']);
  check('dry-run exits 0 and says nothing changed', r.status === 0 && /DRY RUN complete/.test(r.out), `exit ${r.status}: ${tail(r.out, 2)}`);
  check('dry-run wrote nothing', !fs.existsSync(WS) && !fs.existsSync(path.join(CL, '.aceos-starter.json')) && !fs.existsSync(path.join(CL, 'backups')) && Buffer.compare(settingsBytes0, fs.readFileSync(path.join(CL, 'settings.json'))) === 0 && fs.readFileSync(path.join(CL, 'CLAUDE.md'), 'utf8') === FOREIGN_MD && !fs.existsSync(path.join(H1, '.claude_github_username')));
}
// install #1
deps('global', 'workspace', 'dashboard', 'seed');
const r1 = node(H1, [INSTALL, '--port', PORT]);
check('install #1 exits 0 (INSTALL OK, doctor PASS inside)', r1.status === 0 && /INSTALL OK/.test(r1.out), `exit ${r1.status}: ${tail(r1.out, 12)}`);
deps();
let S1 = {};
tryCheck('settings.json: BOM removed, valid JSON', () => { const raw = fs.readFileSync(path.join(CL, 'settings.json'), 'utf8'); S1 = JSON.parse(raw); return { ok: raw.charCodeAt(0) !== 0xfeff }; });
tryCheck('settings.json: foreign keys intact', () => { for (const k of ['model', 'permissions', 'env', 'statusLine']) assert.deepStrictEqual(S1[k], FOREIGN[k]); });
tryCheck('settings.json: foreign hook entries intact and first, in order', () => { for (const [ev, arr] of Object.entries(FOREIGN.hooks)) assert.deepStrictEqual(S1.hooks[ev].slice(0, arr.length), arr); });
tryCheck('settings.json: all 29 wirings present', () => { const st = C.wiringStatus(S1, WIRING); const n = st.filter((x) => x.ok).length; return { ok: n === 29 && st.length === 29, detail: `${n}/${st.length}` }; });
tryCheck('settings.json: command format node "<HOME>/.claude/hooks/<file>"', () => {
  const e = S1.hooks.SessionStart.find((x) => x.hooks.some((h) => C.commandRunsHook(h.command, 'inject-deterministic-contract.js')));
  const cmd = e.hooks[0].command;
  const want = C.hookCommand(H1, 'inject-deterministic-contract.js', 'node');
  return { ok: cmd === want || (process.platform !== 'win32' && cmd.endsWith(`"${C.fwd(H1)}/.claude/hooks/inject-deterministic-contract.js"`)), detail: cmd.replace(C.fwd(SB), '<sandbox>') };
});
tryCheck('settings.json: matchers carried over', () => { const e = S1.hooks.PreToolUse.find((x) => x.hooks.some((h) => C.commandRunsHook(h.command, 'block-nonportable-path.js'))); return { ok: e.matcher === 'Write|Edit|MultiEdit', detail: e.matcher }; });
tryCheck('~/.claude/CLAUDE.md: your text kept + one Ace OS block', () => { const t = fs.readFileSync(path.join(CL, 'CLAUDE.md'), 'utf8'); return { ok: t.startsWith(FOREIGN_MD.trim()) && C.countBlocks(t) === 1 }; });
tryCheck('replaced file backed up (pre-existing deterministic-contract.md)', () => {
  const b = fs.readdirSync(path.join(CL, 'backups')).filter((d) => d.startsWith('aceos-starter-')).map((d) => path.join(CL, 'backups', d, 'deterministic-contract.md')).find((p) => fs.existsSync(p));
  return { ok: !!b && fs.readFileSync(b, 'utf8') === FOREIGN_CONTRACT };
});
tryCheck('workspace marker, launcher and username written', () => {
  const L = C.launcherFor(process.platform);
  const u = path.join(H1, '.claude_github_username');
  const ok = fs.existsSync(path.join(WS, '.ace-os', 'install.json')) && fs.existsSync(path.join(WS, L.name)) && fs.existsSync(u);
  return { ok, detail: `launcher=${L.name}, username=${fs.existsSync(u) ? fs.readFileSync(u, 'utf8').trim() : '-'}` };
});
tryCheck('brain folder at the D3 slug path with MEMORY.md', () => ({ ok: fs.existsSync(path.join(MEM, 'MEMORY.md')), detail: MEM.replace(C.fwd(SB), '<sandbox>') }));

// doctor (json)
deps('global', 'workspace', 'dashboard', 'seed');
let D = null;
{
  const r = node(H1, [DOCTOR, '--json', '--port', PORT]);
  try { D = JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch (_) {}
  check('doctor --json PASS', r.status === 0 && D && D.pass, D ? D.rows.filter((x) => x.status !== 'PASS').map((x) => `${x.status} ${x.name}: ${x.detail}`).join('; ') || `${D.rows.length} rows all PASS` : tail(r.out));
}
deps('dashboard', 'workspace', 'seed');
for (const n of ['dashboard boots', 'GET /brain/', 'GET /sitemap/', 'GET /brain/brain-data.json?fresh=1', 'GET /api/neurons (live stream)']) {
  const row = D && D.rows.find((x) => x.name === n);
  check(`dashboard HTTP: ${n}`, row && row.status === 'PASS', row ? row.detail.replace(/127\.0\.0\.1:\d+/, '127.0.0.1:<port>') : 'row missing');
}

// re-install: no duplicates
deps('global', 'workspace', 'seed');
{
  const r = node(H1, [INSTALL, '--no-dashboard-check']);
  check('re-install exits 0', r.status === 0, `exit ${r.status}: ${tail(r.out, 4)}`);
  tryCheck('re-install: settings.json unchanged, no duplicate wirings', () => {
    const S2 = readJ(path.join(CL, 'settings.json'));
    assert.deepStrictEqual(S2, S1);
    const dup = C.wiringItems(WIRING).filter((it) => countWiring(S2, it.event, it.file) !== 1);
    return { ok: !dup.length, detail: dup.length ? dup.map((d) => `${d.event}:${d.file}`).join(',') : '29 x exactly 1' };
  });
  tryCheck('re-install: still one CLAUDE.md block', () => ({ ok: C.countBlocks(fs.readFileSync(path.join(CL, 'CLAUDE.md'), 'utf8')) === 1 }));
}

// update keeps user content
{
  fs.appendFileSync(path.join(WS, 'CLAUDE.md'), '\nUSER EDIT e2e\n');
  w(path.join(WS, 'Projects', 'mine.md'), 'my project\n');
  const tool = path.join(WS, 'Code', 'memory-system', 'recall.mjs');
  fs.appendFileSync(tool, '\n// user tweak e2e\n');
  fs.appendFileSync(path.join(MEM, 'MEMORY.md'), '\n- my own pin e2e\n');
  const r = node(H1, [INSTALL, '--no-dashboard-check']);
  check('update run exits 0', r.status === 0, `exit ${r.status}: ${tail(r.out, 4)}`);
  check('update keeps the user-edited ~/ace/CLAUDE.md', fs.readFileSync(path.join(WS, 'CLAUDE.md'), 'utf8').includes('USER EDIT e2e'));
  check('update keeps the user\'s own files', fs.existsSync(path.join(WS, 'Projects', 'mine.md')));
  check('update keeps the user\'s MEMORY.md', fs.readFileSync(path.join(MEM, 'MEMORY.md'), 'utf8').includes('my own pin e2e'));
  check('update refreshes an edited tool file', fs.readFileSync(tool, 'utf8') === fs.readFileSync(RP('workspace', 'Code', 'memory-system', 'recall.mjs'), 'utf8'));
  tryCheck('update backs up the edited tool file first', () => {
    const bdir = path.join(WS, '.ace-os', 'backups');
    const hit = fs.readdirSync(bdir).map((d) => path.join(bdir, d, 'Code', 'memory-system', 'recall.mjs')).find((p) => fs.existsSync(p));
    return { ok: !!hit && fs.readFileSync(hit, 'utf8').includes('user tweak e2e') };
  });
}

// hook suite
deps('global');
{
  const r = node(H1, [path.join(CL, 'hooks', '_test-hooks.mjs')], { cwd: WS });
  const m = r.out.match(/\((\d+)\/(\d+)\)\s*$/m);
  check('hook suite (_test-hooks.mjs) in the sandbox home', r.status === 0 && /ALL PASS/.test(r.out), m ? `${m[1]}/${m[2]}` : `exit ${r.status}: ${tail(r.out, 4)}`);
  if (r.status !== 0) console.log(r.out.split('\n').filter((l) => l.startsWith('FAIL')).slice(0, 20).join('\n'));
}

// memory tools
deps('workspace', 'seed');
{
  const ms = (f) => path.join(WS, 'Code', 'memory-system', f);
  let r = node(H1, [ms('reindex.mjs')], { cwd: WS });
  check('reindex.mjs exit 0', r.status === 0, `exit ${r.status}: ${tail(r.out, 3)}`);
  r = node(H1, [ms('recall.mjs'), 'wrap-up'], { cwd: WS });
  const seedNotes = fs.readdirSync(RP('memory-seed')).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
  const hit = seedNotes.find((f) => r.out.includes(f.replace(/\.md$/, '')));
  check('recall "wrap-up" returns a seed note', r.status === 0 && !!hit, hit || tail(r.out, 4));
  const since = Date.now() - 1000;
  w(path.join(MEM, 'e2e_probe_note.md'), '---\nname: e2e_probe_note\ndescription: e2e probe note for verify-memory-pass\nmetadata:\n  type: reference\n  originSessionId: e2e-sid-probe\n---\n\nA probe note written by the release test.\n');
  r = node(H1, [ms('verify-memory-pass.mjs'), '--sid', 'e2e-sid-probe', '--mem-dir', MEM, '--since', String(since)], { cwd: WS });
  check('verify-memory-pass: a session note -> PASS (exit 0)', r.status === 0, `exit ${r.status}: ${tail(r.out, 2)}`);
  r = node(H1, [ms('verify-memory-pass.mjs'), '--sid', 'e2e-sid-nothing', '--mem-dir', MEM, '--since', String(since)], { cwd: WS });
  check('verify-memory-pass: no note -> NO (exit 1)', r.status === 1, `exit ${r.status}`);
  fs.rmSync(path.join(MEM, 'e2e_probe_note.md'), { force: true });
  node(H1, [ms('reindex.mjs')], { cwd: WS });
}

// uninstall keeps foreign entries, restores originals, keeps workspace + brain
deps('global');
{
  const r = node(H1, [UNINSTALL]);
  check('uninstall exits 0', r.status === 0, `exit ${r.status}: ${tail(r.out, 3)}`);
  tryCheck('uninstall: settings.json back to exactly the foreign settings', () => { assert.deepStrictEqual(readJ(path.join(CL, 'settings.json')), FOREIGN); });
  check('uninstall: original deterministic-contract.md restored', fs.readFileSync(path.join(CL, 'deterministic-contract.md'), 'utf8') === FOREIGN_CONTRACT);
  check('uninstall: our hook files removed', WIRED.every((f) => !fs.existsSync(path.join(CL, 'hooks', f))) && !fs.existsSync(path.join(CL, 'hooks', '_testfix')));
  check('uninstall: ~/.claude/CLAUDE.md back to your text', fs.readFileSync(path.join(CL, 'CLAUDE.md'), 'utf8') === FOREIGN_MD);
  check('uninstall: workspace and brain kept', fs.existsSync(path.join(WS, 'Projects', 'mine.md')) && fs.existsSync(path.join(MEM, 'MEMORY.md')));
  const r2 = node(H1, [UNINSTALL, '--purge-workspace', '--purge-brain']);
  check('uninstall --purge-workspace --purge-brain removes both', r2.status === 0 && !fs.existsSync(WS) && !fs.existsSync(MEM), `exit ${r2.status}`);
  tryCheck('purge leaves the foreign settings alone', () => { assert.deepStrictEqual(readJ(path.join(CL, 'settings.json')), FOREIGN); });
}

// ================================================================== refusals (nothing may change)
deps();
{
  const H2 = newHome('home two');
  w(path.join(H2, 'ace', 'notes.txt'), 'someone else\'s folder\n');
  const r = node(H2, [INSTALL]);
  check('existing ~/ace without our marker -> STOPPED, nothing written', r.status === 2 && /was not created by this installer/.test(r.out) && !fs.existsSync(path.join(H2, '.claude')) && fs.readdirSync(path.join(H2, 'ace')).length === 1, `exit ${r.status}`);
  const H3 = newHome('home three');
  w(path.join(H3, '.claude', 'settings.json'), '{ "model": "opus", ');
  const b = fs.readFileSync(path.join(H3, '.claude', 'settings.json'));
  const r3 = node(H3, [INSTALL]);
  check('invalid settings.json -> STOPPED, file untouched, no workspace', r3.status === 2 && /not valid JSON/.test(r3.out) && Buffer.compare(b, fs.readFileSync(path.join(H3, '.claude', 'settings.json'))) === 0 && !fs.existsSync(path.join(H3, 'ace')), `exit ${r3.status}`);
  fs.rmSync(path.join(H3, '.claude', 'settings.json'));
  const r4 = node(H3, [INSTALL], { extra: { CLAUDE_CONFIG_DIR: path.join(H3, 'elsewhere') } });
  check('CLAUDE_CONFIG_DIR pointing elsewhere -> STOPPED, nothing written', r4.status === 2 && /CLAUDE_CONFIG_DIR/.test(r4.out) && !fs.existsSync(path.join(H3, 'ace')), `exit ${r4.status}`);
}
// plain home (no space, no dot), fresh, no pre-existing settings
deps('global', 'workspace', 'seed');
{
  const H4 = newHome('plainhome');
  const r = node(H4, [INSTALL, '--no-dashboard-check']);
  check('plain home: fresh install with no prior ~/.claude exits 0', r.status === 0 && /INSTALL OK/.test(r.out), `exit ${r.status}: ${tail(r.out, 6)}`);
  tryCheck('plain home: settings.json created with exactly the 29 wirings', () => { const s = readJ(path.join(H4, '.claude', 'settings.json')); const n = C.wiringStatus(s, WIRING).filter((x) => x.ok).length; const total = Object.values(s.hooks).flat().length; return { ok: n === 29 && total === 29, detail: `${n} wired, ${total} entries` }; });
  const ru = node(H4, [UNINSTALL]);
  tryCheck('plain home: uninstall leaves no hook entries and no CLAUDE.md', () => { const s = readJ(path.join(H4, '.claude', 'settings.json')); return { ok: ru.status === 0 && !s.hooks && !fs.existsSync(path.join(H4, '.claude', 'CLAUDE.md')) }; });
}

// ================================================================== pure functions with POSIX + Windows inputs
// sample homes and slugs, built at runtime (fixtures, not real machine paths)
deps();
const MH = '/' + ['Users', 'jane.doe'].join('/');
const WH = ['C:', 'Users', 'jane doe'].join('\\');
const WSLUG = ['C', '', 'Users', 'jane', 'doe', 'ace'].join('-');
tryCheck('unit: projectSlug (POSIX home with a dot)', () => { assert.strictEqual(C.projectSlug(MH + '/ace'), '-Users-jane-doe-ace'); });
tryCheck('unit: projectSlug (Windows home with a space)', () => { assert.strictEqual(C.projectSlug(WH + '\\ace'), WSLUG); });
tryCheck('unit: projectSlug (underscore and version dots)', () => { assert.strictEqual(C.projectSlug('/home/jane_x/v2.1.0/ace/'), '-home-jane-x-v2-1-0-ace'); });
tryCheck('unit: memDirFor POSIX', () => { assert.strictEqual(C.memDirFor(MH), MH + '/.claude/projects/-Users-jane-doe-ace/memory'); });
tryCheck('unit: hookCommand POSIX, node on PATH', () => { assert.strictEqual(C.hookCommand(MH, 'x.js'), `node "${MH}/.claude/hooks/x.js"`); });
tryCheck('unit: hookCommand POSIX, absolute node', () => { assert.strictEqual(C.hookCommand(MH, 'x.js', '/opt/homebrew/bin/node'), `"/opt/homebrew/bin/node" "${MH}/.claude/hooks/x.js"`); });
tryCheck('unit: hookCommand Windows backslashes', () => { assert.strictEqual(C.hookCommand(WH, 'x.js'), `node "${C.fwd(WH)}/.claude/hooks/x.js"`); });
tryCheck('unit: commandRunsHook matches both separators, not prefixes', () => {
  assert.ok(C.commandRunsHook(`node "${MH}/.claude/hooks/x.js"`, 'x.js'));
  assert.ok(C.commandRunsHook(`node ${WH}\\.claude\\hooks\\x.js`, 'x.js'));
  assert.ok(!C.commandRunsHook(`node "${MH}/.claude/hooks/x.js.bak"`, 'x.js'));
  assert.ok(!C.commandRunsHook('node "/opt/other/x.js"', 'x.js'));
});
tryCheck('unit: launcherFor darwin', () => { const L = C.launcherFor('darwin'); assert.strictEqual(L.name, 'Start Ace OS.command'); assert.strictEqual(L.mode, 0o755); assert.ok(L.text.startsWith('#!/bin/bash') && L.text.includes('Code/os-dashboard/start.sh')); });
tryCheck('unit: launcherFor linux', () => { assert.strictEqual(C.launcherFor('linux').name, 'Start Ace OS.command'); });
tryCheck('unit: launcherFor win32', () => { const L = C.launcherFor('win32'); assert.strictEqual(L.name, 'Start Ace OS.cmd'); assert.ok(L.crlf && L.text.includes('Code\\os-dashboard\\start.cmd')); });
tryCheck('unit: configDirProblem', () => {
  assert.strictEqual(C.configDirProblem('', MH, 'darwin'), null);
  assert.strictEqual(C.configDirProblem(MH + '/.claude/', MH, 'darwin'), null);
  assert.ok(C.configDirProblem(MH + '/.other', MH, 'darwin'));
  assert.strictEqual(C.configDirProblem(WH.toLowerCase() + '\\.claude', WH, 'win32'), null);
});
tryCheck('unit: homeProblem', () => { assert.ok(C.homeProblem('/')); assert.ok(C.homeProblem('C:\\')); assert.ok(C.homeProblem('relative/x')); assert.strictEqual(C.homeProblem(MH), null); assert.strictEqual(C.homeProblem(WH), null); });
tryCheck('unit: insertBlock / removeBlock round trip', () => {
  const a = C.insertBlock('mine\n', 'ours'); assert.strictEqual(C.countBlocks(a), 1);
  const b = C.insertBlock(a, 'ours v2'); assert.strictEqual(C.countBlocks(b), 1); assert.ok(b.includes('ours v2') && !b.includes('ours\n'));
  assert.strictEqual(C.removeBlock(b), 'mine\n');
  assert.strictEqual(C.removeBlock(C.insertBlock('', 'x')), '');
});
tryCheck('unit: mergeWiring / unwire are idempotent and preserve foreign entries', () => {
  const base = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo x' }] }] }, other: 1 };
  const m1 = C.mergeWiring(base, WIRING, (f) => C.hookCommand(MH, f));
  const m2 = C.mergeWiring(m1.settings, WIRING, (f) => C.hookCommand(MH, f));
  assert.strictEqual(m1.added.length, 29); assert.strictEqual(m2.added.length, 0); assert.deepStrictEqual(m2.settings, m1.settings);
  assert.deepStrictEqual(C.unwire(m1.settings, m1.added).settings, base);
});
tryCheck('unit: sanitizeUsername', () => { assert.strictEqual(C.sanitizeUsername(' Jane Doe.x \n'), 'Jane-Doe-x'); assert.strictEqual(C.sanitizeUsername('***'), ''); });

// bash -n on the shell scripts (and the launcher text)
{
  const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  if (bash.status !== 0) check('bash -n (shell scripts)', true, 'SKIPPED: bash not available on this machine');
  else {
    const L = path.join(SB, 'launcher-check.command');
    fs.writeFileSync(L, C.launcherFor('darwin').text);
    for (const f of [path.join(REL, 'install.sh'), path.join(REL, 'install.command'), L]) {
      if (!fs.existsSync(f)) { check(`bash -n ${path.basename(f)}`, false, 'missing'); continue; }
      const r = spawnSync('bash', ['-n', f], { encoding: 'utf8' });
      check(`bash -n ${path.basename(f)}`, r.status === 0, (r.stderr || '').trim());
    }
  }
  for (const f of ['install.sh', 'install.command']) {
    const t = fs.existsSync(path.join(REL, f)) ? fs.readFileSync(path.join(REL, f), 'utf8') : '';
    check(`${f}: LF line endings + shebang`, t.startsWith('#!') && !t.includes('\r'));
  }
  const cmd = fs.existsSync(path.join(REL, 'install.cmd')) ? fs.readFileSync(path.join(REL, 'install.cmd'), 'utf8') : '';
  check('install.cmd: CRLF line endings', cmd.includes('\r\n') && !/[^\r]\n/.test(cmd));
}

// ------------------------------------------------------------------ report
const failed = results.filter((x) => !x.ok);
const byAgainst = {};
for (const x of results) byAgainst[x.against] = (byAgainst[x.against] || 0) + 1;
console.log(`\nparts under test: ${Object.entries(parts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
console.log(`checks by what they ran against: ${JSON.stringify(byAgainst)}`);
console.log(`e2e: ${results.length - failed.length}/${results.length} passed${failed.length ? ` - FAILED: ${failed.map((f) => f.name).join('; ')}` : ''}`);
if (argv.includes('--json')) console.log(JSON.stringify({ parts, results }, null, 2));
if (!KEEP && !optVal('--sandbox')) fs.rmSync(SB, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
