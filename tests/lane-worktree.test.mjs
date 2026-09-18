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
  const p = c.stdout.trim();
  assert.ok(fs.existsSync(p));
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
  fs.writeFileSync(path.join(c.stdout.trim(), "b.txt"), "b from y\n");
  const m = wt("merge", "y");
  assert.equal(m.status, 0, m.stdout + m.stderr);
  assert.equal(read("a.txt"), "a from x\n", "earlier lane's change survived");
  assert.equal(read("b.txt"), "b from y\n", "new lane landed");
  assert.equal(git("stash", "list").stdout.trim(), "", "no stash left behind");
});

test("check reports a conflict and leaves the tree as it was", () => {
  git("add", "-A"); git("commit", "-qm", "land x and y");
  write("hot.txt", "main edit\n"); git("commit", "-qam", "main: hot");
  const c = wt("create", "z");
  const p = c.stdout.trim();
  fs.writeFileSync(path.join(p, "hot.txt"), "z edit\n");
  const k = wt("check", "z");
  assert.equal(k.status, 1);
  assert.match(k.stdout, /MERGE CONFLICT[\s\S]*hot\.txt/);
  assert.equal(git("status", "--porcelain").stdout.trim(), "", "main tree untouched");
  assert.equal(wt("cleanup").status, 0);
  assert.match(wt("list").stdout, /no lane worktrees/);
});
