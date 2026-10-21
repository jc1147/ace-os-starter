---
name: A session's liveness is its process, not its heartbeat file
description: To tell a busy Claude session from a dead one, check whether its process id is alive; the session file's updatedAt does not refresh during a long tool call, and the main transcript goes quiet while a workflow's agents write to their own transcripts.
metadata:
  type: reference
  seed: aceos-starter
---
**Two facts that look like a stalled session and are not**
- `~/.claude/sessions/<pid>.json` has an `updatedAt` that does **not** refresh during a long tool call, so "busy if
  updated in the last 5 minutes" falsely marks a working session as idle or dead. The reliable signal is the process:
  `process.kill(pid, 0)` succeeds (or fails with EPERM) when it is alive.
- While a multi-agent workflow runs, the **main** session transcript can stay byte-identical for minutes. The work is
  in the workflow's own folder: each agent's transcript grows, and its journal records started and finished agents.

**Why:** live-session panels and "is it stuck?" checks built on the heartbeat or the main transcript report healthy
sessions as dead, and someone kills or restarts work that was progressing.

**How to apply:** for liveness use the pid; for progress of a workflow read its agent transcripts and journal. Never
kill a session you did not start on the strength of a quiet transcript. Related:
[[reference_dashboard_handlers_must_not_block]].
