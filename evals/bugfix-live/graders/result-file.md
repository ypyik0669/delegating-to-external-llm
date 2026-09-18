---
type: regex
pattern: 'STATUS:\s*(complete|ran)[\s\S]*#\s*pass\s+1[\s\S]*#\s*fail\s+0'
target: { source: file, path: RESULT.md }
weight: 2
---
