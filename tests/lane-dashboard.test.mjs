import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import http from "node:http";
import os from "node:os";
import vm from "node:vm";
import { createServer } from "../scripts/lane-dashboard.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
let root, server, url, fixtureLines;
test.before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "dtel-dashboard-"));
  process.env.LLM_USAGE_LOG = path.join(root, "usage.jsonl");
  process.env.HOME = process.env.USERPROFILE = root;
  for (const key of ["LLM_PRICE_IN", "LLM_PRICE_CACHED", "LLM_PRICE_OUT", "CLAUDE_PRICE_IN", "CLAUDE_PRICE_OUT"]) delete process.env[key];
  await fs.mkdir(path.join(root, ".claude"));
  await fs.writeFile(path.join(root, ".claude", "llm-relay.env"), "LLM_PRICE_IN=2\nLLM_PRICE_CACHED=1\nLLM_PRICE_OUT=4\n");
  for (const [slug, age] of [["newest", 0], ["older", 60000], ["expired", 8 * 86400000]]) {
    await fs.writeFile(path.join(root, `${slug}.status.json`), JSON.stringify({ slug, phase: "running", updated_at: new Date(Date.now() - age).toISOString(), spec: path.join(root, "spec.md") }));
  }
  await fs.writeFile(path.join(root, "corrupt.status.json"), "{");
  await fs.writeFile(path.join(root, "null.status.json"), "null");
  await fs.writeFile(path.join(root, "spec.md"), "OBJECTIVE: fixture only\n");
  await fs.writeFile(path.join(root, "newest.report.txt"), "LANE REPORT\nCHANGES:\n  - add.mjs\nVERIFIED:\n");
  await fs.writeFile(path.join(root, "newest.log"), "log line\n");
  await fs.copyFile(path.join(here, "fixtures", "lane-events.jsonl"), path.join(root, "newest.events.jsonl"));
  fixtureLines = (await fs.readFile(path.join(root, "newest.events.jsonl"), "utf8")).trimEnd().split(/\r?\n/);
  server = createServer({ dir: root });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  if (root) await fs.rm(root, { recursive: true, force: true });
});
const get = async (route) => (await fetch(url + route)).json();
const parse = (records) => records.flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });

const patchCommand = "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: new file.mjs\n+new\n*** Update File: existing.mjs\n@@\n-old\n+new\n*** Delete File: obsolete.mjs\n*** End Patch\nPATCH";
const patchFiles = [{ path: "new file.mjs", kind: "add" }, { path: "existing.mjs", kind: "update" }, { path: "obsolete.mjs", kind: "delete" }];

test("PLAN parser uses the last block and stops at prose", async () => {
  const { parsePlanBlock } = await import("../scripts/lane-dashboard.mjs");
  assert.deepEqual(parsePlanBlock("PLAN:\n- [ ] Old\n\nUpdate\nPLAN:\r\n- [x] Inspect\r\n- [ ] Fix <file>\r\nDone talking\n- [x] Not part of plan"), [
    { text: "Inspect", done: true }, { text: "Fix <file>", done: false },
  ]);
  assert.deepEqual(parsePlanBlock("PLAN:\n- [X] Done\n"), [{ text: "Done", done: true }]);
  assert.deepEqual(parsePlanBlock("Mention PLAN: inline\n- [ ] Not a plan"), []);
  assert.deepEqual(parsePlanBlock(undefined), []);
});

test("lane detail derives the latest message plan unless a native todo event exists", async () => {
  const file = path.join(root, "older.events.jsonl");
  const events = [
    { item: { type: "agent_message", text: "PLAN:\n- [ ] Inspect\n- [ ] Verify" } },
    { item: { type: "agent_message", text: "PLAN:\n- [x] Inspect\n- [ ] Verify" } },
    { item: { type: "agent_message", text: "Still working" } },
  ];
  await fs.writeFile(file, events.map(JSON.stringify).join("\n") + "\n");
  try {
    assert.deepEqual((await get("/api/lanes/older")).derived_plan, [{ text: "Inspect", done: true }, { text: "Verify", done: false }]);
    await fs.appendFile(file, JSON.stringify({ item: { type: "todo_list", items: [] } }) + "\n");
    assert.deepEqual((await get("/api/lanes/older")).derived_plan, []);
  } finally { await fs.rm(file); }
});

