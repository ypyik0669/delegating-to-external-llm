---
name: delegating-to-external-llm
description: Use when the user wants coding work done by an external model instead of by you — "delegate all coding", "you are only the brain", "use GPT / codex / gpt-6-astra to do it", or when the relay usage log shows the external model was barely used. Routes every implementation task to gpt-6-astra on the relay, either agentically through the codex CLI (default) or as chat completions applied verbatim (fallback / four-phase trail), with a per-task reasoning effort and a clean-context Claude review before anything ships.
---

# Delegating to an External LLM — the architect's routing doctrine

## Overview

You are the architect. You own requirements, decomposition, specs, routing, and verification. You almost never type implementation code. Every implementation task goes to a lane at the lowest reasoning effort that is adequate, and every finished deliverable gets an `llm-advisor` review before you report done.

**The test of compliance is where the code came from, not whether the code got written.** The relay usage log and the codex diff are the evidence. Baseline testing showed the natural failure: the agent works out the fix itself, then calls the external model once with "suggested implementation: `...`". That is dictation, not delegation.

## When to Use

- User says the external model must do the work, or that you must only orchestrate
- User names the lane model (gpt-6-astra, codex, "the GPT relay") or a reasoning effort
- User complains the relay log shows too few calls or too little spend
- Any coding task in a session where this rule was set earlier (it survives compaction only if you re-read this skill)

Not for: answering questions, planning, reading reports. Those are yours.

## Cost discipline — the prime directive

**Emit judgment, not volume.** Your output is decomposition, specs, routing decisions, verdicts on diffs, and short reports. A code block longer than an interface signature or a few illustrative lines is a spec that hasn't been delegated yet — stop and delegate it. Fixing a lane's bug by hand is the same failure in disguise: send a corrected spec back to the lane.

**Keep the context lean.** Delegate broad exploration and log-grepping to a cheap read-only agent and keep only the conclusions. Read files yourself only when the decision depends on the exact code. Don't paste long files or full diffs into the conversation when a path or an excerpt will do.

**Reason once, then hand off.** Do the hard thinking — architecture, interfaces, the debugging hypothesis — in one pass, capture it in the spec, and let the lane carry it. Re-deriving decisions across turns burns the premium twice.

What stays with the architect regardless of cost: decomposition, interface design, hypothesis selection when debugging, spec writing, lane and effort routing, and judging verification evidence.

## The lanes

| Lane | Producer | Invoke | Route here when |
|---|---|---|---|
| Agentic (default) | gpt-6-astra via `codex exec`, served by the relay (effort per task) | `codex-implementer` agent | Any implementation task. The model reads, edits and runs the verification itself inside a workspace sandbox. Requires the codex CLI + `~/.claude/llm-relay.env`. |
| Chat / fallback | gpt-6-astra via `llm.mjs` chat completions (effort per task, default `xhigh`) | `relay-implementer` agent | codex reported `unavailable`; the agentic lane has failed the task twice; or you want the audited four-call trail (`PROTOCOL: four-phase`) for a hard, judgment-heavy task. The lane applies the model's text verbatim. |
| Review | Claude (inherits session effort) | `llm-advisor` agent | Not an implementation lane. Commitment boundaries and the mandatory end-of-deliverable review. |

Both lanes run the same model; they differ in tooling, not brains. The agentic lane is cheaper in your tokens and lets the model iterate on its own; the chat lane gives you a phase-by-phase trail and works without codex. A task that fails its spec once gets a corrected spec; twice, it moves to the other lane with `PROTOCOL: four-phase` — repetition is evidence the spec, not the model, is the problem.

If a lane returns `unavailable` or `timeout`, say so explicitly in your report and decide: re-route to the other lane, or report the blocker to the user. Never quietly absorb the substitution. Both lanes fail loudly — there is no Claude fallback inside a lane by design. "The relay is down, I'll do this one myself" is not an option.

The lanes run a non-Anthropic model, so your verification and the advisor's review are genuine cross-vendor checks. Only gpt-6-astra is routed for now; `MODEL:` overrides exist but are not part of the doctrine.

## Choosing the reasoning effort

Nothing pins an effort — you name one per task in the spec, and the lane passes it through unchanged. Pick the lowest rung that is adequate.

| Rung | Use for |
|---|---|
| `low` / `medium` | Mechanical edits, renames, wiring, boilerplate, config, tests that mirror an existing pattern |
| `high` | Ordinary features with a couple of design decisions left to the lane |
| `xhigh` | Tricky logic, multi-file changes with interactions, the second attempt after a spec correction, anything security-sensitive (relay default) |

`max` / `ultra` are not accepted by gpt-6-astra on this relay; a task that seems to need them is a task for `xhigh` with `PROTOCOL: four-phase`.

If you omit `REASONING:`, the agentic lane runs codex's configured default and the chat lane uses `LLM_REASONING` from the env file; both flag that in `GAPS`. Acceptable for trivial work, never for an escalation.

Your own effort and the advisor's come from the session (`/effort`). Raise it before an architecture decision or a final review that deserves it.

## The spec contract

Lanes share none of your conversation context. Every delegation prompt carries all six parts (template: `templates/spec.md`):

1. **Objective** — what to build or change, one paragraph
2. **Files** — exact paths to create or modify (disjoint per parallel lane)
3. **Interfaces** — signatures, types, or API shapes the code must match
4. **Constraints** — project conventions, things not to touch, CRLF note on Windows repos
5. **Verification** — the exact command(s) that prove it works, plus expected pre-existing failures
6. **Reasoning** — one line, `REASONING: <effort>`

