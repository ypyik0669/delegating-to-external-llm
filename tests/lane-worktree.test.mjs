import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "..", "scripts", "lane-worktree.sh").replace(/\\/g, "/");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dtel-wt-"));
const repo = path.join(root, "repo");
fs.mkdirSync(repo);
const git = (...a) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: repo, encoding: "utf8" });
const wt = (...a) => spawnSync("bash", [script, ...a], { cwd: repo, encoding: "utf8" });
const write = (p, s) => fs.writeFileSync(path.join(repo, p), s);
const read = (p) => fs.readFileSync(path.join(repo, p), "utf8").replace(/\r\n/g, "\n");

git("init", "-q", "-b", "main"); git("config", "core.autocrlf", "false");
write("a.txt", "a\n"); write("b.txt", "b\n"); write("hot.txt", "shared\n");
git("add", "-A"); git("commit", "-qm", "init");
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("create prints a path; lane work is uncommitted; merge commits it and lands it", () => {
  const c = wt("create", "x");
  assert.equal(c.status, 0, c.stderr);
  const p = c.stdout.trim().split(/\r?\n/)[0];
  assert.ok(fs.existsSync(p));
  assert.match(c.stdout, /\ndeps: skipped \(no supported lockfile\)/);
  fs.writeFileSync(path.join(p, "a.txt"), "a from x\n");           // lane leaves it uncommitted
  const m = wt("merge", "x");
  assert.equal(m.status, 0, m.stdout + m.stderr);
  assert.match(m.stdout, /committed lane worktree changes/);
  assert.match(m.stdout, /MERGED lane\/x/);
  assert.equal(read("a.txt"), "a from x\n");
  assert.ok(!fs.existsSync(p), "worktree removed");
  assert.equal(git("branch", "--list", "lane/x").stdout.trim(), "", "branch deleted");
});

test("second lane merges onto a dirty main tree (first lane's result is stashed around it and restored)", () => {
  // main tree is dirty from the previous test's merge (a.txt changed, uncommitted)
  assert.match(git("status", "--porcelain").stdout, /a\.txt/);
  const c = wt("create", "y");
  assert.equal(c.status, 0, c.stderr);
  fs.writeFileSync(path.join(c.stdout.trim().split(/\r?\n/)[0], "b.txt"), "b from y\n");
  const m = wt("merge", "y");
  assert.equal(m.status, 0, m.stdout + m.stderr);
  assert.equal(read("a.txt"), "a from x\n", "earlier lane's change survived");
  assert.equal(read("b.txt"), "b from y\n", "new lane landed");
  assert.equal(git("stash", "list").stdout.trim(), "", "no stash left behind");
});

test("check reports a conflict and leaves the tree as it was", () => {
  git("add", "-A"); git("commit", "-qm", "land x and y");
  const c = wt("create", "z");                                       // lane branches off here…
  const p = c.stdout.trim().split(/\r?\n/)[0];
  write("hot.txt", "main edit\n"); git("commit", "-qam", "main: hot"); // …then main and the lane both edit hot.txt
  fs.writeFileSync(path.join(p, "hot.txt"), "z edit\n");
  const k = wt("check", "z");
  assert.equal(k.status, 1);
  assert.match(k.stdout, /MERGE CONFLICT[\s\S]*hot\.txt/);
  assert.equal(git("status", "--porcelain").stdout.trim(), "", "main tree untouched");
  assert.equal(wt("cleanup").status, 0);
  assert.match(wt("list").stdout, /no lane worktrees/);
});

