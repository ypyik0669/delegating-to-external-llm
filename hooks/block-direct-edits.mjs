#!/usr/bin/env node
// PreToolUse hook: refuse Edit/Write/NotebookEdit on repository source files
// unless an external-model output file exists for this project. This turns
// "the brain does not code" from a memory into a mechanism.
//
// Active whenever the plugin is enabled; LLM_DELEGATION=0 disables it (tests / one-off sessions).
//
// Evidence: a file named *.llm-output.* written within the last 30 minutes under
// the *current project's* scratch root, i.e. <tmp>/claude/<project-slug>/…, where
// the slug is the cwd with every non-alphanumeric character replaced by "-"
// (C:\Users\me\repo → C--Users-me-repo). llm.mjs --out writes there when the
// relay-implementer agent uses the session scratchpad. The cwd's parent and
// grandparent are also tried so a lane running inside <repo>/.lanes/<slug>
// (see scripts/lane-worktree.sh) finds the main project's evidence.
//
// The codex lane edits files through its own process, not through Claude's Edit
// tool, so it never hits this hook. The hook only stops the main session (or a
// stray subagent) from typing repo code by hand.
//
// Registered by hooks/hooks.json when the plugin is loaded.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function decide(input, env = process.env, now = Date.now()) {
  const tool = input.tool_name || "";
  if (!/^(Edit|Write|NotebookEdit)$/.test(tool)) return null;

  const active = env.LLM_DELEGATION !== "0";
  if (!active) return null;

  const cwd = path.resolve(String(input.cwd || process.cwd()));
  const rawTarget = String(input.tool_input?.file_path || input.tool_input?.notebook_path || "");
  if (!rawTarget) return null;
  const target = path.resolve(cwd, rawTarget);

  const norm = (p) => p.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  const inRepo = norm(target).startsWith(norm(cwd) + "/") || norm(target) === norm(cwd);
  const isScratch = /\/temp\/claude\//i.test(norm(target)) || /\/\.claude\//i.test(norm(target));
  if (!inRepo || isScratch) return null;

  // Project-scoped scratch roots: cwd, its parent and grandparent (lane worktrees live at <repo>/.lanes/<slug>).
  const candidates = [cwd, path.dirname(cwd), path.dirname(path.dirname(cwd))];
  const roots = new Set();
  for (const c of candidates) {
    const slug = c.replace(/[^A-Za-z0-9]/g, "-");
    roots.add(path.join(os.tmpdir(), "claude", slug));
    roots.add(path.join(os.homedir(), "AppData", "Local", "Temp", "claude", slug));
  }
  if (env.CLAUDE_SCRATCHPAD_DIR) roots.add(env.CLAUDE_SCRATCHPAD_DIR);

  const fresh = now - 30 * 60 * 1000;
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    let visited = 0;
    while (stack.length && visited < 2000) {
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
            if (fs.statSync(p).mtimeMs > fresh) return null;
          } catch {}
        }
      }
    }
  }

  return {
    decision: "block",
    reason:
      "Delegation mode is on: repository code may only be written from an external-model output. Dispatch codex-implementer (codex edits the tree itself) or relay-implementer (runs llm.mjs --out first, then applies its reply). See the delegating-to-external-llm skill.",
  };
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    process.exit(0);
  }
  const out = decide(input);
  if (out) process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
