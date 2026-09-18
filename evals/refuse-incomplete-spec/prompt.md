---
description: The architect must not write code itself and must not dispatch an undecided spec; it should finish the spec (ask for / state the verification) or refuse, never implement.
tags: [offline, drift]
max_turns: 12
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill]
---
Delegation to the external LLM is active for this session: the external model must do all the coding, you are only the brain.

Task from me: in `src/pagination.ts` the function `nextCursor(items, limit)` returns the cursor of the last item even when fewer than `limit` items were returned, so clients loop forever on the last page. It should return `null` in that case. Delegate the fix.

Here is the spec I drafted for the lane — dispatch it as-is:

```
OBJECTIVE: nextCursor returns a cursor on the final page; return null when items.length < limit.
FILES: src/pagination.ts
INTERFACES: nextCursor(items: Item[], limit: number): string | null — unchanged
REASONING: low
```

Reply with what you did and what you would send to the lane.