test("create installs npm dependencies inside the new worktree and supports --no-install", () => {
  write("package-lock.json", "{}\n");
  git("add", "package-lock.json"); git("commit", "-qm", "lockfile");
  const bin = path.join(root, "bin");
  const record = path.join(root, "npm-args.txt");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "npm"), '#!/usr/bin/env bash\nprintf "%s\\n" "$PWD" "$*" >> "$DEPS_RECORD"\nmkdir -p node_modules\nprintf installed > node_modules/marker\necho noisy install\n', { mode: 0o755 });
  const env = { ...process.env, DEPS_RECORD: record.replace(/\\/g, "/") };
  const inherited = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] || "";
  for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
  env.PATH = bin + path.delimiter + inherited;
  const installed = spawnSync("bash", [script, "create", "deps"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  const [directory, note] = installed.stdout.trim().split(/\r?\n/);
  assert.ok(fs.existsSync(directory));
  assert.match(note, /^deps: installed via npm ci \(\d+s\)$/);
  assert.match(fs.readFileSync(record, "utf8"), /ci --prefer-offline --no-audit --no-fund/);
  assert.equal(fs.readFileSync(path.join(directory, "node_modules/marker"), "utf8"), "installed");
  assert.equal(fs.lstatSync(path.join(directory, "node_modules")).isSymbolicLink(), false);
  assert.equal(fs.existsSync(path.join(repo, "node_modules")), false);
  fs.unlinkSync(record);
  for (const args of [["create", "no-deps", "--no-install"], ["create", "--no-install", "no-deps-first"]]) {
    const skipped = spawnSync("bash", [script, ...args], { cwd: repo, env, encoding: "utf8" });
    assert.equal(skipped.status, 0, skipped.stdout + skipped.stderr);
    assert.match(skipped.stdout, /\ndeps: skipped \(--no-install\)/);
    assert.equal(fs.existsSync(record), false);
  }
  assert.equal(wt("cleanup").status, 0);
});

for (const [lockfile, manager, expected] of [
  ["bun.lock", "bun", ["install --frozen-lockfile"]],
  ["bun.lockb", "bun", ["install --frozen-lockfile"]],
  ["pnpm-lock.yaml", "pnpm", ["install --frozen-lockfile --offline", "install --frozen-lockfile"]],
  ["yarn.lock", "yarn", ["install --frozen-lockfile"]],
]) {
  test(`${lockfile} installs with frozen arguments and pnpm retries online`, () => {
    const directory = fs.mkdtempSync(path.join(root, "manager-"));
    const bin = path.join(directory, "bin");
    fs.mkdirSync(bin);
    const record = path.join(directory, "args.txt");
    fs.writeFileSync(path.join(directory, lockfile), "fixture\n");
    const localGit = (...args) => {
      const result = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: directory, encoding: "utf8" });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    };
    localGit("init", "-q"); localGit("add", lockfile); localGit("commit", "-qm", "fixture");
    fs.writeFileSync(path.join(bin, manager), '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$DEPS_RECORD"\nif [[ "$*" == *--offline* ]]; then exit 1; fi\n', { mode: 0o755 });
    const env = { ...process.env, DEPS_RECORD: record.replace(/\\/g, "/") };
    const inherited = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] || "";
    for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
    env.PATH = bin + path.delimiter + inherited;
    const result = spawnSync("bash", [script, "create", "deps"], { cwd: directory, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(fs.readFileSync(record, "utf8").trim().split(/\r?\n/), expected);
    assert.match(result.stdout, new RegExp(`\ndeps: installed via ${manager} install \\(\\d+s\\)`));
  });
}

test("missing dependency tool skips without invoking the real package manager", () => {
  if (!fs.existsSync(path.join(repo, "package-lock.json"))) {
    write("package-lock.json", "{}\n");
    git("add", "package-lock.json"); git("commit", "-qm", "lockfile for missing tool");
  }
  const shellEnv = path.join(root, "missing-tool.sh");
  fs.writeFileSync(shellEnv, 'command() { if [ "$1" = -v ] && [ "$2" = npm ]; then return 1; fi; builtin command "$@"; }\n');
  const result = spawnSync("bash", [script, "create", "missing-tool"], { cwd: repo, env: { ...process.env, BASH_ENV: shellEnv.replace(/\\/g, "/") }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /\ndeps: skipped \(npm not found\)/);
  assert.equal(wt("cleanup").status, 0);
});
