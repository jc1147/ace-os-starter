#!/usr/bin/env node
// Injects the Ultracode + Remote Control default directive as additionalContext.
// A launcher app can pass `--effort ultracode --remote-control` as LAUNCH FLAGS
// when it spawns claude. But a user who types `claude`
// in a terminal gets no such flags — there is no persistent settings.json lock for
// either (effortLevel only accepts low..max; there is no remote-control auto-enable
// key). This SessionStart hook closes that gap by telling every session that
// ultracode is the intended default and how to opt into Remote Control.
// Event-agnostic: safe on SessionStart (main agent) AND SubagentStart; echoes back
// whatever hook_event_name it received so the payload is valid for either.
// Fail-OPEN: any error emits nothing (never break a session).

'use strict';

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(data || '{}'); } catch (_) {}
  const event = input.hook_event_name || 'SessionStart';
  const directive =
    '[Ultracode + Remote Control — session default]\n' +
    'Ultracode is the DEFAULT effort for this session. Treat substantive, multi-step ' +
    'work as workflow-worthy by default: author and run Workflows rather than doing ' +
    'long build/debug/research work ad hoc. The user may lower this at any time with ' +
    '/effort (e.g. `/effort high`) — ultracode is the floor, not a lock.\n' +
    'Remote Control: this session can be driven from a phone. Run `/remote-control` to ' +
    'start it for THIS session, or turn on "Enable Remote Control for all sessions" in ' +
    '`/config` to make every session controllable from mobile. If the account is not ' +
    'eligible the local session keeps running normally without it.';
  try {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: event, additionalContext: directive }
    }));
  } catch (_) { /* fail-open */ }
  process.exit(0);
});
