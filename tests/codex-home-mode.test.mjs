import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "dtel-codex-home-"));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const slash = (p) => p.replace(/\\/g, "/");
const native = (p) => process.platform === "win32" ? p.replace(/^\/([a-z])\//i, "$1:/") : p;
const real = (p) => {
  const resolved = fs.realpathSync(native(p));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};
let serial = 0;
function fixture(setting) {
  const home = path.join(scratch, String(++serial));
  const bin = path.join(home, "bin");
  const cwd = path.join(home, "work");
  for (const dir of [bin, cwd, path.join(home, ".claude"), path.join(home, ".codex")]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "llm-relay.env"),
    `LLM_BASE=https://unused.invalid\nLLM_KEY=test-key\n${setting === undefined ? "" : `LLM_CODEX_HOME=${setting}\n`}`);
  fs.writeFileSync(path.join(bin, "codex"), `#!/usr/bin/env bash
if [ "$1" = --version ]; then echo stub-codex; exit 0; fi
if [ -n "$ARGS_DUMP" ]; then printf '%s\\n' "$@" > "$ARGS_DUMP"; fi
if [ -n "$PROMPT_DUMP" ]; then cat > "$PROMPT_DUMP"; fi
if [ -n "$LANE_ACTIONS" ]; then
  node -e 'const fs=require("fs");const actions=JSON.parse(process.env.LANE_ACTIONS);for(const change of actions.writes||[]){fs.mkdirSync(require("path").dirname(change.path),{recursive:true});fs.writeFileSync(change.path,change.text);}for(const event of actions.events||[])console.log(JSON.stringify(event));'
fi
if [ "$WRITE_SCRATCH" = 1 ]; then
  mkdir -p .lane-scratch/nested
  printf 'brief\\n' > .lane-scratch/nested/brief.md
  printf 'updated\\n' > .lane-scratch/tracked.md
  printf 'stray\\n' > outside.txt
  printf 'stray\\n' > 'tracked file.txt'
fi
final=""; model=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output-last-message) final="$2"; shift 2 ;;
    --model) model="$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf 'CODEX_HOME=%s\\nMODEL=%s\\n' "$CODEX_HOME" "$model" > "$final"
exit 0
`, { mode: 0o755 });
  const env = { ...process.env, HOME: slash(home), USERPROFILE: home, CODEX_HOME: "",
    LANE_CODEX_HOME: "", LLM_CODEX_HOME: "", LLM_MODEL: "", LLM_BASE: "", LLM_KEY: "",
    LLM_CODEX_ACCESS: "workspace", EVAL_CODEX_DISABLED: "", LLM_USAGE_LOG: path.join(home, "usage.jsonl"),
    TMPDIR: slash(home), TMP: home, TEMP: home, GIT_CEILING_DIRECTORIES: slash(home), LANE_STATUS_DIR: path.join(home, "status"), LLM_LANE_MAX_INPUT_TOKENS: "3000000" };
  // Windows environment keys are case-insensitive; avoid inherited Path overriding PATH.
  const inheritedPath = Object.entries(env).find(([k]) => k.toUpperCase() === "PATH")?.[1] || "";
  for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
  env.PATH = bin + path.delimiter + inheritedPath;
  return { home, cwd, env };
}
function run(f, args = ["--analyze", "test home"]) {
  const r = spawnSync("bash", [slash(path.join(root, "scripts/codex-lane.sh")), ...args], {
    cwd: f.cwd, env: f.env, encoding: "utf8", timeout: 60000,
  });
  return { ...r, raw: r.stdout + r.stderr };
}
function ran(f, expectedHome, label) {
  const r = run(f);
  assert.equal(r.status, 0, r.raw);
  const reported = r.stdout.match(/^CODEX_HOME=(.+)$/m)?.[1].trim();
  assert.ok(reported, r.raw);
  assert.equal(real(reported), real(expectedHome));
  assert.ok(r.stdout.includes(`home: ${label},`), r.raw);
  const row = JSON.parse(fs.readFileSync(f.env.LLM_USAGE_LOG, "utf8").trim());
  assert.equal(row.home, label);
  assert.equal(row.status, "ran");
  return r;
}