test("Plan tab renders derived checkboxes safely and native todos take precedence", async () => {
  const html = await fs.readFile(path.join(here, "../assets/dashboard.html"), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].split('element("lanes").addEventListener')[0];
  const panel = { innerHTML: "", scrollTop: 0, scrollLeft: 0, querySelectorAll: () => [] };
  const context = vm.createContext({ document: { getElementById: () => panel } });
  vm.runInContext(script + '; state = newState(); selected = "plan"; state.detail = {derived_plan:[{text:"Inspect <file>",done:true},{text:"Verify",done:false}]}; drawContent();', context);
  assert.match(panel.innerHTML, /checked[^]*Inspect &lt;file&gt;/);
  assert.match(panel.innerHTML, /Verify/);
  vm.runInContext('ingest([{item:{type:"todo_list",items:[{text:"Native",completed:false}]}}]); drawContent();', context);
  assert.match(panel.innerHTML, /Native/);
  assert.doesNotMatch(panel.innerHTML, /Inspect/);
});

test("apply_patch parser extracts add, update and delete headers only inside patches", async () => {
  const { parseApplyPatchFiles } = await import("../scripts/lane-dashboard.mjs");
  assert.deepEqual(parseApplyPatchFiles(patchCommand), patchFiles);
  assert.deepEqual(parseApplyPatchFiles("*** Add File: outside.mjs"), []);
  assert.deepEqual(parseApplyPatchFiles(undefined), []);
});

test("fixture includes command, reasoning and message events without unparsable lines", () => {
  const events = parse(fixtureLines);
  assert.equal(fixtureLines.length - events.length, 0, "unparsable fixture lines");
  for (const type of ["command_execution", "reasoning", "agent_message"]) {
    assert.ok(events.filter((event) => event.item?.type === type).length >= 1, type);
  }
});