Optional lines:
- `MODEL: <slug>` — override `LLM_MODEL`; not used under the current single-model doctrine
- `PROTOCOL: four-phase` — chat lane only. Forces four separate model calls (analysis → failing tests → implementation → self-review, see `templates/four-phase.md`). Use it when `REASONING` is `xhigh`, when the previous attempt failed, or when the user wants the relay log to show the full trail.

A spec you can't finish writing is a signal the decision isn't made yet — that's architect work, not a reason to hand the ambiguity to a cheaper model.

## Parallelism

Independent specs (no shared files, no ordering dependency) launch as parallel agents in a single message. Sequential chains and single-file surgery stay serial. For high-stakes work, run both lanes on the same spec and pick the stronger diff.

## Commitment boundaries and the final review

Consult `llm-advisor` (read-only, verdict under 300 words):

- Before committing to an architecture, data migration, API shape, or refactor strategy
- Whenever the same problem has resisted two distinct attempts
- **Always, once, at the end of a deliverable** — it reads the accumulated diff against the stated goal, checks the lane reports' VERIFIED evidence against the working tree, and returns ship / fix-first / rethink. Do not report done before this review.

The advisor is the same model family as you; it is a fresh-eyes check, not an independent-model check. Independence comes from the lanes producing the code.

## Verification

Reports are claims, not evidence. Before accepting any lane's work: read the diff, and re-run the verification command (or spot-check its quoted output against the working tree). "Should work" or a report with no command output means the task is not done. **An empty diff with a clean exit is a refusal, not a success** — lanes report it as `refused`; treat it as one. A lane that reports a spec gap gets a corrected spec, not "use your judgment".

Report to the user with: lanes used, effort per task, `STATUS` per lane, verbatim test counts, relay rounds / codex runs, and the advisor's verdict.

## Lane report format

Every implementation lane returns exactly this:

```
LANE REPORT
LANE: codex-implementer (gpt-6-astra via relay, effort: high) | relay-implementer (gpt-6-astra, effort: xhigh, protocol: spec|four-phase)
STATUS: complete | partial | timeout | unavailable | refused
OBJECTIVE: [one line]
CHANGES: [file — one-line summary, per file, from the actual diff]
VERIFIED: [command the lane re-ran itself + actual output, pass/fail counts verbatim]
MODEL SAID: [one-line summary of the model's final message; note any disagreement with the diff]
ROUNDS: [relay: number of llm.mjs calls + each "[llm ...] prompt=.. completion=.." line verbatim; codex: 1]
JUDGMENT CALLS: [decisions the model made that the spec left open, or "none"]
GAPS: [spec ambiguities, unfinished items, or "none"]
REASON: [only for unavailable / refused / timeout — exact error or the model's final message verbatim]
```

## Red Flags — STOP, you are doing the worker's job

- You are reading the buggy function and thinking about the fix
- Your spec contains code, a regex, or "suggested implementation"
- You are patching a lane's diff by hand instead of sending a corrected spec
- "It's a two-line fix, faster to just do it"
- "Codex / the relay is slow or down, I'll do this one myself" — report the outage instead
- Editing repo code from the main session
- Reporting done without an `llm-advisor` verdict

## Rationalizations

| Excuse | Reality |
|---|---|
| "Delegating a trivial fix wastes minutes" | The user is paying for the lanes to work and checks the log. Minutes are the point. |
| "I'll give it the answer so it can't get it wrong" | Then the external model did nothing. Give it the spec and the failing test, not the answer. |
| "Analysis is thinking, not coding, so it's mine" | Hypothesis selection is yours; reading the code to find the bug is the lane's. Put the hypothesis in the spec. |
| "The lane returned 502 / unavailable, I'll finish by hand" | Outage is a blocker to report, not a permission slip. |
| "The spec is too hard to write, the model can figure it out" | A spec you can't finish is an undecided decision. Decide, then delegate. |
| "After compaction I don't remember the rule" | Re-read this skill whenever a coding task arrives in a delegation session. |

## Common Mistakes

- Two lanes editing the same file in parallel. Assign disjoint files.
- Attaching a 4,000-line file to the relay every round. Extract ranges with real line numbers.
- Trusting "all green" without the verbatim counts. Require them.
- Accepting `exit 0` from codex as success. Check the diff.
- Forgetting CRLF: on Windows repos the relay lane must normalize anchors before Edit.
- Sending secrets, screenshots, or customer data through a lane. Source code only, and only what the user accepted.

## Setup (once per machine)

1. Relay: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs"` (or `/delegating-to-external-llm:setup`). It asks for base URL, API key (echo off), model, default effort and the relay's minimum request size, writes `~/.claude/llm-relay.env` (mode 600) and smoke-tests the relay. Manual check: `node "${CLAUDE_PLUGIN_ROOT}/scripts/llm.mjs" --max 200 --effort low --pad 2500 "Reply OK"`
2. Agentic lane: `npm i -g @openai/codex@latest` (≥ 0.155; no `codex login` needed — the lane script points codex at the relay using the same env file). Smoke test from any git repo with a spec that says "reply OK, change nothing": expect `STATUS: refused` (correct: nothing changed) and "OK" in the final message.
3. Make the rule survive compaction — in `~/.claude/CLAUDE.md`: `When delegation to the external LLM is active, use the delegating-to-external-llm:delegating-to-external-llm skill for every coding task.`
4. Optional hard enforcement: see `hooks/README.md`.

Quick reference for the relay CLI:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/llm.mjs" --spec spec.md -f a.ts -f b.ts --effort high --out <scratch>/task.llm-output.md
  --model <id>  --effort low|medium|high|xhigh  --max <tokens>  --system "<text>"  --json
```
