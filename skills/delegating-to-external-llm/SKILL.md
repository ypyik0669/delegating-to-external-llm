---
name: delegating-to-external-llm
description: Use when the user wants coding work done by an external model instead of by you — "delegate all coding", "you are only the brain", "only orchestrate", "don't write code yourself", "use GPT / codex / gpt-6-astra / the relay to do it", "让外部模型写", "用 GPT 做" — or when the usage ledger shows the external model was barely used. Routes analysis, implementation and cross-vendor review to the relay model through deterministic scripts, so Claude spends tokens only on decisions, a spec review, and a verdict.
---

# Delegating to an External LLM — the architect's routing doctrine

## Overview

You are the architect. You own decomposition, spec approval, routing, and the final verdict. You do not read the codebase to find out how it works, you do not type implementation code, and you do not supervise lanes turn by turn — the external model reads, writes, and re-runs verification; deterministic scripts drive it; you judge the results.

**Two tests of compliance.** (1) Where the code came from: the codex diff and the ledger. (2) Who spent the tokens: the ledger's `claude : external` ratio. A session that delegated the typing but spent most of its tokens on Claude reading code and babysitting lanes has failed the second test.

Models: the lanes run whatever `LLM_MODEL` names in `~/.claude/llm-relay.env` (gpt-6-astra by default). You and every agent in this plugin run on the session model. Nothing in this plugin pins or switches a model; only the user does.

## When to Use

- User says the external model must do the work, or that you must only orchestrate
- User names the lane model (gpt-6-astra, codex, "the GPT relay") or a reasoning effort
- User complains the ledger shows too few calls, too little spend, or too much Claude spend
- Any coding task in a session where this rule was set earlier (re-read this skill after compaction)

Not for: answering questions, planning, reading reports. Those are yours.

## Session hygiene — do this first

Every background notification re-enters your whole context. Delegation is cheap only when that context is small.

1. Start delegation in a fresh session, or run `/compact` before the first lane. Do not delegate from a session that just did hours of unrelated work.
2. `/effort low` for orchestration turns; raise it only for a spec you find hard to approve or a verdict that deserves it.
3. Prefer **one** `lane-run.mjs --batch` call over several agents: you are woken once with all reports instead of once per lane.
4. Never paste diffs, briefs, or reports back into the conversation. Cite paths and counts.

## The workflow

```
task ──► analyze lane (external, read-only by contract) ──► BRIEF + SPEC DRAFT
      ──► you: decide open questions, edit the draft, split by domain, save spec files (≈ 2k tokens)
      ──► lane-run.mjs --batch specs…  (external implements; script lints, verifies, resumes, reports)
      ──► you: read LANE REPORTs, send corrected specs or accept
      ──► llm-advisor (codex review first, Claude verdict second)
      ──► report to user with the ledger line
```

### 1. Analyze — the external model reads the code, not you

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lane-run.mjs" --analyze "<one-line task>" --effort medium --timeout 600 --out "<scratch>/brief.md"
```

(`/delegating-to-external-llm:analyze <task>` does the same; the `codex-analyst` agent wraps it when you want isolation.) It returns a ≤30-line BRIEF (files, tests, hotspots, open decisions) and a six-part SPEC DRAFT. You answer the open decisions, edit the draft, and save it. Open a file the brief cites only when a decision genuinely depends on the exact code — and then read the cited line range, not the file.

### 2. Spec — the only artefact you author

Lanes share none of your context. Every spec carries the six parts (template: `templates/spec.md`): OBJECTIVE, FILES (concrete paths, disjoint per parallel lane, new files marked `(new)`), INTERFACES, CONSTRAINTS (include the lockfile rule), VERIFICATION (exact commands, `→ expected`), `REASONING: low|medium|high|xhigh`. Optional: `WORKTREE:`, `MODEL:`, `PROTOCOL: four-phase` (chat lane only).

`scripts/spec-lint.mjs` runs before any lane spends money: missing parts, invalid effort, globs in FILES, or more than 15 fenced code lines → the lane refuses. A spec you can't finish is an undecided decision. Decide, then delegate. Never put a solution in a spec.

### 3. Implement — deterministic driver, no LLM supervisor

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lane-run.mjs" --spec spec.md --max-resumes 2 --timeout 900
node "${CLAUDE_PLUGIN_ROOT}/scripts/lane-run.mjs" --batch a.md b.md c.md      # parallel, one wake-up
```

The driver lints the spec, runs `codex-lane.sh` (relay model via codex, private `CODEX_HOME`, permission level from `LLM_CODEX_ACCESS`, edits fenced to FILES, stray writes to the main tree moved back into the worktree), re-runs every VERIFICATION command itself, resumes the same codex session with the failing output up to `--max-resumes` times, checks lockfile churn, and prints a LANE REPORT. Exit 0 = `complete`, 5 = `partial`, 2 = `refused`/`unavailable`.

Call it from Bash directly. Use the `codex-implementer` agent only to keep a very long report out of your context; it adds nothing else.

Fallback: `relay-implementer` (chat completions applied verbatim, optional four-phase trail) when codex is `unavailable` or a task has failed twice.

### 4. Parallelism — one worktree per lane

