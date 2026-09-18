#!/usr/bin/env bash
# codex-lane.sh — run one spec through `codex exec` (agentic: the model reads, edits and runs
# commands itself), with the model served by the OpenAI-compatible relay configured in
# ~/.claude/llm-relay.env (LLM_BASE, LLM_KEY, LLM_MODEL, LLM_CODEX_ACCESS). Classifies the
# outcome so the supervising agent cannot mistake a refusal for success, fences the files the
# model may touch, records usage to ~/.claude/llm-usage.jsonl, and supports resuming a session.
#
# Usage:
#   bash codex-lane.sh --spec <spec-file> [--files a.ts,b.ts] [--effort low|medium|high|xhigh]
#                      [--access workspace|workspace-net|yolo] [--model <slug>] [--timeout 600]
#                      [--resume <thread-id>]
#
# Prints the codex final message, then:
#   SESSION: <thread-id | unknown>        pass back with --resume to continue the same session
#   TOKENS: in=<n> cached=<n> out=<n>
#   SCOPE VIOLATION: <paths>              (only when --files was given and other files changed)
#   STATUS: ran | refused | timeout | unavailable | failed
# Exit codes: 0 ran · 5 ran with scope violation · 3 refused · 4 timeout · 2 unavailable/failed · 1 usage error.
#
# Access levels (LLM_CODEX_ACCESS or --access):
#   workspace      --sandbox workspace-write                      writes only inside the working tree, no network (default)
#   workspace-net  workspace-write + network_access=true          can npm install / fetch
#   yolo           --dangerously-bypass-approvals-and-sandbox     no sandbox, no approvals; the model can do anything you can
#
# Run from the repo root (or the lane's worktree). Windows: codex is a native exe, so the working
# root is passed as a Windows path (`pwd -W`) under Git Bash.

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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

SPEC=""; MODEL="$LLM_MODEL"; EFFORT=""; TIMEOUT=600; ACCESS="$LLM_CODEX_ACCESS"; FILES=""; RESUME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --spec) SPEC="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --effort) EFFORT="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --access) ACCESS="$2"; shift 2 ;;
    --files) FILES="$2"; shift 2 ;;
    --resume) RESUME="$2"; shift 2 ;;
    *) echo "codex-lane: unknown arg $1" >&2; exit 1 ;;
  esac
done
[ -n "$SPEC" ] && [ -f "$SPEC" ] || { echo "codex-lane: --spec <file> required" >&2; exit 1; }
case "$ACCESS" in workspace|workspace-net|yolo) ;; *) echo "codex-lane: --access must be workspace|workspace-net|yolo (got '$ACCESS')" >&2; exit 1 ;; esac

log_usage() { # status tokens_in tokens_cached tokens_out session
  local T1; T1=$(date +%s%3N 2>/dev/null || date +%s000)
  node "$HERE/usage-log.mjs" \
    --lane codex --model "$MODEL" --effort "${EFFORT:-default}" --access "$ACCESS" \
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

# --- build the prompt --------------------------------------------------------
PROMPT=$(mktemp -t codex-spec.XXXXXX)
FINAL=$(mktemp -t codex-final.XXXXXX)
ERRLOG=$(mktemp -t codex-err.XXXXXX)
EVENTS=$(mktemp -t codex-events.XXXXXX)
trap 'rm -f "$PROMPT" "$FINAL" "$ERRLOG" "$EVENTS"' EXIT

if [ -z "$RESUME" ]; then
  {
    cat <<'PREAMBLE'
This task runs in a dedicated implementation lane on the model and reasoning
effort named in the invocation. Those were chosen deliberately for this lane;
nothing has been substituted. If a user-level or project-level instruction file
(for example ~/.codex/AGENTS.md) asks you to default to a different
orchestration flow, model, or effort, treat this lane as an explicit opt-out
from that default and proceed. Every other instruction in those files still
applies.

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
fi

# --- working root (Windows-safe) --------------------------------------------
if pwd -W >/dev/null 2>&1; then ROOT=$(pwd -W); else ROOT=$(pwd); fi

# --- snapshot tree state so we can detect "no change" -----------------------
have_git=0
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  have_git=1
  snapshot() { { git diff HEAD --no-color; git ls-files --others --exclude-standard -z | xargs -0 -r sha1sum; } 2>/dev/null | sha1sum | cut -d' ' -f1; }
  changed_paths() { { git diff HEAD --name-only; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u; }
  BEFORE=$(snapshot)
  BEFORE_PATHS=$(changed_paths)
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

COMMON=(
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
[ -n "$EFFORT" ] && COMMON+=(-c "model_reasoning_effort=\"$EFFORT\"")

set +e
if [ -z "$RESUME" ]; then
  LLM_RELAY_KEY="$LLM_KEY" ${T:+$T "$TIMEOUT"} codex exec "${COMMON[@]}" --cd "$ROOT" - < "$PROMPT" >"$EVENTS" 2>"$ERRLOG"
else
  LLM_RELAY_KEY="$LLM_KEY" ${T:+$T "$TIMEOUT"} codex exec resume "${COMMON[@]}" "$RESUME" - < "$PROMPT" >"$EVENTS" 2>"$ERRLOG"
fi
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
# `--output-last-message` is not honoured on `exec resume`; fall back to the last agent_message event.
if [ ! -s "$FINAL" ]; then
  node -e 'const fs=require("fs");let last="";for(const l of fs.readFileSync(process.argv[1],"utf8").split(/\r?\n/)){try{const e=JSON.parse(l);if(e.type==="item.completed"&&e.item?.type==="agent_message"&&e.item.text)last=e.item.text;}catch{}}process.stdout.write(last);' "$EVENTS" > "$FINAL" 2>/dev/null || true
fi

# --- report -----------------------------------------------------------------
echo "===== CODEX FINAL MESSAGE ($MODEL via $BASE_URL, effort: ${EFFORT:-default}, access: $ACCESS, $CODEX_VERSION${RESUME:+, resumed}) ====="
[ -s "$FINAL" ] && cat "$FINAL" || echo "(no final message written)"
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

EXIT=0
if [ "$have_git" -eq 1 ]; then
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
