#!/usr/bin/env node
// Interactive (or flag-driven) setup for the relay used by both lanes.
// Writes ~/.claude/llm-relay.env (mode 600) and runs a smoke test.
//
//   node scripts/setup.mjs                       # prompts for everything
//   node scripts/setup.mjs --base https://relay.example.com --key sk-... [--model gpt-6-astra] [--reasoning xhigh] [--min-input 0] [--codex-access workspace|workspace-net|yolo] [--no-test]
//
// The key is read with echo off when prompted. Nothing is sent anywhere except
// to the relay you name, and only for the smoke test.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(os.homedir(), ".claude", "llm-relay.env");
const DEFAULTS = { model: "gpt-6-astra", reasoning: "xhigh", minInput: "0", codexAccess: "workspace" };
const ACCESS = ["workspace", "workspace-net", "yolo"];
const EFFORTS = ["low", "medium", "high", "xhigh"];

const args = process.argv.slice(2);
const opt = { base: null, key: null, model: null, reasoning: null, minInput: null, codexAccess: null, test: true };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--base") opt.base = args[++i];
  else if (a === "--key") opt.key = args[++i];
  else if (a === "--model") opt.model = args[++i];
  else if (a === "--reasoning") opt.reasoning = args[++i];
  else if (a === "--min-input") opt.minInput = args[++i];
  else if (a === "--codex-access") opt.codexAccess = args[++i];
  else if (a === "--no-test") opt.test = false;
  else if (a === "-h" || a === "--help") {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 9).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    process.exit(0);
  }
}

function readExisting() {
  if (!fs.existsSync(ENV_PATH)) return {};
  return Object.fromEntries(
    fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)
      .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
  );
}
const existing = readExisting();
const tty = Boolean(process.stdin.isTTY);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: tty });

const ask = (q, def) => {
  if (!tty) return Promise.resolve(def || "");
  return new Promise((res) => rl.question(def ? `${q} [${def}]: ` : `${q}: `, (a) => res(a.trim() || def || "")));
};
function askHidden(q) {
  if (!tty) return Promise.resolve("");
  return new Promise((res) => {
    const stdin = process.stdin;
    process.stdout.write(`${q}: `);
    rl.pause();
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding("utf8");
    let buf = "";
    const onData = (ch) => {
      if (ch === "\r" || ch === "\n") {
        stdin.setRawMode(false); stdin.removeListener("data", onData); process.stdout.write("\n"); rl.resume(); res(buf.trim());
      } else if (ch === "") { process.stdout.write("\n"); process.exit(130); }
      else if (ch === "" || ch === "\b") { buf = buf.slice(0, -1); }
      else buf += ch;
    };
    stdin.on("data", onData);
  });
}

const mask = (k) => (k ? `${k.slice(0, 5)}…${k.slice(-4)}` : "");

let { base, key, model, reasoning, minInput, codexAccess } = opt;
if (!base) base = await ask("Relay base URL (OpenAI-compatible, without /v1)", existing.LLM_BASE || "");
if (!key) {
  const cur = existing.LLM_KEY ? ` (enter to keep ${mask(existing.LLM_KEY)})` : "";
  key = (await askHidden(`API key${cur}`)) || existing.LLM_KEY || "";
}
if (!model) model = await ask("Model", existing.LLM_MODEL || DEFAULTS.model);
if (!reasoning) reasoning = await ask(`Default reasoning effort (${EFFORTS.join("|")})`, existing.LLM_REASONING || DEFAULTS.reasoning);
if (minInput === null) minInput = await ask("Minimum input tokens your relay requires per request (0 if none; some relays reject tiny requests)", existing.LLM_MIN_INPUT_TOKENS || DEFAULTS.minInput);
if (!codexAccess) codexAccess = await ask("codex permission level: workspace (repo-only, no network) | workspace-net (repo + network) | yolo (no sandbox, no approvals)", existing.LLM_CODEX_ACCESS || DEFAULTS.codexAccess);
rl.close();

base = (base || "").replace(/\/+$/, "").replace(/\/v1$/, "");
if (!/^https?:\/\//.test(base)) { console.error(tty ? "setup: base URL must start with http:// or https://" : "setup: pass --base and --key when stdin is not a terminal"); process.exit(2); }
if (!key) { console.error(tty ? "setup: API key is required" : "setup: pass --base and --key when stdin is not a terminal"); process.exit(2); }
if (!/^\d+$/.test(String(minInput))) { console.error("setup: --min-input must be a non-negative integer"); process.exit(2); }
if (!EFFORTS.includes(reasoning)) { console.error(`setup: reasoning must be one of ${EFFORTS.join("|")}`); process.exit(2); }
if (!ACCESS.includes(codexAccess)) { console.error(`setup: --codex-access must be one of ${ACCESS.join("|")}`); process.exit(2); }

fs.mkdirSync(path.dirname(ENV_PATH), { recursive: true });
const body = [
  "# Written by delegating-to-external-llm setup. Never commit this file.",
  `LLM_BASE=${base}`,
  `LLM_KEY=${key}`,
  `LLM_MODEL=${model}`,
  `LLM_REASONING=${reasoning}`,
  `LLM_MIN_INPUT_TOKENS=${minInput}`,
  `LLM_CODEX_ACCESS=${codexAccess}`,
  "",
].join("\n");
fs.writeFileSync(ENV_PATH, body, { encoding: "utf8", mode: 0o600 });
try { fs.chmodSync(ENV_PATH, 0o600); } catch {}
console.log(`\nWrote ${ENV_PATH}`);
console.log(`  LLM_BASE=${base}\n  LLM_KEY=${mask(key)}\n  LLM_MODEL=${model}\n  LLM_REASONING=${reasoning}\n  LLM_MIN_INPUT_TOKENS=${minInput}\n  LLM_CODEX_ACCESS=${codexAccess}`);
if (codexAccess === "yolo") console.log("  ! yolo: codex runs with no sandbox and no approval prompts — it can do anything your user account can.");

if (opt.test) {
  console.log("\nSmoke test (chat lane): asking the relay to reply OK …");
  const r = spawnSync(process.execPath, [path.join(HERE, "llm.mjs"), "--max", "200", "--effort", "low", "--pad", "2500", "Reply with the single word OK"], { encoding: "utf8" });
  process.stdout.write(r.stdout || "");
  process.stderr.write(r.stderr || "");
  if (r.status !== 0) {
    console.error("\nSmoke test FAILED — check the base URL / key / model and re-run setup. If the relay complains about a minimum request size, re-run with --min-input <tokens>.");
    process.exit(1);
  }
  const codex = spawnSync(process.platform === "win32" ? "where" : "which", ["codex"], { encoding: "utf8" });
  if (codex.status === 0) {
    const v = spawnSync("codex", ["--version"], { encoding: "utf8", shell: true }).stdout?.trim();
    console.log(`\ncodex CLI found (${v}). The agentic lane will point it at this relay automatically.`);
  } else {
    console.log("\ncodex CLI not found. The agentic lane will report STATUS: unavailable and everything will route to the chat lane.");
    console.log("Install it with:  npm i -g @openai/codex@latest");
  }
  console.log("\nSetup complete. Restart Claude Code, then say: \"delegate all coding to the external model; you are only the brain.\"");
}