Decompose by domain, not by verb. File sets must be disjoint; **hotspot files** (routes, config, registries, dependency manifests, shared types) belong to exactly one spec. Then:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/lane-worktree.sh" create <slug>    # prints the path → WORKTREE: in the spec
node  "${CLAUDE_PLUGIN_ROOT}/scripts/lane-run.mjs" --batch <specs…>
bash "${CLAUDE_PLUGIN_ROOT}/scripts/lane-worktree.sh" merge <slug>     # commits the lane's work, dry-run-checks, merges --no-commit
```

Merge serially, as soon as each lane is `complete`; a conflict goes back to that lane as a corrected spec. Run the cross-cutting verification on the merged tree before the review. Only the user commits.

### 5. Review — cross-vendor first, Claude verdict second

`llm-advisor` runs `codex-lane.sh --review` (the relay model reads the whole diff) and then judges: scope vs FILES, evidence vs working tree, anything unnamed. Consult it at commitment boundaries (architecture, migration, API shape, a problem that resisted two attempts) and **always once at the end of a deliverable**. Do not report done without its verdict.

### 6. Report

Lanes used, effort per task, STATUS per lane, verbatim verification counts, advisor verdict, and the ledger:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/usage.mjs" --since 2h
```

Record your own side too, so the ratio is honest: after any Claude subagent returns (analyst wrapper, advisor, an Explore you could not avoid), log its tokens with `usage.mjs --claude-in <n> --claude-out <n> --note "<what>"`. Target: `claude : external ≥ 1 : 5`.

## Choosing the reasoning effort

| Rung | Use for |
|---|---|
| `low` / `medium` | Mechanical edits, renames, wiring, boilerplate, config, tests that mirror an existing pattern; analysis briefs |
| `high` | Ordinary features with a couple of design decisions left to the lane |
| `xhigh` | Tricky logic, multi-file changes with interactions, the second attempt after a spec correction, anything security-sensitive |

`max`/`ultra` are not accepted. Omitting `REASONING:` uses the lane's default and is flagged in `GAPS`.

## Lane report format

```
LANE REPORT
LANE: codex-implementer (relay model, effort: high) · driver: lane-run.mjs (no LLM supervisor)
STATUS: complete | partial | timeout | unavailable | refused
SPEC / CHANGES (one line per file) / VERIFIED (each command → exit code, ≤ 8 tail lines) / MODEL SAID (≤ 2 sentences)
ROUNDS: n — fresh in=… out=… → ran | resume … / SESSION: <thread id> / GAPS: … / REASON: …
```

## Red Flags — STOP, you are doing the worker's job

- You are opening source files to understand the code before writing a spec (run the analyze lane)
- You launched an Explore agent for something the analyze lane could answer
- Your spec contains code, a regex, or "suggested implementation"
- You are patching a lane's diff, moving files between worktrees, or fixing a lockfile by hand instead of sending a corrected spec (the driver handles stray writes and flags lockfile churn)
- "It's a two-line fix, faster to just do it"
- "Codex / the relay is down, I'll do this one myself" — report the outage
- Reporting done without an `llm-advisor` verdict or without the ledger line

## Rationalizations

| Excuse | Reality |
|---|---|
| "I need to read the code to write a good spec" | The analyze lane reads it and drafts the spec. You read 30 lines and decide. |
| "A Claude subagent is cheaper than a codex run" | Not at 30–40k tokens each; and it doesn't produce code. Use the lane. |
| "Delegating a trivial fix wastes minutes" | The user pays for the lanes and checks the ledger. Minutes are the point. |
| "I'll give it the answer so it can't get it wrong" | Then the external model did nothing. Give it the spec and the failing test. |
| "The relay returned 502, I'll finish by hand" | Outage is a blocker to report, not a permission slip. |
| "After compaction I don't remember the rule" | Re-read this skill whenever a coding task arrives in a delegation session. |

## Common Mistakes

- Two lanes editing the same file in parallel. Assign disjoint files; give hotspots to one lane.
- Trusting "all green" without the driver's VERIFIED block. The driver re-ran the commands; read the exit codes.
- Accepting a `SCOPE VIOLATION` or lockfile gap silently. Widen the spec or send it back; never hand-fix.
- Sending an incomplete spec and hoping. The lint refuses it; write the missing part.
- Running lanes from a bloated session. Compact first.
- Forgetting to log Claude-side subagent tokens, then reporting a flattering ratio.

## Setup (once per machine)

1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs"` (or `/delegating-to-external-llm:setup`): relay base URL, API key (echo off), model, default effort, minimum request size, codex permission level (`workspace` default, `workspace-net`, `yolo`). Writes `~/.claude/llm-relay.env` (mode 600) and smoke-tests.
2. `npm i -g @openai/codex@latest` (≥ 0.155). No `codex login`: the lane points codex at the relay, under a private `~/.claude/llm-codex-home` seeded from `codex-home/config.toml` — your `~/.codex` (MCP servers, AGENTS.md, profiles) never loads into a lane.
3. Optional prices for USD in the ledger: `LLM_PRICE_IN/CACHED/OUT`, `CLAUDE_PRICE_IN/OUT` in the env file.
4. Make the rule survive compaction — in `~/.claude/CLAUDE.md`: `When delegation to the external LLM is active, use the delegating-to-external-llm:delegating-to-external-llm skill for every coding task.`
5. Optional hard enforcement: `touch ~/.claude/llm-delegation.on` (see `hooks/README.md`).
