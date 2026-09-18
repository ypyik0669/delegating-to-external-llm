#!/usr/bin/env bash
# Seeds the eval workspace: a git repo with a one-line bug and a failing test.
set -e
git init -q -b main
printf 'export function add(a, b) { return a - b; }\n' > add.mjs
cat > add.test.mjs <<'EOF'
import test from "node:test"; import assert from "node:assert";
import { add } from "./add.mjs";
test("adds", () => assert.strictEqual(add(2, 3), 5));
EOF
git add -A
git -c user.email=eval@example.com -c user.name=eval commit -qm "fixture: subtracting add()"
