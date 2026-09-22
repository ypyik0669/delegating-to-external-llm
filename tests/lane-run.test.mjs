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
process.env.LLM_DASHBOARD = "0";
process.env.HOME = process.env.USERPROFILE = root;
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
b.args=args;
if(b.captureTask){const file=args[args.indexOf("--task-file")+1];b.task=fs.readFileSync(file,"utf8");b.args=args;}
if(b.metadata){const file=args[args.indexOf("--status-file")+1];fs.writeFileSync(file,JSON.stringify({...JSON.parse(fs.readFileSync(file,"utf8")),...b.metadata}));}
const n=(b.calls=(b.calls||0)+1);fs.writeFileSync(process.argv[1],JSON.stringify(b));
if(b.delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,b.delay);
if(b.gate){const deadline=Date.now()+20000;while(!fs.existsSync(b.gate)&&Date.now()<deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}
for(const f of (b.touch||[])) fs.appendFileSync(f, "// touched\\n");
if(b.fixOnRound && n>=b.fixOnRound) fs.writeFileSync("add.mjs","export const add = (a, b) => a + b;\\n");
if(b.growLock){fs.appendFileSync("bun.lock", Array.from({length:60},(_,i)=>"new "+i).join("\\n")+"\\n");}
console.log("===== CODEX FINAL MESSAGE (stub) =====");console.log(b.say||"done");console.log("===== END =====");
console.log("SESSION: stub-session-1");console.log("TOKENS: in=100 cached=0 out=10");
if(b.status && b.status!=="ran"){console.log("STATUS: "+b.status);console.log("REASON: stub says so");process.exit(b.status==="refused"?3:2);}
console.log("----- changed by this run -----");if(!b.hideChanges) for(const f of (b.touch||[])) console.log(f);
if(!b.hideChanges && b.fixOnRound && n>=b.fixOnRound) console.log("add.mjs");
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
test("driver preserves resolved lane metadata through verification and completion", () => {
  const metadata = { model: "resolved-model", effort: "high", home: "shared", access: "workspace-net" };
  const result = runDriver(specText(), { fixOnRound: 1, metadata });
  assert.equal(result.code, 0, result.raw);
  const status = JSON.parse(fs.readFileSync(result.json.status_file, "utf8"));
  for (const [key, value] of Object.entries(metadata)) assert.equal(status[key], value, key);
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
test("content changes override a false refused result and still run verification", () => {
  const result = runDriver(specText(), { status: "refused", fixOnRound: 1 });
  assert.equal(result.code, 0, result.raw);
  assert.deepEqual(result.json.changes, ["add.mjs"]);
  assert.equal(result.json.verified[0].exit, 0);
});

test("explicit spec resume keeps the new spec and independent verification", () => {
  const result = runDriver(specText(), { fixOnRound: 1 }, ["--resume", "previous-thread"]);
  assert.equal(result.code, 0, result.raw);
  const captured = JSON.parse(fs.readFileSync(behaviour, "utf8"));
  assert.equal(captured.args[captured.args.indexOf("--resume") + 1], "previous-thread");
  assert.equal(result.json.verified[0].exit, 0);
  assert.match(result.json.rounds[0], /^resume/);
});

test("fenced files have content snapshots even without Git", async () => {
  const { snapshotFiles, changedFiles } = await import("../scripts/lane-run.mjs");
  const directory = fs.mkdtempSync(path.join(root, "plain-"));
  fs.writeFileSync(path.join(directory, "allowed.txt"), "before");
  const before = snapshotFiles(directory, ["allowed.txt", "new.txt"]);
  fs.writeFileSync(path.join(directory, "allowed.txt"), "after");
  fs.writeFileSync(path.join(directory, "new.txt"), "new");
  assert.deepEqual(changedFiles(before, snapshotFiles(directory, ["allowed.txt", "new.txt"])), ["allowed.txt", "new.txt"]);
});

test("stray evidence does not treat displayed patch text as an executed patch", async () => {
  const { strayEvidence } = await import("../scripts/lane-run.mjs");
  const escaped = path.join(root, "outside.txt");
  const patch = `*** Begin Patch\n*** Update File: ${escaped}\n@@\n-old\n+new\n*** End Patch`;
  const event = (command, extra = {}) => ({ type: "item.completed", item: { type: "command_execution", status: "completed", exit_code: 0, command, ...extra } });
  assert.equal(strayEvidence([event(`cat <<'PATCH'\n${patch}\nPATCH`)], repo).get(escaped), false);
  assert.equal(strayEvidence([event(`apply_patch <<'PATCH'\n${patch}\nPATCH`)], repo).get(escaped), true);
  assert.equal(strayEvidence([event(`apply_patch <<'PATCH'\n${patch}\nPATCH`, { exit_code: 1 })], repo).get(escaped), false);
  assert.equal(strayEvidence([event(`cd "${root}" && echo changed > outside.txt`)], repo).get(root), false);
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

test("relative WORKTREE resolves FILES and verification in the same directory", () => {
  const worktree = path.join(root, "selected-worktree");
  fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
  fs.writeFileSync(path.join(worktree, "src/only.txt"), "original\n");
  const spec = specText("WORKTREE: ../selected-worktree\n").replace("FILES: add.mjs", "FILES: src/only.txt").replace(/VERIFICATION:.*/, 'VERIFICATION: node -e "if(!require(\'fs\').readFileSync(\'src/only.txt\',\'utf8\').includes(\'touched\'))process.exit(1)"');
  const result = runDriver(spec, { touch: ["src/only.txt"] });
  assert.equal(result.code, 0, result.raw);
  assert.deepEqual(result.json.changes, ["src/only.txt"]);
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
  const slug = launched.json?.slugs[0];
  assert.ok(slug, launched.raw);
  assert.ok(launched.json, launched.raw);
  assert.equal(launched.json.dashboard, null);
  const result = waitFor([slug]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const status = JSON.parse(fs.readFileSync(path.join(statusDir, `${slug}.status.json`), "utf8"));
  assert.equal(result.stdout, fs.readFileSync(status.report_file, "utf8"));
  assert.match(result.stdout, /^LANE REPORT\n/);
  assert.match(result.stdout, /RESUME: codex resume stub-session-1/);
  assert.ok(status.pid > 0);
  assert.ok(fs.existsSync(status.log_file));
});

test("Windows driver launcher uses a hidden inherited console and separate stderr", async () => {
  const { buildDetachedLauncher } = await import("../scripts/lane-run.mjs");
  const launcher = buildDetachedLauncher({ platform: "win32", executable: "C:\\Program Files\\node.exe", args: ["C:\\lane driver.mjs", "--analyze", 'a "quote" and apostrophe\''], logFile: "C:\\logs\\lane.log" });
  assert.equal(launcher.command, "powershell.exe");
  assert.match(launcher.args.join(" "), /Start-Process -WindowStyle Hidden/);
  assert.match(launcher.args.join(" "), /-RedirectStandardError 'C:\\logs\\lane.log.err'/);
  assert.equal(launcher.options.detached, false);
  assert.equal(launcher.options.windowsHide, true);
  const unix = buildDetachedLauncher({ platform: "linux", executable: "/usr/bin/node", args: ["driver.mjs"], logFile: "/tmp/lane.log" });
  assert.equal(unix.command, "/usr/bin/node");
  assert.equal(unix.options.detached, true);
});

test("dirty tracked and untracked files are detected by before/after hashes", async () => {
  const { snapshotFiles, changedFiles } = await import("../scripts/lane-run.mjs");
  fs.appendFileSync(path.join(repo, "add.mjs"), "// pre-existing change\n");
  fs.writeFileSync(path.join(repo, "untracked.txt"), "before\n");
  fs.writeFileSync(path.join(repo, "untouched.txt"), "keep\n");
  const before = snapshotFiles(repo);
  fs.appendFileSync(path.join(repo, "add.mjs"), "// lane change\n");
  fs.writeFileSync(path.join(repo, "untracked.txt"), "after\n");
  fs.rmSync(path.join(repo, "bun.lock"));
  assert.deepEqual(changedFiles(before, snapshotFiles(repo)), ["add.mjs", "bun.lock", "untracked.txt"]);
});

test("LANE REPORT includes edits to already-dirty files even if the lane path list is empty", () => {
  fs.appendFileSync(path.join(repo, "add.mjs"), "// user's dirty edit\n");
  const result = runDriver(specText(), { fixOnRound: 1, hideChanges: true });
  assert.equal(result.code, 0, result.raw);
  assert.deepEqual(result.json.changes, ["add.mjs"]);
});

test("real shell reports already-dirty paths and checks them against FILES", () => {
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "codex"), `#!/usr/bin/env bash
if [ "$1" = --version ]; then echo stub-codex; exit 0; fi
printf '%s\\n' '// lane edit' >> add.mjs
printf '%s\\n' '{"type":"thread.started","thread_id":"hash-session"}' '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}'
`, { mode: 0o755 });
  const spec = path.join(root, "hash.md");
  fs.writeFileSync(spec, specText());
  const slash = (value) => value.replace(/\\/g, "/");
  const env = { ...process.env, HOME: slash(root), USERPROFILE: root, LANE_CODEX_HOME: slash(root), LLM_MODEL: "stub", LLM_BASE: "https://unused.invalid", LLM_KEY: "test", EVAL_CODEX_DISABLED: "", LLM_USAGE_LOG: path.join(root, "hash-usage.jsonl"), TMPDIR: slash(root), TMP: root, TEMP: root };
  const inherited = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] || "";
  for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
  env.PATH = bin + path.delimiter + inherited;
  fs.appendFileSync(path.join(repo, "add.mjs"), "// pre-existing edit\n");
  for (const allowed of ["add.mjs", "other.mjs"]) {
    const result = spawnSync("bash", [slash(path.join(here, "../scripts/codex-lane.sh")), "--spec", slash(spec), "--files", allowed, "--timeout", "20"], { cwd: repo, env, encoding: "utf8", windowsHide: true, timeout: 120000 });
    assert.equal(result.status, allowed === "add.mjs" ? 0 : 5, result.stdout + result.stderr);
    assert.match(result.stdout, /----- changed by this run -----\r?\nadd.mjs/);
    if (allowed !== "add.mjs") assert.match(result.stdout, /SCOPE VIOLATION: add.mjs/);
  }
});

test("copied plugin helpers detect ignored fenced edits and fence explicit resumes", () => {
  const copied = path.join(root, "copied-plugin");
  for (const directory of ["scripts", "templates", "codex-home"]) {
    fs.mkdirSync(path.join(copied, directory), { recursive: true });
    for (const entry of fs.readdirSync(path.join(here, "..", directory), { withFileTypes: true })) {
      if (entry.isFile()) fs.copyFileSync(path.join(here, "..", directory, entry.name), path.join(copied, directory, entry.name));
    }
  }
  const bin = path.join(copied, "bin");
  fs.mkdirSync(bin);
  const prompt = path.join(root, "copied-prompt.md");
  fs.writeFileSync(path.join(bin, "codex"), `#!/usr/bin/env bash
if [ "$1" = --version ]; then echo stub-codex; exit 0; fi
cat > "$PROMPT_DUMP"
printf changed > ignored.txt
printf '%s\\n' '{"type":"thread.started","thread_id":"continued-session"}' '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}'
`, { mode: 0o755 });
  fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n");
  fs.writeFileSync(path.join(repo, "ignored.txt"), "before");
  const spec = path.join(root, "copied-spec.md");
  fs.writeFileSync(spec, specText().replace("FILES: add.mjs", "FILES: ignored.txt").replace(/VERIFICATION:.*/, 'VERIFICATION: node -e "if(require(\'fs\').readFileSync(\'ignored.txt\',\'utf8\')!==\'changed\')process.exit(1)"'));
  const env = { ...process.env, HOME: copied.replace(/\\/g, "/"), USERPROFILE: copied, LANE_RUN_LANE_SH: path.join(copied, "scripts/codex-lane.sh"), LANE_CODEX_HOME: copied.replace(/\\/g, "/"), PROMPT_DUMP: prompt.replace(/\\/g, "/"), LLM_BASE: "https://unused.invalid", LLM_KEY: "test", LLM_MODEL: "stub", EVAL_CODEX_DISABLED: "", LLM_USAGE_LOG: path.join(root, "copy-usage.jsonl"), TMPDIR: root.replace(/\\/g, "/"), TMP: root, TEMP: root };
  const inherited = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] || "";
  for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
  env.PATH = bin + path.delimiter + inherited;
  const result = spawnSync(process.execPath, [driver, "--spec", spec, "--resume", "original-thread", "--status-dir", statusDir, "--json", "--timeout", "30"], { cwd: repo, env, encoding: "utf8", timeout: 120000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).changes, ["ignored.txt"]);
  assert.equal(JSON.parse(result.stdout).verified[0].exit, 0);
  const text = fs.readFileSync(prompt, "utf8");
  assert.match(text, /WORKING ROOT:/);
  assert.match(text, /PLAN:/);
  assert.match(text, /enforced FILES fence.*ignored.txt/);
  assert.match(text, /OBJECTIVE:/);
});

test("wait times out with RUNNING and can be called again", () => {
  const gate = path.join(root, "release-driver");
  const launched = runDriver(specText(), { fixOnRound: 1, gate }, ["--detach"]);
  const slug = launched.json?.slugs[0];
  assert.ok(slug, launched.raw);
  try {
    const result = waitFor([slug], 1);
    assert.equal(result.status, 10, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`^RUNNING ${slug} phase=.+ elapsed=\\d+m \\d+s in=\\d+ cached=\\d+ out=\\d+ session=.+ last=".*"\\n$`));
  } finally {
    fs.writeFileSync(gate, "release");
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

for (const detached of [false, true]) {
  for (const fileInput of [false, true]) {
    test(`analyze literal task transport: detached=${detached}, file=${fileInput}`, () => {
      const task = 'src/a & (b) \'single\' "double" $HOME $(echo unsafe)\nnext line\n\n' + (fileInput ? "long task\n".repeat(12000) : "");
      const taskFile = path.join(root, "task input.md");
      fs.writeFileSync(taskFile, task);
      fs.writeFileSync(behaviour, JSON.stringify({ captureTask: true, say: "BRIEF: literal analysis" }));
      const args = [driver, "--analyze", ...(fileInput && detached ? [] : [fileInput ? "ignored" : task]), "--cwd", repo, "--status-dir", statusDir];
      if (fileInput) args.push("--task-file", taskFile);
      if (detached) args.push("--detach");
      const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", env: { ...process.env, LANE_RUN_LANE_SH: stub } });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      if (detached) {
        const waited = waitFor([result.stdout.match(/^SLUG: (.+)$/m)?.[1]]);
        assert.equal(waited.status, 0, waited.stdout + waited.stderr);
        assert.match(waited.stdout, /BRIEF: literal analysis/);
      } else assert.match(result.stdout, /BRIEF: literal analysis/);
      const captured = JSON.parse(fs.readFileSync(behaviour, "utf8"));
      assert.equal(captured.task, task);
      assert.ok(captured.args.includes("--task-file"));
      assert.ok(!captured.args.includes(task));
      assert.equal(fs.readFileSync(taskFile, "utf8"), task);
    });
  }
}

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

for (const detached of [false, true]) {
  test(`analyze resumes with 1800s default and reports timed-out brief: detached=${detached}`, () => {
    const out = path.join(root, `timeout-${detached}.md`);
    fs.writeFileSync(behaviour, JSON.stringify({ captureTask: true, status: "timeout", say: "partial brief" }));
    const result = spawnSync(process.execPath, [driver, "--analyze", "continue analysis", "--resume", "previous-analysis", "--out", out, "--status-dir", statusDir, ...(detached ? ["--detach"] : [])], { cwd: repo, encoding: "utf8", env: { ...process.env, LANE_RUN_LANE_SH: stub } });
    assert.equal(result.status, detached ? 0 : 2, result.stdout + result.stderr);
    const waited = waitFor([`timeout-${detached}`]);
    assert.equal(waited.status, 2, waited.stdout + waited.stderr);
    assert.match(waited.stdout, /STATUS: timeout/);
    assert.match(waited.stdout, /RESUME: codex resume stub-session-1/);
    assert.ok(waited.stdout.includes(`BRIEF_PATH: ${out}`), waited.stdout);
    const captured = JSON.parse(fs.readFileSync(behaviour, "utf8"));
    assert.equal(captured.args[captured.args.indexOf("--timeout") + 1], "1800");
    assert.equal(captured.args[captured.args.indexOf("--resume") + 1], "previous-analysis");
    assert.equal(captured.task, "continue analysis");
  });
}

test("analyze explicit timeout overrides 1800s", () => {
  fs.writeFileSync(behaviour, JSON.stringify({ captureTask: true }));
  const result = spawnSync(process.execPath, [driver, "--analyze", "inspect", "--timeout", "47", "--status-dir", statusDir], { cwd: repo, encoding: "utf8", env: { ...process.env, LANE_RUN_LANE_SH: stub } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const captured = JSON.parse(fs.readFileSync(behaviour, "utf8"));
  assert.equal(captured.args[captured.args.indexOf("--timeout") + 1], "47");
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
