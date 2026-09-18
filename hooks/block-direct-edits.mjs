#!/usr/bin/env node
// PreToolUse hook: refuse Edit/Write/NotebookEdit on repository source files
// unless an external-model output file exists for this project. This turns
// "the brain does not code" from a memory into a mechanism.
//
// Delegation mode is on when LLM_DELEGATION=1 is set or ~/.claude/llm-delegation.on exists.
// Off → the hook is a no-op.
//
// Evidence: a file named *.llm-output.* written within the last 30 minutes under
// the *current project's* scratch root, i.e. <tmp>/claude/<project-slug>/…, where
// the slug is the cwd with every non-alphanumeric character replaced by "-"
// (C:\Users\me\repo → C--Users-me-repo). llm.mjs --out writes there when the
// relay-implementer agent uses the session scratchpad. Scoping to the project
// keeps one session's evidence from unlocking edits in another.
//
// The codex lane edits files through its own process, not through Claude's Edit
// tool, so it never hits this hook. The hook only stops the main session (or a
// stray subagent) from typing repo code by hand.
//
// Registered by hooks/hooks.json when the plugin is loaded.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let input;
try {
  input = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
const tool = input.tool_name || "";
if (!/^(Edit|Write|NotebookEdit)$/.test(tool)) process.exit(0);

const onFile = path.join(os.homedir(), ".claude", "llm-delegation.on");
const active = process.env.LLM_DELEGATION === "1" || fs.existsSync(onFile);
if (!active) process.exit(0);

const cwd = path.resolve(String(input.cwd || process.cwd()));
const rawTarget = String(input.tool_input?.file_path || input.tool_input?.notebook_path || "");
if (!rawTarget) process.exit(0);
const target = path.resolve(cwd, rawTarget);

const norm = (p) => p.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
const inRepo = norm(target).startsWith(norm(cwd) + "/") || norm(target) === norm(cwd);
const isScratch = /\/temp\/claude\//i.test(norm(target)) || /\/\.claude\//i.test(norm(target));
if (!inRepo || isScratch) process.exit(0);

// Project-scoped scratch roots.
const slug = cwd.replace(/[^A-Za-z0-9]/g, "-");
const roots = new Set([
  path.join(os.tmpdir(), "claude", slug),
  path.join(os.homedir(), "AppData", "Local", "Temp", "claude", slug),
]);
if (process.env.CLAUDE_SCRATCHPAD_DIR) roots.add(process.env.CLAUDE_SCRATCHPAD_DIR);

const fresh = Date.now() - 30 * 60 * 1000;
let evidence = false;
for (const root of roots) {
  if (evidence) break;
  if (!fs.existsSync(root)) continue;
  const stack = [root];
  let visited = 0;
  while (stack.length && !evidence && visited < 2000) {
    const dir = stack.pop();
    visited++;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (/\.llm-output\./.test(e.name)) {
        try {
          if (fs.statSync(p).mtimeMs > fresh) {
            evidence = true;
            break;
          }
        } catch {}
      }
    }
  }
}
if (evidence) process.exit(0);

process.stdout.write(
  JSON.stringify({
    decision: "block",
    reason:
      "Delegation mode is on: repository code may only be written from an external-model output. Dispatch codex-implementer (codex edits the tree itself) or relay-implementer (runs llm.mjs --out first, then applies its reply). See the delegating-to-external-llm skill.",
  }),
);
process.exit(0);
