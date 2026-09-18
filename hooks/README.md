# Hooks

Three hooks, all keyed to one switch: `~/.claude/llm-delegation.on` (or `LLM_DELEGATION=1`), toggled by `/delegating-to-external-llm:on` and `:off`.

## Trigger without a phrase — `delegation-context.mjs`

`SessionStart` and `UserPromptSubmit` hook. When the switch is on it prints a one-paragraph reminder that Claude Code adds to the turn's context: route coding work through the skill, don't read source, don't edit. Session start also warns if the relay isn't configured or codex is missing. When the switch is off it prints nothing. This replaces the old advice to edit `~/.claude/CLAUDE.md`; the reminder is re-injected every turn, so it survives compaction.

## Optional hard enforcement — `block-direct-edits.mjs`

The skill makes the architect *want* to delegate. This hook makes it *unable* to write repo code by hand while delegation mode is on.

## How it works

`block-direct-edits.mjs` is a PreToolUse hook for Edit / Write / NotebookEdit, registered automatically by `hooks/hooks.json` when the plugin is loaded (the command uses `${CLAUDE_PLUGIN_ROOT}`, so it works on Windows without `%USERPROFILE%` tricks).

When delegation mode is on it blocks writes to files under the current repo unless a fresh (< 30 min) external-model output file (`*.llm-output.*`, written by `llm.mjs --out`) exists under the **current project's** scratch root (`%TEMP%/claude/<project-slug>/`). The relay-implementer agent always produces one before applying code; the main agent never does. The codex lane edits files through its own process and never hits this hook.

When delegation mode is off the hook exits immediately and does nothing.

## Turn it on / off

- `/delegating-to-external-llm:on` (= `touch ~/.claude/llm-delegation.on`; or export `LLM_DELEGATION=1` before starting Claude Code).
- `/delegating-to-external-llm:off` (= `rm ~/.claude/llm-delegation.on`).

Hook changes take effect on the next session.

## Caveats

- A determined agent could create a fake `*.llm-output.*` file. The hook stops the default drift ("I'll just do it myself"), not adversarial behaviour.
- The scratch root is derived from the hook's `cwd`, plus its parent and grandparent so a lane running inside `<repo>/.lanes/<slug>` (see `scripts/lane-worktree.sh`) finds the main project's evidence. Other cwd layouts won't match.
