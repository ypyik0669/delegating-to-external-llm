#!/usr/bin/env bash
# codex-lane.sh — run the relay model through `codex exec` in one of three modes:
#   implement (default)  agentic: the model reads, edits and runs commands in the working tree
#   --analyze <task>     read-only by contract: produces a BRIEF + six-part SPEC DRAFT (templates/analysis-prompt.md)
#   --review [--base B]  read-only by contract: cross-vendor review of uncommitted changes (or of BASE...HEAD)
#   (read-only modes run at the user's access level — codex's read-only sandbox cannot run commands on
#    Windows — and every write the model makes is reverted and reported as STRAY WRITES.)
# The model is served by the OpenAI-compatible relay in ~/.claude/llm-relay.env (LLM_BASE, LLM_KEY,
# LLM_MODEL, LLM_CODEX_ACCESS). codex runs with a private CODEX_HOME (<plugin>/codex-home) so the
# user's ~/.codex — MCP servers, AGENTS.md, profiles — never loads into a lane.
#
# Usage:
#   bash codex-lane.sh --spec <spec-file> [--files a.ts,b.ts] [--effort low|medium|high|xhigh]
#                      [--access workspace|workspace-net|yolo] [--model <slug>] [--timeout 600] [--resume <thread-id>]
#   bash codex-lane.sh --analyze "<one-line task>" [--effort medium] [--out brief.md]
#   bash codex-lane.sh --review [--base main] [--spec goal.md] [--effort medium] [--out review.md]
#
# Prints the model's final message, then:
#   SESSION: <thread-id | unknown>        pass back with --resume to continue the same session
#   TOKENS: in=<n> cached=<n> out=<n>
#   SCOPE VIOLATION: <paths>              (implement mode, --files given, other files changed)
#   WROTE OUTSIDE WORKTREE: <paths>       (implement mode inside a linked worktree; the main tree changed — moved back)
#   STATUS: ran | refused | timeout | unavailable | failed
# Exit codes: 0 ran · 5 ran with scope violation · 3 refused · 4 timeout · 2 unavailable/failed · 1 usage error.
#
# Access levels (LLM_CODEX_ACCESS or --access): workspace (default, repo-only, no network) ·
# workspace-net (repo + network) · yolo (--dangerously-bypass-approvals-and-sandbox).
# Windows: codex is a native exe, so the working root is passed as a Windows path (`pwd -W`).

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN="$(cd "$HERE/.." && pwd)"
T0=$(date +%s%3N 2>/dev/null || date +%s000)

# --- relay config -------------------------------------------------------------
ENVF="$HOME/.claude/llm-relay.env"
if [ -f "$ENVF" ]; then
  while IFS='=' read -r k v; do
    case "$k" in ''|\#*) continue ;; esac
    k=$(printf '%s' "$k" | tr -d '[:space:]'); v=$(printf '%s' "$v" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    case "$k" in LLM_BASE|LLM_KEY|LLM_MODEL|LLM_CODEX_ACCESS) [ -z "${!k:-}" ] && eval "$k=\"\$v\"" ;; esac
  done < "$ENVF"
fi
LLM_BASE="${LLM_BASE:-${EVAL_LLM_BASE:-}}"; LLM_KEY="${LLM_KEY:-${EVAL_LLM_KEY:-}}"; LLM_MODEL="${LLM_MODEL:-${EVAL_LLM_MODEL:-gpt-6-astra}}"; LLM_CODEX_ACCESS="${LLM_CODEX_ACCESS:-${EVAL_LLM_CODEX_ACCESS:-workspace}}"

MODE=implement; SPEC=""; TASK=""; BASE=""; OUT=""
MODEL="$LLM_MODEL"; EFFORT=""; TIMEOUT=600; ACCESS="$LLM_CODEX_ACCESS"; FILES=""; RESUME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --spec) SPEC="$2"; shift 2 ;;
    --analyze) MODE=analyze; TASK="$2"; shift 2 ;;
    --review) MODE=review; shift ;;
    --base) BASE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --effort) EFFORT="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --access) ACCESS="$2"; shift 2 ;;
    --files) FILES="$2"; shift 2 ;;
    --resume) RESUME="$2"; shift 2 ;;
    *) echo "codex-lane: unknown arg $1" >&2; exit 1 ;;
  esac
