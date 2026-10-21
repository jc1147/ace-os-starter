#!/usr/bin/env node
// verify-server-boot.mjs — GODCLAUDE v2, Phase 2 (L2 verification-artifact harness).
//
// Produces an UN-FAKEABLE artifact proving a local server actually booted AND serves.
// It is the deterministic answer to "I started the server and it works" — a claim the
// proof-gate can't judge (no file mutation) and the launch-gate doesn't cover (that only
// enforces HOW you launched, not that the result is alive).
//
// Usage:  node verify-server-boot.mjs <url> [path ...]
//   e.g.  node verify-server-boot.mjs http://127.0.0.1:7777 / /api/gates /api/hooks
//
// Probes each path over HTTP(S), records status / latency / bytes / sha8 per endpoint, and writes
//   ~/.claude/verify-artifacts/server-boot/<host>_<port>.report.json
// verdict = pass iff: no connection errors, every status < 500, and at least one status is 2xx/3xx.
//
// Deterministic, Node-stdlib only, $0, read-only on the world (HTTP GET). Exit 0 = pass, 2 = fail, 3 = usage.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const HOME = (os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
const ARTIFACT_DIR = `${HOME}/.claude/verify-artifacts/server-boot`;
const TIMEOUT_MS = 5000;

function usage(msg) {
  if (msg) console.error('verify-server-boot: ' + msg);
  console.error('usage: node verify-server-boot.mjs <url> [path ...]');
  process.exit(3);
}

const rawUrl = process.argv[2];
if (!rawUrl) usage('missing <url>');
let base;
try { base = new URL(rawUrl); } catch (_) { usage(`bad url: ${rawUrl}`); }
if (!/^https?:$/.test(base.protocol)) usage(`only http/https supported, got ${base.protocol}`);

const host = base.hostname;
const port = base.port || (base.protocol === 'https:' ? '443' : '80');
let paths = process.argv.slice(3).filter(Boolean);
if (!paths.length) paths = ['/'];
if (!paths.includes('/')) paths = ['/', ...paths];  // always probe the root

function probe(p) {
  return new Promise((resolve) => {
    const lib = base.protocol === 'https:' ? https : http;
    const started = process.hrtime.bigint();
    const url = `${base.protocol}//${host}:${port}${p.startsWith('/') ? '' : '/'}${p}`;
    const req = lib.get(url, { timeout: TIMEOUT_MS }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const ms = Number((process.hrtime.bigint() - started) / 1000000n);
        const sha8 = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
        resolve({ path: p, status: res.statusCode, ok: res.statusCode > 0 && res.statusCode < 500, ms, bytes: buf.length, sha8 });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ path: p, status: 0, ok: false, ms: TIMEOUT_MS, bytes: 0, sha8: '', error: 'timeout' }); });
    req.on('error', (e) => { resolve({ path: p, status: 0, ok: false, ms: 0, bytes: 0, sha8: '', error: e.code || e.message }); });
  });
}

const checks = [];
for (const p of paths) checks.push(await probe(p));

const noConnErrors = checks.every((c) => !c.error);
const noServerErrors = checks.every((c) => c.status < 500);
const anyOk = checks.some((c) => c.status >= 200 && c.status < 400);
const verdict = noConnErrors && noServerErrors && anyOk ? 'pass' : 'fail';
let reason = '';
if (verdict === 'fail') {
  const errs = checks.filter((c) => c.error).map((c) => `${c.path}:${c.error}`);
  const fives = checks.filter((c) => c.status >= 500).map((c) => `${c.path}:${c.status}`);
  reason = [errs.length ? `conn errors [${errs.join(', ')}]` : '', fives.length ? `5xx [${fives.join(', ')}]` : '', !anyOk ? 'no 2xx/3xx response' : ''].filter(Boolean).join('; ');
}

const report = { tool: 'verify-server-boot', url: `${base.protocol}//${host}:${port}`, host, port: Number(port), ts: new Date().toISOString(), verdict, reason, checks };
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
const reportPath = `${ARTIFACT_DIR}/${host}_${port}.report.json`;
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

console.log(`verify-server-boot ${report.url}  ->  ${verdict.toUpperCase()}${reason ? '  (' + reason + ')' : ''}`);
for (const c of checks) console.log(`  ${c.ok ? 'ok ' : 'XX '} ${String(c.status).padStart(3)}  ${String(c.ms).padStart(5)}ms  ${String(c.bytes).padStart(8)}b  ${c.sha8 || '--------'}  ${c.path}${c.error ? '  (' + c.error + ')' : ''}`);
console.log(`  artifact: ${reportPath}`);
process.exit(verdict === 'pass' ? 0 : 2);
