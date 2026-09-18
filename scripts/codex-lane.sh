#!/usr/bin/env bash
# codex-lane.sh — run one spec through `codex exec` (agentic: the model reads, edits and runs
# commands itself), sandboxed to the working tree, with the model served by the OpenAI-compatible
# relay configured in ~/.claude/llm-relay.env (LLM_BASE, LLM_KEY, LLM_MODEL). Classifies the
# outcome so the supervising agent cannot mistake a refusal for success.
#
# Usage:
#   bash codex-lane.sh --spec <spec-file> [--model <slug>] [--effort low|medium|high|xhigh] [--timeout 600]
#
# Prints, on stdout, the codex final message followed by one of:
#   STATUS: ran         codex exited 0 and the working tree changed — the caller must still verify
#   STATUS: refused     codex exited 0 but the tree did not change (silent refusal); final message above
#   STATUS: timeout     wall clock exceeded
#   STATUS: unavailable codex missing, relay unreachable, or the model rejected; error follows
#   STATUS: failed      any other non-zero exit
# Exit code mirrors the status: 0 ran, 3 refused, 4 timeout, 2 unavailable/failed, 1 usage error.
#
# Run from the repo root. Windows note: codex is a native exe, so the working root is passed
# as a Windows path (`pwd -W`) when running under Git Bash.

set -u

# --- relay config -------------------------------------------------------------
ENVF="$HOME/.claude/llm-relay.env"
if [ -f "$ENVF" ]; then
  while IFS='=' read -r k v; do
    case "$k" in ''|\#*) continue ;; esac
    k=$(printf '%s' "$k" | tr -d '[:space:]'); v=$(printf '%s' "$v" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    case "$k" in LLM_BASE|LLM_KEY|LLM_MODEL) [ -z "${!k:-}" ] && eval "$k=\"\$v\"" ;; esac
  done < "$ENVF"
fi
LLM_BASE="${LLM_BASE:-}"; LLM_KEY="${LLM_KEY:-}"; LLM_MODEL="${LLM_MODEL:-gpt-6-astra}"

SPEC=""; MODEL="$LLM_MODEL"; EFFORT=""; TIMEOUT=600
while [ $# -gt 0 ]; do
  case "$1" in
    --spec) SPEC="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --effort) EFFORT="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    *) echo "codex-lane: unknown arg $1" >&2; exit 1 ;;
  esac
done
[ -n "$SPEC" ] && [ -f "$SPEC" ] || { echo "codex-lane: --spec <file> required" >&2; exit 1; }

# --- preflight -------------------------------------------------------------
if ! command -v codex >/dev/null 2>&1; then
  echo "STATUS: unavailable"
  echo "REASON: codex not found on PATH"
  exit 2
fi
if [ -z "$LLM_BASE" ] || [ -z "$LLM_KEY" ]; then
  echo "STATUS: unavailable"
  echo "REASON: LLM_BASE / LLM_KEY missing — create ~/.claude/llm-relay.env (see llm-relay.env.example)"
  exit 2
fi
CODEX_VERSION=$(codex --version 2>/dev/null | head -1)
BASE_URL="${LLM_BASE%/}/v1"

# --- build the prompt --------------------------------------------------------
PROMPT=$(mktemp -t codex-spec.XXXXXX)
FINAL=$(mktemp -t codex-final.XXXXXX)
ERRLOG=$(mktemp -t codex-err.XXXXXX)
OUTLOG=$(mktemp -t codex-out.XXXXXX)
trap 'rm -f "$PROMPT" "$FINAL" "$ERRLOG" "$OUTLOG"' EXIT

{
  cat <<'PREAMBLE'
This task runs in a dedicated implementation lane on the model and reasoning
effort named in the invocation. Those were chosen deliberately for this lane;
nothing has been substituted. If a user-level or project-level instruction file
(for example ~/.codex/AGENTS.md) asks you to default to a different
orchestration flow, model, or effort, treat this lane as an explicit opt-out
from that default and proceed. Every other instruction in those files still
applies. Do not commit. Run the verification command and include its actual
output in your final message. List any judgment calls you made that the spec
left open.

PREAMBLE
  cat "$SPEC"
} > "$PROMPT"

