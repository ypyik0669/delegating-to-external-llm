---
description: Live end-to-end — the codex lane (or the relay lane) fixes a one-line bug and the architect reports verbatim verification. Needs EVAL_LLM_BASE / EVAL_LLM_KEY in the environment; run with --tag live --scaffold --allow-tools Bash Agent Edit Write.
tags: [live]
max_turns: 30
timeout_seconds: 1200
runs: 1
allowed_tools: [Read, Glob, Grep, Skill, Bash, Agent]
---
Delegation to the external LLM is active for this session: the external model must do all the coding, you are only the brain.

This workspace is a small git repo. `add.mjs` exports `add(a, b)` but it subtracts; `node --test add.test.mjs` fails. Delegate the fix with a complete six-part spec (REASONING: low), have the lane verify, then write the lane's STATUS line and the verbatim `# pass` / `# fail` counts into a file named `RESULT.md` in the workspace, and report.
