---
description: Configure the relay (base URL, API key, model, default reasoning effort) used by the delegation lanes, then smoke-test it
---

Help the user configure the external-model relay for this plugin. Do **not** ask the user to paste their API key into the chat, and never write it yourself.

1. Tell the user to run the interactive setup in their own terminal (in Claude Code they can prefix with `!` to run it inline):

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs"
   ```

   It prompts for the relay base URL (OpenAI-compatible, without `/v1`), the API key (typed with echo off), the relay model (whatever your codex is set to, or `LLM_MODEL`; empty = follow `~/.codex/config.toml`) and the default reasoning effort, permission level, and "codex home for lanes (private = lean/cheap, shared = your full codex plugins/MCPs/skills, ~3x base tokens)" (defaults to the existing `LLM_CODEX_HOME` or `private`), writes `~/.claude/llm-relay.env` with mode 600, and runs a smoke test on both lanes.

   Non-interactive form, if they prefer to pass flags themselves:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --base https://relay.example.com --key sk-... --model <model> --reasoning xhigh --codex-home private
   ```

   `--codex-home private|shared|<path>` saves `LLM_CODEX_HOME` and prints it in the summary. Private seeds `~/.claude/llm-codex-home` from the plugin template. Shared uses `${CODEX_HOME:-$HOME/.codex}` with all user plugins, MCP servers, skills, AGENTS.md and trust entries; measured base input is 42k private vs 122k shared per run. Shared/path directories must exist; the lane never creates them or seeds their configs (missing home: exit 3, unavailable). `LANE_CODEX_HOME` overrides the setting; environment `LLM_CODEX_HOME` overrides the env file.

2. After they confirm it ran, verify without exposing the key:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/llm.mjs" --max 200 --effort low --pad 2500 "Reply OK"
   command -v codex && codex --version
   ```

3. Report: relay reachable or not, codex present or not (and therefore which lanes are live), and remind them to add the compaction-survival line to `~/.claude/CLAUDE.md`:

   > When delegation to the external LLM is active, use the delegating-to-external-llm:delegating-to-external-llm skill for every coding task.

If `$ARGUMENTS` contains `--check`, skip step 1 and only run step 2 and 3.
