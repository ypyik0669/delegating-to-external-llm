import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = fs.mkdtempSync(path.join(root, "tests", ".codex-home-"));
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
function run(f) {
  const r = spawnSync("bash", [slash(path.join(root, "scripts/codex-lane.sh")), "--analyze", "test home"], {
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

test("default private home is created and seeded byte-for-byte", () => {
  const f = fixture();
  const target = path.join(f.home, ".claude", "llm-codex-home");
  ran(f, target, "private");
  assert.deepEqual(fs.readFileSync(path.join(target, "config.toml")), fs.readFileSync(path.join(root, "codex-home/config.toml")));
  assert.match(fs.readFileSync(path.join(target, "config.toml"), "utf8"), /^model_reasoning_summary = "concise"$/m);
});

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
