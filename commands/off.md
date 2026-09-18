---
description: Turn delegation mode off — Claude codes normally again and the edit gate is disarmed
---

Remove the switch file and confirm:

```bash
rm -f ~/.claude/llm-delegation.on && echo "delegation mode OFF"
```

Tell the user in one line that delegation mode is off and that `/delegating-to-external-llm:on` re-enables it. Do not start any task.
