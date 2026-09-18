#!/usr/bin/env node
// lane-run.mjs — deterministic lane driver. No LLM is involved in supervising a lane:
//   spec-lint → codex-lane.sh → run every VERIFICATION command → (on failure) resume the codex
//   session with the failing output, up to --max-resumes times → LANE REPORT.
// The architect calls this directly from Bash; the codex-implementer agent is just a thin wrapper.
//
//   node lane-run.mjs --spec <spec.md> [--max-resumes 2] [--timeout 900] [--json]
//   node lane-run.mjs --batch a.md b.md c.md          # run several specs concurrently, one report each
//   node lane-run.mjs --analyze "<task>" [--cwd <repo>] [--effort medium] [--out brief.md]
//
// Reads FILES, REASONING, WORKTREE, MODEL from the spec. Runs verification commands in the worktree
// with bash. Flags a lockfile change larger than --lockfile-max-lines (default 40) as partial.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { lintSpec } from "./spec-lint.mjs";
import { appendUsage } from "./usage-log.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LANE_SH = process.env.LANE_RUN_LANE_SH || path.join(HERE, "codex-lane.sh");
const LOCKFILES = ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock", "poetry.lock", "uv.lock", "go.sum"];

const args = process.argv.slice(2);
const opt = { spec: null, batch: [], analyze: null, cwd: null, effort: null, out: null, maxResumes: 2, timeout: 900, json: false, lockMax: 40 };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--spec") opt.spec = args[++i];
  else if (a === "--batch") { while (args[i + 1] && !args[i + 1].startsWith("--")) opt.batch.push(args[++i]); }
  else if (a === "--analyze") opt.analyze = args[++i];
  else if (a === "--cwd") opt.cwd = args[++i];
  else if (a === "--effort") opt.effort = args[++i];
  else if (a === "--out") opt.out = args[++i];
  else if (a === "--max-resumes") opt.maxResumes = Number(args[++i]) || 0;
  else if (a === "--timeout") opt.timeout = Number(args[++i]) || 900;
  else if (a === "--lockfile-max-lines") opt.lockMax = Number(args[++i]) || 40;
  else if (a === "--json") opt.json = true;
  else if (a === "-h" || a === "--help") { console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 13).map((l) => l.replace(/^\/\/ ?/, "")).join("\n")); process.exit(0); }
}

const winPath = (p) => (process.platform === "win32" ? p.replace(/\\/g, "/") : p);
const run = (cmd, cwd, timeoutSec) => {
  const r = spawnSync("bash", ["-lc", cmd], { cwd, encoding: "utf8", timeout: timeoutSec * 1000, maxBuffer: 64 * 1024 * 1024, env: process.env });
  const out = (r.stdout || "") + (r.stderr || "");
  return { status: r.status ?? (r.signal ? 124 : 1), out };
};
const tail = (s, n) => s.trim().split(/\r?\n/).slice(-n).join("\n");
const laneField = (out, key) => (out.match(new RegExp(`^${key}: ?(.*)$`, "m")) || [])[1]?.trim() || "";

// ---------------------------------------------------------------- analyze mode
if (opt.analyze) {
  const cwd = opt.cwd || process.cwd();
  const cmd = `bash "${winPath(LANE_SH)}" --analyze ${JSON.stringify(opt.analyze)}${opt.effort ? ` --effort ${opt.effort}` : ""} --timeout ${opt.timeout}${opt.out ? ` --out "${winPath(opt.out)}"` : ""}`;
  const r = run(cmd, cwd, opt.timeout + 60);
  process.stdout.write(r.out.endsWith("\n") ? r.out : r.out + "\n");
  process.exit(r.status);
}

// ---------------------------------------------------------------- implement mode
function parseVerification(section) {
  return section.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .map((l) => { const [cmd, expect] = l.split(/\s+(?:→|->)\s+/); return { cmd: cmd.replace(/^[-*]\s*/, "").replace(/^`|`$/g, "").trim(), expect: (expect || "").trim() }; })
    .filter((v) => v.cmd && !/^(none|n\/a)$/i.test(v.cmd));
}

