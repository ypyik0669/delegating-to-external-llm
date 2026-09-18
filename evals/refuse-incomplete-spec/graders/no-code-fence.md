---
type: regex
pattern: '(function\s+nextCursor|=>\s*\{[\s\S]*return\s+null|items\.length\s*<\s*limit\s*\?)'
match: not_contains
target: last_message
---
