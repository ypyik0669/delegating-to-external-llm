import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { renderTable } from "../scripts/lane-status.mjs";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const watcher = path.join(project, "scripts", "lane-status.mjs");

function streamingFixture() {
  const root = fs.mkdtempSync(path.join(project, "tests", ".lane-stream-"));
  const bin = path.join(root, "bin");
  const cwd = path.join(root, "work");
  const home = path.join(root, "home");
  for (const directory of [bin, cwd, home]) fs.mkdirSync(directory);
  const gate = path.join(root, "release");
  const statusFile = path.join(root, "status with spaces", "stream.status.json");
  const spec = path.join(root, "stream.md");
  fs.writeFileSync(spec, "stub prompt\n");
  fs.writeFileSync(path.join(bin, "codex"), '#!/usr/bin/env bash\nif [ "$1" = --version ]; then echo stub-codex; exit 0; fi\nnode "$STUB_EVENTS"\n', { mode: 0o755 });
  const events = path.join(root, "events.cjs");
  fs.writeFileSync(events, [
    'const fs = require("node:fs");',
    'console.log(JSON.stringify({type:"thread.started",thread_id:"live-session"}));',
    'console.log(JSON.stringify({type:"item.started",item:{type:"command_execution",command:"node --test live.mjs"}}));',
    'const timer=setInterval(()=>{ if(!fs.existsSync(process.env.STUB_GATE)) return; clearInterval(timer);',
    'console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"x".repeat(240)}}));',
    'console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:17,cached_input_tokens:4,output_tokens:9}},null,0).replaceAll(":",": "));',
    '},20);',
  ].join("\n"));
  const env = { ...process.env, HOME: home.replace(/\\/g, "/"), USERPROFILE: home, CODEX_HOME: "", LANE_CODEX_HOME: home.replace(/\\/g, "/"), LLM_MODEL: "stub", LLM_BASE: "https://unused.invalid", LLM_KEY: "test", LLM_CODEX_ACCESS: "workspace", EVAL_CODEX_DISABLED: "", LLM_USAGE_LOG: path.join(root, "usage.jsonl"), TMPDIR: root.replace(/\\/g, "/"), TMP: root, TEMP: root, GIT_CEILING_DIRECTORIES: root.replace(/\\/g, "/"), STUB_EVENTS: events.replace(/\\/g, "/"), STUB_GATE: gate };
  const inheritedPath = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] || "";
  for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
  env.PATH = bin + path.delimiter + inheritedPath;
  return { root, cwd, env, gate, statusFile, spec };
}

