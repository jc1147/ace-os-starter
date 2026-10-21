---
name: The dashboard chat is off until you arm it
description: The Ace OS dashboard chat can start a claude process, so it is off by default; it turns on only when the file Code/os-dashboard/.chat-enabled exists, and every chat request also needs the secret X-Chat-Token header and a loopback origin. Any endpoint that can spawn a process gets its auth gate before the capability.
metadata:
  type: reference
  seed: aceos-starter
---
**How the chat is guarded**
- **Off by default.** The routes answer 403 until you create `Code/os-dashboard/.chat-enabled` yourself. Nothing in
  the dashboard creates that file.
- **A secret token.** Requests must carry an `X-Chat-Token` header matching the server's token (compared in constant
  time). The token is given only to the page the server itself serves on loopback, and a custom header forces a
  browser preflight that another website cannot pass.
- **Loopback only.** The origin and host must be the local machine.

**Why:** any endpoint that can start `claude`, a shell or a terminal is remote code execution for whoever can reach
it. The safe order is: land the auth gate and a guarded stub first, prove 401 without the token and 200 with it,
then add the spawning route behind it. Exposing the capability and "adding auth next" leaves an open window.

**How to apply:** leave chat off unless you want it. If you add any route that starts a process or writes files,
put it behind the same three guards and test the refusal paths first. Do not commit or share the token file.
