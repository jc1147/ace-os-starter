#!/usr/bin/env node
// start.mjs - starts Ace OS (Mission Control) and opens it in your browser. Windows, macOS and Linux.
//
//   node start.mjs [--port 7777] [--chat] [--no-open]
//
//   --port N    the first port to try (default 7777, or the PORT env var)
//   --chat      turn on the optional chat surface (creates .chat-enabled next to server.js). Chat runs
//               `claude -p` behind a secret token on localhost only; delete .chat-enabled to turn it off.
//   --no-open   do not open the browser
//
// It never stops a process it did not start:
//   - a port that already answers as Ace OS  -> Ace OS is already running: open the browser there and exit.
//   - a port taken by anything else          -> try the next port (up to 20 ports).
//   - a free port                            -> start server.js on it (in this window; Ctrl+C stops it),
//                                               wait until it answers, then open the browser.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const FIRST = parseInt(opt('--port') || process.env.PORT || '7777', 10) || 7777;
const OPEN = !argv.includes('--no-open');
const TRIES = 20;

// GET /api/ping on a port: 'ace-os' when Ace OS answers, 'other' when something else answers, 'free' when nothing listens.
function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 1500 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 4096) body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body).app === 'ace-os' ? 'ace-os' : 'other'); } catch { resolve('other'); } });
    });
    req.on('timeout', () => { req.destroy(); resolve('other'); });
    req.on('error', (e) => resolve(e && e.code === 'ECONNREFUSED' ? 'free' : 'other'));
  });
}
// a port is only "free" when we can also bind it ourselves (something may listen on another interface)
function canBind(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}
function openBrowser(url) {
  if (!OPEN) return;
  const p = process.platform;
  const [cmd, args] = p === 'win32' ? ['cmd', ['/c', 'start', '', url]] : p === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { const c = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }); c.on('error', () => {}); c.unref(); } catch { /* no browser opener: the URL is printed */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('Ace OS · Mission Control');
  const flag = path.join(HERE, '.chat-enabled');
  if (argv.includes('--chat')) { fs.writeFileSync(flag, ''); console.log('  chat ON (--chat). Delete .chat-enabled in this folder to turn it off.'); }
  else console.log(fs.existsSync(flag) ? '  chat is ON (.chat-enabled exists). Delete it to turn chat off.' : '  chat OFF (default). Run with --chat to turn it on.');

  for (let port = FIRST; port < FIRST + TRIES; port++) {
    const state = await probe(port);
    const url = `http://127.0.0.1:${port}/`;
    if (state === 'ace-os') { console.log(`  Ace OS is already running on ${url} - opening it.`); openBrowser(url); return 0; }
    if (state === 'other' || !(await canBind(port))) { console.log(`  port ${port} is in use by something else - trying ${port + 1}`); continue; }
    console.log(`  starting Ace OS on ${url}  (keep this window open; Ctrl+C stops it)`);
    const child = spawn(process.execPath, [path.join(HERE, 'server.js')], { stdio: 'inherit', env: { ...process.env, PORT: String(port) } });
    const stop = () => { try { child.kill(); } catch { /* already gone */ } };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    let exited = null;
    child.on('exit', (code) => { exited = code == null ? 1 : code; });
    for (let i = 0; i < 60 && exited == null; i++) { await sleep(250); if ((await probe(port)) === 'ace-os') { openBrowser(url); break; } }
    return await new Promise((resolve) => { if (exited != null) resolve(exited); else child.on('exit', (code) => resolve(code == null ? 0 : code)); });
  }
  console.error(`  no free port between ${FIRST} and ${FIRST + TRIES - 1}. Start with --port <another port>.`);
  return 1;
}
main().then((c) => process.exit(c), (e) => { console.error(e && e.stack || e); process.exit(1); });
