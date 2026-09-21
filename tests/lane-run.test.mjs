import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Drives lane-run.mjs with a stub in place of codex-lane.sh (LANE_RUN_LANE_SH). The stub honours a
// per-run behaviour file so each test can script what "codex" does: which files it touches, whether
// it reports refused / scope violation, and how many rounds until the verification passes.
const here = path.dirname(fileURLToPath(import.meta.url));
const driver = path.join(here, "..", "scripts", "lane-run.mjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dtel-lanerun-"));
const statusDir = path.join(root, "status");
const repo = path.join(root, "repo");
fs.mkdirSync(repo, { recursive: true });
const git = (...a) => spawnSync("git", a, { cwd: repo, encoding: "utf8" });
git("init", "-q", "-b", "main");
fs.writeFileSync(path.join(repo, "add.mjs"), "export const add = (a, b) => a - b;\n");
fs.writeFileSync(path.join(repo, "bun.lock"), Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n") + "\n");
git("add", "-A"); git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");

const behaviour = path.join(root, "behaviour.json");
const stub = path.join(root, "stub-lane.sh");
fs.writeFileSync(stub, `#!/usr/bin/env bash
# stub codex-lane: reads behaviour.json, mutates files, prints a lane-style report
B="${behaviour.replace(/\\/g, "/")}"
node -e '
const fs=require("fs");const b=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const args=process.argv.slice(2);const resumed=args.includes("--resume");
const n=(b.calls=(b.calls||0)+1);fs.writeFileSync(process.argv[1],JSON.stringify(b));
if(b.delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,b.delay);
for(const f of (b.touch||[])) fs.appendFileSync(f, "// touched\\n");
if(b.fixOnRound && n>=b.fixOnRound) fs.writeFileSync("add.mjs","export const add = (a, b) => a + b;\\n");
if(b.growLock){fs.appendFileSync("bun.lock", Array.from({length:60},(_,i)=>"new "+i).join("\\n")+"\\n");}
console.log("===== CODEX FINAL MESSAGE (stub) =====");console.log(b.say||"done");console.log("===== END =====");
console.log("SESSION: stub-session-1");console.log("TOKENS: in=100 cached=0 out=10");
if(b.status && b.status!=="ran"){console.log("STATUS: "+b.status);console.log("REASON: stub says so");process.exit(b.status==="refused"?3:2);}
console.log("----- changed by this run -----");for(const f of (b.touch||[])) console.log(f);
if(b.fixOnRound && n>=b.fixOnRound) console.log("add.mjs");
if(b.growLock) console.log("bun.lock");
if(b.violation){console.log("SCOPE VIOLATION: "+b.violation);console.log("STATUS: ran");process.exit(5);}
console.log("STATUS: ran");
' "$B" "$@"
`);

const specText = (extra = "") => `OBJECTIVE: add() subtracts. Fix it.
FILES: add.mjs
INTERFACES: add(a, b) unchanged
CONSTRAINTS: only add.mjs
VERIFICATION: node -e "import('./add.mjs').then(m=>{if(m.add(2,3)!==5)process.exit(1)})" → add(2,3) === 5
REASONING: low
${extra}`;

function runDriver(spec, b, extraArgs = []) {
  fs.writeFileSync(behaviour, JSON.stringify(b));
  const specPath = path.join(root, `spec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.md`);
  fs.writeFileSync(specPath, spec);
  const r = spawnSync(process.execPath, [driver, "--spec", specPath, "--status-dir", statusDir, "--timeout", "60", "--json", ...extraArgs], { cwd: repo, encoding: "utf8", env: { ...process.env, LANE_RUN_LANE_SH: stub, LLM_USAGE_LOG: path.join(root, "u.jsonl") } });
  let json = null; try { json = JSON.parse(r.stdout); } catch {}
  return { code: r.status, json, raw: r.stdout + r.stderr, calls: JSON.parse(fs.readFileSync(behaviour, "utf8")).calls };
}
const reset = () => { git("checkout", "-q", "--", "."); git("clean", "-fdq"); };
test.beforeEach(reset);
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("complete on first round", () => {
  const r = runDriver(specText(), { fixOnRound: 1 });
  assert.equal(r.code, 0, r.raw);
  assert.equal(r.json.status, "complete");
  assert.deepEqual(r.json.changes, ["add.mjs"]);
  assert.equal(r.json.verified[0].exit, 0);
  assert.equal(r.calls, 1);
});
test("verification fails → resumes once → complete", () => {
  const r = runDriver(specText(), { fixOnRound: 2, touch: ["add.mjs"] }, ["--max-resumes", "2"]);
  assert.equal(r.json.status, "complete", r.raw);
  assert.equal(r.calls, 2);
  assert.match(r.json.rounds[1], /^resume/);
});
test("never passes → partial after max resumes", () => {
  const r = runDriver(specText(), { touch: ["add.mjs"] }, ["--max-resumes", "1"]);
  assert.equal(r.json.status, "partial");
  assert.equal(r.code, 5);
  assert.equal(r.calls, 2);
});
test("refused lane → refused report with reason", () => {
  const r = runDriver(specText(), { status: "refused", say: "nothing to do" });
  assert.equal(r.json.status, "refused");
  assert.match(r.json.reason, /stub says so/);
  assert.equal(r.code, 2);
});
test("scope violation → partial with gap", () => {
  const r = runDriver(specText(), { fixOnRound: 1, touch: ["extra.txt"], violation: "extra.txt" });
  assert.equal(r.json.status, "partial");
  assert.match(r.json.gaps.join(" "), /scope violation: extra.txt/);
});
test("oversized lockfile change → partial with gap", () => {
  const r = runDriver(specText(), { fixOnRound: 1, growLock: true });
  assert.equal(r.json.status, "partial");
  assert.match(r.json.gaps.join(" "), /bun.lock changed by \d+ lines/);
});
test("incomplete spec → refused without calling codex", () => {
  const r = runDriver("OBJECTIVE: x\nREASONING: low\n", { fixOnRound: 1 });
  assert.equal(r.json.status, "refused");
  assert.match(r.json.reason, /spec incomplete/);
  assert.equal(r.calls, undefined);
});
test("WORKTREE line selects the cwd", () => {
  const wt = path.join(root, "nope");
  const r = runDriver(specText(`WORKTREE: ${wt}\n`), { fixOnRound: 1 });
  assert.equal(r.json.status, "refused");
  assert.match(r.json.reason, /WORKTREE/);
});

function waitFor(slugs, timeout = 60) {
  return spawnSync(process.execPath, [driver, "--wait", ...slugs, "--timeout", String(timeout), "--status-dir", statusDir], { encoding: "utf8", timeout: (timeout + 10) * 1000 });
}

test("wait recovers a dead driver with an unavailable LANE REPORT", () => {
  fs.mkdirSync(statusDir, { recursive: true });
  const slug = "dead-driver.analysis";
  const statusFile = path.join(statusDir, `${slug}.status.json`);
  assert.throws(() => process.kill(999999, 0), { code: "ESRCH" });
  fs.writeFileSync(statusFile, JSON.stringify({ slug, mode: "analyze", spec: "inspect the stub", phase: "running", pid: 999999, updated_at: new Date().toISOString() }));
  const result = waitFor([slug], 5);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout, /^LANE REPORT\n/);
  assert.match(result.stdout, /REASON: driver exited without report \(pid 999999\)/);
  const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
  assert.equal(status.phase, "done unavailable");
  assert.equal(status.exit, 2);
  assert.equal(result.stdout, fs.readFileSync(status.report_file, "utf8"));
  assert.equal(waitFor([slug], 5).stdout, result.stdout);
});

