---
name: A syntax check is not a run check
description: node --check answers whether a parser accepts the file as a module, never whether it runs where it is actually loaded; code run inside a vm sandbox, eval, a worker, or an injected page script can pass the check and die at once.
metadata:
  type: reference
  seed: aceos-starter
---
A file that is not loaded as a normal module (a snippet executed in a `vm` context, `eval`'d code, a worker body, a
script injected into a browser page) has a different set of globals. A fix that uses `__dirname` is valid CommonJS
grammar, so `node --check` passes, while in a context that only provides, say, `page`, it throws a ReferenceError on
the first run; `import.meta` fails to compile there at all.

**Why:** a syntax gate certifies broken files as fixed whenever the execution context differs from a module, and the
proof-of-work gate accepts `node --check` as evidence.

**How to apply:** before relying on a syntax check, find out how the file is actually loaded. Verify by running it in
that same context (replicate the harness if needed). Related: [[feedback_closing_message_what_stop_gates_want]].
