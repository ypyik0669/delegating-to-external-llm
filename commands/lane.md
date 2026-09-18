---
description: Run one or more spec files through the deterministic lane driver (spec-lint → codex on the relay → verification → resume → LANE REPORT) without any LLM supervisor
---

Run the lane driver on the spec file(s) in `$ARGUMENTS` and show the LANE REPORT(s) verbatim. Do not read the diff, do not fix anything, do not summarise beyond one line per lane stating its STATUS.

Single spec (run from the spec's WORKTREE if it has one, else the repo root; Bash timeout 1800000):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lane-run.mjs" --spec $ARGUMENTS --max-resumes 2 --timeout 900
```

Several specs at once — they run concurrently, each in its own WORKTREE, and you are woken once with all reports:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lane-run.mjs" --batch $ARGUMENTS --max-resumes 2 --timeout 900
```

Exit code 0 = every lane `complete`; 5 = at least one `partial` (scope violation, failing verification, oversized lockfile change); 2 = `refused`/`unavailable`. Then decide as the architect: corrected spec, widen FILES, or report the blocker. Never patch by hand.
