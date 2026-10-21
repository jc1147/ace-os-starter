#!/usr/bin/env node
// GLOBAL memory gate — PreToolUse(Write|Edit) on any project's MEMORY.md.
//
// v2 (2026-07-10): enforces ROUTER DISCIPLINE, not just the truncation cap. The user-visible
// failure this closes: MEMORY.md creeping (15%→20% in a day) because sessions append a pin per
// note; the old gate only fired at the catastrophic 24.4KB harness-truncation threshold, so
// creep was invisible until cleanup day. Now the write is blocked AT THE BUDGET, with the fix
// (hub notes / one-in-one-out / _sunset) in the deny message. See the `memory` + `wrap-up` skills.
//
// Checks on the RESULTING file (Write = content; Edit = current file with the replace simulated):
//   1. HARD CAP    > 24,400 bytes  — harness truncates; late pins never load. (v1 check.)
//   2. ROUTER BUDGET > 6,000 bytes — MEMORY.md is a fixed-budget router (~14 pins + initiatives);
//      the budget forces rotation long before the hard cap.
//   3. BULLET BUDGET > 22 `- [` lines — one-in-one-out: merge into a hub note or demote a pin.
//   4. LINE LENGTH  any `- [` line > 220 chars — the pin only needs to trigger recall; detail
//      lives in the note body.
// Fail-OPEN on any parse/read error — never wedge a session. Deny ONLY on a deterministic
// over-budget result.

const HARD_CAP_BYTES = 24400; // harness truncation threshold
const ROUTER_BUDGET_BYTES = 6000; // ~25% of hard cap — the working ceiling that forces rotation
const MAX_BULLET_LINES = 22; // tree links + initiatives + essentials, with modest headroom
const MAX_PIN_LINE_CHARS = 220; // longest allowed `- [` pointer line
const MEMORY_PATH_PATTERN = /[\/\\]MEMORY\.md$/;

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason
    }
  }));
}

const REMEDY = `MEMORY.md is a fixed-budget ROUTER, not an append-log. Fix, then retry: ` +
  `(a) new notes need NO MEMORY.md line — the manifest/MOC regen indexes them (memory skill step 3); ` +
  `(b) themed pins merge into a HUB note (e.g. reference_<theme>_hub) that keeps ONE line; ` +
  `(c) adding a genuine always-on pin = one-in-one-out — demote or merge an existing pin; ` +
  `(d) stale pins soft-archive to _sunset/. Audit anytime: node "$HOME/ace/Code/memory-system/router-audit.mjs"`;

let data = "";
process.stdin.on("data", chunk => data += chunk);
process.stdin.on("end", () => {
  let input = {};
  try { input = JSON.parse(data || "{}"); } catch (_) { return; }

  const filePath = input?.tool_input?.file_path || "";
  if (!MEMORY_PATH_PATTERN.test(filePath)) return;

  const toolName = input?.tool_name || "";
  let resultText = null;

  try {
    if (toolName === "Write" && typeof input?.tool_input?.content === "string") {
      resultText = input.tool_input.content;
    } else if (toolName === "Edit") {
      const fs = require("fs");
      const cur = fs.readFileSync(filePath, "utf8");
      const oldStr = input?.tool_input?.old_string ?? "";
      const newStr = input?.tool_input?.new_string ?? "";
      if (!oldStr) return; // nothing to simulate -> allow (tool will error itself if invalid)
      resultText = input?.tool_input?.replace_all
        ? cur.split(oldStr).join(newStr)
        : cur.replace(oldStr, newStr);
    } else {
      return; // unknown tool -> allow
    }
  } catch (_) {
    return; // fail-OPEN: never wedge on a read/simulate error
  }
  if (typeof resultText !== "string") return;

  const resultBytes = Buffer.byteLength(resultText, "utf8");

  // 1. hard cap (v1 behavior, unchanged)
  if (resultBytes > HARD_CAP_BYTES) {
    return deny(`MEMORY.md write would be ${resultBytes} bytes (> ${HARD_CAP_BYTES} hard cap — the harness truncates near 24.4KB and late pins stop loading). ${REMEDY}`);
  }
  // 2. router budget
  if (resultBytes > ROUTER_BUDGET_BYTES) {
    return deny(`MEMORY.md write would be ${resultBytes} bytes (> ${ROUTER_BUDGET_BYTES} ROUTER BUDGET). ${REMEDY}`);
  }
  // 3 + 4. bullet count + pin line length
  const lines = resultText.split(/\r?\n/);
  let bullets = 0;
  for (const line of lines) {
    if (/^- \[/.test(line)) {
      bullets++;
      if (line.length > MAX_PIN_LINE_CHARS) {
        return deny(`MEMORY.md pin line is ${line.length} chars (> ${MAX_PIN_LINE_CHARS}): "${line.slice(0, 80)}…" — a pin only needs enough to trigger recall; the detail belongs in the note body. ${REMEDY}`);
      }
    }
  }
  if (bullets > MAX_BULLET_LINES) {
    return deny(`MEMORY.md write would have ${bullets} bullet lines (> ${MAX_BULLET_LINES} BULLET BUDGET). ${REMEDY}`);
  }
});
