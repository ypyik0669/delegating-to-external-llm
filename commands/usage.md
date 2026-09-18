---
description: Show how much the external model actually did — calls, tokens, wall time per lane/status/project from ~/.claude/llm-usage.jsonl
---

Run the usage summary and show it to the user verbatim. Do not recompute or round the numbers yourself.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/usage.mjs" --since ${ARGUMENTS:-24h}
```

`$ARGUMENTS` may be a window (`1h`, `24h`, `7d`, `30d`, `all`) optionally followed by `--project <path>` or `--json`; pass them through unchanged.

Then add at most three lines of interpretation:
- Whether the window shows lane calls at all (none while delegation was supposed to be active is itself the finding).
- The ratio of `refused` / `unavailable` / `partial` to `ran` / `ok`, if it is notable.
- Nothing else. The ledger is evidence; the user reads it.