done
if [ "$MODE" = implement ]; then [ -n "$SPEC" ] && [ -f "$SPEC" ] || { echo "codex-lane: --spec <file> required" >&2; exit 1; }; fi
if [ "$MODE" = analyze ]; then [ -n "$TASK" ] || { echo "codex-lane: --analyze \"<task>\" required" >&2; exit 1; }; fi
case "$ACCESS" in workspace|workspace-net|yolo) ;; *) echo "codex-lane: --access must be workspace|workspace-net|yolo (got '$ACCESS')" >&2; exit 1 ;; esac
# analyze/review are read-only by contract, not by sandbox: codex's read-only sandbox blocks every shell
# command on Windows, so they run at the user's access level and any write is reverted afterwards.
READONLY_MODE=0; [ "$MODE" != implement ] && READONLY_MODE=1

log_usage() { # status tokens_in tokens_cached tokens_out session
  local T1; T1=$(date +%s%3N 2>/dev/null || date +%s000)
  node "$HERE/usage-log.mjs" \
    --lane "codex-$MODE" --model "$MODEL" --effort "${EFFORT:-default}" --access "$ACCESS" \
    --status "$1" --in "${2:-0}" --cached "${3:-0}" --out "${4:-0}" \
    --duration "$((T1 - T0))" --project "$(pwd -W 2>/dev/null || pwd)" --session "${5:-}" >/dev/null 2>&1 || true
}

# --- preflight -------------------------------------------------------------
if [ "${EVAL_CODEX_DISABLED:-}" = "1" ]; then
  echo "STATUS: unavailable"; echo "REASON: codex disabled by EVAL_CODEX_DISABLED=1"; log_usage unavailable; exit 2
fi
if ! command -v codex >/dev/null 2>&1; then
  echo "STATUS: unavailable"; echo "REASON: codex not found on PATH"; log_usage unavailable; exit 2
fi
if [ -z "$LLM_BASE" ] || [ -z "$LLM_KEY" ]; then
  echo "STATUS: unavailable"; echo "REASON: LLM_BASE / LLM_KEY missing — run scripts/setup.mjs"; log_usage unavailable; exit 2
fi
CODEX_VERSION=$(codex --version 2>/dev/null | head -1)
BASE_URL="${LLM_BASE%/}/v1"
# Private codex home at runtime (codex writes state + trust entries there); seeded from the plugin template.
export CODEX_HOME="${LANE_CODEX_HOME:-$HOME/.claude/llm-codex-home}"
mkdir -p "$CODEX_HOME"
[ -f "$CODEX_HOME/config.toml" ] || cp "$PLUGIN/codex-home/config.toml" "$CODEX_HOME/config.toml"

# --- working root (Windows-safe) --------------------------------------------
if pwd -W >/dev/null 2>&1; then ROOT=$(pwd -W); else ROOT=$(pwd); fi

# --- build the prompt --------------------------------------------------------
PROMPT=$(mktemp -t codex-spec.XXXXXX)
FINAL=$(mktemp -t codex-final.XXXXXX)
ERRLOG=$(mktemp -t codex-err.XXXXXX)
EVENTS=$(mktemp -t codex-events.XXXXXX)
trap 'rm -f "$PROMPT" "$FINAL" "$ERRLOG" "$EVENTS"' EXIT

case "$MODE" in
  implement)
    if [ -z "$RESUME" ]; then
      {
        cat <<PREAMBLE
This task runs in a dedicated implementation lane on the model and reasoning
effort named in the invocation. Those were chosen deliberately; nothing has been
substituted.

WORKING ROOT: $ROOT
Every path you read or write must be under this root. It may be a git linked
worktree; never follow .git to another checkout and never write to the main
working tree or any other directory.

Rules for this lane:
- Only modify the files listed under FILES. If the task truly needs another
  file, stop and say so in your final message instead of editing it.
- Do not commit.
- Run the verification command and include its actual output in your final
  message.
- List any judgment calls you made that the spec left open.

PREAMBLE
        cat "$SPEC"
      } > "$PROMPT"
    else
      cp "$SPEC" "$PROMPT"
    fi ;;
  analyze)
    TASK_ESC=$(printf '%s' "$TASK" | sed 's/[&|\\]/\\&/g')
    sed "s|{{TASK}}|$TASK_ESC|" "$PLUGIN/templates/analysis-prompt.md" > "$PROMPT"
    printf '\nWORKING ROOT: %s — read-only by contract: you may run read-only commands (tests, git, grep); any file you write will be reverted.\n' "$ROOT" >> "$PROMPT" ;;
  review)
    if [ -n "$BASE" ]; then DIFFCMD="git diff $BASE...HEAD"; else DIFFCMD="git diff HEAD (plus git status --porcelain for untracked files; read them too)"; fi
    cat > "$PROMPT" <<REVIEW
