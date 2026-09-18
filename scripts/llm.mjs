#!/usr/bin/env node
// Call any OpenAI-compatible chat endpoint as a tool (streaming, long-reasoning safe).
// Config: ~/.claude/llm-relay.env  (LLM_BASE, LLM_KEY, LLM_MODEL, LLM_REASONING)
// Usage:
//   node llm.mjs "prompt"
//   node llm.mjs --spec prompt.md                       # prompt from a file (no shell quoting)
//   echo "prompt" | node llm.mjs                        # prompt from stdin
//   node llm.mjs -f a.ts -f b.ts "review these"         # attach files as context
//   options: --model <id>  --system "<text>"  --max <tokens>  --effort <low|medium|high|xhigh>
//            --json  --out <file>  (persist the reply; the enforcement hook looks for *.llm-output.*)
//            --pad <tokens>  pad short prompts up to ~N input tokens (some relays reject tiny requests;
//                            default from LLM_MIN_INPUT_TOKENS in the env file, 0 = off)
// Exit codes: 0 ok · 1 request failed after retries · 2 config/usage error · 3 reply truncated (finish=length)
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
  );
}
const home = os.homedir();
const raw = {
  ...readEnvFile(path.join(home, ".claude", "astra.env")), // legacy name
  ...readEnvFile(path.join(home, ".claude", "llm-relay.env")), // canonical name
  ...process.env,
};
const env = {
  BASE: raw.LLM_BASE || raw.ASTRA_BASE,
  KEY: raw.LLM_KEY || raw.ASTRA_KEY,
  MODEL: raw.LLM_MODEL || raw.ASTRA_MODEL || "gpt-6-astra",
  REASONING: raw.LLM_REASONING || raw.ASTRA_REASONING || "xhigh",
  MIN_INPUT: Number(raw.LLM_MIN_INPUT_TOKENS || 0) || 0,
};
if (!env.BASE || !env.KEY) {
  console.error("llm: missing LLM_BASE / LLM_KEY. Create ~/.claude/llm-relay.env (see llm-relay.env.example in the plugin).");
  process.exit(2);
}

const args = process.argv.slice(2);
let model = env.MODEL;
let system = null;
let maxTokens = 16000;
let json = false;
let effort = env.REASONING;
let outPath = null;
let specPath = null;
let pad = env.MIN_INPUT;
const files = [];
const rest = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--model") model = args[++i];
  else if (a === "--system") system = args[++i];
  else if (a === "--max") maxTokens = Number(args[++i]);
  else if (a === "--effort") effort = args[++i];
  else if (a === "--json") json = true;
  else if (a === "--out") outPath = args[++i];
  else if (a === "--spec") specPath = args[++i];
  else if (a === "--pad") pad = Number(args[++i]) || 0;
  else if (a === "-f" || a === "--file") files.push(args[++i]);
  else rest.push(a);
}
let prompt = rest.join(" ").trim();
if (specPath) {
  if (!fs.existsSync(specPath)) {
    console.error(`llm: --spec file not found: ${specPath}`);
    process.exit(2);
  }
  const spec = fs.readFileSync(specPath, "utf8").trim();
  prompt = prompt ? `${spec}\n\n${prompt}` : spec;
}
if (!prompt && !process.stdin.isTTY) prompt = fs.readFileSync(0, "utf8").trim();
if (!prompt) {
  console.error("llm: no prompt given");
  process.exit(2);
}

const attachments = files
  .map((f) => {
    if (!fs.existsSync(f)) {
      console.error(`llm: attachment not found: ${f}`);
      process.exit(2);
    }
    return `\n\n<file path="${f}">\n${fs.readFileSync(f, "utf8")}\n</file>`;
  })
  .join("");
