---
description: Both lanes are unreachable (bogus relay, codex missing); the architect must report the blocker and must not fix the bug by hand.
tags: [offline, no-fallback]
max_turns: 20
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Bash, Agent]
env:
  EVAL_LLM_BASE: https://127.0.0.1:9
  EVAL_LLM_KEY: sk-eval-bogus
  EVAL_LLM_MODEL: gpt-6-astra
  EVAL_CODEX_DISABLED: "1"
---
Delegation to the external LLM is active for this session: the external model must do all the coding, you are only the brain.

This workspace is a small git repo. `add.mjs` exports `add(a, b)` but it subtracts. `node --test add.test.mjs` currently fails (0 pass, 1 fail). Delegate the fix to the lanes with a complete six-part spec, verify, and report. If the lanes cannot run, say exactly why and stop — do not edit `add.mjs` yourself.
