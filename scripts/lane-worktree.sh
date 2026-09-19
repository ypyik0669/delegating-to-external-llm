#!/usr/bin/env bash
# lane-worktree.sh — one git worktree per parallel lane, so lanes never touch each other's files,
# plus a pre-merge conflict check so problems surface before anything lands on the main tree.
#
#   bash lane-worktree.sh create <slug>   # .lanes/<slug> on branch lane/<slug> from HEAD; prints the path
#   bash lane-worktree.sh check  <slug>   # commits the lane's work, dry-run merge; lists conflicting files; exit 1 on conflict
#   bash lane-worktree.sh merge  <slug>   # check, then merge --no-commit (you commit), then remove worktree + branch
#                                         # a dirty main tree (e.g. an earlier lane already merged) is stashed around the merge
#   bash lane-worktree.sh list
#   bash lane-worktree.sh cleanup         # remove every .lanes/* worktree and lane/* branch (asks nothing — use after merging)
#
# Run from the main working tree of the repo. Worktrees live under <repo>/.lanes/ (git-ignored via
# .git/info/exclude). Lanes never commit; check/merge commit whatever the lane left in the worktree
# onto lane/<slug> so the merge has something to merge. On Windows, create enables core.longpaths.
set -u
cmd="${1:-}"; slug="${2:-}"
[ -n "$cmd" ] || { sed -n '2,13p' "$0"; exit 1; }
ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "lane-worktree: not inside a git repo" >&2; exit 1; }
cd "$ROOT" || exit 1
LANES="$ROOT/.lanes"
need_slug() { [ -n "$slug" ] && [[ "$slug" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "lane-worktree: slug required ([A-Za-z0-9._-])" >&2; exit 1; }; }
ensure_exclude() { mkdir -p "$ROOT/.git/info"; grep -qx '.lanes/' "$ROOT/.git/info/exclude" 2>/dev/null || echo '.lanes/' >> "$ROOT/.git/info/exclude"; }
STASHED=0
stash_main() { # park uncommitted main-tree changes (earlier merged lanes, WIP) so merge has a clean base
  if [ -n "$(git status --porcelain)" ]; then
    git stash push -u -q -m "lane-worktree: main tree during $cmd $slug" || { echo "lane-worktree: could not stash main tree" >&2; exit 1; }
    STASHED=1
  fi
}
unstash_main() {
  [ "$STASHED" -eq 1 ] || return 0
  STASHED=0
  if ! git stash pop -q; then
    echo "lane-worktree: restored main-tree changes conflict with this merge — resolve the conflicts listed by git status, then 'git stash drop'" >&2
    return 1
  fi
}
commit_lane() { # commit uncommitted work inside the worktree so the branch carries it
  local wt="$LANES/$slug"
  [ -d "$wt" ] || return 0
  if [ -n "$(git -C "$wt" status --porcelain)" ]; then
    git -C "$wt" add -A
    git -C "$wt" -c user.name="lane/$slug" -c user.email="lane@delegating-to-external-llm" commit -q -m "lane/$slug: work" || return 1
    echo "committed lane worktree changes onto lane/$slug"
  fi
}

case "$cmd" in
  create)
    need_slug; ensure_exclude; mkdir -p "$LANES"
    case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) git config core.longpaths true ;; esac
    if git show-ref --verify --quiet "refs/heads/lane/$slug"; then echo "lane-worktree: branch lane/$slug already exists" >&2; exit 1; fi
    if ! git rev-parse --verify -q HEAD >/dev/null; then echo "lane-worktree: repo has no commits yet; commit first" >&2; exit 1; fi
    git worktree add -q "$LANES/$slug" -b "lane/$slug" HEAD || exit 1
    if pwd -W >/dev/null 2>&1; then (cd "$LANES/$slug" && pwd -W); else echo "$LANES/$slug"; fi
    ;;
  check)
    need_slug
    git show-ref --verify --quiet "refs/heads/lane/$slug" || { echo "lane-worktree: no branch lane/$slug" >&2; exit 1; }
    commit_lane || exit 1
    stash_main
    if git merge --no-commit --no-ff -q "lane/$slug" >/dev/null 2>&1; then
      git merge --abort 2>/dev/null || git reset -q --hard HEAD
      unstash_main
      echo "MERGE OK: lane/$slug applies cleanly onto $(git rev-parse --abbrev-ref HEAD)"
      git diff --stat HEAD "lane/$slug" | tail -1
      exit 0
    else
      echo "MERGE CONFLICT: lane/$slug vs $(git rev-parse --abbrev-ref HEAD)"
      git diff --name-only --diff-filter=U
      git merge --abort 2>/dev/null || git reset -q --hard HEAD
      unstash_main
      exit 1
    fi
    ;;
  merge)
    need_slug
    bash "$0" check "$slug" || exit 1
    stash_main
    git merge --no-commit --no-ff -q "lane/$slug" || { unstash_main; exit 1; }
    git reset -q  # leave the merge result unstaged so it combines with restored changes as plain working-tree edits
    unstash_main || exit 1
    git worktree remove --force "$LANES/$slug" 2>/dev/null || git worktree prune
    git branch -D -q "lane/$slug" 2>/dev/null
    echo "MERGED lane/$slug into working tree (not committed). Review, run the cross-cutting verification, then commit."
    git status --short
    ;;
  list)
    git worktree list | grep -F "$LANES" || echo "(no lane worktrees)"
    ;;
  cleanup)
    for wt in "$LANES"/*/; do [ -d "$wt" ] || continue; git worktree remove --force "$wt" 2>/dev/null; done
    git worktree prune
    for b in $(git for-each-ref --format='%(refname:short)' refs/heads/lane/); do git branch -D -q "$b"; done
    rmdir "$LANES" 2>/dev/null
    echo "cleaned"
    ;;
  *) echo "lane-worktree: unknown command $cmd" >&2; exit 1 ;;
esac
