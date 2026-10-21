---
name: An unschema'd synthesis agent can answer the memory hook instead of its task
description: In a multi-agent workflow, a final synthesis agent that returns free text (no output schema) can be pulled off task by the injected memory protocol and return a "nothing to persist" meta-message; give it a schema, or synthesize yourself from the workflow journal.
metadata:
  type: reference
  seed: aceos-starter
---
Every subagent gets the memory protocol injected at start (SubagentStart). A final workflow step that asks for a free
text digest, with no structured output schema, has been seen to answer the injected memory instructions instead of
its task ("not a durable memory fact, nothing to persist"). Upstream agents that returned a forced schema were fine.

**Why:** a structured output contract anchors the agent to its task; free text has nothing to hold it against the
injected context.

**How to apply:**
- Give the synthesis agent an output schema too, or plan to synthesize the deliverable yourself.
- Recovery without re-running: the per-agent results are in the workflow's journal (one result line per agent), and
  the full final result is in the task output file the completion notification names.

Related: [[reference_how_your_brain_works]].
