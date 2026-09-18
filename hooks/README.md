# Optional hard enforcement

The skill makes the architect *want* to delegate. This hook makes it *unable* to write repo code by hand while delegation mode is on.

## How it works

`block-direct-edits.mjs` is a PreToolUse hook for Edit / Write / NotebookEdit, registered automatically by `hooks/hooks.json` when the plugin is loaded (the command uses `${CLAUDE_PLUGIN_ROOT}`, so it works on Windows without `%USERPROFILE%` tricks).

When delegation mode is on it blocks writes to files under the current repo unless a fresh (< 30 min) external-model output file (`*.llm-output.*`, written by `llm.mjs --out`) exists under the **current project's** scratch root (`%TEMP%/claude/<project-slug>/`). The relay-implementer agent always produces one before applying code; the main agent never does. The codex lane edits files through its own process and never hits this hook.

When delegation mode is off the hook exits immediately and does nothing.

## Turn it on / off

- On for this machine: `touch ~/.claude/llm-delegation.on` (or export `LLM_DELEGATION=1` before starting Claude Code).
- Off: `rm ~/.claude/llm-delegation.on`.

Hook changes take effect on the next session.

## Caveats

- A determined agent could create a fake `*.llm-output.*` file. The hook stops the default drift ("I'll just do it myself"), not adversarial behaviour.
- The scratch root is derived from the hook's `cwd`, plus its parent and grandparent so a lane running inside `<repo>/.lanes/<slug>` (see `scripts/lane-worktree.sh`) finds the main project's evidence. Other cwd layouts won't match.
