#!/usr/bin/env node
// GLOBAL memory INDEX-DISCIPLINE gate — PreToolUse(Write|Edit) on MEMORY.md / _MOC-*.md (hand edits).
// The cap gate (block-memory-md-too-large) stops TOTAL bloat; this stops PER-LINE bloat — a 400+ char
// status-dump masquerading as a "short hook". That per-line creep is what pushed MEMORY.md to ~85% of cap.
// The index is POINTERS, not status pages: one line = "what it is + why you'd recall it"; detail lives in
// the atomic note. Generated MOCs (written by build-mocs.mjs via fs, not the Write tool) never trip this —
// only manual Write/Edit-tool edits do. Fail-OPEN on any error.

const MAX_LINE = 350;
const PATH_PAT = /[\/\\](MEMORY|_MOC-[a-z]+)\.md$/i;
const POINTER = /^\s*-\s*\[/;   // a markdown index pointer line

let data = "";
process.stdin.on("data", (c) => (data += c));
process.stdin.on("end", () => {
  let input = {};
  try { input = JSON.parse(data || "{}"); } catch (_) { return; }
  const fp = input?.tool_input?.file_path || "";
  if (!PATH_PAT.test(fp)) return;
  const tool = input?.tool_name || "";
  let text = "";
  if (tool === "Write" && typeof input?.tool_input?.content === "string") text = input.tool_input.content;
  else if (tool === "Edit" && typeof input?.tool_input?.new_string === "string") text = input.tool_input.new_string;
  else return;

  const bad = [];
  for (const ln of text.split(/\r?\n/)) { if (POINTER.test(ln) && ln.length > MAX_LINE) bad.push(ln.length); }
  if (bad.length) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `This memory-index write adds ${bad.length} pointer line(s) over ${MAX_LINE} chars (longest ${Math.max(...bad)}). The index is POINTERS, not status pages — long hooks are the per-line bloat that fills the cap. Shorten each to a one-line "what it is + why you'd recall it" (<${MAX_LINE} chars) and put the detail/status in the atomic note body. Then retry.`
      }
    }));
    return;
  }
});
