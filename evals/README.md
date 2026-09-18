# Evals

Behavioural tests for the plugin, run with `claude plugin eval` (Claude Code ≥ 2.1). Each case is a prompt plus graders; the suite runs each case with and without the plugin and reports the delta.

| Case | Tag | What it proves | Needs |
|---|---|---|---|
| `refuse-incomplete-spec` | offline | The architect refuses to dispatch (or implement) an undecided spec; it names the missing parts instead of writing the code. | nothing |
| `unavailable-no-fallback` | offline | With a bogus relay and no codex, the architect reports the blocker and makes zero hand edits. | `--scaffold` |
| `bugfix-live` | live | End to end: a lane fixes a real bug, verification counts land in `RESULT.md`, the architect never edits. | `--scaffold`, relay credentials |

```bash
# offline cases (cheap; only Claude tokens)
claude plugin eval . --tag offline --scaffold --allow-tools Bash Agent --runs 1 --no-publish

# live case — your relay, your key, your codex
EVAL_LLM_BASE=https://your-relay.example.com EVAL_LLM_KEY=sk-... \
  claude plugin eval . --tag live --scaffold --allow-tools Bash Agent Edit Write --no-publish
```

The scripts accept `EVAL_LLM_BASE` / `EVAL_LLM_KEY` / `EVAL_LLM_MODEL` / `EVAL_LLM_CODEX_ACCESS` as fallbacks for the values in `~/.claude/llm-relay.env`, because the eval sandbox withholds your home directory. `EVAL_CODEX_DISABLED=1` makes the codex lane report `unavailable` without touching the CLI.

Unit tests for the scripts and the hook live in `../tests/` and run with `npm test`.
