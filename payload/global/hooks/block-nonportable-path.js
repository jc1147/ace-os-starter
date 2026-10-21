#!/usr/bin/env node
// GLOBAL portability gate -- PreToolUse(Write|Edit|MultiEdit). Blocks any write/edit that
// INTRODUCES a machine-specific absolute user path or a username-derived memory slug into
// RUNTIME CODE, so work stays portable across machines and user accounts. This is the standing
// enforcement of the invariant: a runtime-code scan for machine paths finds none.
// Derive instead: os.homedir(), process.env.USERPROFILE, CLAUDE_PROJECT_DIR, a repoSlug() of
// the repo path, or a relative path.
//
// SCOPE (deliberately narrow to avoid false positives): only runtime-code file types
// (.js/.mjs/.cjs/.ts/.tsx/.py/.ps1/.psm1/.sh/.bash/.bat/.cmd). Docs (.md), JSON/data, logs,
// memory notes, and fixtures are NOT inspected -- they legitimately carry real paths.
// A comment line is allowed. A line carrying a `portable-exempt` marker is allowed. Files under
// node_modules/logs/_archive/_quarantine/_renders/fixtures/_sunset are skipped. For Edit, a
// literal already present in old_string is NOT flagged (only NEWLY introduced literals count).
//
// Fail-OPEN: any parse/read error, unknown tool, or missing field -> return (allow). It must
// never wedge a session. Fail-CLOSED only on the one thing it checks: a machine literal added
// to code.

const CODE_EXT = /\.(m?[jt]sx?|cjs|py|ps1|psm1|sh|bash|bat|cmd)$/i;
// username-agnostic machine-path scan
const MACHINE_PATH = /[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9._-]+|\/[a-z]\/Users\/[A-Za-z0-9._-]+|C-{2}Users-[A-Za-z0-9._-]+/;
const SKIP_SEG = /[\\/](node_modules|logs|_archive|_quarantine|_renders|fixtures|_sunset)[\\/]/i;
const EXEMPT = /portable-exempt/;
const COMMENT_LINE = /^\s*(\/\/|#|\*|\/\*|<!--|--)/;

let data = "";
process.stdin.on("data", (c) => (data += c));
process.stdin.on("end", () => {
  let input = {};
  try { input = JSON.parse(data || "{}"); } catch (_) { return; }
  try {
    const fp = input?.tool_input?.file_path || "";
    if (!fp || !CODE_EXT.test(fp)) return;   // only runtime-code files
    if (SKIP_SEG.test(fp)) return;            // inert / legitimate-literal dirs

    const tool = input?.tool_name || "";
    const ti = input?.tool_input || {};
    // Pair each NEW text chunk with the OLD text it replaces (so pre-existing literals don't count).
    const pairs = [];
    if (tool === "Write" && typeof ti.content === "string") {
      pairs.push({ neu: ti.content, alt: "" });
    } else if (tool === "Edit" && typeof ti.new_string === "string") {
      pairs.push({ neu: ti.new_string, alt: typeof ti.old_string === "string" ? ti.old_string : "" });
    } else if (tool === "MultiEdit" && Array.isArray(ti.edits)) {
      for (const e of ti.edits) {
        if (e && typeof e.new_string === "string") pairs.push({ neu: e.new_string, alt: typeof e.old_string === "string" ? e.old_string : "" });
      }
    } else {
      return; // unknown tool / no new text -> allow
    }

    const violations = [];
    for (const { neu, alt } of pairs) {
      for (const line of neu.split(/\r?\n/)) {
        if (COMMENT_LINE.test(line)) continue;   // comments may reference real paths
        if (EXEMPT.test(line)) continue;          // explicit escape hatch
        const m = line.match(MACHINE_PATH);
        if (m && !alt.includes(m[0])) violations.push(m[0]);   // only NEWLY introduced literals
      }
    }

    if (violations.length) {
      const uniq = [...new Set(violations)].slice(0, 5);
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            `Non-portable machine-specific path(s) in code: ${uniq.join(", ")}. ` +
            `This breaks portability to another machine or user account -- runtime code must not hardcode an absolute ` +
            `user-home path or a username-derived memory slug. Derive it instead: os.homedir() or ` +
            `process.env.USERPROFILE, CLAUDE_PROJECT_DIR, a repoSlug() of the repo path, or a RELATIVE ` +
            `path. If this literal is genuinely required (a test fixture, an intentional example), append ` +
            `a "portable-exempt" comment on that line, then retry. (Only code files are gated -- docs, ` +
            `JSON, and logs are not.)`,
        },
      }));
      return;
    }
  } catch (_) {
    return; // fail-open on any internal error -- never wedge a session
  }
});
