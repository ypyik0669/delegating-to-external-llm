# Changelog

## 2.1.0 — 2026-09-18

Efficiency, token discipline, and drift control, informed by 2026 community findings on multi-agent coding (see README → Credits).

### Added
- **codex permission levels** — `LLM_CODEX_ACCESS=workspace | workspace-net | yolo` (setup prompt / `--codex-access`). `yolo` runs codex with `--dangerously-bypass-approvals-and-sandbox`.
- **File fence** — `codex-lane.sh --files` compares what changed against the spec's FILES; extra paths print `SCOPE VIOLATION` (exit 5) and the lane reports `partial`. The preamble tells the model to stop rather than touch other files.
- **Spec lint** — `scripts/spec-lint.mjs`: six parts present, valid `REASONING`, concrete `FILES`, ≤ 15 fenced code lines, runnable `VERIFICATION`. Lanes refuse incomplete specs before spending anything.
- **Usage ledger** — every lane call appends to `~/.claude/llm-usage.jsonl`; `scripts/usage.mjs` and `/delegating-to-external-llm:usage` summarise calls, tokens, wall time by lane / status / project.
- **Session resume** — `codex-lane.sh --resume <thread-id>`; the lane retries a failed verification inside the same codex session (max 2) instead of restarting.
- **Worktree isolation** — `scripts/lane-worktree.sh create | check | merge | list | cleanup`; one worktree per parallel lane, dry-run merge before landing, hotspot-file rule in the skill.
- **Evals + CI** — `evals/` (two offline cases, one live), `tests/` (22 node:test cases for the hook, lint and ledger), GitHub Actions on ubuntu + windows.
- `EVAL_LLM_*` / `EVAL_CODEX_DISABLED` environment fallbacks so the eval sandbox can run the lanes.

### Changed
- Lane reports are capped at ~40 lines; the skill tells the architect to cite paths and counts, never re-paste diffs.
- `codex-lane.sh` now consumes codex's `--json` event stream: session id, token usage, in-stream errors; no longer `--ephemeral`.
- Advisor checks changed paths against the specs' FILES.
- Skill description gains more trigger phrases (English and Chinese).
- `REASONING` rungs are `low | medium | high | xhigh` everywhere (`max` removed).

## 2.0.0 — 2026-09-18

Rebuilt as a Claude Code plugin on the fable-advisor architect pattern: three agents (`codex-implementer`, `relay-implementer`, `llm-advisor`), six-part spec contract, `LANE REPORT` with re-run verification, interactive relay/key setup, in-stream relay error retry, request-size padding, optional PreToolUse gate, bilingual README.

## 1.x

Single skill: relay-only, four mandatory phases per task.