test("wait recovers stale statuses with missing or invalid driver pids", () => {
  fs.mkdirSync(statusDir, { recursive: true });
  for (const [index, pid] of [undefined, 0, -1, "invalid", 1.5, 2147483648].entries()) {
    const slug = `stale-driver-${index}`;
    fs.writeFileSync(path.join(statusDir, `${slug}.status.json`), JSON.stringify({ phase: "running", pid, updated_at: new Date(Date.now() - 61000).toISOString() }));
    const result = waitFor([slug], 5);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /driver exited without report/);
  }
});

test("wait uses file modification time when a missing-pid status has no timestamp", () => {
  fs.mkdirSync(statusDir, { recursive: true });
  const statusFile = path.join(statusDir, "stale-file.status.json");
  fs.writeFileSync(statusFile, JSON.stringify({ phase: "running" }));
  const stale = new Date(Date.now() - 61000);
  fs.utimesSync(statusFile, stale, stale);
  const result = waitFor(["stale-file"], 5);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout, /driver exited without report/);
});

test("wait leaves fresh invalid-pid statuses and stale live drivers running", () => {
  fs.mkdirSync(statusDir, { recursive: true });
  for (const [slug, pid, updated_at] of [
    ["fresh-invalid", -1, new Date().toISOString()],
    ["stale-live", process.pid, new Date(Date.now() - 61000).toISOString()],
  ]) {
    fs.writeFileSync(path.join(statusDir, `${slug}.status.json`), JSON.stringify({ phase: "running", pid, updated_at }));
    const result = waitFor([slug], 0.1);
    assert.equal(result.status, 10, result.stdout + result.stderr);
    assert.match(result.stdout, /^RUNNING /);
    assert.equal(fs.existsSync(path.join(statusDir, `${slug}.report.txt`)), false);
  }
});

