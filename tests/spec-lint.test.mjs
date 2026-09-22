import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lintSpec } from "../scripts/spec-lint.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dtel-lint-"));
fs.writeFileSync(path.join(root, "add.mjs"), "export const add = (a, b) => a - b;\n");
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const good = `OBJECTIVE: add() subtracts. Fix it.
FILES: add.mjs
INTERFACES: add(a, b) unchanged
CONSTRAINTS: touch only add.mjs
VERIFICATION: node --test add.test.mjs → 1 pass
REASONING: low
`;

test("complete spec passes", () => {
  const r = lintSpec(good, root);
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.files, ["add.mjs"]);
});
test("missing sections are reported", () => {
  const r = lintSpec("OBJECTIVE: x\nREASONING: low\n", root);
  assert.equal(r.ok, false);
  for (const k of ["FILES", "INTERFACES", "CONSTRAINTS", "VERIFICATION"]) assert.ok(r.problems.some((p) => p.startsWith(k + ":")), k);
});
test("bad reasoning rung", () => {
  const r = lintSpec(good.replace("REASONING: low", "REASONING: max"), root);
  assert.ok(r.problems.some((p) => p.includes('"max"')));
});
test("glob in FILES rejected", () => {
  const r = lintSpec(good.replace("FILES: add.mjs", "FILES: src/*.ts"), root);
  assert.ok(r.problems.some((p) => p.includes("glob")));
});
test("nonexistent file without (new) marker rejected; with marker accepted", () => {
  assert.ok(lintSpec(good.replace("FILES: add.mjs", "FILES: nope/deep/x.ts"), root).problems.some((p) => p.includes("neither the file")));
  assert.equal(lintSpec(good.replace("FILES: add.mjs", "FILES: newfile.mjs (new)"), root).ok, true);
});
test("too much fenced code is dictation", () => {
  const code = "```\n" + Array.from({ length: 16 }, (_, i) => `line ${i}`).join("\n") + "\n```\n";
  const r = lintSpec(good + code, root);
  assert.ok(r.problems.some((p) => p.startsWith("code:")));
  assert.equal(lintSpec(good + "```\nfoo()\n```\n", root).ok, true);
});
test("verification must name a command", () => {
  const r = lintSpec(good.replace(/VERIFICATION:.*/, "VERIFICATION: it should work"), root);
  assert.ok(r.problems.some((p) => p.startsWith("VERIFICATION")));
});
test("optional PROTOCOL / WORKTREE validated", () => {
  assert.ok(lintSpec(good + "PROTOCOL: sixteen-phase\n", root).problems.some((p) => p.startsWith("PROTOCOL")));
  assert.equal(lintSpec(good + "PROTOCOL: four-phase\n", root).ok, true);
  assert.ok(lintSpec(good + "WORKTREE: /definitely/not/here\n", root).problems.some((p) => p.startsWith("WORKTREE")));
});

test("FILES resolve against cwd without WORKTREE and against WORKTREE when present", () => {
  const worktree = path.join(root, "lane");
  fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
  fs.writeFileSync(path.join(worktree, "src/only-in-lane.ts"), "export {};\n");
  const spec = good.replace("FILES: add.mjs", "FILES: src/only-in-lane.ts");
  assert.equal(lintSpec(good, { cwd: root }).ok, true);
  assert.equal(lintSpec(spec, { cwd: root }).ok, false);
  assert.equal(lintSpec(spec, { cwd: worktree }).ok, true);
  assert.equal(lintSpec(spec + `WORKTREE: ${worktree}\n`, { cwd: root }).ok, true);
  assert.equal(lintSpec(spec + "WORKTREE: lane\n", { cwd: root }).ok, true);
  assert.equal(lintSpec(spec + "WORKTREE: lane\n", root).ok, true);
  assert.equal(lintSpec(spec + "WORKTREE: missing\n", { cwd: root }).ok, false);
});
