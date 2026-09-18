#!/usr/bin/env node
// UserPromptSubmit / SessionStart hook: when delegation mode is on, inject a short reminder so
// Claude routes coding work through the plugin without the user having to say so each time.
// Delegation mode = ~/.claude/llm-delegation.on exists (toggle with /delegating-to-external-llm:on|off)
// or LLM_DELEGATION=1. Off → prints nothing. Kept to a few dozen tokens: it is added to every turn.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function status(env = process.env) {
  const home = os.homedir();
  const on = env.LLM_DELEGATION === "1" || fs.existsSync(path.join(home, ".claude", "llm-delegation.on"));
  const relay = fs.existsSync(path.join(home, ".claude", "llm-relay.env"));
  return { on, relay };
}

export function message(event, st, codexPresent) {
  if (!st.on) return "";
  const core = "[delegating-to-external-llm] Delegation mode is ON: for any coding work in this turn (implement, fix, refactor, add tests) use the delegating-to-external-llm:delegating-to-external-llm skill — analyze lane → spec → lane-run.mjs → llm-advisor. Do not read source to learn the codebase, do not edit repo files yourself, do not launch Explore agents for what the analyze lane can answer. Questions, planning and reviewing reports stay with you. `/delegating-to-external-llm:off` turns this off.";
  if (event !== "SessionStart") return core;
  const parts = [core];
  if (!st.relay) parts.push("Relay is NOT configured — tell the user to run /delegating-to-external-llm:setup before delegating.");
  if (codexPresent === false) parts.push("codex CLI not found on PATH — lanes will fall back to relay-implementer.");
  return parts.join("\n");
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
  let event = "UserPromptSubmit";
  try { event = JSON.parse(fs.readFileSync(0, "utf8")).hook_event_name || event; } catch {}
  const st = status();
  let codex = null;
  if (event === "SessionStart" && st.on) {
    const r = spawnSync(process.platform === "win32" ? "where" : "which", ["codex"], { encoding: "utf8" });
    codex = r.status === 0;
  }
  const out = message(event, st, codex);
  if (out) process.stdout.write(out + "\n");
  process.exit(0);
}
