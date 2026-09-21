# Changelog

## 2.8.2

### Fixed
- Preserve analysis task text literally, including quotes, shell metacharacters and newlines, instead of interpolating it into sed or shell commands.
- Add --task-file to the driver and shell lane; file input takes precedence over inline tasks. Detached analysis also passes only the task file path, and the analyst wrapper prefers file input.
- Keep analysis/review artifacts under .lane-scratch/ while reverting other new writes; register /.lane-scratch/ in the target repository's local Git exclude file. Reports and --out continue to use the model's final message.
- Cover literal prompt bytes, foreground/detached file transport, and scratch preservation alongside stray-write cleanup with stub-based regression tests.

## 2.8.1

### Fixed
- Preserve resolved model, effort, home and access metadata throughout live lane status and driver rewrites.
- Require a live update_plan before implementation edits; show the latest reasoning headline when no plan events exist.
- Derive dashboard file entries from apply_patch commands and merge them with file_change events by path, with the latest successful kind winning; dim failed patches without replacing successful changes.
- Dashboard reads `spec`/`log_file` paths from status.json verbatim; the status directory is user-owned.
- Accept both WATCH and DASHBOARD stderr notices and isolate lane/dashboard test fixtures in the OS temporary directory.

## 2.8.0

### Added
- Zero-dependency, loopback-only browser dashboard with Plan, Thinking, Commands, Files, Messages, Report and Log tabs; incremental two-second event polling, seven-day lane history, light/dark appearance, Follow control and session resume copying.
- `/delegating-to-external-llm:dashboard` opens the dashboard. Foreground, detached and batch drivers auto-start it and print `DASHBOARD:` after `WATCH:`; JSON output includes `dashboard`. `LLM_DASHBOARD=0` disables auto-start and `LLM_DASHBOARD_PORT` selects the port (default 7788).
- Header usage totals for 1h/24h/7d reuse the ledger's aggregation and pricing semantics; fixture-based HTTP tests cover raw events, missing artifacts and safe slug handling.

### Fixed
- Lane changes and scope checks compare per-file hashes before and after execution, including edits to files already dirty before the lane and changes retained across resumes.
- Windows detached drivers launch through `Start-Process -WindowStyle Hidden`, with separate `.log.err` stderr and the real driver's PID. Console descendants inherit the hidden console instead of repeatedly allocating visible windows.

## 2.7.0 — 2026-09-21

### Added
- `lane-run.mjs --detach` starts independent implementation, analysis or batch drivers on Windows and Linux, printing lane slugs, status paths and the watcher command. Status files include PID, report and log paths; every finished lane saves a verbatim `*.report.txt`.
- `--wait <slug…> --timeout 540` polls every three seconds, returning saved reports and outcome codes (0/5/2), verbatim RUNNING snapshots on timeout (10), or MISSING after a 30-second grace period (4). Known sessions include resume commands in reports.
- Env-only `LLM_LANE_MAX_INPUT_TOKENS` (default 3000000) stops codex when cumulative prompt usage exceeds the limit, including cached input, with a token-budget timeout reason. The live event monitor enforces it with or without status output.

### Known limitations
- batch slugs are spec basenames; two specs with the same basename collide. Duplicate basenames are rejected before launch; use unique spec filenames.

### Changed
- Default dispatch uses one visible thin subagent per lane, launched in the same message up to the cap. Implementer and analyst wrappers only detach, echo SLUG/WATCH, wait in nine-minute slices, relay RUNNING verbatim and return LANE REPORTs. Main-session background Bash is reserved for batches.
- Private home's template requests concise reasoning summaries; implementation prompts ask codex to maintain and refresh an update_plan plan. Existing private/shared configs remain untouched.

### Fixed
- Recover non-terminal statuses whose driver has exited as unavailable reports instead of repeatedly timing out in `--wait`.
- Reject duplicate batch slugs before launching any work; format elapsed times of at least a minute as `12m 05s`.
- Include every test file in the package test script, isolate lane-status fixtures, and cover detach/wait, missing slugs, outcome propagation, elapsed formatting and live token-budget termination.

### Known limitations
- `--batch` uses spec basenames as slugs, so matching basenames across repositories collide and are rejected; use distinct spec basenames.

## 2.6.0 — 2026-09-21

### Added
- Live per-lane `*.status.json` files track phase, elapsed time, tokens, session and last message; sibling `*.events.jsonl` files retain the codex events stream.
- `scripts/lane-status.mjs --watch` refreshes the status table every two seconds; `/delegating-to-external-llm:status` prints it once verbatim. Every background launch must be reported with the driver's `WATCH:` line.

### Changed
- Hook scope narrowed to code inside git work trees; paths outside work trees and documentation/data extensions are allowed without external-model evidence.
- `lane-run.mjs --batch` caps concurrency at 2 by default, configurable with `--concurrency` or `LLM_LANE_CONCURRENCY`; analyze lanes count toward the architect's concurrency budget too. Four concurrent codex sessions timed out the relay.
- LANE_RUN timeout note: `lane-run.mjs --timeout` defaults to 900 seconds per codex invocation, not for the whole batch; verification commands have their own 900-second timeout. Use a background Bash call with timeout 3600000 for long-running lanes rather than polling the conversation.

## 2.5.0 — 2026-09-21

### Added
- `LLM_CODEX_HOME=private|shared|<path>` selects the codex home for lanes. Private remains the default; shared uses the incoming `CODEX_HOME` or `~/.codex` with the user's plugins, MCP servers, skills, AGENTS.md and trust entries. `LANE_CODEX_HOME` wins over the setting; environment values win over the env file.
- Setup prompts for the home, accepts `--codex-home`, saves the selection and prints it in the summary.
- Lane banners show `home:`; usage records include optional `home` (null when absent). Older records and unknown fields remain supported.
- Shared/path homes must already exist (missing home: `STATUS: unavailable`, exit 3); the lane never seeds or overwrites their configs. Private still seeds only a missing config.
- Stub-codex tests cover home selection, precedence, preservation, missing homes and ledger compatibility. Documented measured base input: private 42k vs shared 122k per run (~3x).

## 2.4.0 — 2026-09-21

### Changed
- Model follows the user's codex config; no vendor-model pins. `LLM_MODEL` overrides the top-level model in `${CODEX_HOME:-~/.codex}/config.toml`. With neither set, codex chooses its default and chat reports a configuration error.
- Setup accepts an empty model to follow codex config.
- **Breaking change:** removed the `ASTRA_MODEL` / `EVAL_LLM_MODEL` fallbacks; use `LLM_MODEL` or codex config instead.
- `codex_config_model` reads only a double-quoted top-level `model = "..."`.

## 2.3.0 — 2026-09-19

### Changed
- **Installed = on.** No switch file, no `:on`/`:off` commands (a slash command costs a model turn anyway). `hooks/delegation-context.mjs` on `SessionStart` and `UserPromptSubmit` injects a one-paragraph reminder every turn (survives compaction) plus setup/codex warnings at session start; the edit gate is always armed. To code normally, disable the plugin. `LLM_DELEGATION=0` silences both hooks for one session. No `~/.claude/CLAUDE.md` edit required.


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