test("events derive successful patch kinds only for completed commands with exit code zero", async () => {
  const outcomes = [{ status: "completed", exit_code: 0 }, { status: "completed", exit_code: 1 }, { status: "failed", exit_code: 0 }, { status: "in_progress", exit_code: null }, { status: "completed" }, { exit_code: 0 }];
  const events = outcomes.map((outcome, index) => ({ type: "item.completed", item: { id: `patch_${index}`, type: "command_execution", command: patchCommand, aggregated_output: "", ...outcome } }));
  await fs.writeFile(path.join(root, "older.events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  try {
    assert.deepEqual(await get("/api/lanes/older/events"), { next: events.length, events: events.map((event, index) => ({ ...event, derived_files: index === 0 ? patchFiles : patchFiles.map((file) => ({ ...file, kind: "failed" })) })) });
  } finally { await fs.rm(path.join(root, "older.events.jsonl")); }
});

test("page merges file events in arrival order and renders a safe reasoning fallback", async () => {
  const html = await fs.readFile(path.join(here, "../assets/dashboard.html"), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].split('element("lanes").addEventListener')[0];
  const panel = { innerHTML: "", scrollTop: 0, scrollLeft: 0, querySelectorAll: () => [] };
  const context = vm.createContext({ document: { getElementById: () => panel } });
  vm.runInContext(script + '; state = newState(); selected = "fixture";', context);
  context.events = [
    { item: { id: "first", type: "reasoning", text: "Old headline" } },
    { item: { id: "second", type: "reasoning", text: "Other headline" } },
    { item: { id: "first", type: "reasoning", text: "Latest <headline>\nHidden body" } },
    { derived_files: [{ path: "same.mjs", kind: "add" }] },
    { item: { id: "files", type: "file_change", changes: [{ path: "same.mjs", kind: "modified" }] } },
    { derived_files: [{ path: "same.mjs", kind: "delete" }] },
  ];
  vm.runInContext("ingest(events); drawContent();", context);
  assert.match(panel.innerHTML, /no update_plan calls — latest reasoning: Latest &lt;headline&gt;/);
  assert.doesNotMatch(panel.innerHTML, /Hidden body/);
  vm.runInContext('tab = "Files"; drawContent();', context);
  assert.equal((panel.innerHTML.match(/same\.mjs/g) || []).length, 1);
  assert.match(panel.innerHTML, />delete<\/span>/);
  vm.runInContext('ingest([{item:{type:"todo_list",items:[{text:"Concrete step",completed:true}]}}]); tab = "Plan"; drawContent();', context);
  assert.match(panel.innerHTML, /Concrete step/);
  assert.doesNotMatch(panel.innerHTML, /no update_plan calls/);
});

test("Files dims failed patches and never lets failures replace successful kinds", async () => {
  const html = await fs.readFile(path.join(here, "../assets/dashboard.html"), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].split('element("lanes").addEventListener')[0];
  const panel = { innerHTML: "", scrollTop: 0, scrollLeft: 0, querySelectorAll: () => [] };
  const context = vm.createContext({ document: { getElementById: () => panel } });
  vm.runInContext(script + '; state = newState(); selected = "fixture"; tab = "Files";', context);
  context.events = [
    { derived_files: [{ path: "failed<only>.mjs", kind: "failed" }, { path: "retry.mjs", kind: "failed" }] },
    { derived_files: patchFiles },
    { item: { type: "file_change", changes: [{ path: "native.mjs", kind: "modified" }] } },
  ];
  vm.runInContext("ingest(events); drawContent();", context);
  assert.match(panel.innerHTML, /class="entry failed"[^]*?failed&lt;only&gt;\.mjs<\/code><span class="badge">failed<\/span>/);
  assert.match(html, /\.failed\s*\{[^}]*opacity:\s*\.[0-9]+/);
  assert.match(html, /\.failed code\s*\{[^}]*text-decoration:\s*line-through/);
  context.events = [
    { derived_files: [...patchFiles, { path: "native.mjs" }].map((file) => ({ ...file, kind: "failed" })) },
    { derived_files: [{ path: "retry.mjs", kind: "add" }] },
  ];
  vm.runInContext("ingest(events); drawContent();", context);
  assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify([...state.files])", context)), [
    ["failed<only>.mjs", "failed"], ["retry.mjs", "add"], ...patchFiles.map((file) => [file.path, file.kind]), ["native.mjs", "update"],
  ]);
  assert.equal((panel.innerHTML.match(/class="entry failed"/g) || []).length, 1);
});