for (const transport of ["--analyze", "--task", "--task-file"]) {
  test(`analysis prompt preserves literal task bytes via ${transport}`, () => {
    const f = fixture();
    const task = 'Inspect src/a & (b) \'single\' "double" | \\ $HOME $(echo unsafe) $& {{TASK}}\nsecond line\n\n';
    const taskFile = path.join(f.home, "task text.md");
    fs.writeFileSync(taskFile, task);
    f.env.PROMPT_DUMP = slash(path.join(f.home, "prompt.md"));
    const args = transport === "--analyze" ? [transport, task] : ["--analyze", "ignored", transport, transport === "--task-file" ? slash(taskFile) : task];
    const result = run(f, args);
    assert.equal(result.status, 0, result.raw);
    const template = fs.readFileSync(path.join(root, "templates/analysis-prompt.md"), "utf8");
    const expected = Buffer.from(template.replace("{{TASK}}", () => task));
    assert.deepEqual(fs.readFileSync(f.env.PROMPT_DUMP).subarray(0, expected.length), expected);
  });
}

for (const mode of ["--analyze", "--review"]) {
  test(`${mode} retains scratch artifacts but reverts other writes`, () => {
    const f = fixture();
    const git = (...args) => {
      const result = spawnSync("git", args, { cwd: f.cwd, env: f.env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return result.stdout;
    };
    git("init", "-q");
    git("config", "core.autocrlf", "false");
    fs.mkdirSync(path.join(f.cwd, ".lane-scratch"));
    fs.writeFileSync(path.join(f.cwd, ".lane-scratch/tracked.md"), "original\n");
    fs.writeFileSync(path.join(f.cwd, "tracked file.txt"), "original\n");
    git("add", "-A");
    git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
    f.env.WRITE_SCRATCH = "1";
    const out = path.join(f.cwd, ".lane-scratch/output-brief.md");
    const args = [...(mode === "--analyze" ? [mode, "inspect"] : [mode]), "--out", slash(out)];
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = run(f, args);
      assert.equal(result.status, 0, result.raw);
      assert.equal(fs.readFileSync(path.join(f.cwd, ".lane-scratch/nested/brief.md"), "utf8"), "brief\n");
      assert.equal(fs.readFileSync(path.join(f.cwd, ".lane-scratch/tracked.md"), "utf8"), "updated\n");
      assert.match(fs.readFileSync(out, "utf8"), /CODEX_HOME=/);
      assert.equal(fs.existsSync(path.join(f.cwd, "outside.txt")), false);
      assert.equal(fs.readFileSync(path.join(f.cwd, "tracked file.txt"), "utf8"), "original\n");
      assert.match(result.stdout, /STRAY WRITES.*outside.txt/);
      assert.doesNotMatch(result.stdout.match(/STRAY WRITES.*/)?.[0] || "", /\.lane-scratch/);
    }
    const exclude = fs.readFileSync(path.join(f.cwd, ".git/info/exclude"), "utf8");
    assert.equal(exclude.split(/\r?\n/).filter((line) => line === "/.lane-scratch/").length, 1);
    assert.match(git("check-ignore", ".lane-scratch/nested/brief.md"), /brief.md/);
  });
}

test("analyze resume invokes the original session with a fresh read-only task", () => {
  const fixtureValue = fixture();
  fixtureValue.env.ARGS_DUMP = slash(path.join(fixtureValue.home, "args.txt"));
  fixtureValue.env.PROMPT_DUMP = slash(path.join(fixtureValue.home, "prompt.md"));
  const result = run(fixtureValue, ["--analyze", "new continuation task", "--resume", "analysis-thread"]);
  assert.equal(result.status, 0, result.raw);
  const args = fs.readFileSync(fixtureValue.env.ARGS_DUMP, "utf8");
  assert.match(args, /^exec\nresume\n/);
  assert.match(args, /\nanalysis-thread\n-\n/);
  assert.match(fs.readFileSync(fixtureValue.env.PROMPT_DUMP, "utf8"), /new continuation task[\s\S]*read-only by contract/);
});

test("default private home is created and seeded byte-for-byte", () => {
  const f = fixture();
  const target = path.join(f.home, ".claude", "llm-codex-home");
  ran(f, target, "private");
  assert.deepEqual(fs.readFileSync(path.join(target, "config.toml")), fs.readFileSync(path.join(root, "codex-home/config.toml")));
  assert.match(fs.readFileSync(path.join(target, "config.toml"), "utf8"), /^model_reasoning_summary = "concise"$/m);
});

function linkedFixture() {
  const fixtureValue = fixture();
  const main = fixtureValue.cwd;
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: main, env: fixtureValue.env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  git("init", "-q");
  git("config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(main, "allowed.txt"), "original\n");
  fs.writeFileSync(path.join(main, ".gitignore"), "node_modules/\n.lanes/\n.lane-scratch/\nignored.txt\n");
  git("add", "-A");
  git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
  fixtureValue.cwd = path.join(fixtureValue.home, "lane");
  git("worktree", "add", "-qb", "lane", fixtureValue.cwd);
  const spec = path.join(fixtureValue.home, "spec.md");
  fs.writeFileSync(spec, "OBJECTIVE: update allowed.txt\nFILES: allowed.txt\n");
  return { ...fixtureValue, main, spec };
}

test("main-tree changes by someone else are untouched and are not stray writes", () => {
  const fixtureValue = linkedFixture();
  const writes = [
    { path: path.join(fixtureValue.cwd, "allowed.txt"), text: "lane\n" },
    { path: path.join(fixtureValue.main, "merged.txt"), text: "another lane\n" },
    { path: path.join(fixtureValue.main, "node_modules/keep.txt"), text: "dependency\n" },
  ];
  fixtureValue.env.LANE_ACTIONS = JSON.stringify({ writes });
  const result = run(fixtureValue, ["--spec", slash(fixtureValue.spec), "--files", "allowed.txt"]);
  assert.equal(result.status, 0, result.raw);
  assert.doesNotMatch(result.stdout, /WROTE OUTSIDE WORKTREE/);
  for (const change of writes) assert.equal(fs.readFileSync(change.path, "utf8"), change.text);
  assert.equal(fs.existsSync(path.join(fixtureValue.cwd, "merged.txt")), false);
});

for (const evidence of ["file_change", "apply_patch"]) {
  test(`main-tree write attributed by ${evidence} is recovered without a stash`, () => {
    const fixtureValue = linkedFixture();
    const file = slash(path.join(fixtureValue.main, "allowed.txt"));
    const item = evidence === "file_change"
      ? { type: "file_change", status: "completed", changes: [{ path: file, kind: "update" }] }
      : { type: "command_execution", status: "completed", exit_code: 0, command: `apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: ${file}\n@@\n-original\n+lane\n*** End Patch\nPATCH` };
    fixtureValue.env.LANE_ACTIONS = JSON.stringify({ writes: [{ path: file, text: "lane\n" }], events: [{ type: "item.completed", item }] });
    const result = run(fixtureValue, ["--spec", slash(fixtureValue.spec), "--files", "allowed.txt"]);
    assert.equal(result.status, 0, result.raw);
    assert.match(result.stdout, /WROTE OUTSIDE WORKTREE: allowed.txt/);
    assert.equal(fs.readFileSync(file, "utf8"), "original\n");
    assert.equal(fs.readFileSync(path.join(fixtureValue.cwd, "allowed.txt"), "utf8"), "lane\n");
  });
}

for (const scenario of ["ignored", "dirty", "command", "destination"]) {
  test(`ambiguous ${scenario} stray is reported but neither tree is changed by recovery`, () => {
    const fixtureValue = linkedFixture();
    const relative = scenario === "ignored" ? "node_modules/keep.txt" : "allowed.txt";
    const file = slash(path.join(fixtureValue.main, relative));
    if (scenario === "dirty") fs.writeFileSync(file, "user edit\n");
    const writes = [{ path: file, text: "external lane write\n" }, { path: path.join(fixtureValue.cwd, "allowed.txt"), text: "local lane write\n" }];
    const item = scenario === "command"
      ? { type: "command_execution", status: "completed", exit_code: 0, cwd: slash(fixtureValue.main), command: `echo changed > "${file}"` }
      : { type: "file_change", status: "completed", changes: [{ path: file, kind: "update" }] };
    if (scenario !== "destination") writes[1] = { path: path.join(fixtureValue.cwd, "new.txt"), text: "new\n" };
    fixtureValue.env.LANE_ACTIONS = JSON.stringify({ writes, events: [{ type: "item.completed", item }] });
    const result = run(fixtureValue, ["--spec", slash(fixtureValue.spec), "--files", "allowed.txt,new.txt"]);
    assert.equal(result.status, 5, result.raw);
    assert.match(result.stdout, /WROTE OUTSIDE WORKTREE \(not moved\):/);
    for (const change of writes) assert.equal(fs.readFileSync(change.path, "utf8"), change.text);
  });
}

test("private home retains existing config and follows the user's original model", () => {
  const f = fixture("private");
  const target = path.join(f.home, ".claude", "llm-codex-home");
  fs.mkdirSync(target);
  const marker = 'model = "private-model"\n# keep me\n';
  fs.writeFileSync(path.join(target, "config.toml"), marker);
  fs.writeFileSync(path.join(f.home, ".codex", "config.toml"), 'model = "user-model"\n');
  assert.match(ran(f, target, "private").stdout, /MODEL=user-model/);
  assert.equal(fs.readFileSync(path.join(target, "config.toml"), "utf8"), marker);
});

test("shared uses HOME/.codex without changing marker config", () => {
  const f = fixture("shared");
  const target = path.join(f.home, ".codex");
  const marker = Buffer.from('# personal config\r\nmodel = "personal"\r\n');
  fs.writeFileSync(path.join(target, "config.toml"), marker);
  assert.match(ran(f, target, "shared").stdout, /MODEL=personal/);
  assert.deepEqual(fs.readFileSync(path.join(target, "config.toml")), marker);
  assert.equal(fs.existsSync(path.join(f.home, ".claude", "llm-codex-home")), false);
});

test("shared honors incoming CODEX_HOME and never seeds a missing config", () => {
  const f = fixture("shared");
  const target = path.join(f.home, "custom codex");
  fs.mkdirSync(target);
  f.env.CODEX_HOME = slash(target);
  ran(f, target, "shared");
  assert.equal(fs.existsSync(path.join(target, "config.toml")), false);
});

test("explicit path with spaces uses existing config without changes", () => {
  const f = fixture();
  const target = path.join(f.home, "explicit home");
  fs.mkdirSync(target);
  const marker = '# explicit config\n';
  fs.writeFileSync(path.join(target, "config.toml"), marker);
  fs.appendFileSync(path.join(f.home, ".claude/llm-relay.env"), `LLM_CODEX_HOME=${slash(target)}\n`);
  ran(f, target, slash(target));
  assert.equal(fs.readFileSync(path.join(target, "config.toml"), "utf8"), marker);
});

test("environment selection beats the env file and LANE_CODEX_HOME beats both", () => {
  const f = fixture("missing-file-home");
  f.env.LLM_CODEX_HOME = "shared";
  ran(f, path.join(f.home, ".codex"), "shared");
  fs.unlinkSync(f.env.LLM_USAGE_LOG);
  const target = path.join(f.home, "override");
  fs.mkdirSync(target);
  f.env.LANE_CODEX_HOME = slash(target);
  ran(f, target, slash(target));
  assert.equal(fs.existsSync(path.join(target, "config.toml")), false);
});

test("literal ~/ paths from the env file expand to the temporary HOME", () => {
  const f = fixture("~/.codex");
  ran(f, path.join(f.home, ".codex"), "~/.codex");
});

for (const mode of ["explicit", "shared", "override"]) {
  test(`${mode} missing home exits 3 unavailable without creating it`, () => {
    const f = fixture();
    const target = slash(path.join(f.home, "missing home"));
    if (mode === "shared") { f.env.LLM_CODEX_HOME = "shared"; f.env.CODEX_HOME = target; }
    else if (mode === "override") f.env.LANE_CODEX_HOME = target;
    else fs.appendFileSync(path.join(f.home, ".claude/llm-relay.env"), `LLM_CODEX_HOME=${target}\n`);
    const r = run(f);
    assert.equal(r.status, 3, r.raw);
    assert.ok(r.raw.includes(`codex home not found: ${target}`), r.raw);
    assert.match(r.stdout, /STATUS: unavailable/);
    assert.equal(fs.existsSync(target), false);
    assert.equal(JSON.parse(fs.readFileSync(f.env.LLM_USAGE_LOG, "utf8").trim()).home, mode === "shared" ? "shared" : target);
  });
}

test("usage accepts home and future fields, and absent home is null", () => {
  const f = fixture();
  const script = (name, args) => spawnSync(process.execPath, [path.join(root, "scripts", name), ...args], {
    cwd: f.cwd, env: f.env, encoding: "utf8", timeout: 60000,
  });
  assert.equal(script("usage-log.mjs", ["--home", "shared", "--in", "12"]).status, 0);
  assert.equal(script("usage-log.mjs", ["--in", "8"]).status, 0);
  const rows = fs.readFileSync(f.env.LLM_USAGE_LOG, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows[0].home, "shared");
  assert.equal(rows[1].home, null);
  rows[0].future_field = { value: true };
  fs.writeFileSync(f.env.LLM_USAGE_LOG, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const r = script("usage.mjs", ["--since", "all", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).total.prompt_tokens, 20);
  assert.equal(script("usage.mjs", ["--since", "all"]).status, 0);
});
