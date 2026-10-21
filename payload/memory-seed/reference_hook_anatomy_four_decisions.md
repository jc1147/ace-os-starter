---
name: Hook anatomy, the four decisions
description: Writing a Claude Code hook comes down to four decisions that fail when guessed - which event, which scope, which output (exit 0 pass, exit 2 plus stderr to block, JSON on stdout to inject or decide), and invocation (the event arrives as JSON on stdin, never in argv).
metadata:
  type: reference
  seed: aceos-starter
---
1. **Event.** PreToolUse (stop a tool call before it runs), PostToolUse, Stop and SubagentStop (check the end of a
   turn), UserPromptSubmit and SessionStart or SubagentStart (inject context), PreCompact, and others.
2. **Scope.** User `~/.claude/settings.json` (every project), project `.claude/settings.json` (sessions launched
   there), or skill/agent frontmatter (only while it is active). See [[reference_hook_scoping_settings_vs_skill]].
3. **Output.** Pass: exit 0 with no output. Block: exit 2 with the reason on stderr (the model sees it), or a JSON
   decision on stdout. Inject: exit 0 with JSON `additionalContext` on stdout (the shape depends on the event).
4. **Invocation.** The event payload is JSON on **stdin** (`JSON.parse(fs.readFileSync(0, 'utf8'))`); argv is
   empty. The `matcher` filters by tool name (`Write|Edit`, `Bash|PowerShell`).

**Why:** each of these is a silent failure when wrong: a hook on the wrong event never fires, a hook reading argv
sees nothing and passes everything, a hook that exits 1 instead of 2 does not block.

**How to apply:** decide all four explicitly before writing code, keep the hook fail-open on its own errors (a
crashing hook must not brick every session), and test both paths: one input it must pass and one it must block.
Ship it in diagnostic mode first ([[feedback_new_blocking_hooks_ship_diag_first]]).
