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
  const r = spawnSync(process.execPath, [driver, "--spec", specPath, "--timeout", "60", "--json", ...extraArgs], { cwd: repo, encoding: "utf8", env: { ...process.env, LANE_RUN_LANE_SH: stub, LLM_USAGE_LOG: path.join(root, "u.jsonl") } });
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
