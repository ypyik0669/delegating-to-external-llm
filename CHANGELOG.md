# Changelog

## 2.2.0 — 2026-09-18

Goal: Claude spends tokens only on decisions. Measured on a real repo (supermemory) 2.1 delegated the typing but Claude still did the exploring, supervising and cleanup; 2.2 moves those to the external model or to scripts.

### Added
- **Analyze lane** — `codex-lane.sh --analyze "<task>"` / `lane-run.mjs --analyze` / `/delegating-to-external-llm:analyze` / `codex-analyst` agent: the relay model reads the repo read-only and returns a ≤30-line BRIEF plus a six-part SPEC DRAFT (`templates/analysis-prompt.md`). The architect reviews a draft instead of reading code.
- **Deterministic lane driver** — `scripts/lane-run.mjs`: spec-lint → codex → independent verification → resume with failing output (max N) → lockfile-churn check → LANE REPORT, with no LLM supervising. `--batch` runs several specs concurrently and wakes the architect once. `/delegating-to-external-llm:lane`.
- **Private codex home** — lanes run with `CODEX_HOME=~/.claude/llm-codex-home` seeded from `codex-home/config.toml`; the user's MCP servers, AGENTS.md, skills and profiles never load into a lane. Base input per run dropped from ~24k to ~17–21k tokens and start-up noise is gone.
- **Cross-vendor review** — `codex-lane.sh --review [--base]`: the relay model reviews the diff read-only; `llm-advisor` reads that first and only then judges.
- **Two-sided ledger** — `usage.mjs --claude-in/--claude-out` records Claude-side spend; the summary prints a `claude : external` token ratio (target ≥ 1 : 5) and USD when `LLM_PRICE_*` / `CLAUDE_PRICE_*` are set.
- **Stray-write guard** — in a linked worktree the lane detects files codex wrote to the main tree (`WROTE OUTSIDE WORKTREE`) and moves them back; the preamble states the absolute working root.
- `lane-worktree.sh` commits the lane's work before `check`/`merge` and enables `core.longpaths` on Windows.
- `tests/lane-run.test.mjs` (8 cases with a stub lane) — 31 unit tests total.

### Changed
- No agent pins a model any more; every agent inherits the session model. Only the user switches models.
- `codex-implementer` and `codex-analyst` are thin wrappers that return the driver's output verbatim.
- SKILL.md rewritten around the analyze → spec → lane-run → advisor flow, with session-hygiene rules (fresh session / `/compact`, `/effort low`, batch, never re-paste reports) and the ratio as a compliance test.

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
