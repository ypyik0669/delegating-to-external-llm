#!/usr/bin/env node
// Show live status for lanes launched by lane-run.mjs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const defaultDir = () => path.resolve(process.env.LANE_STATUS_DIR || (process.env.CLAUDE_SCRATCHPAD_DIR ? path.join(process.env.CLAUDE_SCRATCHPAD_DIR, "lanes") : path.join(os.homedir(), ".claude", "lane-status")));
const age = (status, now) => {
  const updated = Date.parse(status?.updated_at || "");
  return Number.isFinite(updated) ? now - updated : MAX_AGE_MS + 1;
};
const fresh = (status, now) => age(status, now) <= MAX_AGE_MS;
const clean = (value, width = 200) => String(value ?? "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\s+/g, " ").replace(/[\x00-\x1f\x7f]/g, "").replace(/[|]/g, "¦").slice(0, width);
const elapsed = (status, now) => {
  const started = Date.parse(status.started_at || "");
  const seconds = String(status.phase || "").startsWith("done ") || !Number.isFinite(started) ? Number(status.elapsed_s || 0) : Math.max(0, (now - started) / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${String(Math.floor(seconds % 60)).padStart(2, "0")}s` : `${Math.round(seconds * 10) / 10}s`;
};

export function renderTable(statuses, now = Date.now()) {
  const visible = recentStatuses(statuses, now);
  const header = "SLUG | PHASE | ELAPSED | TOKENS (in/cached/out) | LAST MESSAGE";
  const rows = visible.map((status) => {
    const tokens = status.tokens || {};
    return `${clean(status.slug)} | ${clean(status.phase)} | ${elapsed(status, now)} | ${Number(tokens.in || 0)}/${Number(tokens.cached || 0)}/${Number(tokens.out || 0)} | ${clean(status.last_message)}`;
  });
  return [header, "-".repeat(header.length), ...rows].join("\n");
}

function recentStatuses(statuses, now) {
  return statuses.filter((status) => fresh(status, now)).sort((first, second) => Date.parse(second.updated_at) - Date.parse(first.updated_at));
}

function readStatuses(dir, now = Date.now()) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((name) => name.endsWith(".status.json")); } catch { return []; }
  return names.flatMap((name) => {
    try {
      const status = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      return fresh(status, now) ? [status] : [];
    } catch { return []; }
  });
}

function parseArgs(argv) {
  const options = { dir: defaultDir(), watch: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir" && argv[i + 1] && !argv[i + 1].startsWith("--")) options.dir = path.resolve(argv[++i]);
    else if (argv[i] === "--watch") options.watch = true;
    else if (argv[i] === "--json") options.json = true;
  }
  return options;
}

function print(options) {
  const statuses = recentStatuses(readStatuses(options.dir), Date.now());
  const output = options.json ? JSON.stringify(statuses, null, 2) : renderTable(statuses);
  process.stdout.write(`${options.watch ? "\x1b[2J\x1b[H" : ""}${output}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const options = parseArgs(process.argv.slice(2));
  print(options);
  if (options.watch) {
    const timer = setInterval(() => print(options), 2000);
    process.once("SIGINT", () => { clearInterval(timer); process.exit(0); });
  }
}
