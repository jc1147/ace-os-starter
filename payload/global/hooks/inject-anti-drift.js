#!/usr/bin/env node
// Anti-drift: re-inject a TERSE contract reminder on every user prompt so the operating
// discipline stays in context through long sessions (especially after compaction, when the
// original SessionStart injection may have been summarized away).
// Pure context injection — never blocks. Fail-OPEN. Kept short on purpose (token cost every turn).

'use strict';
let data = '';
process.stdin.on('data', c => (data += c));
process.stdin.on('end', () => {
  try { JSON.parse(data || '{}'); } catch (_) {}
  const reminder =
    '[Deterministic Operating Contract — active] decide-before-acting; no defaults/assumptions ' +
    '(read source, label anything unverified); evidence-or-flag; re-audit before declaring done; ' +
    'stick to the committed plan; fail closed; facts not self-promotion. ' +
    'A Stop gate bounces any "done/works/fixed" claim that follows file edits without verification. ' +
    'Full text: ~/.claude/deterministic-contract.md';
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: reminder }
  }));
  process.exit(0);
});