test("detach returns launch lines, then wait returns the saved report", () => {
  const launched = runDriver(specText(), { fixOnRound: 1 }, ["--detach"]);
  assert.equal(launched.code, 0, launched.raw);
  const slug = launched.raw.match(/^SLUG: (.+)$/m)?.[1];
  assert.ok(slug, launched.raw);
  assert.match(launched.raw, /^SLUG: .+\r?\nSTATUS_FILE: .+\r?\nWATCH: .+\r?\n$/);
  const result = waitFor([slug]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const status = JSON.parse(fs.readFileSync(path.join(statusDir, `${slug}.status.json`), "utf8"));
  assert.equal(result.stdout, fs.readFileSync(status.report_file, "utf8"));
  assert.match(result.stdout, /^LANE REPORT\n/);
  assert.match(result.stdout, /RESUME: codex resume stub-session-1/);
  assert.ok(status.pid > 0);
  assert.ok(fs.existsSync(status.log_file));
});

test("wait times out with RUNNING and can be called again", () => {
  const launched = runDriver(specText(), { fixOnRound: 1, delay: 5000 }, ["--detach"]);
  const slug = launched.raw.match(/^SLUG: (.+)$/m)?.[1];
  assert.ok(slug, launched.raw);
  try {
    const result = waitFor([slug], 1);
    assert.equal(result.status, 10, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`^RUNNING ${slug} phase=.+ elapsed=\\d+m \\d+s in=\\d+ cached=\\d+ out=\\d+ session=.+ last=".*"\\n$`));
  } finally {
    assert.equal(waitFor([slug]).status, 0);
  }
});

test("duplicate batch slugs refuse before starting any lane, detached or foreground", () => {
  fs.writeFileSync(behaviour, "{}");
  const spec = path.join(root, "duplicate.md");
  fs.writeFileSync(spec, specText());
  for (const flags of [[], ["--detach"]]) {
    const result = spawnSync(process.execPath, [driver, "--batch", spec, spec, "--status-dir", statusDir, ...flags], { cwd: repo, encoding: "utf8", env: { ...process.env, LANE_RUN_LANE_SH: stub } });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /duplicate.*slug.*duplicate/i);
    assert.equal(JSON.parse(fs.readFileSync(behaviour, "utf8")).calls, undefined);
    assert.equal(fs.existsSync(path.join(statusDir, "duplicate.status.json")), false);
  }
});

test("wait reports a missing slug after the grace period", { timeout: 45000 }, () => {
  const result = waitFor(["missing"], 35);
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.equal(result.stdout, "MISSING missing\n");
});

test("wait passes through partial and refused outcomes and chooses the worst", () => {
  const partial = runDriver(specText(), {}, ["--max-resumes", "0"]);
  const refused = runDriver("OBJECTIVE: incomplete\n", {});
  const partialSlug = path.basename(partial.json.spec, ".md");
  const refusedSlug = path.basename(refused.json.spec, ".md");
  assert.equal(waitFor([partialSlug]).status, 5);
  assert.equal(waitFor([refusedSlug]).status, 2);
  const result = waitFor([partialSlug, refusedSlug]);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.equal((result.stdout.match(/^LANE REPORT$/gm) || []).length, 2);
});

