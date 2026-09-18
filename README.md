# delegating-to-external-llm

[![ci](https://github.com/ypyik0669/delegating-to-external-llm/actions/workflows/ci.yml/badge.svg)](https://github.com/ypyik0669/delegating-to-external-llm/actions/workflows/ci.yml)

**English** | [中文](README.zh-CN.md)

A Claude Code plugin that turns Claude into the **architect** and hands **all implementation** to an external model on **your own OpenAI-compatible relay** (any base URL + API key). Claude writes specs, routes work, verifies diffs, and asks a clean-context Claude advisor for a ship / fix-first / rethink verdict before reporting done. It never types the code itself.

Modeled on the architect pattern from [fable-advisor](https://github.com/DannyMac180/fable-advisor) by Dan McAteer, adapted to a single relay-served model with two delivery mechanisms and hard enforcement.

## Why

- **Spend the premium on judgment, not typing.** Claude's tokens go to decomposition, specs and verdicts; the relay model does the volume.
- **Cross-vendor by construction.** The code comes from a non-Anthropic model; Claude's verification and the advisor's review are real second opinions.
- **No silent drift.** Specs are linted before a lane spends anything, edits are fenced to the spec's FILES, lanes fail loudly (`unavailable`, `refused`, `SCOPE VIOLATION`), reports carry the verification the lane re-ran itself, and an optional hook physically blocks Claude from editing repo files while delegation is on.
- **Evidence, not vibes.** Every lane call lands in a usage ledger; `/delegating-to-external-llm:usage` shows exactly how much the external model did.

## How it works

```
you ──► Claude (architect)
          │  six-part spec + REASONING: <effort>
          ├──► codex-implementer   codex exec ──► your relay ──► model edits the repo itself
          ├──► relay-implementer   llm.mjs    ──► your relay ──► text applied verbatim
          │  LANE REPORT (STATUS, CHANGES, VERIFIED …)
          ├──► llm-advisor (Claude, read-only, clean context) ──► ship / fix-first / rethink
          └──► report to you: lanes, efforts, verbatim test counts, advisor verdict
```

| Lane | How the model runs | Agent | When |
|---|---|---|---|
| Agentic (default) | `codex exec` pointed at your relay (Responses API); the model reads, edits and runs tests itself at the permission level you chose (`workspace` / `workspace-net` / `yolo`); retries resume the same session | `codex-implementer` | Any implementation task |
| Chat / fallback | `scripts/llm.mjs` chat completions; the agent applies the reply verbatim | `relay-implementer` | codex unavailable, a task failed twice, or you want the audited four-call trail (`PROTOCOL: four-phase`) |
| Review | Claude, session effort, read-only | `llm-advisor` | Commitment boundaries + mandatory end-of-deliverable review |

Reasoning effort is named **per task** in the spec (`REASONING: low|medium|high|xhigh`), never pinned globally.

## Requirements

- Claude Code ≥ 2.1.x
- Node ≥ 18
- An OpenAI-compatible relay: base URL + API key (`/v1/chat/completions`; `/v1/responses` too if you want the agentic lane)
- Optional, for the agentic lane: [OpenAI Codex CLI](https://github.com/openai/codex) ≥ 0.155 (`npm i -g @openai/codex@latest`). No `codex login` needed — the lane points codex at your relay.
- Windows: Git Bash (ships with Git for Windows)

## Install

**From GitHub (recommended):**

```
claude plugin marketplace add ypyik0669/delegating-to-external-llm
claude plugin install delegating-to-external-llm@delegating-to-external-llm
```

**Or clone into the skills directory** (auto-discovered in place as `delegating-to-external-llm@skills-dir`, edits take effect immediately):

```
git clone https://github.com/ypyik0669/delegating-to-external-llm ~/.claude/skills/delegating-to-external-llm
```

**Or one-off:** `claude --plugin-dir /path/to/delegating-to-external-llm`

Restart Claude Code. `/plugin list` shows the plugin; `/agents` lists `codex-implementer`, `relay-implementer`, `llm-advisor`.

## Setup — your relay and key

Run the interactive setup **in your own terminal** (the key is typed with echo off and written to `~/.claude/llm-relay.env` with mode 600; it is never pasted into the chat):

```
node ~/.claude/skills/delegating-to-external-llm/scripts/setup.mjs
```

It asks for:

| Prompt | Meaning |
|---|---|
| Relay base URL | e.g. `https://relay.example.com` (no `/v1`) |
| API key | echo off |
| Model | default `gpt-6-astra`; any slug your relay serves |
| Default reasoning effort | `low|medium|high|xhigh`, used when a spec omits `REASONING:` |
| Minimum input tokens | `0` unless your relay rejects small requests; then e.g. `2000` and `llm.mjs` pads short prompts automatically |
| codex permission level | `workspace` (repo-only, no network — default), `workspace-net` (repo + network), `yolo` (no sandbox, no approval prompts: the model can do anything your account can) |

Then it smoke-tests the relay and reports whether codex is present. Non-interactive:

```
node scripts/setup.mjs --base https://relay.example.com --key sk-... --model gpt-6-astra --reasoning xhigh --min-input 0 --codex-access workspace
```

Inside Claude Code, `/delegating-to-external-llm:setup` walks you through the same thing (and `--check` re-verifies).

Finally, make the rule survive context compaction — add to `~/.claude/CLAUDE.md`:

```
When delegation to the external LLM is active (the user said the external model must do the coding, or "you are only the brain"), use the delegating-to-external-llm:delegating-to-external-llm skill for every coding task, including after context compaction.
```

## Use

Tell Claude:

> delegate all coding to the external model; you are only the brain.

Claude loads the skill, writes a six-part spec per task, dispatches lanes on disjoint file sets (in parallel when independent), reads the diffs, re-runs or spot-checks the verification, consults `llm-advisor`, and reports.

### The spec contract (`templates/spec.md`)

```
OBJECTIVE:     what to build or change, one paragraph
FILES:         exact paths (disjoint per parallel lane)
INTERFACES:    signatures / types / API shapes to match
CONSTRAINTS:   conventions, things not to touch, CRLF note on Windows
VERIFICATION:  exact command(s) + expected outcome
REASONING:     low | medium | high | xhigh
MODEL:         optional override
PROTOCOL:      four-phase   (optional, chat lane: analysis → failing tests → implementation → self-review)
```

A spec with code in it is a spec that hasn't been delegated yet. Lanes run `scripts/spec-lint.mjs` first and refuse incomplete specs (missing parts, invalid `REASONING`, globs in `FILES`, more than 15 fenced code lines).

### The lane report

Every lane returns:

```
LANE REPORT
LANE: codex-implementer (gpt-6-astra via relay, effort: high)
STATUS: complete | partial | timeout | unavailable | refused
OBJECTIVE / CHANGES / VERIFIED (re-run by the lane, verbatim counts) / MODEL SAID / ROUNDS / JUDGMENT CALLS / GAPS / REASON
```

An empty diff is `refused`, never `complete`. A missing CLI or dead relay is `unavailable`. A file changed outside the spec's FILES is a `SCOPE VIOLATION` and the lane reports `partial`. No lane ever falls back to Claude writing the code.

### Parallel tasks — one worktree per lane

```
bash scripts/lane-worktree.sh create <slug>   # .lanes/<slug> on branch lane/<slug>; put the path in the spec as WORKTREE:
bash scripts/lane-worktree.sh check  <slug>   # dry-run merge, lists conflicting files
bash scripts/lane-worktree.sh merge  <slug>   # merge --no-commit (you commit), remove worktree
bash scripts/lane-worktree.sh cleanup
```

File sets must be disjoint and hotspot files (routes, config, registries, manifests) belong to exactly one spec. Conflicts go back to the lane as a corrected spec; the architect never resolves them by hand.

### Usage ledger

Every lane call appends to `~/.claude/llm-usage.jsonl`. `node scripts/usage.mjs --since 24h` (or `/delegating-to-external-llm:usage`) shows calls, prompt / cached / output tokens and wall time by lane, status and project — the proof that the external model, not Claude, did the work.

## Hard enforcement (optional)

`hooks/block-direct-edits.mjs` is a PreToolUse hook registered by the plugin. While delegation mode is on it blocks Edit / Write / NotebookEdit on repository files from the main session unless a fresh external-model output exists for the current project.

```
touch ~/.claude/llm-delegation.on    # on
rm    ~/.claude/llm-delegation.on    # off
```

See [hooks/README.md](hooks/README.md).

## Degradation

- No codex → everything routes to `relay-implementer`; the report says so.
- Relay down → both lanes report `unavailable`; Claude reports the blocker and does not write the code.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `HTTP 400 … fewer than N input tokens` | Your relay rejects small requests. Re-run setup with `--min-input N`; `llm.mjs` pads short prompts. |
| `relay error in stream: … overloaded` | The relay sent an error inside a 200 stream. `llm.mjs` retries twice, then reports `unavailable`. |
| `STATUS: unavailable … 401` from the codex lane | Bad key or base URL in `~/.claude/llm-relay.env`. |
| `wire_api = "chat" is no longer supported` | codex ≥ 0.155 only speaks the Responses API; your relay must serve `/v1/responses` for the agentic lane. Otherwise use the chat lane. |
| codex exits 0 but nothing changed | That is `refused`. Read the final message; usually a spec gap or a rule in `~/.codex/AGENTS.md`. The lane preamble opts out of such rules. |
| Windows: codex can't find the repo | The lane script passes `pwd -W`; run lanes from the repo root in Git Bash. |

## Tests and evals

```
npm test                                   # 22 node:test cases: hook, spec-lint, usage ledger
npm run check                              # node --check + bash -n on every script
claude plugin eval . --tag offline --scaffold --runs 1 --no-publish   # behavioural cases (see evals/README.md)
```

CI runs the same on ubuntu + windows (`.github/workflows/ci.yml`).

## Files

```
.claude-plugin/plugin.json, marketplace.json   manifest + marketplace entry
skills/delegating-to-external-llm/SKILL.md     routing doctrine, spec contract, report format, red flags
agents/codex-implementer.md                    agentic lane (codex exec over your relay)
agents/relay-implementer.md                    chat lane (llm.mjs, verbatim apply, four-phase)
agents/llm-advisor.md                          read-only Claude reviewer
commands/setup.md, commands/usage.md           /delegating-to-external-llm:setup, :usage
scripts/setup.mjs                              interactive relay/key/permission setup + smoke test
scripts/llm.mjs                                streaming chat-completions CLI (--spec, -f, --effort, --out, --pad, retries, ledger)
scripts/codex-lane.sh                          codex exec wrapper: relay provider, access level, file fence, session resume, ledger, ran/refused/unavailable
scripts/spec-lint.mjs                          refuses incomplete or code-dictating specs
scripts/lane-worktree.sh                       create / check / merge / cleanup one worktree per parallel lane
scripts/usage.mjs, scripts/usage-log.mjs       usage ledger
hooks/hooks.json, hooks/block-direct-edits.mjs optional PreToolUse gate
templates/spec.md, templates/four-phase.md
tests/, evals/, .github/workflows/ci.yml
llm-relay.env.example                          never commit the real one
```

## Security notes

- Credentials live only in `~/.claude/llm-relay.env` (mode 600). The repo's `.gitignore` excludes it.
- Everything you delegate is sent to the relay you configured. Don't send secrets, `.env` files, or customer data; the skill tells the lanes the same.
- The codex lane runs at the permission level you set in `LLM_CODEX_ACCESS`. The default `workspace` is a write-only-inside-the-repo sandbox with no network. `yolo` removes the sandbox and approval prompts entirely — choose it only on machines where you would let the model act as you.

## Credits

Architecture and doctrine adapted from [DannyMac180/fable-advisor](https://github.com/DannyMac180/fable-advisor) (MIT). The 2.1 drift and cost controls follow 2026 findings on multi-agent coding: subagent token multiplication and scope bounding ([MindStudio](https://www.mindstudio.ai/blog/claude-code-subagents-cost-tokens)), context drift and file-level fences ([arXiv 2603.00822](https://arxiv.org/html/2603.00822v1), [Codex KB](https://codex.danielvaughan.com/2026/06/15/agents-md-beyond-init-writing-project-instructions-that-reduce-token-spend-hooks-mcp-skills/)), and worktree isolation vs. coordination ([AgenticFlict](https://codex.danielvaughan.com/2026/07/28/agent-pr-merge-conflicts-concurrent-coding-agents-codex-cli-worktree-isolation-coordination-defence/), [STORM](https://arxiv.org/pdf/2605.20563)).

## License

MIT