You are a strict senior engineer doing a cross-vendor code review. You have READ-ONLY access.
First run: $DIFFCMD
Then report, in under 300 words:
1. Correctness bugs (with file:line and a one-line fix).
2. Scope: files changed that the stated goal does not need.
3. Missing tests or verification gaps.
4. Risks the author did not name (compatibility, security, performance).
End with one line: VERDICT: ship | fix-first | rethink.
REVIEW
    if [ -n "$SPEC" ] && [ -f "$SPEC" ]; then printf '\nSTATED GOAL / SPEC:\n' >> "$PROMPT"; cat "$SPEC" >> "$PROMPT"; fi
    if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      printf '\n\nDIFF (captured for you; run the command above yourself if you need more context):\n```diff\n' >> "$PROMPT"
      if [ -n "$BASE" ]; then git diff "$BASE...HEAD" --no-color | head -c 200000 >> "$PROMPT"; else { git diff HEAD --no-color; for f in $(git ls-files --others --exclude-standard); do printf '\n+++ untracked: %s\n' "$f"; head -c 20000 "$f"; done; } | head -c 200000 >> "$PROMPT"; fi
      printf '\n```\n' >> "$PROMPT"
    fi ;;
esac

# --- snapshot tree state ---------------------------------------------------------
have_git=0; linked=0; MAIN_ROOT=""; MAIN_BEFORE=""
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  have_git=1
  snapshot() { { git diff HEAD --no-color; git ls-files --others --exclude-standard -z | xargs -0 -r sha1sum; } 2>/dev/null | sha1sum | cut -d' ' -f1; }
  changed_paths() { { git diff HEAD --name-only; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u; }
  BEFORE=$(snapshot)
  BEFORE_PATHS=$(changed_paths)
  # linked worktree? then also watch the main working tree for stray writes
  COMMON=$(git rev-parse --git-common-dir 2>/dev/null)
  GITDIR=$(git rev-parse --git-dir 2>/dev/null)
  if [ -n "$COMMON" ] && [ "$COMMON" != "$GITDIR" ] && [ "$COMMON" != ".git" ]; then
    linked=1
    MAIN_ROOT=$(cd "$COMMON/.." && pwd)
    MAIN_BEFORE=$( { git -C "$MAIN_ROOT" diff HEAD --name-only; git -C "$MAIN_ROOT" ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
  fi
fi

# --- access flags -------------------------------------------------------------
ACCESS_ARGS=()
case "$ACCESS" in
  workspace)     ACCESS_ARGS=(--sandbox workspace-write) ;;
  workspace-net) ACCESS_ARGS=(--sandbox workspace-write -c 'sandbox_workspace_write.network_access=true') ;;
  yolo)          ACCESS_ARGS=(--dangerously-bypass-approvals-and-sandbox) ;;
esac

# --- run --------------------------------------------------------------------
T=$(command -v gtimeout || command -v timeout || true)
[ -z "$T" ] && echo "WARN: no timeout binary; codex runs uncapped" >&2

COMMON_ARGS=(
  --model "$MODEL"
  -c model_provider=relay
  -c 'model_providers.relay.name="relay"'
  -c "model_providers.relay.base_url=\"$BASE_URL\""
  -c 'model_providers.relay.env_key="LLM_RELAY_KEY"'
  -c 'model_providers.relay.wire_api="responses"'
  "${ACCESS_ARGS[@]}"
  --skip-git-repo-check
  --json
  --output-last-message "$FINAL"
)
[ -n "$EFFORT" ] && COMMON_ARGS+=(-c "model_reasoning_effort=\"$EFFORT\"")

