---
description: Ask the relay model (read-only codex) to read the repo for a one-line task and return a BRIEF plus a six-part SPEC DRAFT — the architect reviews the draft instead of reading the code
---

Run the analysis lane for the task in `$ARGUMENTS` from the repo root (Bash timeout 900000):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lane-run.mjs" --analyze "$ARGUMENTS" --effort medium --timeout 600 --out "${CLAUDE_SCRATCHPAD_DIR:-/tmp}/brief.md"
```

Show the BRIEF and SPEC DRAFT verbatim. Then, as the architect, do only this: answer the open decisions the brief lists, edit the draft (objective, constraints, effort), split it into disjoint specs if it names hotspot conflicts, and save each spec to a file. Do not open the files the brief cites unless a decision genuinely depends on the exact code.
