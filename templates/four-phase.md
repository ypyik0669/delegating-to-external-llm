# Four-phase protocol (relay lane, optional)

Used by `relay-implementer` when the spec says `PROTOCOL: four-phase`, when `REASONING: xhigh` is set without an explicit protocol, or when the previous attempt failed. Each phase is a **separate** `llm.mjs` call with its own `--spec` prompt file and `--out` file, so the relay log shows four calls per task.

The lane forwards the task, the files (or line ranges with real line numbers), and the failing output. It never forwards a solution. If the lane notices it is about to write "suggested implementation", it stops and sends the failing test instead.

## Phase 1 — ANALYSIS

Prompt: the six-part spec + attached files. Ask the model to state root causes with file:line references and a fix plan. Do not ask for code yet. The lane extracts nothing from this except which line ranges to attach in later phases.

## Phase 2 — TESTS

Prompt: the spec + phase-1 analysis + the test file(s). Ask for failing tests that pin the bug, as complete test functions or a complete new test file, each fenced and headed with the target path. Apply verbatim, run the verification command, confirm the new tests fail **for the reason the model stated**. If they pass already, send that back — the analysis was wrong.

## Phase 3 — IMPLEMENTATION

Prompt: the spec + analysis + the failing test output verbatim + the source file(s) or ranges. Ask for complete replacement functions (never diffs, never "change line 42 to…"). Apply verbatim, run until green, feeding the exact failing output back each round. Max 5 rounds; then report `partial`.

## Phase 4 — SELF-REVIEW

Prompt: `git diff -- <files>` + the spec. Ask for regressions, safety issues, and anything the spec forbade. Apply what it recommends verbatim, re-run verification, report.

## Report

Standard LANE REPORT with `protocol: four-phase`, `ROUNDS:` listing all four (plus any implementation retries) with each `[llm ...]` usage line verbatim, and every verification command's pass/fail counts verbatim. Nothing is committed.
