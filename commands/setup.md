---
description: Configure the relay (base URL, API key, model, default reasoning effort) used by the delegation lanes, then smoke-test it
---

Help the user configure the external-model relay for this plugin. Do **not** ask the user to paste their API key into the chat, and never write it yourself.

1. Tell the user to run the interactive setup in their own terminal (in Claude Code they can prefix with `!` to run it inline):

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs"
   ```

   It prompts for the relay base URL (OpenAI-compatible, without `/v1`), the API key (typed with echo off), the model (default `gpt-6-astra`) and the default reasoning effort, writes `~/.claude/llm-relay.env` with mode 600, and runs a smoke test on both lanes.

   Non-interactive form, if they prefer to pass flags themselves:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --base https://relay.example.com --key sk-... --model gpt-6-astra --reasoning xhigh
   ```

2. After they confirm it ran, verify without exposing the key:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/llm.mjs" --max 200 --effort low --pad 2500 "Reply OK"
   command -v codex && codex --version
   ```

3. Report: relay reachable or not, codex present or not (and therefore which lanes are live), and remind them to add the compaction-survival line to `~/.claude/CLAUDE.md`:

   > When delegation to the external LLM is active, use the delegating-to-external-llm:delegating-to-external-llm skill for every coding task.

If `$ARGUMENTS` contains `--check`, skip step 1 and only run step 2 and 3.
