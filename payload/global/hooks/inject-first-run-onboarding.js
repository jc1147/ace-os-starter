#!/usr/bin/env node
// First-run onboarding trigger. On a FRESH install nothing tells a new Ace OS user to
// run the guided setup -- they would have to somehow know to type "start here". This SessionStart
// hook closes that gap: when the completion marker `<configDir>/.ace-os-onboarded` is ABSENT, it
// injects a context block that LEADS the assistant to run the start-here onboarding before other
// work. Once onboarding finishes, start-here writes that marker (this hook never writes it), so
// the nag stops firing -- one-time, idempotent, read-only.
//
// configDir = process.env.CLAUDE_CONFIG_DIR || os.homedir()+'/.claude'  (CLAUDE_CONFIG_DIR-aware,
// same convention Claude Code uses to relocate its config).
//
// Event-agnostic: echoes back whatever hook_event_name it received so the payload is valid for the
// event it is wired on (SessionStart). Fail-OPEN: any error -> emit nothing, exit 0 (NEVER block a
// session, never nag on error). Marker PRESENT -> emit nothing (no nag).

'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(data || '{}'); } catch (_) {}
  const event = input.hook_event_name || 'SessionStart';
  try {
    const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const marker = path.join(configDir, '.ace-os-onboarded');
    // Already onboarded -> stay silent (no nag).
    if (fs.existsSync(marker)) { process.exit(0); }
    // Fresh install -> lead the assistant into the start-here onboarding.
    const directive =
      '[FIRST RUN — Ace OS onboarding not yet completed]\n' +
      'Ace OS has not been set up for its user yet (the completion marker ' +
      '`<configDir>/.ace-os-onboarded` is absent, where configDir = $CLAUDE_CONFIG_DIR or ' +
      '~/.claude). Before starting other work, walk the user through first-run onboarding by ' +
      'invoking the `start-here` agent. It ships in the Ace OS workspace (~/ace): if this session ' +
      'was not started in ~/ace and the agent is not available, tell the user to open the ~/ace ' +
      'folder in Claude Code and say "start here". It covers who they are and what they do (saved ' +
      'to the brain as a user note via the memory skill), their goals, and their first project. ' +
      'When onboarding finishes, the start-here agent writes the completion marker ' +
      '`<configDir>/.ace-os-onboarded`, after which this message stops appearing. ' +
      'If the user explicitly says they have already set up / wants to skip, respect that and ' +
      'move on (do not force it).';
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: event, additionalContext: directive }
    }));
  } catch (_) { /* fail-open: emit nothing */ }
  process.exit(0);
});
