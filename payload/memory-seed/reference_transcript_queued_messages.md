---
name: Messages typed mid-turn are queued entries in the transcript
description: When reconstructing what the user asked (a wrap-up gap-hunt, a "did I miss a request" check), read the queued-message records in the session transcript as well as the plain user turns; messages typed while Claude was working are stored differently, and image messages have no plain text.
metadata:
  type: reference
  seed: aceos-starter
---
Session transcripts live at `~/.claude/projects/<slug>/<session-id>.jsonl`. A message typed while Claude is
mid-turn is not a plain `type: "user"` turn:
- it is recorded as `{"type": "queue-operation", "operation": "enqueue", ...}` when sent,
- and delivered as an attachment of type `queued_command` whose `prompt` is a string or a content array.

**Which to trust:** the person's own messages are the `queued_command` attachments whose `origin.kind` is `human`.
Many other queued entries are machine events (task notifications, messages from other agents). Enqueue records
both over-count (machine events) and under-count (a message with a screenshot can have no `content` string; its
prompt is a block array).

**Why:** in a long, busy session most corrections arrive mid-turn. A scan of plain user turns misses them, and with
them the sharpest feedback of the session.

**How to apply:** in a gap-hunt or any reconstruction, collect both plain user turns and human-origin
`queued_command` attachments, and handle array prompts. Related: [[reference_prompt_history_file]].