test("codex streams live events, preserves resume metadata, and records spaced JSON usage", { timeout: 60000 }, async () => {
  const fixture = streamingFixture();
  fs.mkdirSync(path.dirname(fixture.statusFile));
  const initial = { slug: "stream", mode: "implement", spec: fixture.spec, phase: "resume 1/2", started_at: new Date().toISOString(), tokens: { in: 0, cached: 0, out: 0 }, exit: null };
  fs.writeFileSync(fixture.statusFile, JSON.stringify(initial));
  const child = spawn("bash", [path.join(project, "scripts", "codex-lane.sh").replace(/\\/g, "/"), "--spec", fixture.spec.replace(/\\/g, "/"), "--resume", "live-session", "--status-file", fixture.statusFile.replace(/\\/g, "/"), "--timeout", "30"], { cwd: fixture.cwd, env: fixture.env });
  let output = "";
  let closed = false;
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const finished = new Promise((resolve) => child.once("close", (code) => { closed = true; resolve(code); }));
  try {
    let live;
    const deadline = Date.now() + 20000;
    while (!closed && Date.now() < deadline) {
      try { live = JSON.parse(fs.readFileSync(fixture.statusFile, "utf8")); } catch {}
      if (live?.last_message === "node --test live.mjs") break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(closed, false, output);
    assert.equal(live?.last_message, "node --test live.mjs", output);
    assert.equal(live.phase, "resume 1/2");
    assert.equal(live.spec, fixture.spec);
    assert.equal(live.session, "live-session");
    assert.match(fs.readFileSync(path.join(path.dirname(fixture.statusFile), "stream.events.jsonl"), "utf8"), /command_execution/);
    fs.writeFileSync(fixture.gate, "release");
    assert.equal(await finished, 0, output);
    const final = JSON.parse(fs.readFileSync(fixture.statusFile, "utf8"));
    assert.equal(final.phase, "done ran");
    assert.equal(final.last_message.length, 200);
    assert.deepEqual(final.tokens, { in: 17, cached: 4, out: 9 });
    assert.equal(final.exit, 0);
    assert.match(output, /TOKENS: in=17 cached=4 out=9/);
    assert.equal(fs.readdirSync(path.dirname(fixture.statusFile)).filter((name) => name.endsWith(".tmp")).length, 0);
  } finally {
    fs.writeFileSync(fixture.gate, "release");
    await finished;
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("codex status write failures are reported without failing the lane", { timeout: 60000 }, () => {
  const fixture = streamingFixture();
  try {
    fs.writeFileSync(path.dirname(fixture.statusFile), "not a directory");
    fs.writeFileSync(fixture.gate, "release");
    const result = spawnSync("bash", [path.join(project, "scripts", "codex-lane.sh").replace(/\\/g, "/"), "--spec", fixture.spec.replace(/\\/g, "/"), "--status-file", fixture.statusFile.replace(/\\/g, "/")], { cwd: fixture.cwd, env: fixture.env, encoding: "utf8", timeout: 45000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /lane status write failed/);
    assert.match(result.stdout, /TOKENS: in=17 cached=4 out=9/);
    assert.match(result.stdout, /STATUS: ran/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("status CLI runs on Windows, handles missing directories, and sorts JSON", () => {
  const root = fs.mkdtempSync(path.join(project, "tests", ".status-cli-"));
  try {
    const missing = spawnSync(process.execPath, [watcher, "--dir", path.join(root, "missing")], { encoding: "utf8" });
    assert.equal(missing.status, 0, missing.stderr);
    assert.match(missing.stdout, /^SLUG \| PHASE/);
    for (const [slug, offset] of [["older", 1000], ["newer", 0], ["stale", 90000000]]) {
      fs.writeFileSync(path.join(root, slug + ".status.json"), JSON.stringify({ slug, updated_at: new Date(Date.now() - offset).toISOString() }));
    }
    fs.writeFileSync(path.join(root, "broken.status.json"), "{");
    fs.writeFileSync(path.join(root, "null.status.json"), "null");
    const result = spawnSync(process.execPath, [watcher, "--dir", root, "--json"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).map((status) => status.slug), ["newer", "older"]);
    const invalid = spawnSync(process.execPath, [watcher, "--dir"], { encoding: "utf8" });
    assert.equal(invalid.status, 0, invalid.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("renderTable sorts by updated_at and excludes stale lanes", () => {
  const now = Date.parse("2026-09-21T12:00:00.000Z");
  const table = renderTable([
    { slug: "running", phase: "running", started_at: "2026-09-21T11:59:00.000Z", updated_at: "2026-09-21T11:59:30.000Z", elapsed_s: 30, tokens: { in: 10, cached: 2, out: 3 }, last_message: "working" },
    { slug: "done", phase: "done complete", started_at: "2026-09-21T11:00:00.000Z", updated_at: "2026-09-21T11:59:45.000Z", elapsed_s: 3600, tokens: { in: 20, cached: 4, out: 5 }, last_message: "finished" },
    { slug: "stale", phase: "done partial", started_at: "2026-09-20T10:00:00.000Z", updated_at: "2026-09-20T10:00:00.000Z", elapsed_s: 1, tokens: { in: 1, cached: 0, out: 1 }, last_message: "old" },
  ], now);
  assert.match(table, /done \| done complete/);
  assert.match(table, /running \| running/);
  assert.doesNotMatch(table, /stale/);
  assert.ok(table.indexOf("done |") < table.indexOf("running |"));
});

test("lane-run writes a completed status file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dtel-lane-status-"));
  const repo = path.join(root, "repo");
  const statusDir = path.join(root, "status");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "existing.txt"), "ok\n");
  const stub = path.join(root, "stub.sh");
  fs.writeFileSync(stub, `#!/usr/bin/env bash
echo "===== CODEX FINAL MESSAGE (stub) ====="
echo "done"
echo "===== END ====="
echo "SESSION: stub-session"
echo "TOKENS: in=1 cached=0 out=1"
echo "STATUS: ran"
`);
  const spec = path.join(root, "complete.md");
  fs.writeFileSync(spec, `OBJECTIVE: finish the stub lane
FILES: existing.txt
INTERFACES: unchanged
CONSTRAINTS: only listed files
VERIFICATION: node -e "process.exit(0)" → exits 0
REASONING: low
`);
  const driver = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "lane-run.mjs");
  try {
    const result = spawnSync(process.execPath, [driver, "--spec", spec, "--status-dir", statusDir, "--timeout", "60", "--json"], { cwd: repo, encoding: "utf8", env: { ...process.env, LANE_RUN_LANE_SH: stub, LLM_USAGE_LOG: path.join(root, "usage.jsonl") } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "complete");
    const status = JSON.parse(fs.readFileSync(path.join(statusDir, "complete.status.json"), "utf8"));
    assert.equal(status.phase, "done complete");
    assert.equal(status.slug, "complete");
    assert.equal(report.status_file, path.join(statusDir, "complete.status.json"));
    assert.deepEqual(status.tokens, { in: 1, cached: 0, out: 1 });
    assert.equal(status.session, "stub-session");
    assert.equal(status.exit, 0);
    assert.equal(result.stderr.trim().split(/\r?\n/).length, 1);
    assert.match(result.stderr, /^WATCH: node ".*lane-status.mjs" --watch --dir "/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
