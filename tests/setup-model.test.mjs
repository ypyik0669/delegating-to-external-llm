import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = fs.mkdtempSync(path.join(root, "tests", ".setup-model-"));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
let serial = 0;
function fixture(config, customHome = false) {
  const home = path.join(scratch, String(++serial));
  const codexHome = path.join(home, customHome ? "custom-codex" : ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  if (config !== undefined) fs.writeFileSync(path.join(codexHome, "config.toml"), config);
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: customHome ? codexHome : "",
    LLM_BASE: "http://unused.invalid", LLM_KEY: "test-key", LLM_MODEL: "",
    ASTRA_MODEL: "legacy-must-not-win", EVAL_LLM_MODEL: "legacy-must-not-win",
    LLM_USAGE_LOG: path.join(home, "usage.jsonl") };
  return { home, env };
}
function node(script, args, f) {
  return spawnSync(process.execPath, [path.join(root, "scripts", script), ...args], {
    env: f.env, cwd: f.home, encoding: "utf8", timeout: 60000,
  });
}
function chat(f, args = []) {
  // Intercept fetch inside the child: no network, and assert the actual request's model.
  const code = `globalThis.fetch = async (_, options) => {
    console.log('REQUEST_MODEL=' + JSON.parse(options.body).model);
    return { ok: true, body: (async function* () {
      yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\\n\\n');
    })() };
  }; process.argv = ['node', 'llm.mjs', ...${JSON.stringify(args)}, 'hello'];
  await import(${JSON.stringify(pathToFileURL(path.join(root, "scripts/llm.mjs")).href)});`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    env: f.env, cwd: f.home, encoding: "utf8", timeout: 60000,
  });
}
function codexArgs(f, args = []) {
  // Exercise real config loading, CLI parsing, command-array building and ledger logging
  // without launching codex or switching to its private runtime home.
  const source = fs.readFileSync(path.join(root, "scripts/codex-lane.sh"), "utf8");
  const config = source.slice(source.indexOf('ENVF='), source.indexOf('# --- preflight'));
  const command = source.slice(source.indexOf('COMMON_ARGS=('), source.indexOf('\nset +e'));
  const shell = `set -u\nHERE="$1"; shift\nT0=0\n${config}\nBASE_URL=test; FINAL=test; ACCESS_ARGS=()\n${command}\nprintf 'ARG:%s\\n' "\${COMMON_ARGS[@]}"\nlog_usage test\n`;
  return spawnSync("bash", ["-c", shell, "model-test", path.join(root, "scripts").replace(/\\/g, "/"), "--analyze", "test", ...args], {
    env: f.env, cwd: f.home, encoding: "utf8", timeout: 60000,
  });
}

for (const customHome of [false, true]) {
  test(`both lanes follow ${customHome ? "CODEX_HOME" : "HOME/.codex"} top-level model`, () => {
    const f = fixture('# model = "comment"\n  model = "user-model" # comment\nmodel = "later"\n[profiles.test]\nmodel = "nested"\n', customHome);
    const c = chat(f);
    assert.equal(c.status, 0, c.stderr);
    assert.match(c.stdout, /REQUEST_MODEL=user-model/);
    const b = codexArgs(f);
    assert.equal(b.status, 0, b.stderr);
    assert.match(b.stdout, /ARG:--model\r?\nARG:user-model/);
  });
}
test("LLM_MODEL and explicit CLI model overrides win in both lanes", () => {
  const f = fixture('model = "configured"\n');
  f.env.LLM_MODEL = "override";
  for (const [args, expected] of [[[], "override"], [["--model", "cli-model"], "cli-model"]]) {
    const c = chat(f, args);
    assert.equal(c.status, 0, c.stderr);
    assert.ok(c.stdout.includes(`REQUEST_MODEL=${expected}`));
    const b = codexArgs(f, args);
    assert.equal(b.status, 0, b.stderr);
    assert.ok(b.stdout.includes(`ARG:${expected}`));
  }
});
for (const config of [undefined, '[profiles.test]\nmodel = "nested"\n', 'model = ""\nmodel = "later"\n']) {
  test(`no model: codex omits flag, chat fails without request (${JSON.stringify(config)})`, () => {
    const f = fixture(config);
    delete f.env.LLM_MODEL;
    const c = chat(f);
    assert.equal(c.status, 2, c.stderr);
    assert.match(c.stderr, /no model: set LLM_MODEL or a model in ~\/.codex\/config.toml/);
    assert.doesNotMatch(c.stdout, /REQUEST_MODEL/);
    const b = codexArgs(f);
    assert.equal(b.status, 0, b.stderr);
    assert.doesNotMatch(b.stdout, /ARG:--model/);
    const usage = JSON.parse(fs.readFileSync(f.env.LLM_USAGE_LOG, "utf8").trim());
    assert.equal(usage.model, "codex-default");
  });
}
test("setup accepts empty --model and clears an existing override", () => {
  const f = fixture();
  const envFile = path.join(f.home, ".claude", "llm-relay.env");
  for (const model of ["explicit-model", ""]) {
    const r = node("setup.mjs", ["--base", "https://example.invalid", "--key", "test-key", "--model", model, "--no-test"], f);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.readFileSync(envFile, "utf8").split("\n").includes(`LLM_MODEL=${model}`));
    if (!model) assert.match(r.stdout, /\(empty = follow ~\/.codex\/config.toml\)/);
  }
});
test("interactive rerun preserves existing LLM_MODEL", () => {
  const f = fixture();
  const envFile = path.join(f.home, ".claude", "llm-relay.env");
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  fs.writeFileSync(envFile, "LLM_BASE=https://example.invalid\nLLM_KEY=test-key\nLLM_MODEL=foo\n");
  const r = spawnSync(process.execPath, [path.join(root, "scripts/setup.mjs"), "--no-test"], {
    env: f.env, cwd: f.home, input: "\n\n\n\n\n\n", encoding: "utf8", timeout: 60000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(envFile, "utf8"), /^LLM_MODEL=foo$/m);
});

test("setup defaults to following codex config", () => {
  const f = fixture();
  const r = node("setup.mjs", ["--base", "https://example.invalid", "--key", "test-key", "--no-test"], f);
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(f.home, ".claude/llm-relay.env"), "utf8"), /^LLM_MODEL=$/m);
});
test("lane driver omits --model for an empty MODEL spec field", () => {
  const f = fixture();
  const stub = path.join(f.home, "lane.sh");
  fs.writeFileSync(stub, '#!/usr/bin/env bash\nfor arg in "$@"; do\nif [ "$arg" = --model ]; then echo "STATUS: unavailable"; exit 2; fi\ndone\necho "STATUS: ran"\n');
  const spec = path.join(f.home, "spec.md");
  fs.writeFileSync(spec, 'OBJECTIVE: check empty model\nFILES: file.txt\nINTERFACES: unchanged\nCONSTRAINTS: only listed files\nVERIFICATION: node --version\nREASONING: low\nMODEL:   \n');
  f.env.LANE_RUN_LANE_SH = stub;
  const r = node("lane-run.mjs", ["--spec", spec, "--json"], f);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).status, "complete");
});
