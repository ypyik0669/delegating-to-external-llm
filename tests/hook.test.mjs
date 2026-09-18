import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decide } from "../hooks/block-direct-edits.mjs";

const repo = path.join(os.tmpdir(), "dtel-hook-fakerepo");
const slug = repo.replace(/[^A-Za-z0-9]/g, "-");
const scratch = path.join(os.tmpdir(), "claude", slug);
const otherScratch = path.join(os.tmpdir(), "claude", slug + "-other");
const on = {};
const off = { LLM_DELEGATION: "0" };
const edit = (file_path, cwd = repo) => ({ tool_name: "Edit", cwd, tool_input: { file_path } });

test.beforeEach(() => { fs.rmSync(scratch, { recursive: true, force: true }); fs.rmSync(otherScratch, { recursive: true, force: true }); });
test.after(() => { fs.rmSync(scratch, { recursive: true, force: true }); fs.rmSync(otherScratch, { recursive: true, force: true }); });

test("delegation off → allow", () => {
  assert.equal(decide(edit(path.join(repo, "src", "a.ts")), off), null);
});
test("on, no evidence → block", () => {
  assert.equal(decide(edit(path.join(repo, "src", "a.ts")), on)?.decision, "block");
});
test("on, relative path → block", () => {
  assert.equal(decide(edit("src/a.ts"), on)?.decision, "block");
});
test("on, target outside repo → allow", () => {
  assert.equal(decide(edit(path.join(os.tmpdir(), "elsewhere", "x.ts")), on), null);
});
test("on, fresh evidence in project scratch → allow", () => {
  fs.mkdirSync(path.join(scratch, "s"), { recursive: true });
  fs.writeFileSync(path.join(scratch, "s", "t.llm-output.md"), "x");
  assert.equal(decide(edit(path.join(repo, "src", "a.ts")), on), null);
});
test("on, stale evidence (31 min) → block", () => {
  fs.mkdirSync(scratch, { recursive: true });
  const f = path.join(scratch, "t.llm-output.md");
  fs.writeFileSync(f, "x");
  const old = (Date.now() - 31 * 60 * 1000) / 1000;
  fs.utimesSync(f, old, old);
  assert.equal(decide(edit(path.join(repo, "src", "a.ts")), on)?.decision, "block");
});
test("on, evidence only in another project → block", () => {
  fs.mkdirSync(otherScratch, { recursive: true });
  fs.writeFileSync(path.join(otherScratch, "t.llm-output.md"), "x");
  assert.equal(decide(edit(path.join(repo, "src", "a.ts")), on)?.decision, "block");
});
test("on, editing inside a lane worktree finds the main repo's evidence → allow", () => {
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, "t.llm-output.md"), "x");
  const wt = path.join(repo, ".lanes", "task1");
  assert.equal(decide(edit(path.join(wt, "src", "a.ts"), wt), on), null);
});
test("non-edit tool → allow", () => {
  assert.equal(decide({ tool_name: "Bash", cwd: repo, tool_input: {} }, on), null);
});
test("scratch/.claude targets → allow", () => {
  assert.equal(decide(edit(path.join(repo, ".claude", "x.md")), on), null);
});
