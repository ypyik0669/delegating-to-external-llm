#!/usr/bin/env node
// Append one usage record to ~/.claude/llm-usage.jsonl (or $LLM_USAGE_LOG).
//   node usage-log.mjs --lane codex|chat --model m --effort e --access a --status s \
//        --in 123 --cached 0 --out 45 --duration 8000 --project <cwd> [--session <id>]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LOG_PATH = process.env.LLM_USAGE_LOG || path.join(os.homedir(), ".claude", "llm-usage.jsonl");

export function appendUsage(rec) {
  const row = {
    ts: new Date().toISOString(),
    lane: rec.lane || "chat",
    model: rec.model || null,
    effort: rec.effort || null,
    access: rec.access || null,
    status: rec.status || "unknown",
    prompt_tokens: num(rec.in),
    cached_tokens: num(rec.cached),
    completion_tokens: num(rec.out),
    duration_ms: num(rec.duration),
    project: rec.project || process.cwd(),
    session: rec.session || null,
  };
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify(row) + "\n", "utf8");
  } catch {}
  return row;
}
function num(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const a = process.argv.slice(2);
  const rec = {};
  for (let i = 0; i < a.length; i++) if (a[i].startsWith("--")) rec[a[i].slice(2)] = a[++i];
  appendUsage(rec);
}
