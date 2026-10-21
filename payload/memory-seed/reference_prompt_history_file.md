---
name: The prompt history file
description: ~/.claude/history.jsonl holds every prompt typed into the Claude Code CLI on this machine, across all projects, one JSON line each with text, time, project folder and session id; use it to find which session worked on a topic or to spot a message sent to the wrong session.
metadata:
  type: reference
  seed: aceos-starter
---
Each line is roughly `{"display": "<what was typed>", "pastedContents": {...}, "timestamp": <epoch ms>,
"project": "<folder the session ran in>", "sessionId": "<id>"}`. Pastes and images appear as placeholders. It covers
this machine's CLI only, and only what the person typed (not work Claude started on its own).

**Uses**
1. "Did any session work on X after date D?" One pass over this file answers it for every project folder, where
   grepping transcripts means streaming large files.
2. Find the session for a topic, then open that session's transcript for the detail.
3. Place a message that does not fit the conversation: people running several sessions sometimes type into the wrong
   one. If a message starts mid-thought or is about another piece of work, check the last lines of this file; if the
   same text went to another session moments earlier, say in one line that it looks meant for that chat and change
   nothing.

**Why:** it is the cheapest complete index of what was asked, when, and where.

**How to apply:** read it, never edit it. Related: [[reference_transcript_queued_messages]].
