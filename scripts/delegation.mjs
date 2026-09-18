#!/usr/bin/env node
// Toggle delegation mode without spending a model turn.
//   node delegation.mjs on | off | status
// Inside Claude Code, prefix with "!" so it runs as a plain shell command (zero tokens):
//   ! node ~/.claude/skills/delegating-to-external-llm/scripts/delegation.mjs on
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = path.join(os.homedir(), ".claude");
const sw = path.join(dir, "llm-delegation.on");
const relay = fs.existsSync(path.join(dir, "llm-relay.env"));
const cmd = process.argv[2] || "status";

if (cmd === "on") {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(sw, new Date().toISOString() + "\n");
  console.log(`delegation mode ON  (${sw})`);
  console.log(relay ? "relay configured" : "relay NOT configured — run: node scripts/setup.mjs");
} else if (cmd === "off") {
  fs.rmSync(sw, { force: true });
  console.log("delegation mode OFF");
} else if (cmd === "status") {
  console.log(`delegation mode ${fs.existsSync(sw) || process.env.LLM_DELEGATION === "1" ? "ON" : "OFF"}; relay ${relay ? "configured" : "NOT configured"}`);
} else {
  console.error("usage: delegation.mjs on | off | status");
  process.exit(2);
}
