import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, "..", "scripts");
const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dtel-usage-")), "u.jsonl");
const env = { ...process.env, LLM_USAGE_LOG: log };
const run = (file, args) => spawnSync(process.execPath, [path.join(scripts, file), ...args], { encoding: "utf8", env });
test.after(() => fs.rmSync(path.dirname(log), { recursive: true, force: true }));

test("usage-log appends JSON rows", () => {
  run("usage-log.mjs", ["--lane", "chat", "--model", "m", "--effort", "low", "--status", "ok", "--in", "100", "--out", "5", "--duration", "1200", "--project", "/p"]);
  run("usage-log.mjs", ["--lane", "codex", "--model", "m", "--effort", "high", "--access", "yolo", "--status", "ran", "--in", "24000", "--cached", "17000", "--out", "300", "--duration", "90000", "--project", "/p", "--session", "abc"]);
  const rows = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);
  assert.equal(rows[1].lane, "codex");
  assert.equal(rows[1].prompt_tokens, 24000);
  assert.equal(rows[1].session, "abc");
  assert.equal(rows[0].access, null);
});
test("usage summarises by lane and status", () => {
  const r = run("usage.mjs", ["--since", "1h", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.equal(s.total.calls, 2);
  assert.equal(s.total.prompt_tokens, 24100);
  assert.deepEqual(s.by_lane.map((l) => l.label).sort(), ["chat", "codex"]);
  assert.ok(s.by_status.some((l) => l.label === "ran" && l.calls === 1));
});
test("usage text output and empty window", () => {
  const r = run("usage.mjs", ["--since", "24h"]);
  assert.match(r.stdout, /by lane/);
  const e = run("usage.mjs", ["--since", "1m", "--project", "/nowhere"]);
  assert.match(e.stdout, /No lane calls recorded/);
});
test("usage rejects bad --since", () => {
  assert.equal(run("usage.mjs", ["--since", "soon"]).status, 2);
});
