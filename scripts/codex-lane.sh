#!/usr/bin/env bash
# codex-lane.sh — run the relay model through `codex exec` in one of three modes:
#   implement (default)  agentic: the model reads, edits and runs commands in the working tree
#   --analyze <task>     read-only by contract: produces a BRIEF + six-part SPEC DRAFT (templates/analysis-prompt.md)
#   --review [--base B]  read-only by contract: cross-vendor review of uncommitted changes (or of BASE...HEAD)
#   (read-only modes run at the user's access level — codex's read-only sandbox cannot run commands on
#    Windows — and writes outside .lane-scratch/ are reverted and reported as STRAY WRITES.)
# The model is served by the OpenAI-compatible relay in ~/.claude/llm-relay.env (LLM_BASE, LLM_KEY,
# LLM_MODEL, LLM_CODEX_ACCESS, LLM_CODEX_HOME). By default codex runs with a private
# CODEX_HOME; shared or an explicit path loads the user's selected codex home.
#
# Usage:
#   bash codex-lane.sh --spec <spec-file> [--files a.ts,b.ts] [--effort low|medium|high|xhigh]
#                      [--access workspace|workspace-net|yolo] [--model <slug>] [--timeout 600] [--resume <thread-id>]
#                      [--status-file <path>]
#   bash codex-lane.sh --analyze "<one-line task>" [--effort medium] [--out brief.md]
#   bash codex-lane.sh --analyze --task-file <task.md> [--out .lane-scratch/brief.md]
#   bash codex-lane.sh --review [--base main] [--spec goal.md] [--effort medium] [--out review.md]
#
# Prints the model's final message, then:
#   SESSION: <thread-id | unknown>        pass back with --resume to continue the same session
#   TOKENS: in=<n> cached=<n> out=<n>
#   SCOPE VIOLATION: <paths>              (implement mode, --files given, other files changed)
#   WROTE OUTSIDE WORKTREE: <paths>       (implement mode inside a linked worktree; the main tree changed — moved back)
#   STATUS: ran | refused | timeout | unavailable | failed
# Exit codes: 0 ran · 5 ran with scope violation · 3 refused/home not found · 4 timeout · 2 unavailable/failed · 1 usage error.
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
    case "$k" in LLM_BASE|LLM_KEY|LLM_MODEL|LLM_CODEX_ACCESS|LLM_CODEX_HOME|LLM_LANE_MAX_INPUT_TOKENS) [ -z "${!k:-}" ] && eval "$k=\"\$v\"" ;; esac
  done < "$ENVF"
fi
LLM_BASE="${LLM_BASE:-${EVAL_LLM_BASE:-}}"; LLM_KEY="${LLM_KEY:-${EVAL_LLM_KEY:-}}"; LLM_CODEX_ACCESS="${LLM_CODEX_ACCESS:-${EVAL_LLM_CODEX_ACCESS:-workspace}}"
LLM_LANE_MAX_INPUT_TOKENS="${LLM_LANE_MAX_INPUT_TOKENS:-3000000}"

# Read the user's config before switching to the lane's selected CODEX_HOME.
codex_config_model() {
  local config="${CODEX_HOME:-$HOME/.codex}/config.toml"
  [ -r "$config" ] || return 0
  awk '
    /^[[:space:]]*\[/ { exit }
    /^[[:space:]]*model[[:space:]]*=[[:space:]]*"[^"]*"[[:space:]]*(#.*)?$/ {
      sub(/^[[:space:]]*model[[:space:]]*=[[:space:]]*"/, "")
      sub(/"[[:space:]]*(#.*)?$/, "")
      print; exit
    }
  ' "$config"
}

HOME_LABEL="${LANE_CODEX_HOME:-${LLM_CODEX_HOME:-private}}"
resolve_codex_home() {
  HOME_LABEL="${LANE_CODEX_HOME:-${LLM_CODEX_HOME:-private}}"
  local selected
  case "$HOME_LABEL" in
    private)
      export CODEX_HOME="$HOME/.claude/llm-codex-home"
      mkdir -p "$CODEX_HOME"
      [ -f "$CODEX_HOME/config.toml" ] || cp "$PLUGIN/codex-home/config.toml" "$CODEX_HOME/config.toml"
      return ;;
    shared) selected="${CODEX_HOME:-$HOME/.codex}" ;;
    *) selected="$HOME_LABEL" ;;
  esac
  # Expand a literal ~/ from the env file without evaluating shell expressions.
  case "$selected" in '~') selected="$HOME" ;; '~/'*) selected="$HOME/${selected:2}" ;; esac
  if [ ! -d "$selected" ]; then
    echo "codex home not found: $selected" >&2
    return 3
  fi
  export CODEX_HOME="$selected"
}

