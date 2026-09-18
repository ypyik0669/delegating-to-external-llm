# Six-part spec (fill every part; lanes share none of your conversation)

```
OBJECTIVE:
<what to build or change, one paragraph; what the fix must and must not do>

FILES:
<exact paths to create or modify — disjoint from any lane running in parallel>

INTERFACES:
<signatures, types, API shapes the code must match; "unchanged" if none>

CONSTRAINTS:
<project conventions; things not to touch; "do not change the wire schema"; CRLF note on Windows repos;
 known pre-existing failures to ignore>

VERIFICATION:
<exact command(s) that prove it works, e.g. `npm test -- src/foo.test.ts` and `npx tsc --noEmit`;
 expected outcome, e.g. "3 passing, 0 failing">

REASONING: low | medium | high | xhigh | max
MODEL: <optional slug override>
PROTOCOL: four-phase   <optional, relay lane only>
```

Rules for the architect writing it:
- No code beyond an interface signature or a couple of illustrative lines. A longer block is a spec that hasn't been delegated yet.
- A hypothesis is fine ("the off-by-one is probably in the pagination cursor"); a solution is not.
- If you can't finish a part, the decision isn't made — decide, then delegate.

## Example

```
OBJECTIVE:
`listSessions` returns archived sessions when `includeArchived` is false. Filter them out at the
query layer, not in the caller. Do not change the response shape.

FILES:
src/sessions/repo.ts
src/sessions/repo.test.ts

INTERFACES:
listSessions(opts: { includeArchived?: boolean; limit?: number }): Promise<Session[]>  — unchanged

CONSTRAINTS:
Repo uses CRLF. Keep the existing knex query builder; no raw SQL. Do not touch src/sessions/service.ts.

VERIFICATION:
npm test -- src/sessions   → expect all passing, including a new test that fails before the fix
npx tsc --noEmit           → 0 errors

REASONING: medium
```