set +e
case "$MODE" in
  implement)
    if [ -z "$RESUME" ]; then
      LLM_RELAY_KEY="$LLM_KEY" ${T:+$T "$TIMEOUT"} codex exec "${COMMON_ARGS[@]}" --cd "$ROOT" - < "$PROMPT" >"$EVENTS" 2>"$ERRLOG"
    else
      LLM_RELAY_KEY="$LLM_KEY" ${T:+$T "$TIMEOUT"} codex exec resume "${COMMON_ARGS[@]}" "$RESUME" - < "$PROMPT" >"$EVENTS" 2>"$ERRLOG"
    fi ;;
  analyze)
    LLM_RELAY_KEY="$LLM_KEY" ${T:+$T "$TIMEOUT"} codex exec "${COMMON_ARGS[@]}" --cd "$ROOT" - < "$PROMPT" >"$EVENTS" 2>"$ERRLOG" ;;
  review)
    LLM_RELAY_KEY="$LLM_KEY" ${T:+$T "$TIMEOUT"} codex exec "${COMMON_ARGS[@]}" --cd "$ROOT" - < "$PROMPT" >"$EVENTS" 2>"$ERRLOG" ;;
esac
RC=$?

# --- parse events -----------------------------------------------------------
SESSION=$(grep -o '"thread_id":"[^"]*"' "$EVENTS" | head -1 | cut -d'"' -f4)
[ -z "$SESSION" ] && [ -n "$RESUME" ] && SESSION="$RESUME"
[ -z "$SESSION" ] && SESSION="unknown"
USAGE_LINE=$(grep '"type":"turn.completed"' "$EVENTS" | tail -1)
TOK_IN=$(printf '%s' "$USAGE_LINE" | grep -o '"input_tokens":[0-9]*' | head -1 | cut -d: -f2)
TOK_CACHED=$(printf '%s' "$USAGE_LINE" | grep -o '"cached_input_tokens":[0-9]*' | head -1 | cut -d: -f2)
TOK_OUT=$(printf '%s' "$USAGE_LINE" | grep -o '"output_tokens":[0-9]*' | head -1 | cut -d: -f2)
EVENT_ERRORS=$(grep '"type":"error"' "$EVENTS" | grep -o '"message":"[^"]*"' | cut -d'"' -f4 | grep -v -i 'skills context budget' | head -5)
# `--output-last-message` is not honoured on `exec resume`/`review`; fall back to the last agent_message event.
if [ ! -s "$FINAL" ]; then
  node -e 'const fs=require("fs");let last="";for(const l of fs.readFileSync(process.argv[1],"utf8").split(/\r?\n/)){try{const e=JSON.parse(l);if(e.type==="item.completed"&&e.item?.type==="agent_message"&&e.item.text)last=e.item.text;}catch{}}process.stdout.write(last);' "$EVENTS" > "$FINAL" 2>/dev/null || true
fi
if [ -n "$OUT" ]; then mkdir -p "$(dirname "$OUT")"; cp "$FINAL" "$OUT"; fi

# --- report -----------------------------------------------------------------
echo "===== CODEX FINAL MESSAGE ($MODE · $MODEL via $BASE_URL, effort: ${EFFORT:-default}, access: $ACCESS, $CODEX_VERSION${RESUME:+, resumed}) ====="
if [ -s "$FINAL" ]; then cat "$FINAL"; else echo "(no final message written)"; fi
echo
echo "===== END ====="
echo "SESSION: $SESSION"
echo "TOKENS: in=${TOK_IN:-0} cached=${TOK_CACHED:-0} out=${TOK_OUT:-0}"

if [ "$RC" -eq 124 ] || [ "$RC" -eq 137 ]; then
  echo "STATUS: timeout"; echo "REASON: wall clock of ${TIMEOUT}s exceeded"
  log_usage timeout "$TOK_IN" "$TOK_CACHED" "$TOK_OUT" "$SESSION"; exit 4
fi