MODE=implement; SPEC=""; TASK=""; TASK_FILE=""; BASE=""; OUT=""; STATUS_FILE=""
MODEL="${LLM_MODEL:-$(codex_config_model)}"; EFFORT=""; TIMEOUT=600; ACCESS="$LLM_CODEX_ACCESS"; FILES=""; RESUME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --spec) SPEC="$2"; shift 2 ;;
    --analyze) MODE=analyze; shift; if [ $# -gt 0 ] && [[ "$1" != --* ]]; then TASK="$1"; shift; fi ;;
    --task|--task-file)
      [ $# -ge 2 ] && [[ "$2" != --* ]] || { echo "codex-lane: $1 requires a value" >&2; exit 1; }
      MODE=analyze
      if [ "$1" = --task-file ]; then TASK_FILE="$2"; else TASK="$2"; fi
      shift 2 ;;
    --review) MODE=review; shift ;;
    --base) BASE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --effort) EFFORT="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --access) ACCESS="$2"; shift 2 ;;
    --files) FILES="$2"; shift 2 ;;
    --resume) RESUME="$2"; shift 2 ;;
    --status-file) STATUS_FILE="$2"; shift 2 ;;
    *) echo "codex-lane: unknown arg $1" >&2; exit 1 ;;
  esac
done
if [ "$MODE" = implement ]; then [ -n "$SPEC" ] && [ -f "$SPEC" ] || { echo "codex-lane: --spec <file> required" >&2; exit 1; }; fi
if [ "$MODE" = analyze ]; then
  if [ -n "$TASK_FILE" ]; then
    [ -f "$TASK_FILE" ] && [ -r "$TASK_FILE" ] && [ -s "$TASK_FILE" ] || { echo "codex-lane: --task-file must be a readable nonempty file" >&2; exit 1; }
  else
    [ -n "$TASK" ] || { echo "codex-lane: --analyze \"<task>\" or --task-file <path> required" >&2; exit 1; }
  fi
fi
case "$ACCESS" in workspace|workspace-net|yolo) ;; *) echo "codex-lane: --access must be workspace|workspace-net|yolo (got '$ACCESS')" >&2; exit 1 ;; esac
if ! [[ "$LLM_LANE_MAX_INPUT_TOKENS" =~ ^[1-9][0-9]*$ ]]; then echo "codex-lane: LLM_LANE_MAX_INPUT_TOKENS must be a positive integer" >&2; exit 1; fi
# analyze/review are read-only by contract, not by sandbox: codex's read-only sandbox blocks every shell
# command on Windows, so writes outside .lane-scratch/ are reverted afterwards.
READONLY_MODE=0; [ "$MODE" != implement ] && READONLY_MODE=1

STATUS_EVENTS_FILE=""
STATUS_NATIVE_FILE="$STATUS_FILE"
STATUS_SLUG=""
STATUS_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ -n "$STATUS_FILE" ]; then
  if command -v cygpath >/dev/null 2>&1; then
    STATUS_NATIVE_FILE=$(cygpath -m "$STATUS_FILE")
    STATUS_FILE=$(cygpath -u "$STATUS_FILE")
  fi
  STATUS_SLUG=$(basename "$STATUS_FILE")
  STATUS_SLUG=${STATUS_SLUG%.status.json}
  if [ "$STATUS_SLUG" = "$(basename "$STATUS_FILE")" ]; then
    STATUS_EVENTS_FILE="${STATUS_FILE}.events.jsonl"
  else
    STATUS_EVENTS_FILE="$(dirname "$STATUS_FILE")/${STATUS_SLUG}.events.jsonl"
  fi