test("ping identifies the dashboard and JSON encoding", async () => {
  const response = await fetch(url + "/api/ping");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(await response.json(), { app: "lane-dashboard" });
});
test("lanes are newest-first, seven-day bounded, with artifact counts", async () => {
  const lanes = await get("/api/lanes");
  assert.deepEqual(lanes.map((lane) => lane.slug), ["newest", "older"]);
  assert.equal(lanes[0].has_report, true);
  assert.equal(lanes[1].has_report, false);
  assert.equal(lanes[0].events_count, parse(fixtureLines).length);
});
test("detail includes report, spec and log tail; optional artifacts may be missing", async () => {
  const lane = await get("/api/lanes/newest");
  assert.match(lane.report, /^LANE REPORT/);
  assert.match(lane.spec_text, /^OBJECTIVE:/);
  assert.equal(lane.log, "log line\n");
  const older = await get("/api/lanes/older");
  assert.equal(older.report, null);
  assert.equal(older.log, null);
});
test("raw fixture streams by physical line index, skipping malformed lines", async () => {
  const result = await get("/api/lanes/newest/events?from=0");
  const rawEvents = (events) => events.map(({ derived_files, ...event }) => event);
  assert.deepEqual(rawEvents(result.events), parse(fixtureLines));
  assert.equal(result.next, fixtureLines.length);
  const later = await get("/api/lanes/newest/events?from=5");
  assert.deepEqual({ ...later, events: rawEvents(later.events) }, { next: result.next, events: parse(fixtureLines.slice(5)) });
  assert.deepEqual(await get(`/api/lanes/newest/events?from=${result.next}`), { next: result.next, events: [] });
  await fs.appendFile(path.join(root, "newest.events.jsonl"), 'bad line\n{"type":"turn.started"}\n{"type":');
  const incremental = await get(`/api/lanes/newest/events?from=${result.next}`);
  assert.deepEqual(incremental, { next: result.next + 2, events: [{ type: "turn.started" }] });
  await fs.appendFile(path.join(root, "newest.events.jsonl"), '"turn.completed"}\n');
  assert.deepEqual(await get(`/api/lanes/newest/events?from=${incremental.next}`), { next: result.next + 3, events: [{ type: "turn.completed" }] });
});
test("unknown slugs are 404; invalid slugs and cursors are 400", async () => {
  for (const route of ["/api/lanes/absent", "/api/lanes/absent/events"]) assert.equal((await fetch(url + route)).status, 404);
  for (const route of ["/api/lanes/bad%2Fslug", "/api/lanes/bad%5Cslug/events", "/api/lanes/%00", "/api/lanes/%ZZ", "/api/lanes/newest/events?from=-1", "/api/lanes/newest/events?from=1.5"]) assert.equal((await fetch(url + route)).status, 400, route);
  assert.deepEqual(await get("/api/lanes/older/events"), { next: 0, events: [] });
});
test("HTML is self-contained and includes all seven tabs", async () => {
  const response = await fetch(url + "/");
  assert.match(response.headers.get("content-type"), /text\/html/);
  const html = await response.text();
  for (const name of ["Plan", "Thinking", "Commands", "Files", "Messages", "Report", "Log"]) assert.match(html, new RegExp(`>${name}<`));
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /<(script|link)[^>]+(?:src|href)=/);
});
test("usage aggregation matches ledger counts, cache pricing and time windows", async () => {
  const row = { ts: new Date().toISOString(), lane: "codex-implement", status: "ran", project: "fixture", prompt_tokens: 100, cached_tokens: 40, completion_tokens: 20, duration_ms: 6000 };
  await fs.writeFile(process.env.LLM_USAGE_LOG, [row, { ...row, lane: "claude", status: "driver", prompt_tokens: 0, cached_tokens: 0, completion_tokens: 0 }, { ...row, ts: new Date(Date.now() - 2 * 3600000).toISOString() }].map((value) => JSON.stringify(value)).join("\n") + "\nbad\n");
  const summary = await get("/api/usage?since=1h");
  assert.equal(summary.total.calls, 2);
  assert.equal(summary.external.calls, 1);
  assert.equal(summary.external.minutes, 0.1);
  assert.equal(summary.usd.external, 0.00024);
  assert.equal(summary.ratio_claude_to_external, 0);
  assert.equal((await get("/api/usage?since=24h")).total.calls, 3);
  assert.equal((await get("/api/usage?since=7d")).total.calls, 3);
  assert.equal((await fetch(url + "/api/usage?since=bad")).status, 400);
  await fs.rm(process.env.LLM_USAGE_LOG);
  assert.equal((await get("/api/usage")).total.calls, 0);
});
test("CLI reuses a running dashboard and exits successfully", async () => {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(here, "../scripts/lane-dashboard.mjs"), "--dir", root, "--port", String(server.address().port)], { windowsHide: true });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
  assert.equal(result.code, 0);
  assert.ok(result.output.includes(url), result.output);
});

const run = (script, args, env = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(here, "../scripts", script), ...args], { windowsHide: true, env: { ...process.env, ...env } });
  let stdout = "", stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  child.on("error", reject);
  child.on("close", (code) => resolve({ code, stdout, stderr }));
});