# --- working root (Windows-safe) --------------------------------------------
if pwd -W >/dev/null 2>&1; then ROOT=$(pwd -W); else ROOT=$(pwd); fi

# --- snapshot tree state so we can detect "no change" -----------------------
have_git=0
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  have_git=1
  snapshot() { { git diff HEAD --no-color; git ls-files --others --exclude-standard -z | xargs -0 -r sha1sum; } 2>/dev/null | sha1sum | cut -d' ' -f1; }
  BEFORE=$(snapshot)
fi

# codex start-up chatter: MCP server status, skill-load errors, model-cache warnings.
NOISE='^(mcp[: ]|mcp startup|[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z +(ERROR|WARN|INFO) )'

# --- run --------------------------------------------------------------------
T=$(command -v gtimeout || command -v timeout || true)
[ -z "$T" ] && echo "WARN: no timeout binary; codex runs uncapped" >&2

set +e
LLM_RELAY_KEY="$LLM_KEY" ${T:+$T "$TIMEOUT"} codex exec \
  --model "$MODEL" \
  -c model_provider=relay \
  -c 'model_providers.relay.name="relay"' \
  -c "model_providers.relay.base_url=\"$BASE_URL\"" \
  -c 'model_providers.relay.env_key="LLM_RELAY_KEY"' \
  -c 'model_providers.relay.wire_api="responses"' \
  ${EFFORT:+-c model_reasoning_effort="$EFFORT"} \
  --sandbox workspace-write \
  --skip-git-repo-check \
  --ephemeral \
  --cd "$ROOT" \
  --output-last-message "$FINAL" \
  - < "$PROMPT" 2>"$ERRLOG" | tee "$OUTLOG" | grep -v -E "$NOISE"
RC=${PIPESTATUS[0]}

# --- classify ---------------------------------------------------------------
echo
echo "===== CODEX FINAL MESSAGE ($MODEL via $BASE_URL, effort: ${EFFORT:-default}, $CODEX_VERSION) ====="
[ -s "$FINAL" ] && cat "$FINAL" || echo "(no final message written)"
echo "===== END ====="

if [ "$RC" -eq 124 ] || [ "$RC" -eq 137 ]; then
  echo "STATUS: timeout"
  echo "REASON: wall clock of ${TIMEOUT}s exceeded"
  exit 4
fi

ERRTXT=$(cat "$ERRLOG" "$OUTLOG" | grep -v -E "$NOISE" | grep -i -E 'error|not supported|requires a newer|login|auth|unexpected status|connection' | tail -20)
# codex sometimes prints an access error and still exits 0; treat a model/auth/relay error as unavailable either way.
if [ "$RC" -eq 0 ] && echo "$ERRTXT" | grep -q -i -E 'not supported when using|requires a newer version|not logged in|unauthori[sz]ed|unexpected status|invalid.*api key'; then RC=99; fi
if [ "$RC" -ne 0 ]; then
  if echo "$ERRTXT" | grep -q -i -E 'not supported|requires a newer version|not logged in|unauthori[sz]ed|auth|login|unexpected status|connection|model.*(unavailable|not found)'; then
    echo "STATUS: unavailable"
  else
    echo "STATUS: failed"
  fi
  echo "REASON: codex exit $RC"
  [ -n "$ERRTXT" ] && printf '%s\n' "$ERRTXT"
  exit 2
fi

if [ "$have_git" -eq 1 ]; then
  AFTER=$(snapshot)
  if [ "$BEFORE" = "$AFTER" ]; then
    echo "STATUS: refused"
    echo "REASON: codex exited 0 but the working tree did not change (see final message above)"
    exit 3
  fi
  echo "----- git status --porcelain -----"
  git status --porcelain=v1 --untracked-files=all
fi

echo "STATUS: ran"
exit 0