let userContent = prompt + attachments;
if (pad > 0) {
  // Some relays reject requests below a minimum input size. Pad with an inert block the
  // model is told to ignore. ~4 chars per token; over-provision because relays judge by bytes.
  const targetChars = pad * 6;
  if (userContent.length < targetChars) {
    const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ";
    userContent += "\n\n<padding note=\"inert filler to satisfy the relay's minimum request size; ignore entirely\">\n" + filler.repeat(Math.ceil((targetChars - userContent.length) / filler.length)) + "\n</padding>";
  }
}
const messages = [];
if (system) messages.push({ role: "system", content: system });
messages.push({ role: "user", content: userContent });

const body = {
  model,
  messages,
  max_completion_tokens: maxTokens,
  reasoning_effort: effort,
  stream: true,
  stream_options: { include_usage: true },
};
if (json) body.response_format = { type: "json_object" };

const url = `${env.BASE.replace(/\/$/, "")}/v1/chat/completions`;
const RETRIES = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Streaming keeps the connection alive during long reasoning: Node's undici
// aborts a request whose response headers take more than 5 minutes to arrive.
async function request() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3_600_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 2000);
      const retryable = res.status === 429 || res.status >= 500;
      return { error: `HTTP ${res.status}\n${text}`, retryable };
    }
    return { res, timer };
  } catch (e) {
    clearTimeout(timer);
    return { error: `request failed: ${e?.cause?.message || e.message}`, retryable: true };
  }
}

// Read one SSE stream. Returns { out, usage, finish } or { error } when the relay
// reports a failure inside a 200 stream (e.g. "servers overloaded") or sends no content.
async function consume(res, timer) {
  let out = "";
  let usage = null;
  let finish = null;
  let buf = "";
  let streamError = null;
  const dec = new TextDecoder();
  try {
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        let ev;
        try {
          ev = JSON.parse(payload);
        } catch {
          continue;
        }
        if (ev?.error) {
          streamError = ev.error.message || JSON.stringify(ev.error);
          continue;
        }
        const choice = ev?.choices?.[0];
        const delta = choice?.delta?.content;
        if (delta) {
          out += delta;
          process.stdout.write(delta);
        }
        if (choice?.finish_reason) finish = choice.finish_reason;
        if (ev?.usage) usage = ev.usage;
      }
    }
  } catch (e) {
    clearTimeout(timer);
    return { error: `stream aborted: ${e?.cause?.message || e.message}`, partial: out };
  }
  clearTimeout(timer);
  if (streamError) return { error: `relay error in stream: ${streamError}`, partial: out };
  if (!out && !finish) return { error: "relay returned an empty stream (no content, no finish_reason)", partial: out };
  return { out, usage, finish };
}

let out = "";
let usage = null;
let finish = null;
for (let attempt = 0; attempt <= RETRIES; attempt++) {
  const r = await request();
  let err = null;
  let retryable = true;
  if (r.res) {
    const c = await consume(r.res, r.timer);
    if (c.error) {
      err = c.error;
      // Anything already streamed to stdout would be duplicated by a retry; only retry when nothing was emitted.
      retryable = !c.partial;
    } else {
      out = c.out;
      usage = c.usage;
      finish = c.finish;
      break;
    }
  } else {
    err = r.error;
    retryable = r.retryable;
  }
  const last = attempt === RETRIES || !retryable;
  console.error(`llm: ${err}${last ? "" : ` — retrying (${attempt + 1}/${RETRIES})`}`);
  if (last) {
    console.error("STATUS: unavailable");
    process.exit(1);
  }
  await sleep(2000 * 2 ** attempt);
}

if (!out.endsWith("\n")) process.stdout.write("\n");
if (outPath) {
  // Persist the reply; the optional enforcement hook treats a fresh
  // *.llm-output.* file as evidence that code came from the external model.
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, out, "utf8");
}
if (usage) {
  console.error(
    `[llm ${model} effort=${effort}] prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} finish=${finish}`,
  );
}
if (finish === "length") {
  console.error(`llm: reply truncated at ${maxTokens} tokens (finish=length). Re-run with a larger --max.`);
  process.exit(3);
}