test("foreground, batch and detached JSON expose the reused dashboard", async () => {
  const first = path.join(root, "refused-one.md"), second = path.join(root, "refused-two.md");
  await fs.writeFile(first, "OBJECTIVE: incomplete\n");
  await fs.writeFile(second, "OBJECTIVE: incomplete\n");
  const env = { LLM_DASHBOARD: "1", LLM_DASHBOARD_PORT: String(server.address().port), LLM_USAGE_LOG: path.join(root, "integration-usage.jsonl") };
  for (const flags of [["--spec", first], ["--batch", first, second]]) {
    const result = await run("lane-run.mjs", [...flags, "--status-dir", root, "--json"], env);
    const reports = JSON.parse(result.stdout);
    for (const report of Array.isArray(reports) ? reports : [reports]) assert.equal(report.dashboard, url);
    assert.match(result.stderr, /WATCH: [^\n]+\nDASHBOARD: /);
  }
  const detached = await run("lane-run.mjs", ["--detach", "--spec", first, "--status-dir", root, "--json"], env);
  assert.equal(detached.code, 0, detached.stderr);
  const launched = JSON.parse(detached.stdout);
  assert.equal(launched.dashboard, url);
  assert.deepEqual(launched.slugs, ["refused-one"]);
  const waited = await run("lane-run.mjs", ["--wait", "refused-one", "--timeout", "15", "--status-dir", root], env);
  assert.equal(waited.code, 2, waited.stdout + waited.stderr);
  assert.match(waited.stdout, /LANE REPORT/);
  const text = await run("lane-run.mjs", ["--spec", first, "--status-dir", root], env);
  assert.match(text.stdout, /WATCH: [^\n]+\nDASHBOARD: /);
});

test("CLI refuses a port occupied by a different application", async () => {
  const other = http.createServer((request, response) => response.end('{"app":"other"}'));
  await new Promise((resolve) => other.listen(0, "127.0.0.1", resolve));
  try {
    const result = await run("lane-dashboard.mjs", ["--port", String(other.address().port), "--dir", root]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /EADDRINUSE/);
  } finally { other.closeAllConnections(); await new Promise((resolve) => other.close(resolve)); }
});

test("missing status directory is empty and log tails are bounded", async () => {
  const absent = createServer({ dir: path.join(root, "missing") });
  await new Promise((resolve) => absent.listen(0, "127.0.0.1", resolve));
  try { assert.deepEqual(await (await fetch(`http://127.0.0.1:${absent.address().port}/api/lanes`)).json(), []); }
  finally { absent.closeAllConnections(); await new Promise((resolve) => absent.close(resolve)); }
  await fs.writeFile(path.join(root, "newest.log"), "line\n".repeat(20000) + "last line\n");
  const detail = await get("/api/lanes/newest");
  assert.ok(Buffer.byteLength(detail.log) <= 65536);
  assert.match(detail.log, /last line\n$/);
});

test("complete unterminated JSON lines are read and a truncated stream resets its cursor", async () => {
  const file = path.join(root, "older.events.jsonl");
  await fs.writeFile(file, '{"type":"turn.started"}');
  assert.deepEqual(await get("/api/lanes/older/events"), { next: 1, events: [{ type: "turn.started" }] });
  await fs.appendFile(file, '\n{"type":"turn.completed"}\n');
  assert.deepEqual(await get("/api/lanes/older/events?from=1"), { next: 2, events: [{ type: "turn.completed" }] });
  await fs.writeFile(file, '{"type":"thread.started"}\n');
  assert.deepEqual(await get("/api/lanes/older/events?from=2"), { next: 1, events: [{ type: "thread.started" }] });
});

test("cross-origin requests and writes cannot access lane data", async () => {
  assert.equal((await fetch(url + "/api/lanes", { headers: { Origin: "https://untrusted.invalid" } })).status, 403);
  assert.equal((await fetch(url + "/api/lanes", { method: "POST" })).status, 405);
});
