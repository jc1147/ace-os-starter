// Both-directions test harness for the deterministic-hook layer.
// Builds synthetic transcript JSONL fixtures, runs each hook as the harness would
// (JSON on stdin), and asserts ALLOW vs BLOCK / injection output.
// Run: node _test-hooks.mjs   (exit 0 = all pass, exit 1 = a case failed)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import libConc from './lib-concurrency.js'; // CJS default import -> module.exports { normPath, ... }

const HOME = (os.homedir() || process.env.USERPROFILE || '').replace(/\\/g, '/');
const HOOKS = `${HOME}/.claude/hooks`;
const GATE = `${HOOKS}/block-unverified-completion.js`;
const INJECT = `${HOOKS}/inject-deterministic-contract.js`;
const DRIFT = `${HOOKS}/inject-anti-drift.js`;
const FIX = `${HOOKS}/_testfix`;
fs.mkdirSync(FIX, { recursive: true });

// ---- transcript building blocks ----
const userPrompt = (t) => ({ type: 'user', message: { role: 'user', content: t } });
const toolResult = () => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } });
const asstTool = (name, input) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] } });
const asstText = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

const WP = 'C:\\Users\\someuser\\proj\\thing.js'; // portable-exempt: synthetic transcript fixture (string only, never touches disk)
const WP_FWD = WP.replace(/\\/g, '/');

function writeFixture(name, objs) {
  const p = `${FIX}/${name}.jsonl`;
  fs.writeFileSync(p, objs.map(o => JSON.stringify(o)).join('\n') + '\n');
  return p;
}

function runGate(transcriptPath, { event = 'Stop', stopActive = false } = {}) {
  const input = JSON.stringify({ hook_event_name: event, transcript_path: transcriptPath, stop_hook_active: stopActive });
  let out = '';
  try { out = execFileSync('node', [GATE], { input, encoding: 'utf8' }); } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  const blocked = /"decision"\s*:\s*"block"/.test(out);
  return { blocked, out };
}
function runInject(hook, event) {
  const input = JSON.stringify({ hook_event_name: event });
  let out = '';
  try { out = execFileSync('node', [hook], { input, encoding: 'utf8' }); } catch (e) { out = e.stdout || ''; }
  return out;
}

// ---- cases ----
const cases = [];
const expect = (name, got, want) => cases.push({ name, pass: got === want, got, want });

