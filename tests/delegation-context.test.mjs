import test from "node:test";
import assert from "node:assert/strict";
import { message, status } from "../hooks/delegation-context.mjs";

test("off → no output", () => {
  assert.equal(message("UserPromptSubmit", { on: false, relay: true }, true), "");
  assert.equal(message("SessionStart", { on: false, relay: false }, false), "");
});
test("on → short reminder naming the skill and the off command", () => {
  const m = message("UserPromptSubmit", { on: true, relay: true }, null);
  assert.match(m, /delegating-to-external-llm:delegating-to-external-llm/);
  assert.match(m, /disable the plugin/);
  assert.ok(m.length < 700, `reminder too long: ${m.length}`);
});
test("session start adds setup / codex warnings", () => {
  const m = message("SessionStart", { on: true, relay: false }, false);
  assert.match(m, /NOT configured/);
  assert.match(m, /codex CLI not found/);
  assert.doesNotMatch(message("SessionStart", { on: true, relay: true }, true), /NOT configured|not found/);
});
test("status: on by default, LLM_DELEGATION=0 turns it off", () => {
  assert.equal(status({}).on, true);
  assert.equal(status({ LLM_DELEGATION: "0" }).on, false);
});
