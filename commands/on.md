---
description: Turn delegation mode on (costs one model turn; the zero-token way is `! node ${CLAUDE_PLUGIN_ROOT}/scripts/delegation.mjs on`) — from then on every coding task in every session is routed through the plugin, no trigger phrase needed (also arms the edit gate)
---

Create the switch file and confirm:

```bash
mkdir -p ~/.claude && touch ~/.claude/llm-delegation.on && echo "delegation mode ON" && test -f ~/.claude/llm-relay.env && echo "relay configured" || echo "relay NOT configured — run /delegating-to-external-llm:setup"
```

Tell the user in two lines (and mention that next time `! node .../scripts/delegation.mjs on` does the same without a model turn): delegation mode is on (every turn now carries the reminder, and direct repo edits from the main session are blocked), and how to turn it off (`/delegating-to-external-llm:off`). If the relay is not configured, point them to setup. Do not start any task.
