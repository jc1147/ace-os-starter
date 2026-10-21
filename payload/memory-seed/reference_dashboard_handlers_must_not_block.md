---
name: Ace OS dashboard handlers must not block
description: The Ace OS dashboard server is one Node process; any heavy synchronous scan inside a request handler (reading every transcript, formatting a date per log line) freezes every other request, so build heavy data in a cached background refresh and let handlers only read the cache.
metadata:
  type: reference
  seed: aceos-starter
---
Node runs request handlers on one thread. A handler that synchronously reads gigabytes of session transcripts, or
does expensive work per line of a large log on every poll, blocks all other requests: the page looks dead, cards flap
to "unreachable", while the server is still listening.

**The pattern**
- A module-level cache, refreshed on a timer (minutes, not seconds) and warmed once shortly after the server starts.
- Build it with async, streaming reads (for example `readline`) so it yields to the event loop.
- The `/api/*` handler only reads or slices the cache, so it answers instantly.
- For date bucketing, compute the day's window once and compare ISO strings; do not format a date per line.

**Why:** the dashboard polls several endpoints every few seconds; one slow handler makes the whole shell unusable.

**How to apply:** when adding a panel or endpoint to `Code/os-dashboard/server.js`, keep the handler cheap and move
any scan into a cached refresh. Verify by loading the page while the refresh runs. Related:
[[feedback_render_verify_dashboard_by_looking]].