// 1. FAIL → BLOCK: mutation + completion claim + no verification
{
  const f = writeFixture('block_basic', [
    userPrompt('fix the bug'),
    asstTool('Write', { file_path: WP, content: 'x' }),
    toolResult(),
    asstText('Done — fixed the bug, it works now.')
  ]);
  expect('1. mutation+claim+no-evidence → BLOCK', runGate(f).blocked, true);
}
// 2. ALLOW: re-read of written path after the write
{
  const f = writeFixture('allow_reread', [
    userPrompt('fix the bug'),
    asstTool('Write', { file_path: WP, content: 'x' }),
    toolResult(),
    asstTool('Read', { file_path: WP }),
    toolResult(),
    asstText('Done — re-read it, the fix is present and correct.')
  ]);
  expect('2. mutation+claim+re-read → ALLOW', runGate(f).blocked, false);
}
// 3. ALLOW: no mutation (pure answer)
{
  const f = writeFixture('allow_nomutation', [
    userPrompt('what does this function do?'),
    asstText('It validates input. Done — that is the complete answer and it works.')
  ]);
  expect('3. no-mutation (exempt) → ALLOW', runGate(f).blocked, false);
}
// 4. ALLOW: mutation but no completion claim
{
  const f = writeFixture('allow_noclaim', [
    userPrompt('draft a paragraph'),
    asstTool('Write', { file_path: WP, content: 'x' }),
    toolResult(),
    asstText('I drafted the paragraph. Take a look and tell me if the direction is right.')
  ]);
  expect('4. mutation, no claim → ALLOW', runGate(f).blocked, false);
}
// 5. ALLOW: evidence marker (fenced code block) in closing message
{
  const f = writeFixture('allow_evidence', [
    userPrompt('fix the bug'),
    asstTool('Edit', { file_path: WP, old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstText('Fixed. Evidence:\n```\n$ node thing.js\nOK exit 0\n```')
  ]);
  expect('5. mutation+claim+code-block evidence → ALLOW', runGate(f).blocked, false);
}
// 6. ALLOW: test command ran this turn
{
  const f = writeFixture('allow_testcmd', [
    userPrompt('fix the bug'),
    asstTool('Edit', { file_path: WP, old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstTool('Bash', { command: 'npm test' }),
    toolResult(),
    asstText('All tests pass now — fixed and verified.')
  ]);
  expect('6. mutation+claim+npm test → ALLOW', runGate(f).blocked, false);
}
// 7. ALLOW: circuit breaker (stop_hook_active)
{
  const f = writeFixture('cb', [
    userPrompt('fix the bug'),
    asstTool('Write', { file_path: WP, content: 'x' }),
    toolResult(),
    asstText('Done, it works.')
  ]);
  expect('7. would-block but stop_hook_active → ALLOW', runGate(f, { stopActive: true }).blocked, false);
}
// 8. FAIL → BLOCK on SubagentStop (subagent gating)
{
  const f = writeFixture('block_subagent', [
    userPrompt('fix the bug'),
    asstTool('Write', { file_path: WP, content: 'x' }),
    toolResult(),
    asstText('Implemented successfully, ready to go.')
  ]);
  expect('8. SubagentStop mutation+claim+no-evidence → BLOCK', runGate(f, { event: 'SubagentStop' }).blocked, true);
}

// 9-11. injectors
{
  const o = runInject(INJECT, 'SessionStart');
  expect('9. inject SessionStart has contract', /Deterministic Operating Contract/.test(o) && /"hookEventName":"SessionStart"/.test(o), true);
}
{
  const o = runInject(INJECT, 'SubagentStart');
  expect('10. inject echoes SubagentStart event', /"hookEventName":"SubagentStart"/.test(o) && /Deterministic Operating Contract/.test(o), true);
}
{
  const o = runInject(DRIFT, 'UserPromptSubmit');
  expect('11. anti-drift emits reminder', /Deterministic Operating Contract — active/.test(o), true);
}

// 12. TIGHTENING: a BARE fenced code block must NO LONGER count as evidence → BLOCK
{
  const f = writeFixture('block_bareblock', [
    userPrompt('fix the bug'),
    asstTool('Write', { file_path: WP, content: 'x' }),
    toolResult(),
    asstText('Fixed it, it works now.\n```\nsome quoted log line\nanother line\n```')
  ]);
  expect('12. mutation+claim+BARE code block (no real evidence) → BLOCK', runGate(f).blocked, true);
}
// 13. TIGHTENING: claim word only in EARLY prose, neutral tail (>1200 chars) → ALLOW
{
  const longNeutral = 'I will now explain the analysis in detail. ' + 'The approach considers many factors and trade-offs across the larger architecture. '.repeat(30) + 'Let me know your thoughts on the direction.';
  const f = writeFixture('allow_claim_early_only', [
    userPrompt('analyze and tweak'),
    asstTool('Edit', { file_path: WP, old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstText('I am done reviewing. ' + longNeutral)
  ]);
  expect('13. claim only in early prose, neutral tail → ALLOW', runGate(f).blocked, false);
}
// 14. shell-prompt line ($ cmd) in message still counts as evidence → ALLOW
{
  const f = writeFixture('allow_shellprompt', [
    userPrompt('fix the bug'),
    asstTool('Edit', { file_path: WP, old_string: 'a', new_string: 'b' }),
    toolResult(),
    asstText('Fixed and confirmed working:\n```\n$ node thing.js\nrunning...\nall good\n```')
  ]);
  expect('14. mutation+claim+shell-prompt evidence → ALLOW', runGate(f).blocked, false);
}

// ---- launch-gate (PreToolUse) cases — GODCLAUDE v2 Phase 1b ----
const LAUNCH = `${HOOKS}/block-undocumented-launch.js`;
function runLaunch(command, { cwd = '', transcript = '' } = {}) {
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_input: { command }, cwd, transcript_path: transcript });
  let out = '';
  try { out = execFileSync('node', [LAUNCH], { input, encoding: 'utf8' }); } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  return /"permissionDecision"\s*:\s*"deny"/.test(out);
}
// fixture project WITH a documented launcher, and one WITHOUT
const PROJ = `${FIX}/proj_launch`;
fs.mkdirSync(PROJ, { recursive: true });
fs.writeFileSync(`${PROJ}/server.js`, '// fake entrypoint\n');
fs.writeFileSync(`${PROJ}/start.ps1`, '# fake launcher\n');
const PROJ2 = `${FIX}/proj_nolaunch`;
fs.mkdirSync(PROJ2, { recursive: true });
fs.writeFileSync(`${PROJ2}/server.js`, '// fake entrypoint\n');

// 15. node entrypoint + sibling launcher + no marker → BLOCK (the 2026-06-21 failure)
expect('15. launch: node server.js w/ start.ps1, no marker → BLOCK', runLaunch(`node "${PROJ}/server.js"`), true);
// 16. + DEVIATION-JUSTIFIED in the command → ALLOW
expect('16. launch: + DEVIATION-JUSTIFIED in command → ALLOW', runLaunch(`node "${PROJ}/server.js" # DEVIATION-JUSTIFIED: one-off debug`), false);
// 17. + DEVIATION-JUSTIFIED in the turn's last assistant message → ALLOW
{
  const tf = writeFixture('launch_marker_msg', [
    userPrompt('boot it'),
    asstText('DEVIATION-JUSTIFIED: running raw for a one-off debug, start.ps1 enables chat I do not want now.')
  ]);
  expect('17. launch: + DEVIATION-JUSTIFIED in message → ALLOW', runLaunch(`node "${PROJ}/server.js"`, { transcript: tf }), false);
}
// 18. invoking the documented launcher itself → ALLOW
expect('18. launch: running ./start.ps1 → ALLOW', runLaunch(`& "${PROJ}/start.ps1"`), false);
// 19. node entrypoint but NO sibling launcher → ALLOW (nothing documented to honor)
expect('19. launch: node server.js, no launcher present → ALLOW', runLaunch(`node "${PROJ2}/server.js"`), false);
// 20. node --check (syntax check, not a spawn) even w/ launcher → ALLOW
expect('20. launch: node --check server.js (not a spawn) → ALLOW', runLaunch(`node --check "${PROJ}/server.js"`), false);

// ---- proof-gate command-claim broadening cases — GODCLAUDE v2 Phase 1a ----
// 21. side-effecting command (npm install) + completion claim + NO verification → BLOCK
{
  const f = writeFixture('block_sidefx_install', [
    userPrompt('install the deps'),
    asstTool('PowerShell', { command: 'npm install' }),
    toolResult(),
    asstText('Done — installed successfully, everything works now.')
  ]);
  expect('21. side-effect cmd (npm install)+claim+no-verify → BLOCK', runGate(f).blocked, true);
}
// 22. side-effecting command (git push) + claim + shell-prompt evidence → ALLOW
{
  const f = writeFixture('allow_sidefx_git_evidence', [
    userPrompt('push it'),
    asstTool('PowerShell', { command: 'git push origin main' }),
    toolResult(),
    asstText('Pushed and confirmed:\n```\n$ git push origin main\nTo origin... done\n```')
  ]);
  expect('22. side-effect cmd (git push)+claim+shell-prompt evidence → ALLOW', runGate(f).blocked, false);
}
// 23. read-only command (git status) + claim → ALLOW (NOT side-effecting; FP guard)
{
  const f = writeFixture('allow_readonly_gitstatus', [
    userPrompt('check status'),
    asstTool('PowerShell', { command: 'git status' }),
    toolResult(),
    asstText('Done — the working tree is clean, all good.')
  ]);
  expect('23. read-only cmd (git status)+claim → ALLOW (not side-effecting)', runGate(f).blocked, false);
}
// 24. side-effecting command (node deploy.js) + claim + HTTP probe verification → ALLOW
{
  const f = writeFixture('allow_sidefx_deploy_probe', [
    userPrompt('deploy and verify'),
    asstTool('PowerShell', { command: 'node deploy.js' }),
    toolResult(),
    asstTool('PowerShell', { command: 'Invoke-WebRequest http://localhost:3000/health' }),
    toolResult(),
    asstText('Deployed and verified — the health endpoint responds.')
  ]);
  expect('24. side-effect (node deploy.js)+claim+HTTP probe → ALLOW', runGate(f).blocked, false);
}
// 25. side-effecting command but NO completion claim → ALLOW
{
  const f = writeFixture('allow_sidefx_noclaim', [
    userPrompt('install deps'),
    asstTool('PowerShell', { command: 'npm install' }),
    toolResult(),
    asstText('I ran the install step. Tell me if you want the dev server started next.')
  ]);
  expect('25. side-effect cmd, no completion claim → ALLOW', runGate(f).blocked, false);
}
// 26. read-only HTTP probe only + claim → ALLOW (exempt; a probe is verification, not a state change)
{
  const f = writeFixture('allow_probe_only_claim', [
    userPrompt('is the server up?'),
    asstTool('PowerShell', { command: 'Invoke-WebRequest http://127.0.0.1:7777/' }),
    toolResult(),
    asstText('Yes — it returned 200, the server is up and working.')
  ]);
  expect('26. read-only HTTP probe only + claim → ALLOW (exempt)', runGate(f).blocked, false);
}

// ---- boot-gate (Stop/SubagentStop) cases — GODCLAUDE v2 Phase 2 (L2 verification artifact) ----
const BOOT = `${HOOKS}/block-unfounded-boot-claim.js`;
function runBoot(transcriptPath, { event = 'Stop' } = {}) {
  const input = JSON.stringify({ hook_event_name: event, transcript_path: transcriptPath, stop_hook_active: false });
  let out = '';
  try { out = execFileSync('node', [BOOT], { input, encoding: 'utf8' }); } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  return /"decision"\s*:\s*"block"/.test(out);
}
const ARTDIR = `${HOME}/.claude/verify-artifacts/server-boot`;
fs.mkdirSync(ARTDIR, { recursive: true });
const writeArtifact = (host, port, verdict) => fs.writeFileSync(`${ARTDIR}/${host}_${port}.report.json`,
  JSON.stringify({ tool: 'verify-server-boot', url: `http://${host}:${port}`, host, port: Number(port), ts: new Date().toISOString(), verdict, reason: verdict === 'fail' ? 'synthetic test fail' : '', checks: [] }));
for (const p of ['65111', '65222', '65333']) { try { fs.rmSync(`${ARTDIR}/127.0.0.1_${p}.report.json`); } catch (_) {} } // clean stale test artifacts

// 27. boot claim on a port with NO fresh artifact → BLOCK
{
  const f = writeFixture('boot_no_artifact', [
    userPrompt('boot it'),
    asstText('Done — the dashboard is live at http://127.0.0.1:65333 and serving.')
  ]);
  expect('27. boot claim, no artifact → BLOCK', runBoot(f), true);
}
// 28. boot claim + fresh PASS artifact → ALLOW
// (session-scope contract, 2026-07-09: the artifact only counts if THIS session's transcript
//  shows a verify-server-boot run for the port — foreign artifacts are ignored. The fixture
//  therefore carries the harness tool_use, like a real proven session.)
{
  writeArtifact('127.0.0.1', '65111', 'pass');
  const f = writeFixture('boot_pass', [
    userPrompt('boot it'),
    asstTool('Bash', { command: 'node ~/.claude/hooks/verify-server-boot.mjs http://127.0.0.1:65111' }),
    toolResult(),
    asstText('The server is up on port 65111 and responding.')
  ]);
  expect('28. boot claim + fresh PASS artifact → ALLOW', runBoot(f), false);
}
// 29. boot claim + fresh FAIL artifact (claiming up while down) → BLOCK
{
  writeArtifact('127.0.0.1', '65222', 'fail');
  const f = writeFixture('boot_fail', [
    userPrompt('boot it'),
    asstText('All set — the app is running at http://127.0.0.1:65222.')
  ]);
  expect('29. boot claim + fresh FAIL artifact → BLOCK', runBoot(f), true);
}
// 30. no boot claim at all → ALLOW
{
  const f = writeFixture('boot_noclaim', [
    userPrompt('explain the code'),
    asstText('This function validates the input. Done — that is the full explanation.')
  ]);
  expect('30. no boot claim → ALLOW', runBoot(f), false);
}
// 31. boot verb but NO local target (generic "deploy is live") → ALLOW (FP guard)
{
  const f = writeFixture('boot_no_target', [
    userPrompt('ship it'),
    asstText('Deployed — the production site is live and working now.')
  ]);
  expect('31. boot verb but no local URL/port → ALLOW (FP guard)', runBoot(f), false);
}
// 32. boot claim via full localhost URL + fresh PASS → ALLOW
// (carries the session-scope proof for the port, same contract as case 28)
{
  const f = writeFixture('boot_url_pass', [
    userPrompt('boot it'),
    asstTool('Bash', { command: 'node ~/.claude/hooks/verify-server-boot.mjs http://127.0.0.1:65111' }),
    toolResult(),
    asstText('Verified — running at http://127.0.0.1:65111/ now.')
  ]);
  expect('32. boot claim (full URL) + fresh PASS → ALLOW', runBoot(f), false);
}

// ---- persistence-gate (Stop/SubagentStop) cases — the "stops on doable work" gate ----
const PERSIST = `${HOOKS}/block-premature-stop.js`;
function runPersist(transcriptPath, { event = 'Stop', stopActive = false } = {}) {
  const input = JSON.stringify({ hook_event_name: event, transcript_path: transcriptPath, stop_hook_active: stopActive });
  let out = '';
  try { out = execFileSync('node', [PERSIST], { input, encoding: 'utf8' }); } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  return /"decision"\s*:\s*"block"/.test(out);
}
// 33. work + named-fix + "recommend before any further build run" → BLOCK
{
  const f = writeFixture('persist_giveup_fix', [
    userPrompt('build the site, full workload, you have approval'),
    asstTool('Bash', { command: 'node verify.js' }), toolResult(),
    asstText('The diagnostic stands. The fix is the real B4 — port each menu CSS into structural.css, which I recommend before any further build run.')
  ]);
  expect('33. persist: work + named-fix + recommend-before-build → BLOCK', runPersist(f), true);
}
// 34. work + "want me to proceed?" → BLOCK
{
  const f = writeFixture('persist_defer_q', [
    userPrompt('do the whole build'),
    asstTool('Edit', { file_path: WP, old_string: 'a', new_string: 'b' }), toolResult(),
    asstText('Phase 1 is teed up. Want me to proceed with porting the CSS and continue the build?')
  ]);
  expect('34. persist: work + "want me to proceed?" → BLOCK', runPersist(f), true);
}
// 35. circuit breaker → ALLOW
{
  const f = writeFixture('persist_cb', [
    userPrompt('build it'),
    asstTool('Bash', { command: 'node x.js' }), toolResult(),
    asstText('The fix is X — recommend before any further build run.')
  ]);
  expect('35. persist: would-block but stop_hook_active → ALLOW', runPersist(f, { stopActive: true }), false);
}
// 36. genuine owner-gate (real choice) → ALLOW
{
  const f = writeFixture('persist_owner_gate', [
    userPrompt('build the hero'),
    asstTool('Bash', { command: 'node x.js' }), toolResult(),
    asstText('This needs your decision: hero as option A (video) or option B (static)? Your call.')
  ]);
  expect('36. persist: genuine owner-gate (real choice) → ALLOW', runPersist(f), false);
}
// 37. legit done, no give-up → ALLOW
{
  const f = writeFixture('persist_done', [
    userPrompt('run the tests'),
    asstTool('Bash', { command: 'npm test' }), toolResult(),
    asstText('All done — 8/8 tests pass, verified. The site builds clean.')
  ]);
  expect('37. persist: legit done, no give-up → ALLOW', runPersist(f), false);
}
// 38. pure chat (no tool use) even with give-up words → ALLOW
{
  const f = writeFixture('persist_purechat', [
    userPrompt('what do you recommend before the build?'),
    asstText('I recommend porting the CSS before any further build run.')
  ]);
  expect('38. persist: pure chat (no tool use) → ALLOW', runPersist(f), false);
}

// ---- index-discipline gate (PreToolUse) cases — per-line MEMORY.md/MOC bloat ----
const BLOAT = `${HOOKS}/block-memory-line-bloat.js`;
function runBloat(tool, filePath, payload) {
  const ti = tool === 'Write' ? { file_path: filePath, content: payload } : { file_path: filePath, new_string: payload };
  let out = '';
  try { out = execFileSync('node', [BLOAT], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: ti }), encoding: 'utf8' }); } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  return /"permissionDecision"\s*:\s*"deny"/.test(out);
}
const LONG_PTR = '- [x](y.md) — ' + 'z'.repeat(360);
expect('39. line-bloat: MEMORY.md edit w/ 370+char pointer → BLOCK', runBloat('Edit', 'C:/x/MEMORY.md', LONG_PTR), true);
expect('40. line-bloat: MEMORY.md edit w/ short pointer → ALLOW', runBloat('Edit', 'C:/x/MEMORY.md', '- [x](y.md) — short hook'), false);
expect('41. line-bloat: non-MEMORY file w/ long line → ALLOW', runBloat('Edit', 'C:/x/server.js', LONG_PTR), false);

// ---- persist-to-memory gate (Stop/SubagentStop) cases — explicit save-signal + no memory write ----
const PMEM = `${HOOKS}/block-unpersisted-memory.js`;
function runPersistMem(transcriptPath, { event = 'Stop', stopActive = false } = {}) {
  let out = '';
  try { out = execFileSync('node', [PMEM], { input: JSON.stringify({ hook_event_name: event, transcript_path: transcriptPath, stop_hook_active: stopActive }), encoding: 'utf8' }); } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  return /"decision"\s*:\s*"block"/.test(out);
}
{
  const f = writeFixture('pmem_block', [userPrompt('remember that we always deploy via start.ps1'), asstText('Got it.')]);
  expect('42. persist-mem: "remember that..." + NO memory write → BLOCK', runPersistMem(f), true);
}
{
  const f = writeFixture('pmem_wrote', [userPrompt('remember that we use X'), asstTool('Write', { file_path: 'C:/u/memory/feedback_x.md', content: 'y' }), toolResult(), asstText('saved')]);
  expect('43. persist-mem: save-signal + memory note written → ALLOW', runPersistMem(f), false);
}
{
  const f = writeFixture('pmem_nosignal', [userPrompt('fix the bug in server.js'), asstTool('Edit', { file_path: WP, old_string: 'a', new_string: 'b' }), toolResult(), asstText('fixed')]);
  expect('44. persist-mem: no save-signal → ALLOW', runPersistMem(f), false);
}

import { createHash } from 'node:crypto';

// ---- WS-D multi-session concurrency gates (Stage 2) — both-directions + DIAG-safety ----------
// Three PreToolUse gates that read tool_input/session_id/cwd directly (no transcript needed):
//   PROJECT: .claude/hooks/block-unkeyed-temp-log.js  (per-session temp-log keying)
//   GLOBAL : bootstrap/dotclaude/hooks/block-shared-file-contention.js  (shared-file lease)
//   GLOBAL : bootstrap/dotclaude/hooks/block-git-add-sweep.js           (shared git index)
// Every gate is DIAG/LOG-ONLY by default and only DENIES when ACE_MULTISESSION_ENFORCE==='1'.
// The concurrency gates read session heartbeats + file leases from os.homedir()/.claude — so we
// sandbox HOME/USERPROFILE to a throwaway tmp dir (os.homedir() honors USERPROFILE, verified),
// fabricate co-resident beats + a held lease there, and NEVER touch the real ~/.claude.
const HERE = path.dirname(fileURLToPath(import.meta.url));                       // .../bootstrap/dotclaude/hooks
// D-11 LAYOUT-INDEPENDENCE: this harness runs from 3 layouts — dev tree (ace/bootstrap/dotclaude/hooks),
// release bundle (<root>/dotclaude/hooks — one level shallower), and installed (~/.claude/hooks — no repo
// above at all). A fixed ../../../ hop count is correct ONLY in the dev tree, so instead walk UP from HERE
// (bounded) probing each ancestor for the fixture's relative path. Returns the absolute path of the first
// hit, or null when no ancestor has it — an absent optional fixture is a SKIP, never a module-load crash.
function findUpward(relPath, maxLevels = 6) {
  let dir = HERE;
  for (let i = 0; i <= maxLevels; i++) {
    const candidate = path.join(dir, relPath);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break; // hit the filesystem root
    dir = parent;
  }
  return null;
}
// Ace OS: on an installed machine the workspace hooks + the memory oracle live in the Ace workspace (~/ace).
function inAce(relPath) { const p = path.join(os.homedir(), 'ace', relPath); return fs.existsSync(p) ? p : null; }
const HOOK_TEMPLOG    = findUpward('.claude/hooks/block-unkeyed-temp-log.js') || inAce('.claude/hooks/block-unkeyed-temp-log.js');   // PROJECT hook; null ⇒ cases 57-61 SKIP
const HOOK_CONTENTION = path.join(HERE, 'block-shared-file-contention.js');
const HOOK_GITSWEEP   = path.join(HERE, 'block-git-add-sweep.js');
const libNorm = libConc.normPath;

// Sandbox HOME (beats/locks/audit all land here, never in real ~/.claude) + a REAL workspace dir
// (so realpath resolves consistently) + an NTFS junction alias of it (for the alias-spelling test).
const WSD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wsd-home-'));
fs.mkdirSync(path.join(WSD_HOME, '.claude/session-beats'), { recursive: true });
fs.mkdirSync(path.join(WSD_HOME, '.claude/locks/files'), { recursive: true });
const WSD_WS = fs.mkdtempSync(path.join(os.tmpdir(), 'wsd-ws-'));                 // real co-resident workspace root
fs.mkdirSync(path.join(WSD_WS, 'memory'), { recursive: true });
const MEM_NOTE = path.join(WSD_WS, 'memory', 'reference_probe.md');
fs.writeFileSync(MEM_NOTE, '# probe note\n');
const WSD_WS_ALIAS = WSD_WS + '-alias';
let JUNCTION_OK = false;
try { fs.symlinkSync(WSD_WS, WSD_WS_ALIAS, 'junction'); JUNCTION_OK = fs.existsSync(WSD_WS_ALIAS); } catch (_) { JUNCTION_OK = false; }
const MEM_NOTE_ALIAS = path.join(WSD_WS_ALIAS, 'memory', 'reference_probe.md');   // same file, junction spelling

const OTHER_SID = 'other1111-aaaa-bbbb-cccc';   // a co-resident live session (also the lease holder)
const MINE_SID  = 'mine2222-dddd-eeee-ffff';    // this session
const TL_SID    = 'abcd1234-5678-9abc';         // temp-log session; sid8 = 'abcd1234'

const beatsDir  = path.join(WSD_HOME, '.claude/session-beats');
const leasesDir = path.join(WSD_HOME, '.claude/locks/files');
function wsdReset() {
  for (const d of [beatsDir, leasesDir]) { try { for (const f of fs.readdirSync(d)) fs.rmSync(path.join(d, f), { force: true }); } catch (_) {} }
}
function wsdBeat(sid, cwd) { fs.writeFileSync(path.join(beatsDir, `${sid}.beat`), JSON.stringify({ ts: Date.now(), cwd })); }
function wsdSeedLease(filePath, sid) {  // seed a lease held by `sid`, byte-identical key to acquireLease()
  const key = createHash('sha1').update(libNorm(filePath).toLowerCase()).digest('hex').slice(0, 16);
  fs.writeFileSync(path.join(leasesDir, `${key}.json`), JSON.stringify({ sid, path: libNorm(filePath), ts: Date.now() }));
}
function wsdEnv(enforce) {
  const env = { ...process.env, USERPROFILE: WSD_HOME, HOME: WSD_HOME };
  if (enforce) env.ACE_MULTISESSION_ENFORCE = '1'; else delete env.ACE_MULTISESSION_ENFORCE;
  return env;
}
function runHook(hookPath, payload, enforce) {
  let out = '';
  try { out = execFileSync('node', [hookPath], { input: JSON.stringify(payload), encoding: 'utf8', env: wsdEnv(enforce) }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  return { denied: /"permissionDecision"\s*:\s*"deny"/.test(out), out };
}
const runTempLog = (tool, toolInput, sid, enforce = false) =>
  runHook(HOOK_TEMPLOG, { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput, session_id: sid, cwd: WSD_WS }, enforce).denied;
const runContention = (tool, toolInput, sid, enforce = false, cwd = WSD_WS) =>
  runHook(HOOK_CONTENTION, { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput, session_id: sid, cwd }, enforce).denied;
const runGitSweep = (cmd, sid, enforce = false, cwd = WSD_WS) =>
  runHook(HOOK_GITSWEEP, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd }, session_id: sid, cwd }, enforce).denied;

const TEMPDIR = `${WSD_WS.replace(/\\/g, '/')}/logs/temp`;   // path STRINGS only (temp-log gate is lexical, no fs access)
const KEYED   = `${TEMPDIR}/code-user-2026-07-07-abcd1234.md`;  // ends -abcd1234 (this session's sid8)
const UNKEYED = `${TEMPDIR}/code-user-2026-07-07.md`;           // no sid8 -> the shared-file collision this gate kills

// -- temp-log gate (block-unkeyed-temp-log) --
// D-11: the temp-log gate is a PROJECT hook (repo .claude/hooks), not vendored into the global layer —
// on an installed machine (~/.claude/hooks, no repo above) it is legitimately absent. Skip its 5 cases
// rather than fail, mirroring the OVERHAUL_GATES_PRESENT pattern above.
const TEMPLOG_GATE_PRESENT = !!HOOK_TEMPLOG;
if (TEMPLOG_GATE_PRESENT) {
expect('57. temp-log: keyed Write (enforce) → ALLOW', runTempLog('Write', { file_path: KEYED }, TL_SID, true), false);
expect('58. temp-log: unkeyed Write (enforce) → BLOCK', runTempLog('Write', { file_path: UNKEYED }, TL_SID, true), true);
expect('59. temp-log: unkeyed Write (DIAG default) → ALLOW (would-block only)', runTempLog('Write', { file_path: UNKEYED }, TL_SID, false), false);
expect('60. temp-log: bash echo>> dodge, unkeyed (enforce) → BLOCK', runTempLog('Bash', { command: `echo "x" >> logs/temp/code-user-2026-07-07.md` }, TL_SID, true), true);
expect('61. temp-log: missing session_id, unkeyed (enforce) → ALLOW (fail-open)', runTempLog('Write', { file_path: UNKEYED }, '', true), false);
}
if (!TEMPLOG_GATE_PRESENT) console.log(`\n  (SKIP temp-log cases 57-61: .claude/hooks/block-unkeyed-temp-log.js not found in any ancestor of this harness or in ~/ace)`);

// -- shared-file contention gate (block-shared-file-contention) --
// solo (0 other live) → zero-friction allow even under enforce
wsdReset();
expect('62. contention: solo (0 co-live) Edit MEMORY.md (enforce) → ALLOW', runContention('Edit', { file_path: `${WSD_WS}/memory/MEMORY.md` }, MINE_SID, true), false);
// advisory path (status.md) with a co-live session → only audits, NEVER denies (even enforce)
wsdReset(); wsdBeat(OTHER_SID, WSD_WS);
expect('63. contention: advisory status.md, 1 co-live (enforce) → ALLOW (audit only)', runContention('Edit', { file_path: `${WSD_WS}/status.md` }, MINE_SID, true), false);
// full-overwrite Write to MEMORY.md under concurrency → refuse (Edit-only)
wsdReset(); wsdBeat(OTHER_SID, WSD_WS);
expect('64. contention: full-overwrite Write MEMORY.md, 1 co-live (enforce) → BLOCK', runContention('Write', { file_path: `${WSD_WS}/memory/MEMORY.md` }, MINE_SID, true), true);
// hard lease held by OTHER on a memory note → deny this session's Edit (SLASH spelling)
wsdReset(); wsdBeat(OTHER_SID, WSD_WS); wsdSeedLease(MEM_NOTE, OTHER_SID);
expect('65. contention: memory-note lease held by other, slash form (enforce) → BLOCK', runContention('Edit', { file_path: MEM_NOTE.replace(/\\/g, '/') }, MINE_SID, true), true);
// same held lease, JUNCTION-ALIAS spelling → realpath collapses to same key → still denied
if (JUNCTION_OK) {
  wsdReset(); wsdBeat(OTHER_SID, WSD_WS); wsdSeedLease(MEM_NOTE, OTHER_SID);
  expect('66. contention: memory-note lease held by other, junction-alias form (enforce) → BLOCK', runContention('Edit', { file_path: MEM_NOTE_ALIAS }, MINE_SID, true), true);
} else {
  console.log('\n  (SKIP case 66: NTFS junction unavailable on this machine)');
}
// DIAG SAFETY: same would-block held-lease input, enforce UNSET → ALLOW (audit only)
wsdReset(); wsdBeat(OTHER_SID, WSD_WS); wsdSeedLease(MEM_NOTE, OTHER_SID);
expect('67. contention: held-lease Edit (DIAG default) → ALLOW (would-block only)', runContention('Edit', { file_path: MEM_NOTE.replace(/\\/g, '/') }, MINE_SID, false), false);

// -- git-index sweep gate (block-git-add-sweep) --
// git add -A with 2 live beats (self + 1 other) → deny under enforce
wsdReset(); wsdBeat(MINE_SID, WSD_WS); wsdBeat(OTHER_SID, WSD_WS);
expect('68. git-sweep: git add -A, 2 live beats (enforce) → BLOCK', runGitSweep('git add -A', MINE_SID, true), true);
// DIAG SAFETY: same input, enforce UNSET → ALLOW (would-block only)
wsdReset(); wsdBeat(MINE_SID, WSD_WS); wsdBeat(OTHER_SID, WSD_WS);
expect('69. git-sweep: git add -A, 2 live beats (DIAG default) → ALLOW (would-block only)', runGitSweep('git add -A', MINE_SID, false), false);
// only 1 live beat (self) → 0 others → solo allow even under enforce
wsdReset(); wsdBeat(MINE_SID, WSD_WS);
expect('70. git-sweep: git add -A, 1 live beat / 0 others (enforce) → ALLOW (solo)', runGitSweep('git add -A', MINE_SID, true), false);
// pathspec-scoped commit under concurrency → the SAFE form → allow
wsdReset(); wsdBeat(MINE_SID, WSD_WS); wsdBeat(OTHER_SID, WSD_WS);
expect('71. git-sweep: pathspec commit `-- src/a.js`, 2 live (enforce) → ALLOW', runGitSweep('git commit -m "wip" -- src/a.js', MINE_SID, true), false);
// unscoped plain commit under concurrency → deny under enforce (bonus branch)
wsdReset(); wsdBeat(MINE_SID, WSD_WS); wsdBeat(OTHER_SID, WSD_WS);
expect('72. git-sweep: unscoped `git commit -m`, 2 live (enforce) → BLOCK', runGitSweep('git commit -m "wip"', MINE_SID, true), true);

// ---- Q4 canaries (2026-07-07 audit): quote-stripping + command-boundary anchoring ----
// quoted "git add -A" inside a commit MESSAGE must not trip the sweep rule; the ` -- x` pathspec scopes it
wsdReset(); wsdBeat(MINE_SID, WSD_WS); wsdBeat(OTHER_SID, WSD_WS);
expect('91. git-sweep Q4: scoped commit w/ "git add -A" in quoted message (enforce) → ALLOW', runGitSweep('git commit -m "never use git add -A" -- src/a.js', MINE_SID, true), false);
// git only inside quotes, no real git invocation at all
wsdReset(); wsdBeat(MINE_SID, WSD_WS); wsdBeat(OTHER_SID, WSD_WS);
expect('92. git-sweep Q4: `echo "git add -A is banned" >> notes.txt` (enforce) → ALLOW', runGitSweep('echo "git add -A is banned" >> notes.txt', MINE_SID, true), false);
// a REAL sweep behind a && boundary still denies
wsdReset(); wsdBeat(MINE_SID, WSD_WS); wsdBeat(OTHER_SID, WSD_WS);
expect('93. git-sweep Q4: real sweep `cd sub && git add -A` (enforce) → BLOCK', runGitSweep('cd sub && git add -A', MINE_SID, true), true);
// unquoted prose: `git` not at a command boundary → not an invocation
wsdReset(); wsdBeat(MINE_SID, WSD_WS); wsdBeat(OTHER_SID, WSD_WS);
expect('94. git-sweep Q4: `echo git add -A` (not at boundary) (enforce) → ALLOW', runGitSweep('echo git add -A', MINE_SID, true), false);

// ---- Q5 canaries (2026-07-07 audit): writer-verb-TIED shell extraction ----
// a READ of the leased note with an unrelated redirect must NOT engage (old code denied this)
wsdReset(); wsdBeat(OTHER_SID, WSD_WS); wsdSeedLease(MEM_NOTE, OTHER_SID);
expect('95. contention Q5: read note + redirect elsewhere (enforce, lease held) → ALLOW', runContention('Bash', { command: `grep pattern "${MEM_NOTE}" > "${path.join(WSD_HOME, 'out.txt')}"` }, MINE_SID, true), false);
// a real shell WRITE targeting the leased note still denies
wsdReset(); wsdBeat(OTHER_SID, WSD_WS); wsdSeedLease(MEM_NOTE, OTHER_SID);
expect('96. contention Q5: `echo x >> <note>` (enforce, lease held) → BLOCK', runContention('Bash', { command: `echo x >> "${MEM_NOTE}"` }, MINE_SID, true), true);

// ---- Q6 canary (2026-07-07 audit): MultiEdit covered by the contention gate ----
wsdReset(); wsdBeat(OTHER_SID, WSD_WS); wsdSeedLease(MEM_NOTE, OTHER_SID);
expect('97. contention Q6: MultiEdit on leased note (enforce, lease held) → BLOCK', runContention('MultiEdit', { file_path: MEM_NOTE.replace(/\\/g, '/'), edits: [{ old_string: 'a', new_string: 'b' }] }, MINE_SID, true), true);

// cleanup throwaway sandboxes (all under os.tmpdir(); never ~/.claude or the repo)
try { if (JUNCTION_OK) fs.rmSync(WSD_WS_ALIAS, { recursive: true, force: true }); } catch (_) {}
try { fs.rmSync(WSD_HOME, { recursive: true, force: true }); } catch (_) {}
try { fs.rmSync(WSD_WS, { recursive: true, force: true }); } catch (_) {}

// ---- WS-E memory-pass gates (Stage 3) — oracle + commit-gate + wrap-gate + inject ----------
// The memory-pass enforcement layer: an evidence ORACLE (Code/memory-system/verify-memory-pass.mjs) and
// three gates that shell to it. Every gate is DIAG/LOG-ONLY by default and only DENIES/BLOCKS under
// MEMGATE_ENFORCE==='1'. We sandbox HOME/USERPROFILE (pass-markers + audit land in a throwaway), point
// MEMGATE_MEM_DIR at throwaway mem-dirs, and run the commit gate inside a throwaway git repo that carries a
// COPY of the oracle — so the real memory brain / real repo are NEVER touched.
// D-11: the oracle lives in the workspace repo (Code/memory-system/), not in the global hook layer — probe
// upward for it instead of assuming a fixed ../../../ depth. On an installed machine (no repo above
// ~/.claude/hooks) it is legitimately absent → skip the WHOLE WS-E section, never crash at module load.
const WSE_ORACLE_SRC = findUpward('Code/memory-system/verify-memory-pass.mjs') || inAce('Code/memory-system/verify-memory-pass.mjs');
const WSE_ORACLE_PRESENT = !!WSE_ORACLE_SRC;
if (WSE_ORACLE_PRESENT) {
const WSE_COMMIT = path.join(HERE, 'block-commit-without-memory.js');
const WSE_WRAP   = path.join(HERE, 'block-wrap-without-memory.js');
const WSE_INJECT = path.join(HERE, 'inject-wrap-memory-directive.js');
const WSE_SID = 'wse2222-3333-4444-5555';

const gitq = (args, cwd) => { try { execFileSync('git', args, { cwd, stdio: 'ignore' }); } catch (_) {} };
function wseInitRepo(prefix, withOracle) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  if (withOracle) { fs.mkdirSync(path.join(r, 'Code/memory-system'), { recursive: true }); fs.copyFileSync(WSE_ORACLE_SRC, path.join(r, 'Code/memory-system/verify-memory-pass.mjs')); }
  gitq(['init', '-q'], r); gitq(['config', 'user.email', 't@t'], r); gitq(['config', 'user.name', 't'], r);
  gitq(['commit', '-q', '--allow-empty', '-m', 'init'], r);
  return r;
}
const WSE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wse-home-'));
fs.mkdirSync(path.join(WSE_HOME, '.claude'), { recursive: true });
const WSE_REPO = wseInitRepo('wse-repo-', true);       // memory-ENABLED (oracle vendored)
const WSE_FOREIGN = wseInitRepo('wse-foreign-', false); // memory-DISABLED (no oracle) — foreign-repo case

// throwaway mem-dirs: an evidencing note (sid + recent), a foreign-sid note (no evidence), a malformed note,
// and an UPDATE-only note (Q2: foreign originSessionId + this session's lastSessionId — the update convention).
function wseMemDir(kind) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `wse-mem-${kind}-`));
  if (kind === 'evidence')  fs.writeFileSync(path.join(d, 'reference_valid.md'),  `---\nname: t-valid\ndescription: valid note\nmetadata:\n  type: reference\n  originSessionId: ${WSE_SID}\n---\nbody content\n`);
  if (kind === 'noevidence') fs.writeFileSync(path.join(d, 'reference_foreign.md'), `---\nname: t-foreign\ndescription: foreign sid\nmetadata:\n  type: reference\n  originSessionId: OTHER-SID\n---\nbody\n`);
  if (kind === 'malformed') fs.writeFileSync(path.join(d, 'reference_notype.md'),  `---\nname: t-notype\ndescription: missing type\nmetadata:\n  originSessionId: ${WSE_SID}\n---\nbody\n`);
  if (kind === 'updated')   fs.writeFileSync(path.join(d, 'reference_updated.md'), `---\nname: t-updated\ndescription: note updated this session\nmetadata:\n  type: reference\n  originSessionId: OTHER-SID\n  lastSessionId: ${WSE_SID}\n---\nbody content\n`);
  return d;
}
const WSE_MEM_EV = wseMemDir('evidence'), WSE_MEM_NOEV = wseMemDir('noevidence'), WSE_MEM_MAL = wseMemDir('malformed'), WSE_MEM_UPD = wseMemDir('updated');