fi

status_write() {
  [ -n "$STATUS_FILE" ] || return 0
  node -e '
const fs=require("fs"),path=require("path");
const [file,phase,exitValue,slug,mode,spec,started,session,tin,tcached,tout,message,model,effort,home,access]=process.argv.slice(1);
try {
  let current={}; try { current=JSON.parse(fs.readFileSync(file,"utf8"))||{}; } catch {}
  if(!phase && String(current.phase||"").startsWith("done ")) current={};
  const now=new Date();
  const startedAt=current.started_at||started||now.toISOString();
  const elapsed=Math.max(0,(now.getTime()-Date.parse(startedAt))/1000);
  const driverFinishes=current.report_file&&phase.startsWith("done ");
  current={...current,model,effort,home,access};
  current={...current,slug:slug||current.slug||"",mode:mode||current.mode||"",spec:current.spec||spec||"",phase:driverFinishes?current.phase:(phase||current.phase||"running"),started_at:startedAt,updated_at:now.toISOString(),elapsed_s:Math.round(elapsed*10)/10,tokens:{in:Number(tin||current.tokens?.in||0),cached:Number(tcached||current.tokens?.cached||0),out:Number(tout||current.tokens?.out||0)},session:session||current.session||"unknown",last_message:(message||current.last_message||"").slice(0,200),exit:driverFinishes||exitValue===""?(current.exit??null):Number(exitValue)};
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=`${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp,JSON.stringify(current)+"\n","utf8");
  try { fs.renameSync(tmp,file); } catch (error) { try { fs.rmSync(tmp,{force:true}); } catch {} throw error; }
} catch (error) { process.stderr.write(`lane status write failed: ${error.message}\n`); }
' "$STATUS_NATIVE_FILE" "$1" "${2:-}" "$STATUS_SLUG" "$MODE" "$SPEC" "$STATUS_STARTED_AT" "${SESSION:-unknown}" "${TOK_IN:-0}" "${TOK_CACHED:-0}" "${TOK_OUT:-0}" "${3:-}" "${MODEL:-codex-default}" "${EFFORT:-default}" "$HOME_LABEL" "$ACCESS" >/dev/null || true
}

if [ -n "$STATUS_FILE" ]; then
  status_write "" ""
fi

log_usage() { # status tokens_in tokens_cached tokens_out session
  local T1; T1=$(date +%s%3N 2>/dev/null || date +%s000)
  node "$HERE/usage-log.mjs" \
    --lane "codex-$MODE" --model "${MODEL:-codex-default}" --effort "${EFFORT:-default}" --access "$ACCESS" --home "$HOME_LABEL" \
    --status "$1" --in "${2:-0}" --cached "${3:-0}" --out "${4:-0}" \
    --duration "$((T1 - T0))" --project "$(pwd -W 2>/dev/null || pwd)" --session "${5:-}" >/dev/null 2>&1 || true
}

# --- preflight -------------------------------------------------------------
if [ "${EVAL_CODEX_DISABLED:-}" = "1" ]; then
  echo "STATUS: unavailable"; echo "REASON: codex disabled by EVAL_CODEX_DISABLED=1"; status_write "done unavailable" 2; log_usage unavailable; exit 2
fi
if ! command -v codex >/dev/null 2>&1; then
  echo "STATUS: unavailable"; echo "REASON: codex not found on PATH"; status_write "done unavailable" 2; log_usage unavailable; exit 2
fi
if [ -z "$LLM_BASE" ] || [ -z "$LLM_KEY" ]; then
  echo "STATUS: unavailable"; echo "REASON: LLM_BASE / LLM_KEY missing — run scripts/setup.mjs"; status_write "done unavailable" 2; log_usage unavailable; exit 2
fi
CODEX_VERSION=$(codex --version 2>/dev/null | head -1)
BASE_URL="${LLM_BASE%/}/v1"
# Only private mode creates and seeds a home. Other modes use existing homes as-is.
resolve_codex_home || { echo "STATUS: unavailable"; status_write "done unavailable" 3; log_usage unavailable; exit 3; }

# --- working root (Windows-safe) --------------------------------------------
if pwd -W >/dev/null 2>&1; then ROOT=$(pwd -W); else ROOT=$(pwd); fi

# --- build the prompt --------------------------------------------------------
PROMPT=$(mktemp -t codex-spec.XXXXXX)
FINAL=$(mktemp -t codex-final.XXXXXX)
ERRLOG=$(mktemp -t codex-err.XXXXXX)
EVENTS=$(mktemp -t codex-events.XXXXXX)
HASH_BEFORE=$(mktemp -t codex-hashes.XXXXXX)
trap 'rm -f "$PROMPT" "$FINAL" "$ERRLOG" "$EVENTS" "$EVENTS.summary" "$HASH_BEFORE"' EXIT

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
- Before the first edit, call update_plan with 3-8 concrete steps; update it as each step completes.
  The plan is displayed to the user live.

PREAMBLE
        cat "$SPEC"
      } > "$PROMPT"
    else
      cp "$SPEC" "$PROMPT"
    fi ;;
  analyze)
    TASK_TEXT="$TASK" node -e '
const fs=require("fs");
const [template,file]=process.argv.slice(1);
const task=file?fs.readFileSync(file,"utf8"):process.env.TASK_TEXT;
process.stdout.write(fs.readFileSync(template,"utf8").replace("{{TASK}}",()=>task));
' "$PLUGIN/templates/analysis-prompt.md" "$TASK_FILE" > "$PROMPT" || exit 1
    printf '\nWORKING ROOT: %s — read-only by contract: you may run read-only commands (tests, git, grep); only .lane-scratch/ may be written. Other writes will be reverted.\n' "$ROOT" >> "$PROMPT" ;;
  review)
    if [ -n "$BASE" ]; then DIFFCMD="git diff $BASE...HEAD"; else DIFFCMD="git diff HEAD (plus git status --porcelain for untracked files; read them too)"; fi
    cat > "$PROMPT" <<REVIEW
You are a strict senior engineer doing a cross-vendor code review. You have READ-ONLY access except for output artifacts under .lane-scratch/.
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
  EXCLUDE=$(git rev-parse --git-path info/exclude)
  mkdir -p "$(dirname "$EXCLUDE")"
  grep -qxF '/.lane-scratch/' "$EXCLUDE" 2>/dev/null || printf '\n/.lane-scratch/\n' >> "$EXCLUDE"
  snapshot() { { git diff HEAD --no-color; git ls-files --others --exclude-standard -z | xargs -0 -r sha1sum; } 2>/dev/null | sha1sum | cut -d' ' -f1; }
  changed_paths() { { git diff HEAD --name-only; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u; }
  BEFORE=$(snapshot)
  BEFORE_PATHS=$(changed_paths)
  node -e 'import(require("node:url").pathToFileURL(process.argv[2]).href).then(({snapshotFiles})=>require("node:fs").writeFileSync(process.argv[3],JSON.stringify(snapshotFiles(process.cwd()))));' snapshot "$HERE/lane-run.mjs" "$HASH_BEFORE"
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
COMMON_ARGS=(
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
[ -n "$MODEL" ] && COMMON_ARGS+=(--model "$MODEL")
[ -n "$EFFORT" ] && COMMON_ARGS+=(-c "model_reasoning_effort=\"$EFFORT\"")

set +e
export LLM_RELAY_KEY="$LLM_KEY"

capture_codex() {
  node -e '
const fs=require("fs"),path=require("path"),{spawn,spawnSync}=require("child_process");
const [statusFile,eventsFile,publicEventsFile,errorFile,limitText,resume,timeoutText,model,effort,home,access,...command]=process.argv.slice(1);
const limit=Number(limitText);
let status={}; if(statusFile) { try { status=JSON.parse(fs.readFileSync(statusFile,"utf8"))||{}; } catch {} }
status={...status,model,effort,home,access};
let session=resume||"unknown",budgetReason="",carry="",timedOut=false;
const completed={in:0,cached:0,out:0},counted={in:0,cached:0,out:0};
let tokens={in:0,cached:0,out:0};
const usageTokens=(usage)=>({in:Number(usage.input_tokens||0),cached:Number(usage.cached_input_tokens||usage.cache_read_input_tokens||0),out:Number(usage.output_tokens||0)});
const clip=(value)=>String(value||"").replace(/\s+/g," ").trim().slice(0,200);
const atomic=()=>{ if(!statusFile) return; try { fs.mkdirSync(path.dirname(statusFile),{recursive:true}); const tmp=`${statusFile}.${process.pid}.tmp`; fs.writeFileSync(tmp,JSON.stringify(status)+"\n","utf8"); try { fs.renameSync(tmp,statusFile); } catch (error) { try { fs.rmSync(tmp,{force:true}); } catch {} throw error; } } catch (error) { process.stderr.write(`lane status write failed: ${error.message}\n`); } };
let publicEvents=null;
if(publicEventsFile) { try { fs.mkdirSync(path.dirname(publicEventsFile),{recursive:true}); publicEvents=fs.openSync(publicEventsFile,"a"); } catch(error) { process.stderr.write(`lane events write failed: ${error.message}\n`); } }
const events=fs.openSync(eventsFile,"a"),errors=fs.openSync(errorFile,"w");
const child=spawn("bash",["-c",process.platform==="win32"?"\"$@\"; exit $?":"exec \"$@\"","lane-codex",...command],{detached:process.platform!=="win32",windowsHide:true,stdio:["inherit","pipe",errors]});
fs.closeSync(errors);
const stop=()=>{
  if(process.platform==="win32") {
    const listing=spawnSync("bash",["-c","ps -W"],{windowsHide:true,encoding:"utf8"});
    const rows=(listing.stdout||"").trim().split(/\r?\n/).map(line=>line.trim().replace(/^I\s+/,"").split(/\s+/));
    const group=Number(rows.find(row=>Number(row[3])===child.pid)?.[2]);
    const ownGroup=Number(rows.find(row=>Number(row[3])===process.pid)?.[2]);
    if(group>0&&group!==ownGroup) {
      const killed=spawnSync("bash",["-c",`kill -KILL -- -${group}`],{windowsHide:true,encoding:"utf8"});
      if(killed.status===0) return;
    }
    const killed=spawnSync("taskkill.exe",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,encoding:"utf8"});
    if(killed.status!==0) process.stderr.write(`codex stop failed: ${killed.error?.message||killed.stderr}\n`);
  }
  else { try { process.kill(-child.pid,"SIGKILL"); } catch {} }
};
const timer=Number(timeoutText)>0?setTimeout(()=>{timedOut=true;stop();},Number(timeoutText)*1000):null;
const update=(line)=>{
  let event; try { event=JSON.parse(line); } catch { return; }
  event=event.payload?.type==="token_count"?event.payload:event.msg?.type==="token_count"?event.msg:event;
  const now=new Date(); status.updated_at=now.toISOString(); status.elapsed_s=Math.round(Math.max(0,(now.getTime()-Date.parse(status.started_at||now.toISOString()))/1000)*10)/10;
  if(event.thread_id) session=event.thread_id;
  if(event.type==="turn.completed"&&event.usage) {
    const usage=usageTokens(event.usage); for(const key of Object.keys(completed)) completed[key]+=usage[key];
  } else if(event.type==="token_count") {
    const total=event.info?.total_token_usage;
    const usage=usageTokens(total||event.info?.last_token_usage||event.usage||event.info?.usage||{});
    for(const key of Object.keys(counted)) counted[key]=total?Math.max(counted[key],usage[key]):counted[key]+usage[key];
  }
  tokens=Object.fromEntries(Object.keys(completed).map(key=>[key,Math.max(completed[key],counted[key])]));
  status.session=session; status.tokens=tokens;
  const item=event.item||{}; const text=item.text||event.text; const command=item.command||item.cmd||event.command;
  if((item.type==="agent_message"||item.type==="reasoning")&&text) status.last_message=clip(text); else if(command) status.last_message=clip(command);
  if(!budgetReason&&tokens.in>limit) { budgetReason=`token budget exceeded (${tokens.in} > ${limit})`; status.last_message=budgetReason; stop(); }
  atomic();
};
child.stdout.setEncoding("utf8");
child.stdout.on("data",chunk=>{ fs.writeSync(events,chunk); if(publicEvents!==null) fs.writeSync(publicEvents,chunk); carry+=chunk; const lines=carry.split(/\r?\n/); carry=lines.pop(); for(const line of lines) if(line) update(line); });
child.on("error",error=>process.stderr.write(`codex launch failed: ${error.message}\n`));
child.on("close",(code,signal)=>{
  clearTimeout(timer);
  if(carry) update(carry);
  fs.closeSync(events); if(publicEvents!==null) fs.closeSync(publicEvents);
  fs.writeFileSync(eventsFile+".summary",JSON.stringify({session,tokens,budgetReason}));
  process.exitCode=budgetReason?4:timedOut?124:(code??(signal?137:2));
});
' "$STATUS_NATIVE_FILE" "$EVENTS" "$STATUS_EVENTS_FILE" "$ERRLOG" "$LLM_LANE_MAX_INPUT_TOKENS" "$RESUME" "$TIMEOUT" "${MODEL:-codex-default}" "${EFFORT:-default}" "$HOME_LABEL" "$ACCESS" "$@"
}

case "$MODE" in
  implement)
    if [ -z "$RESUME" ]; then
      capture_codex codex exec "${COMMON_ARGS[@]}" --cd "$ROOT" - < "$PROMPT"
    else
      capture_codex codex exec resume "${COMMON_ARGS[@]}" "$RESUME" - < "$PROMPT"
    fi ;;
  analyze)
    capture_codex codex exec "${COMMON_ARGS[@]}" --cd "$ROOT" - < "$PROMPT" ;;
  review)
    capture_codex codex exec "${COMMON_ARGS[@]}" --cd "$ROOT" - < "$PROMPT" ;;
esac
RC=$?

# --- parse events -----------------------------------------------------------
read -r SESSION TOK_IN TOK_CACHED TOK_OUT BUDGET_REASON < <(node -e '
const fs=require("fs"); let summary={}; try { summary=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); } catch {}
console.log([summary.session||process.argv[2]||"unknown",summary.tokens?.in||0,summary.tokens?.cached||0,summary.tokens?.out||0,summary.budgetReason||""].join(" "));
' "$EVENTS.summary" "$RESUME")
EVENT_ERRORS=$(grep '"type":"error"' "$EVENTS" | grep -o '"message":"[^"]*"' | cut -d'"' -f4 | grep -v -i 'skills context budget' | head -5)
# `--output-last-message` is not honoured on `exec resume`/`review`; fall back to the last agent_message event.
if [ ! -s "$FINAL" ]; then
  node -e 'const fs=require("fs");let last="";for(const l of fs.readFileSync(process.argv[1],"utf8").split(/\r?\n/)){try{const e=JSON.parse(l);if(e.type==="item.completed"&&e.item?.type==="agent_message"&&e.item.text)last=e.item.text;}catch{}}process.stdout.write(last);' "$EVENTS" > "$FINAL" 2>/dev/null || true
fi
if [ -n "$OUT" ]; then mkdir -p "$(dirname "$OUT")"; cp "$FINAL" "$OUT"; fi

# --- report -----------------------------------------------------------------
echo "===== CODEX FINAL MESSAGE ($MODE · $MODEL via $BASE_URL, effort: ${EFFORT:-default}, access: $ACCESS, home: $HOME_LABEL, $CODEX_VERSION${RESUME:+, resumed}) ====="
if [ -s "$FINAL" ]; then cat "$FINAL"; else echo "(no final message written)"; fi
echo
echo "===== END ====="
echo "SESSION: $SESSION"
echo "TOKENS: in=${TOK_IN:-0} cached=${TOK_CACHED:-0} out=${TOK_OUT:-0}"

if [ -n "$BUDGET_REASON" ]; then
  echo "STATUS: timeout"; echo "REASON: $BUDGET_REASON"; status_write "done timeout" 4 "$BUDGET_REASON"
  log_usage timeout "$TOK_IN" "$TOK_CACHED" "$TOK_OUT" "$SESSION"; exit 4
fi

if [ "$RC" -eq 124 ] || [ "$RC" -eq 137 ]; then
  echo "STATUS: timeout"; echo "REASON: wall clock of ${TIMEOUT}s exceeded"; status_write "done timeout" "$RC"
  log_usage timeout "$TOK_IN" "$TOK_CACHED" "$TOK_OUT" "$SESSION"; exit 4
fi

NOISE='^(mcp[: ]|mcp startup|[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z +(ERROR|WARN|INFO) )'
ERRTXT=$( { grep -v -E "$NOISE" "$ERRLOG"; printf '%s\n' "$EVENT_ERRORS"; } | grep -i -E 'error|not supported|requires a newer|login|auth|unexpected status|connection|overloaded' | tail -20)
if [ "$RC" -eq 0 ] && printf '%s' "$ERRTXT" | grep -q -i -E 'not supported when using|requires a newer version|not logged in|unauthori[sz]ed|unexpected status|invalid.*api key'; then RC=99; fi
if [ "$RC" -ne 0 ]; then
  if printf '%s' "$ERRTXT" | grep -q -i -E 'not supported|requires a newer version|not logged in|unauthori[sz]ed|auth|login|unexpected status|connection|overloaded|model.*(unavailable|not found)'; then
    FAILURE_STATUS=unavailable
  else
    FAILURE_STATUS=failed
  fi
  echo "STATUS: $FAILURE_STATUS"
  echo "REASON: codex exit $RC"
  [ -n "$ERRTXT" ] && printf '%s\n' "$ERRTXT"
  status_write "done $FAILURE_STATUS" "$RC"
  log_usage unavailable "$TOK_IN" "$TOK_CACHED" "$TOK_OUT" "$SESSION"; exit 2
fi

if [ "$READONLY_MODE" -eq 1 ]; then
  if [ "$have_git" -eq 1 ]; then
    AFTER=$(snapshot)
    if [ "$BEFORE" != "$AFTER" ]; then
      STRAYP=$(comm -13 <(printf '%s\n' "$BEFORE_PATHS") <(changed_paths) | sed '/^$/d; /^\.lane-scratch\//d')
      if [ -n "$STRAYP" ]; then
        echo "STRAY WRITES IN READ-ONLY MODE (reverted): $(printf '%s' "$STRAYP" | tr '\n' ' ')"
        while IFS= read -r stray_path; do
          git checkout -q -- "$stray_path" 2>/dev/null
          git clean -fq -- "$stray_path" 2>/dev/null
        done <<< "$STRAYP"
      fi
    fi
  fi
  if [ ! -s "$FINAL" ]; then echo "STATUS: refused"; echo "REASON: model returned no message"; status_write "done refused" 3; log_usage refused "$TOK_IN" "$TOK_CACHED" "$TOK_OUT" "$SESSION"; exit 3; fi
  echo "STATUS: ran"; status_write "done ran" 0; log_usage ran "$TOK_IN" "$TOK_CACHED" "$TOK_OUT" "$SESSION"; exit 0
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
  NEW_PATHS=$(node -e 'import(require("node:url").pathToFileURL(process.argv[2]).href).then(({snapshotFiles,changedFiles})=>{const before=JSON.parse(require("node:fs").readFileSync(process.argv[3],"utf8"));process.stdout.write(changedFiles(before,snapshotFiles(process.cwd())).join("\n"));});' snapshot "$HERE/lane-run.mjs" "$HASH_BEFORE")
  if [ -z "$NEW_PATHS" ]; then
    echo "STATUS: refused"
    echo "REASON: codex exited 0 but the working tree did not change (see final message above)"
    status_write "done refused" 3
    log_usage refused "$TOK_IN" "$TOK_CACHED" "$TOK_OUT" "$SESSION"; exit 3
  fi
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
status_write "done ran" "$EXIT"
log_usage ran "$TOK_IN" "$TOK_CACHED" "$TOK_OUT" "$SESSION"
exit $EXIT