NOISE='^(mcp[: ]|mcp startup|[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z +(ERROR|WARN|INFO) )'
ERRTXT=$( { grep -v -E "$NOISE" "$ERRLOG"; printf '%s\n' "$EVENT_ERRORS"; } | grep -i -E 'error|not supported|requires a newer|login|auth|unexpected status|connection|overloaded' | tail -20)
if [ "$RC" -eq 0 ] && printf '%s' "$ERRTXT" | grep -q -i -E 'not supported when using|requires a newer version|not logged in|unauthori[sz]ed|unexpected status|invalid.*api key'; then RC=99; fi
if [ "$RC" -ne 0 ]; then
  if printf '%s' "$ERRTXT" | grep -q -i -E 'not supported|requires a newer version|not logged in|unauthori[sz]ed|auth|login|unexpected status|connection|overloaded|model.*(unavailable|not found)'; then
    echo "STATUS: unavailable"
  else
    echo "STATUS: failed"
  fi
  echo "REASON: codex exit $RC"
  [ -n "$ERRTXT" ] && printf '%s\n' "$ERRTXT"
  log_usage unavailable "$TOK_IN" "$TOK_CACHED" "$TOK_OUT" "$SESSION"; exit 2
fi

if [ "$READONLY_MODE" -eq 1 ]; then
  if [ "$have_git" -eq 1 ]; then
    AFTER=$(snapshot)
    if [ "$BEFORE" != "$AFTER" ]; then
      STRAYP=$(comm -13 <(printf '%s\n' "$BEFORE_PATHS") <(changed_paths) | sed '/^$/d')
      echo "STRAY WRITES IN READ-ONLY MODE (reverted): $(printf '%s' "$STRAYP" | tr '\n' ' ')"
      # shellcheck disable=SC2086
      [ -n "$STRAYP" ] && { git checkout -q -- $STRAYP 2>/dev/null; git clean -fq -- $STRAYP 2>/dev/null; }
    fi
  fi
  if [ ! -s "$FINAL" ]; then echo "STATUS: refused"; echo "REASON: model returned no message"; log_usage refused "$TOK_IN" "$TOK_CACHED" "$TOK_OUT" "$SESSION"; exit 3; fi
  echo "STATUS: ran"; log_usage ran "$TOK_IN" "$TOK_CACHED" "$TOK_OUT" "$SESSION"; exit 0
fi

EXIT=0
if [ "$have_git" -eq 1 ]; then
  # stray writes into the main working tree from a linked worktree: move them back here
  if [ "$linked" -eq 1 ]; then
    MAIN_AFTER=$( { git -C "$MAIN_ROOT" diff HEAD --name-only; git -C "$MAIN_ROOT" ls-files --others --exclude-standard; } 2>/dev/null | sort -u)
    STRAY=$(comm -13 <(printf '%s\n' "$MAIN_BEFORE") <(printf '%s\n' "$MAIN_AFTER") | sed '/^$/d')
    if [ -n "$STRAY" ]; then
      echo "WROTE OUTSIDE WORKTREE: $(printf '%s' "$STRAY" | tr '\n' ' ')"
      # shellcheck disable=SC2086
      if git -C "$MAIN_ROOT" stash push -u -q -- $STRAY 2>/dev/null && git stash pop -q 2>/dev/null; then
        echo "(moved those changes from the main tree into this worktree)"
      else
        echo "(could not move them automatically; inspect $MAIN_ROOT)"
      fi
    fi
  fi
  AFTER=$(snapshot)
  if [ "$BEFORE" = "$AFTER" ]; then
    echo "STATUS: refused"
    echo "REASON: codex exited 0 but the working tree did not change (see final message above)"
    log_usage refused "$TOK_IN" "$TOK_CACHED" "$TOK_OUT" "$SESSION"; exit 3
  fi
  NEW_PATHS=$(comm -13 <(printf '%s\n' "$BEFORE_PATHS") <(changed_paths))
  echo "----- changed by this run -----"
  printf '%s\n' "$NEW_PATHS"
  if [ -n "$FILES" ]; then
    ALLOWED=$(printf '%s' "$FILES" | tr ',' '\n' | sed 's#^\./##;s#\\#/#g' | sed '/^$/d' | sort -u)
    VIOL=$(comm -23 <(printf '%s\n' "$NEW_PATHS" | sed 's#^\./##' | sort -u) <(printf '%s\n' "$ALLOWED") | sed '/^$/d')
    if [ -n "$VIOL" ]; then
      echo "SCOPE VIOLATION: $(printf '%s' "$VIOL" | tr '\n' ' ')"
      EXIT=5
    fi
  fi
fi

echo "STATUS: ran"
log_usage ran "$TOK_IN" "$TOK_CACHED" "$TOK_OUT" "$SESSION"
exit $EXIT