async function runSpec(specPath) {
  const specAbs = path.resolve(specPath);
  const text = fs.readFileSync(specAbs, "utf8");
  const report = { spec: specAbs, status: "unavailable", changes: [], verified: [], modelSaid: "", rounds: [], judgment: "", gaps: [], reason: "", session: "unknown", lane: "" };
  const lint = lintSpec(text, process.cwd());
  const s = lint.sections;
  const worktree = (s.WORKTREE || "").trim() || process.cwd();
  const effort = (s.REASONING || "").trim().split(/\s+/)[0]?.toLowerCase() || "";
  const model = (s.MODEL || "").trim();
  const files = lint.files.map((f) => f.split(/\s+/)[0].replace(/[`'"]/g, ""));
  const fileArg = files.join(",");
  report.lane = `codex-implementer (relay model, effort: ${effort || "default"})`;

  if (!lint.ok) { report.status = "refused"; report.reason = "spec incomplete — " + lint.problems.join("; "); return report; }
  if (!fs.existsSync(worktree)) { report.status = "refused"; report.reason = `WORKTREE does not exist: ${worktree}`; return report; }
  if (effort && !["low", "medium", "high", "xhigh"].includes(effort)) { report.status = "unavailable"; report.reason = `effort ${effort} not supported`; return report; }

  const verifs = parseVerification(s.VERIFICATION || "");
  const baseCmd = `bash "${winPath(LANE_SH)}" --files "${fileArg}"${effort ? ` --effort ${effort}` : ""}${model ? ` --model ${model}` : ""} --timeout ${opt.timeout}`;

  let promptFile = specAbs;
  let resume = "";
  for (let round = 0; round <= opt.maxResumes; round++) {
    const cmd = `${baseCmd} --spec "${winPath(promptFile)}"${resume ? ` --resume ${resume}` : ""}`;
    const r = run(cmd, worktree, opt.timeout + 120);
    const st = laneField(r.out, "STATUS");
    const tokens = laneField(r.out, "TOKENS");
    report.session = laneField(r.out, "SESSION") || report.session;
    report.rounds.push(`${round === 0 ? "fresh" : "resume"} ${tokens} → ${st}${r.status === 5 ? " (scope violation)" : ""}`);
    const finalMsg = (r.out.split("===== END =====")[0] || "").split("=====").pop()?.trim() || "";
    report.modelSaid = finalMsg.split(/\r?\n/).filter(Boolean).slice(0, 2).join(" ").slice(0, 400);
    if (st !== "ran") {
      report.status = st === "refused" ? "refused" : st === "timeout" ? "timeout" : "unavailable";
      report.reason = laneField(r.out, "REASON") || tail(r.out, 6);
      if (st === "refused" && finalMsg) report.reason += " — " + finalMsg.slice(0, 300);
      return report;
    }
    const changedBlock = (r.out.split("----- changed by this run -----")[1] || "").split(/\n(?=[A-Z ]+:)/)[0];
    report.changes = changedBlock.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^(SCOPE VIOLATION|WROTE OUTSIDE|STATUS|SESSION|TOKENS)/.test(l));
    const viol = laneField(r.out, "SCOPE VIOLATION");
    if (viol) report.gaps.push(`scope violation: ${viol}`);
    const stray = laneField(r.out, "WROTE OUTSIDE WORKTREE");
    if (stray) report.gaps.push(`model wrote outside the worktree (moved back): ${stray}`);

    // independent verification
    report.verified = [];
    let allPass = true;
    for (const v of verifs) {
      const vr = run(v.cmd, worktree, 900);
      const pass = vr.status === 0;
      allPass = allPass && pass;
      report.verified.push({ cmd: v.cmd, expect: v.expect, exit: vr.status, tail: tail(vr.out, 20) });
    }
    if (allPass) break;
    if (round === opt.maxResumes || report.session === "unknown") break;
    const failing = report.verified.filter((v) => v.exit !== 0).map((v) => `$ ${v.cmd}\n(exit ${v.exit})\n${v.tail}`).join("\n\n");
    promptFile = path.join(path.dirname(specAbs), `${path.basename(specAbs, ".md")}.resume${round + 1}.md`);
    fs.writeFileSync(promptFile, `The verification did not pass. Fix it so every command below exits 0. Stay within FILES; do not touch other files; do not commit.\n\n${failing}\n`, "utf8");
    resume = report.session;
  }

  // lockfile discipline
  for (const lf of LOCKFILES) {
    if (report.changes.includes(lf)) {
      const d = run(`git diff --numstat -- ${lf}`, worktree, 60).out.trim().split(/\s+/);
      const lines = (Number(d[0]) || 0) + (Number(d[1]) || 0);
      if (lines > opt.lockMax) report.gaps.push(`${lf} changed by ${lines} lines (> ${opt.lockMax}); regenerate with the pinned package-manager version or revert`);
    }
  }
  const allPass = report.verified.length > 0 && report.verified.every((v) => v.exit === 0);
  report.status = allPass && report.gaps.length === 0 ? "complete" : "partial";
  if (!verifs.length) { report.status = "partial"; report.gaps.push("no runnable VERIFICATION command in spec"); }
  return report;
}

function format(r) {
  const L = [];
  L.push("LANE REPORT");
  L.push(`LANE: ${r.lane} · driver: lane-run.mjs (no LLM supervisor)`);
  L.push(`STATUS: ${r.status}`);
  L.push(`SPEC: ${r.spec}`);
  L.push(`CHANGES: ${r.changes.length ? "" : "none"}`);
  for (const c of r.changes) L.push(`  - ${c}`);
  L.push("VERIFIED:");
  if (!r.verified.length) L.push("  (not run)");
  for (const v of r.verified) { L.push(`  $ ${v.cmd} → exit ${v.exit}${v.expect ? ` (expected: ${v.expect})` : ""}`); for (const t of v.tail.split("\n").slice(-8)) L.push(`    ${t}`); }
  L.push(`MODEL SAID: ${r.modelSaid || "-"}`);
  L.push(`ROUNDS: ${r.rounds.length} — ${r.rounds.join(" | ") || "-"}`);
  L.push(`SESSION: ${r.session}`);
  L.push(`GAPS: ${r.gaps.length ? r.gaps.join("; ") : "none"}`);
  if (r.reason) L.push(`REASON: ${r.reason}`);
  return L.join("\n");
}

const specs = opt.batch.length ? opt.batch : opt.spec ? [opt.spec] : [];
if (!specs.length) { console.error("lane-run: --spec <file> | --batch <files...> | --analyze <task>"); process.exit(1); }

if (specs.length === 1) {
  const r = await runSpec(specs[0]);
  appendUsage({ lane: "claude", model: "none", effort: null, status: "driver", in: 0, out: 0, duration: 0, project: process.cwd() });
  console.log(opt.json ? JSON.stringify(r, null, 2) : format(r));
  process.exit(r.status === "complete" ? 0 : r.status === "partial" ? 5 : 2);
} else {
  // batch: each spec in its own child process so they run concurrently; reports come back in order
  const children = specs.map((sp) => new Promise((res) => {
    const c = spawn(process.execPath, [fileURLToPath(import.meta.url), "--spec", sp, "--max-resumes", String(opt.maxResumes), "--timeout", String(opt.timeout), "--json"], { encoding: "utf8", env: process.env });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", () => {});
    c.on("close", (code) => { try { res({ code, r: JSON.parse(out) }); } catch { res({ code, r: { spec: sp, status: "unavailable", reason: tail(out, 5), changes: [], verified: [], rounds: [], gaps: [], lane: "?", session: "unknown", modelSaid: "" } }); } });
  }));
  const results = await Promise.all(children);
  if (opt.json) console.log(JSON.stringify(results.map((x) => x.r), null, 2));
  else console.log(results.map((x) => format(x.r)).join("\n\n"));
  process.exit(results.every((x) => x.code === 0) ? 0 : 5);
}