test("detached analyze preserves the full brief in a LANE REPORT", () => {
  fs.writeFileSync(behaviour, JSON.stringify({ say: "BRIEF: stub analysis" }));
  const result = spawnSync(process.execPath, [driver, "--detach", "--analyze", "inspect the stub", "--cwd", repo, "--status-dir", statusDir], { encoding: "utf8", env: { ...process.env, LANE_RUN_LANE_SH: stub, LLM_USAGE_LOG: path.join(root, "u.jsonl") } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const slug = result.stdout.match(/^SLUG: (.+)$/m)?.[1];
  assert.ok(slug, result.stdout);
  const waited = waitFor([slug]);
  assert.equal(waited.status, 0, waited.stdout + waited.stderr);
  assert.match(waited.stdout, /^LANE REPORT\n/);
  assert.match(waited.stdout, /BRIEF: stub analysis/);
});

test("detached batch queues all slugs and respects --cwd", () => {
  fs.writeFileSync(path.join(repo, "add.mjs"), "export const add = (a, b) => a + b;\n");
  fs.writeFileSync(behaviour, "{}");
  const specs = ["detached-one", "detached-two"].map((slug) => {
    const spec = path.join(root, `${slug}.md`);
    fs.writeFileSync(spec, specText());
    return spec;
  });
  const result = spawnSync(process.execPath, [driver, "--detach", "--batch", ...specs, "--cwd", repo, "--concurrency", "1", "--status-dir", statusDir], { cwd: root, encoding: "utf8", env: { ...process.env, LANE_RUN_LANE_SH: stub, LLM_USAGE_LOG: path.join(root, "u.jsonl") } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const slugs = [...result.stdout.matchAll(/^SLUG: (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(slugs, ["detached-one", "detached-two"]);
  for (const slug of slugs) assert.ok(fs.existsSync(path.join(statusDir, `${slug}.status.json`)));
  const waited = waitFor(slugs);
  assert.equal(waited.status, 0, waited.stdout + waited.stderr);
  assert.equal((waited.stdout.match(/^LANE REPORT$/gm) || []).length, 2);
  assert.equal(JSON.parse(fs.readFileSync(behaviour, "utf8")).calls, 2);
});

test("wait limits last_message to 120 characters without embedded quotes or newlines", () => {
  fs.mkdirSync(statusDir, { recursive: true });
  fs.writeFileSync(path.join(statusDir, "long-message.status.json"), JSON.stringify({ phase: "running", started_at: new Date().toISOString(), session: "known-session", last_message: 'say "hello"\n' + "x".repeat(200) }));
  const result = waitFor(["long-message"], 0.1);
  assert.equal(result.status, 10, result.stderr);
  assert.match(result.stdout, /session=known-session/);
  const message = result.stdout.match(/last="([^"]*)"\n$/)?.[1];
  assert.equal(message?.length, 120, result.stdout);
});

test("wait flushes long reports verbatim before exiting", () => {
  fs.mkdirSync(statusDir, { recursive: true });
  const report = "LANE REPORT\n" + "long verification output\n".repeat(10000);
  fs.writeFileSync(path.join(statusDir, "long-report.report.txt"), report);
  fs.writeFileSync(path.join(statusDir, "long-report.status.json"), JSON.stringify({ phase: "done complete", exit: 0 }));
  const result = waitFor(["long-report"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, report);
});

test("batch concurrency cap keeps only one stub lane active", () => {
  fs.writeFileSync(path.join(repo, "add.mjs"), "export const add = (a, b) => a + b;\n");
  const overlapLog = path.join(root, "overlap.json");
  fs.writeFileSync(overlapLog, JSON.stringify({ active: 0, max: 0, runs: 0 }));
  const overlapStub = path.join(root, "overlap-stub.sh");
  fs.writeFileSync(overlapStub, `#!/usr/bin/env bash
node -e '
const fs=require("fs");const p=process.argv[1];const state=JSON.parse(fs.readFileSync(p,"utf8"));state.active++;state.runs++;state.max=Math.max(state.max,state.active);fs.writeFileSync(p,JSON.stringify(state));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,120);state.active--;fs.writeFileSync(p,JSON.stringify(state));
' "${overlapLog.replace(/\\/g, "/")}"
printf '%s\\n' '===== CODEX FINAL MESSAGE (stub) =====' 'done' '===== END =====' 'SESSION: stub-session' 'TOKENS: in=1 cached=0 out=1' 'STATUS: ran'
`);
  const specs = ["one", "two", "three"].map((name) => {
    const p = path.join(root, `batch-${name}.md`);
    fs.writeFileSync(p, specText());
    return p;
  });
  const statusDir = path.join(root, "batch-status");
  const r = spawnSync(process.execPath, [driver, "--batch", ...specs, "--concurrency", "1", "--status-dir", statusDir, "--timeout", "60", "--json"], { cwd: repo, encoding: "utf8", env: { ...process.env, LANE_RUN_LANE_SH: overlapStub, LLM_USAGE_LOG: path.join(root, "u-batch.jsonl") } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(overlapLog, "utf8")).max, 1);
  assert.equal(JSON.parse(r.stdout).length, 3);
});