function wseResetMarkers() { try { fs.rmSync(path.join(WSE_HOME, '.claude/memory-pass'), { recursive: true, force: true }); } catch (_) {} }
// Q7: seed a pass-marker file directly (forged or valid) at the exact path the gates read.
function wseSeedMarker(obj) {
  const d = path.join(WSE_HOME, '.claude/memory-pass');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${WSE_SID}.json`), JSON.stringify(obj));
}
function wseEnv(memDir, enforce) {
  const env = { ...process.env, USERPROFILE: WSE_HOME, HOME: WSE_HOME, MEMGATE_MEM_DIR: memDir };
  // enforce: true -> '1' (explicit on), '0' -> '0' (explicit log-only opt-out — wrap gate v2 semantics),
  // false -> UNSET (the default: commit gate stays DIAG, wrap gate v2 is ENFORCING by default).
  if (enforce === '0') env.MEMGATE_ENFORCE = '0';
  else if (enforce) env.MEMGATE_ENFORCE = '1';
  else delete env.MEMGATE_ENFORCE;
  return env;
}

// -- oracle (direct): exit 0 = pass, 1 = no evidence, 2 = malformed --
function runOracleExit(sid, memDir, since) {
  try { execFileSync('node', [path.join(WSE_REPO, 'Code/memory-system/verify-memory-pass.mjs'), '--sid', sid, '--mem-dir', memDir, '--since', String(since)], { stdio: 'ignore' }); return 0; }
  catch (e) { return typeof e.status === 'number' ? e.status : -1; }
}
const WSE_SINCE = Date.now() - 3600000;
expect('73. oracle: valid note (sid + recent mtime) → exit 0', runOracleExit(WSE_SID, WSE_MEM_EV, WSE_SINCE), 0);
expect('74. oracle: evidenced note missing metadata.type → exit 2 (malformed)', runOracleExit(WSE_SID, WSE_MEM_MAL, WSE_SINCE), 2);
expect('75. oracle: only a foreign originSessionId note → exit 1 (no evidence)', runOracleExit(WSE_SID, WSE_MEM_NOEV, WSE_SINCE), 1);

// -- commit gate (PreToolUse Bash|PowerShell) --
function wseStage(repo, files) { // files: [{path, lines}] — reset index, write+stage exactly these
  gitq(['reset', '-q'], repo);
  for (const f of files) { const abs = path.join(repo, f.path); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, Array.from({ length: f.lines }, (_, i) => 'L' + i).join('\n') + '\n'); gitq(['add', '--', f.path], repo); }
}
function runCommitGate(cmd, memDir, enforce, cwd = WSE_REPO) {
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd }, session_id: WSE_SID, cwd, transcript_path: '' });
  let out = '';
  try { out = execFileSync('node', [WSE_COMMIT], { input, encoding: 'utf8', env: wseEnv(memDir, enforce) }); } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  return /"permissionDecision"\s*:\s*"deny"/.test(out);
}
wseResetMarkers(); wseStage(WSE_REPO, [{ path: 'big.txt', lines: 40 }]);
expect('76. commit-gate: non-trivial (40L) + no-evidence (ENFORCE) → BLOCK', runCommitGate('git commit -m x', WSE_MEM_NOEV, true), true);
wseResetMarkers(); wseStage(WSE_REPO, [{ path: 'big.txt', lines: 40 }]);
expect('77. commit-gate: non-trivial + no-evidence (DIAG default) → ALLOW (would-block only)', runCommitGate('git commit -m x', WSE_MEM_NOEV, false), false);
wseResetMarkers(); wseStage(WSE_REPO, [{ path: 'small.txt', lines: 2 }]);
expect('78. commit-gate: trivial diff (2L) (ENFORCE) → ALLOW', runCommitGate('git commit -m x', WSE_MEM_NOEV, true), false);
wseResetMarkers(); wseStage(WSE_REPO, [{ path: 'memory/note.md', lines: 40 }]);
expect('79. commit-gate: housekeeping-only paths, non-trivial (ENFORCE) → ALLOW', runCommitGate('git commit -m x', WSE_MEM_NOEV, true), false);
wseResetMarkers(); wseStage(WSE_REPO, [{ path: 'big.txt', lines: 40 }]);
expect('80. commit-gate: non-trivial + valid-note-evidence (ENFORCE) → ALLOW', runCommitGate('git commit -m x', WSE_MEM_EV, true), false);
wseResetMarkers(); wseStage(WSE_REPO, [{ path: 'big.txt', lines: 40 }]);
expect('81. commit-gate: non-trivial + no-evidence + DEVIATION-JUSTIFIED (ENFORCE) → ALLOW', runCommitGate('git commit -m x # DEVIATION-JUSTIFIED: no durable lesson', WSE_MEM_NOEV, true), false);
wseResetMarkers(); wseStage(WSE_FOREIGN, [{ path: 'big.txt', lines: 40 }]);
expect('82. commit-gate: foreign repo (no oracle vendored) (ENFORCE) → ALLOW (silent)', runCommitGate('git commit -m x', WSE_MEM_NOEV, true, WSE_FOREIGN), false);

// -- wrap gate (Stop only) --
function runWrapGate(transcriptPath, memDir, enforce, { stopActive = false, cwd = WSE_REPO } = {}) {
  const input = JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcriptPath, session_id: WSE_SID, cwd, stop_hook_active: stopActive });
  let out = '';
  try { out = execFileSync('node', [WSE_WRAP], { input, encoding: 'utf8', env: wseEnv(memDir, enforce) }); } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  return /"decision"\s*:\s*"block"/.test(out);
}
const wseWrapWork = writeFixture('wse_wrap_work', [userPrompt('wrap up for the day'), asstTool('Write', { file_path: 'x.js', content: 'y' }), toolResult(), asstText('All finished for today.')]);
const wseFalsePos = writeFixture('wse_wrap_fp',   [userPrompt('wrap the string in quotes'), asstTool('Write', { file_path: 'x.js', content: 'y' }), toolResult(), asstText('I wrapped the string in quotes as requested.')]);
const wseReadOnly = writeFixture('wse_wrap_readonly', [userPrompt('wrap up for the day'), asstTool('Read', { file_path: 'x.js' }), toolResult(), asstText('Here is what I found.')]);
wseResetMarkers(); expect('83. wrap-gate: wrap + work + no-evidence (ENFORCE) → BLOCK', runWrapGate(wseWrapWork, WSE_MEM_NOEV, true), true);
wseResetMarkers(); expect('84. wrap-gate: wrap + work + no-evidence (default — v2 ENFORCING, MEMGATE_ENFORCE unset) → BLOCK', runWrapGate(wseWrapWork, WSE_MEM_NOEV, false), true);
wseResetMarkers(); expect('84b. wrap-gate: wrap + work + no-evidence (MEMGATE_ENFORCE=0 explicit opt-out) → ALLOW (would-block only)', runWrapGate(wseWrapWork, WSE_MEM_NOEV, '0'), false);
wseResetMarkers(); expect('85. wrap-gate: wrap + work + valid-note-evidence (ENFORCE) → ALLOW', runWrapGate(wseWrapWork, WSE_MEM_EV, true), false);
wseResetMarkers(); expect('86. wrap-gate: false-positive phrase "wrap the string" (ENFORCE) → ALLOW (no engage)', runWrapGate(wseFalsePos, WSE_MEM_NOEV, true), false);
wseResetMarkers(); expect('87. wrap-gate: circuit breaker (stop_hook_active) (ENFORCE) → ALLOW', runWrapGate(wseWrapWork, WSE_MEM_NOEV, true, { stopActive: true }), false);
wseResetMarkers(); expect('88. wrap-gate: read-only session (no edits/side-effect shell) (ENFORCE) → ALLOW (trivial session)', runWrapGate(wseReadOnly, WSE_MEM_NOEV, true), false);
// v2 Task weight: DELEGATED work (Task tool_use) is counted — a fan-out session is NOT trivial.
const wseTaskOnly = writeFixture('wse_wrap_taskonly', [userPrompt('wrap up for the day'), asstTool('Task', { description: 'build the pages', prompt: 'build all 60 pages', subagent_type: 'general-purpose' }), toolResult(), asstText('All finished for today.')]);
wseResetMarkers(); expect('88b. wrap-gate: DELEGATED-only session (Task, no direct edits) + no-evidence (ENFORCE) → BLOCK (v2 Task weight)', runWrapGate(wseTaskOnly, WSE_MEM_NOEV, true), true);

// -- inject-wrap-memory-directive (UserPromptSubmit) --
function runInjectWrap(prompt, sid) {
  const input = JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, session_id: sid });
  let out = '';
  try { out = execFileSync('node', [WSE_INJECT], { input, encoding: 'utf8' }); } catch (e) { out = e.stdout || ''; }
  return out;
}
{ const o = runInjectWrap('lets wrap up for the day', 'SID-WSE-INJ'); expect('89. inject-wrap: wrap prompt → additionalContext has live sid + recall.mjs', /SID-WSE-INJ/.test(o) && /recall\.mjs/.test(o) && /additionalContext/.test(o), true); }
{ const o = runInjectWrap('fix the bug in server.js', 'SID-WSE-INJ'); expect('90. inject-wrap: non-wrap prompt → no output (empty)', o.trim() === '', true); }

// ---- Q2 canaries (2026-07-07 audit): UPDATE-only pass credits via metadata.lastSessionId ----
expect('98. oracle Q2: UPDATE-only note (lastSessionId===sid, originSessionId foreign) → exit 0', runOracleExit(WSE_SID, WSE_MEM_UPD, WSE_SINCE), 0);
wseResetMarkers(); wseStage(WSE_REPO, [{ path: 'big.txt', lines: 40 }]);
expect('99. commit-gate Q2: non-trivial + UPDATE-only evidence (ENFORCE) → ALLOW', runCommitGate('git commit -m x', WSE_MEM_UPD, true), false);
wseResetMarkers();
expect('100. wrap-gate Q2: wrap + work + UPDATE-only evidence (ENFORCE) → ALLOW', runWrapGate(wseWrapWork, WSE_MEM_UPD, true), false);

// ---- Q7 canaries (2026-07-07 audit): pass-markers are VALIDATED, not existence-checked ----
// forged marker (fresh ts, but no sid / no oracle:'pass') must be IGNORED → gate still engages
wseResetMarkers(); wseSeedMarker({ ts: Date.now() }); wseStage(WSE_REPO, [{ path: 'big.txt', lines: 40 }]);
expect('101. commit-gate Q7: FORGED marker (no sid/oracle) + no-evidence (ENFORCE) → BLOCK', runCommitGate('git commit -m x', WSE_MEM_NOEV, true), true);
// wrong-sid forged marker equally ignored
wseResetMarkers(); wseSeedMarker({ sid: 'SOMEONE-ELSE', ts: Date.now(), oracle: 'pass' }); wseStage(WSE_REPO, [{ path: 'big.txt', lines: 40 }]);
expect('102. commit-gate Q7: FORGED marker (wrong sid) + no-evidence (ENFORCE) → BLOCK', runCommitGate('git commit -m x', WSE_MEM_NOEV, true), true);
// a VALID marker (sid + oracle:pass + fresh ts) is honored
wseResetMarkers(); wseSeedMarker({ sid: WSE_SID, ts: Date.now(), oracle: 'pass', notes: [] }); wseStage(WSE_REPO, [{ path: 'big.txt', lines: 40 }]);
expect('103. commit-gate Q7: VALID marker (sid+oracle:pass) (ENFORCE) → ALLOW', runCommitGate('git commit -m x', WSE_MEM_NOEV, true), false);
// wrap gate validates too
wseResetMarkers(); wseSeedMarker({ ts: Date.now() });
expect('104. wrap-gate Q7: FORGED marker + wrap + work + no-evidence (ENFORCE) → BLOCK', runWrapGate(wseWrapWork, WSE_MEM_NOEV, true), true);

// ---- Q13 canaries (2026-07-07 audit): WRAP_RE false positives NO-ENGAGE, true wraps ENGAGE ----
// wrap gate: an approval phrase must not trigger the gate at all
{
  const f = writeFixture('wse_wrap_signoff_on', [userPrompt('sign off on this PR please'), asstTool('Write', { file_path: 'x.js', content: 'y' }), toolResult(), asstText('Reviewed and commented.')]);
  wseResetMarkers();
  expect('105. wrap-gate Q13: "sign off on this PR" + work + no-evidence (ENFORCE) → ALLOW (no engage)', runWrapGate(f, WSE_MEM_NOEV, true), false);
}
// inject: the 6 false-positive phrases emit NOTHING
{ const o = runInjectWrap('sign off on this PR', 'SID-Q13'); expect('106. inject Q13 FP: "sign off on this PR" → no output', o.trim() === '', true); }
{ const o = runInjectWrap('wrap up a promise chain here', 'SID-Q13'); expect('107. inject Q13 FP: "wrap up a promise chain" → no output', o.trim() === '', true); }
{ const o = runInjectWrap("done for now, next let's fix the tests", 'SID-Q13'); expect('108. inject Q13 FP: "done for now, next..." → no output', o.trim() === '', true); }
{ const o = runInjectWrap('wrap up the refactor before lunch', 'SID-Q13'); expect('109. inject Q13 FP: "wrap up the refactor" → no output', o.trim() === '', true); }
{ const o = runInjectWrap('signing off on the changes now', 'SID-Q13'); expect('110. inject Q13 FP: "signing off on the changes" → no output', o.trim() === '', true); }
{ const o = runInjectWrap('wrap up my review comments', 'SID-Q13'); expect('111. inject Q13 FP: "wrap up my review comments" → no output', o.trim() === '', true); }
// inject: true wrap phrasings still ENGAGE
{ const o = runInjectWrap('ok wrap it up', 'SID-Q13'); expect('112. inject Q13: "wrap it up" → engages', /additionalContext/.test(o), true); }
{ const o = runInjectWrap('call it a night', 'SID-Q13'); expect('113. inject Q13: "call it a night" → engages', /additionalContext/.test(o), true); }
{ const o = runInjectWrap('done for now', 'SID-Q13'); expect('114. inject Q13: standalone "done for now" → engages', /additionalContext/.test(o), true); }
{ const o = runInjectWrap('wrap up the session', 'SID-Q13'); expect('115. inject Q13: "wrap up the session" → engages', /additionalContext/.test(o), true); }
{ const o = runInjectWrap('time to sign off', 'SID-Q13'); expect('116. inject Q13: "time to sign off" → engages', /additionalContext/.test(o), true); }

// cleanup WS-E throwaways (all under os.tmpdir(); never ~/.claude or the repo)
for (const d of [WSE_HOME, WSE_REPO, WSE_FOREIGN, WSE_MEM_EV, WSE_MEM_NOEV, WSE_MEM_MAL, WSE_MEM_UPD]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }

}
if (!WSE_ORACLE_PRESENT) console.log(`\n  (SKIP WS-E memory-pass cases 73-90/98-116: Code/memory-system/verify-memory-pass.mjs not found in any ancestor of this harness or in ~/ace)`);

// ---- report ----
let allPass = true;
console.log('\n=== deterministic-hook layer — both-directions test ===');
for (const c of cases) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}` + (c.pass ? '' : `   (got=${c.got} want=${c.want})`));
  if (!c.pass) allPass = false;
}
console.log(`\n${allPass ? 'ALL PASS' : 'SOME FAILED'} (${cases.filter(c => c.pass).length}/${cases.length})`);
process.exit(allPass ? 0 : 1);
