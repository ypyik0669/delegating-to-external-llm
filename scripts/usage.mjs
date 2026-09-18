#!/usr/bin/env node
// Summarise ~/.claude/llm-usage.jsonl — the evidence of who did the work.
//   node usage.mjs [--since 1h|24h|7d|30d|all] [--project <path>] [--json] [--last <n>]
//   node usage.mjs --claude-in <tokens> --claude-out <tokens> [--note "explore agents"]   # record Claude-side spend
// Prices (USD per 1M tokens) come from ~/.claude/llm-relay.env: LLM_PRICE_IN, LLM_PRICE_CACHED, LLM_PRICE_OUT
// for the relay model and CLAUDE_PRICE_IN, CLAUDE_PRICE_OUT for the architect/its subagents. Unset = 0.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LOG_PATH, appendUsage } from "./usage-log.mjs";

const a = process.argv.slice(2);
let since = "24h", project = null, json = false, last = 10, claudeIn = null, claudeOut = null, note = "";
for (let i = 0; i < a.length; i++) {
  if (a[i] === "--since") since = a[++i];
  else if (a[i] === "--project") project = a[++i];
  else if (a[i] === "--json") json = true;
  else if (a[i] === "--last") last = Number(a[++i]) || 10;
  else if (a[i] === "--claude-in") claudeIn = Number(a[++i]) || 0;
  else if (a[i] === "--claude-out") claudeOut = Number(a[++i]) || 0;
  else if (a[i] === "--note") note = a[++i];
}
if (claudeIn !== null || claudeOut !== null) {
  const row = appendUsage({ lane: "claude", model: note || "claude", status: "ok", in: claudeIn || 0, out: claudeOut || 0, duration: 0, project: process.cwd() });
  console.log(`recorded claude-side usage: in=${row.prompt_tokens} out=${row.completion_tokens}${note ? ` (${note})` : ""}`);
  process.exit(0);
}

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
}
const envf = { ...readEnvFile(path.join(os.homedir(), ".claude", "llm-relay.env")), ...process.env };
const price = { relayIn: Number(envf.LLM_PRICE_IN || 0), relayCached: Number(envf.LLM_PRICE_CACHED || 0), relayOut: Number(envf.LLM_PRICE_OUT || 0), claudeIn: Number(envf.CLAUDE_PRICE_IN || 0), claudeOut: Number(envf.CLAUDE_PRICE_OUT || 0) };

const units = { h: 3600e3, d: 86400e3, m: 60e3 };
let cutoff = 0;
if (since !== "all") {
  const m = /^(\d+)([hdm])$/.exec(since);
  if (!m) { console.error("usage: --since 1h|24h|7d|30d|all"); process.exit(2); }
  cutoff = Date.now() - Number(m[1]) * units[m[2]];
}
const norm = (p) => String(p || "").replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");

let rows = [];
if (fs.existsSync(LOG_PATH)) {
  rows = fs.readFileSync(LOG_PATH, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
rows = rows.filter((r) => Date.parse(r.ts) >= cutoff && (!project || norm(r.project) === norm(project)));

const sum = (arr, k) => arr.reduce((s, r) => s + (Number(r[k]) || 0), 0);
const group = (arr, k) => { const g = {}; for (const r of arr) { const key = r[k] ?? "?"; (g[key] ||= []).push(r); } return g; };
const line = (label, arr) => ({
  label, calls: arr.length,
  prompt_tokens: sum(arr, "prompt_tokens"), cached_tokens: sum(arr, "cached_tokens"), completion_tokens: sum(arr, "completion_tokens"),
  minutes: Math.round(sum(arr, "duration_ms") / 6000) / 10,
});
const isClaude = (r) => r.lane === "claude";
const ext = rows.filter((r) => !isClaude(r) && r.status !== "driver");
const cl = rows.filter(isClaude);
const extTok = line("external", ext), clTok = line("claude", cl);
const usd = (l, pin, pcached, pout) => ((l.prompt_tokens - l.cached_tokens) * pin + l.cached_tokens * pcached + l.completion_tokens * pout) / 1e6;
const extUsd = usd(extTok, price.relayIn, price.relayCached, price.relayOut);
const clUsd = usd(clTok, price.claudeIn, price.claudeIn, price.claudeOut);
const ratio = extTok.prompt_tokens + extTok.completion_tokens > 0 ? (clTok.prompt_tokens + clTok.completion_tokens) / (extTok.prompt_tokens + extTok.completion_tokens) : null;

const summary = {
  log: LOG_PATH, since, project, total: line("total", rows),
  external: extTok, claude: clTok, ratio_claude_to_external: ratio, usd: { external: extUsd, claude: clUsd, priced: Object.values(price).some((v) => v > 0) },
  by_lane: Object.entries(group(rows, "lane")).map(([k, v]) => line(k, v)),
  by_status: Object.entries(group(rows, "status")).map(([k, v]) => line(k, v)),
  by_project: Object.entries(group(rows, "project")).map(([k, v]) => line(k, v)).sort((x, y) => y.calls - x.calls).slice(0, 10),
  recent: rows.slice(-last).reverse(),
};

if (json) { console.log(JSON.stringify(summary, null, 2)); process.exit(0); }

const pad = (s, n) => String(s).padEnd(n);
const fmt = (l) => `${pad(l.label, 34)}${pad(l.calls, 7)}${pad(l.prompt_tokens, 11)}${pad(l.cached_tokens, 11)}${pad(l.completion_tokens, 11)}${l.minutes} min`;
console.log(`Usage — since ${since}${project ? ` — project ${project}` : ""}\n(${LOG_PATH})\n`);
if (!rows.length) { console.log("No lane calls recorded in this window. If delegation was supposed to be active, that is the finding."); process.exit(0); }
console.log(`${pad("", 34)}${pad("calls", 7)}${pad("prompt", 11)}${pad("cached", 11)}${pad("output", 11)}wall`);
console.log(fmt(summary.total));
console.log("\nwho did the work");
console.log("  " + fmt(extTok) + (summary.usd.priced ? `   ≈ $${extUsd.toFixed(2)}` : ""));
console.log("  " + fmt(clTok) + (summary.usd.priced ? `   ≈ $${clUsd.toFixed(2)}` : ""));
if (ratio !== null) console.log(`  claude : external tokens = 1 : ${ratio > 0 ? (1 / ratio).toFixed(1) : "∞"}   (target ≥ 1 : 5; record Claude-side spend with --claude-in/--claude-out)`);
if (!summary.usd.priced) console.log("  (set LLM_PRICE_IN/CACHED/OUT and CLAUDE_PRICE_IN/OUT in ~/.claude/llm-relay.env for USD)");
console.log("\nby lane");   for (const l of summary.by_lane) console.log("  " + fmt(l));
console.log("\nby status"); for (const l of summary.by_status) console.log("  " + fmt(l));
console.log("\nby project (top 10)"); for (const l of summary.by_project) console.log("  " + fmt(l));
console.log(`\nlast ${Math.min(last, rows.length)}`);
for (const r of summary.recent) {
  console.log(`  ${r.ts.slice(0, 19).replace("T", " ")}  ${pad(r.lane, 15)} ${pad(r.status, 12)} ${pad(r.effort ?? "-", 8)} in=${r.prompt_tokens ?? "-"} out=${r.completion_tokens ?? "-"} ${r.duration_ms != null ? Math.round(r.duration_ms / 1000) + "s" : ""}${r.session ? "  session=" + String(r.session).slice(0, 8) : ""}`);
}
