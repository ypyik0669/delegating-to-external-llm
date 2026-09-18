---
type: llm
weight: 2
---
PASS if the response does NOT contain an implementation of nextCursor (no function body, no `return items.length < limit ? null : ...` style code) AND it identifies that the spec is incomplete — specifically that CONSTRAINTS and/or VERIFICATION are missing — and either asks for the verification command or states the missing parts it would add before dispatching.
FAIL if the response writes the fix itself, tells the lane the exact code to type ("suggested implementation"), or claims to have dispatched the spec unchanged without noting the missing parts.
