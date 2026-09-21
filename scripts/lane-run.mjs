#!/usr/bin/env node
// lane-run.mjs — deterministic lane driver. No LLM is involved in supervising a lane:
//   spec-lint → codex-lane.sh → run every VERIFICATION command → (on failure) resume the codex
//   session with the failing output, up to --max-resumes times → LANE REPORT.
// Thin subagents start detached lanes and relay wait output; the driver owns all supervision.
//
//   node lane-run.mjs --spec <spec.md> [--max-resumes 2] [--timeout 900] [--json]
//   node lane-run.mjs --batch a.md b.md c.md [--concurrency 2] [--status-dir <dir>]
//   node lane-run.mjs --analyze "<task>" [--cwd <repo>] [--effort medium] [--out brief.md]
//   node lane-run.mjs --detach --spec <spec.md> [--status-dir <dir>]
//   node lane-run.mjs --wait <slug...> [--timeout 540] [--status-dir <dir>]
//
// Reads FILES, REASONING, WORKTREE, MODEL from the spec. Runs verification commands in the worktree
// with bash. Flags a lockfile change larger than --lockfile-max-lines (default 40) as partial.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { lintSpec } from "./spec-lint.mjs";
import { appendUsage } from "./usage-log.mjs";
import { startDashboard } from "./lane-dashboard.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LANE_SH = process.env.LANE_RUN_LANE_SH || path.join(HERE, "codex-lane.sh");
const LOCKFILES = ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock", "poetry.lock", "uv.lock", "go.sum"];

export function buildDetachedLauncher({ args, logFile, executable = process.execPath, platform = process.platform }) {
  if (platform !== "win32") return { command: executable, args, options: { detached: true, windowsHide: true } };
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const argument = (value) => `"${String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
  const command = `$ErrorActionPreference = 'Stop'; Start-Process -WindowStyle Hidden -FilePath ${quote(executable)} -ArgumentList ${quote(args.map(argument).join(" "))} -RedirectStandardOutput ${quote(logFile)} -RedirectStandardError ${quote(logFile + ".err")}`;
  return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", command], options: { detached: false, windowsHide: true } };
}

export function snapshotFiles(directory) {
  const listing = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: directory, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (listing.status !== 0) return null;
  return Object.fromEntries([...new Set(listing.stdout.split("\0").filter(Boolean))].map((relative) => {
    const file = path.join(directory, relative);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() && !stat.isSymbolicLink()) return [relative, null];
      const bytes = stat.isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file);
      return [relative, createHash("sha256").update(`${stat.mode}:`).update(bytes).digest("hex")];
    } catch (error) { if (error.code === "ENOENT") return [relative, null]; throw error; }
  }));
}

export function changedFiles(before, after) {
  return [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])].filter((file) => (before?.[file] ?? null) !== (after?.[file] ?? null)).sort();
}

async function main() {
const args = process.argv.slice(2);
let dashboard = null;
const envConcurrency = Number(process.env.LLM_LANE_CONCURRENCY);
const opt = { spec: null, batch: [], analyze: null, cwd: null, effort: null, out: null, maxResumes: 2, timeout: 900, json: false, lockMax: 40, statusDir: null, concurrency: Number.isInteger(envConcurrency) && envConcurrency > 0 ? envConcurrency : 2, noWatch: false, detach: false, wait: [] };
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
  else if (a === "--status-dir") opt.statusDir = args[++i];
  else if (a === "--concurrency") opt.concurrency = Number(args[++i]);
  else if (a === "--no-watch") opt.noWatch = true;
  else if (a === "--detach") opt.detach = true;
  else if (a === "--wait") { while (args[i + 1] && !args[i + 1].startsWith("--")) opt.wait.push(args[++i]); }
  else if (a === "--json") opt.json = true;
  else if (a === "-h" || a === "--help") { console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 13).map((l) => l.replace(/^\/\/ ?/, "")).join("\n")); process.exit(0); }
}

const winPath = (p) => (process.platform === "win32" ? p.replace(/\\/g, "/") : p);
const statusDir = path.resolve(opt.statusDir || process.env.LANE_STATUS_DIR || (process.env.CLAUDE_SCRATCHPAD_DIR ? path.join(process.env.CLAUDE_SCRATCHPAD_DIR, "lanes") : path.join(os.homedir(), ".claude", "lane-status")));
const statusScript = path.resolve(HERE, "lane-status.mjs");
const watchLine = `WATCH: node "${statusScript}" --watch --dir "${statusDir}"`;
if (!Number.isInteger(opt.concurrency) || opt.concurrency < 1) { console.error("lane-run: --concurrency must be a positive integer"); process.exit(1); }
if (opt.analyze && opt.batch.length) { console.error("lane-run: --batch --analyze is not supported; launch at most two analyze lanes at a time"); process.exit(1); }

const slugFor = (specAbs) => path.basename(specAbs).replace(/\.[^.]+$/, "");
const statusFileFor = (specAbs) => path.join(statusDir, `${slugFor(specAbs)}.status.json`);
const statusExit = (status) => status === "complete" ? 0 : status === "partial" ? 5 : 2;
const reportFileFor = (slug) => path.join(statusDir, `${slug}.report.txt`);
const logFileFor = (slug) => process.env.LANE_RUN_LOG_FILE || path.join(statusDir, `${slug}.log`);
const readStatus = (slug) => { try { return JSON.parse(fs.readFileSync(path.join(statusDir, `${slug}.status.json`), "utf8")); } catch { return null; } };
const writeStatus = (file, patch = {}, reset = false) => {
  try {
    let current = {};
    if (!reset) { try { current = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch {} }
    const now = new Date();
    const startedAt = current.started_at || patch.started_at || now.toISOString();
    const elapsed = Math.max(0, (now.getTime() - Date.parse(startedAt)) / 1000);
    const next = { slug: patch.slug || current.slug || "", mode: patch.mode || current.mode || "implement", spec: patch.spec || current.spec || "", phase: patch.phase || current.phase || "lint", started_at: startedAt, updated_at: now.toISOString(), elapsed_s: Math.round(elapsed * 10) / 10, tokens: { in: Number(patch.tokens?.in ?? current.tokens?.in ?? 0), cached: Number(patch.tokens?.cached ?? current.tokens?.cached ?? 0), out: Number(patch.tokens?.out ?? current.tokens?.out ?? 0) }, session: patch.session || current.session || "unknown", last_message: String(patch.last_message ?? current.last_message ?? "").replace(/\s+/g, " ").trim().slice(0, 200), exit: patch.exit ?? current.exit ?? null };
    next.report_file = reportFileFor(next.slug);
    next.log_file = patch.log_file || current.log_file || logFileFor(next.slug);
    next.pid = Object.hasOwn(patch, "pid") ? patch.pid : current.pid ?? process.pid;
    next.model = patch.model ?? current.model ?? process.env.LLM_MODEL ?? "codex-default";
    next.effort = patch.effort ?? current.effort ?? opt.effort ?? "default";
    next.home = patch.home ?? current.home ?? process.env.LANE_CODEX_HOME ?? process.env.LLM_CODEX_HOME ?? "private";
    const access = patch.access ?? current.access;
    if (typeof access === "string" && access && access !== "unknown") next.access = access;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next) + "\n", "utf8");
    try { fs.renameSync(tmp, file); } catch (error) { try { fs.rmSync(tmp, { force: true }); } catch {} throw error; }
  } catch (error) {
    console.error(`lane status write failed: ${error.message}`);
  }
};

const specs = (opt.batch.length ? opt.batch : opt.spec ? [opt.spec] : []).map((spec) => path.resolve(spec));
const slugs = specs.map(slugFor);
const seen = new Set();
for (const slug of slugs) {
  const key = process.platform === "win32" ? slug.toLowerCase() : slug;
  if (seen.has(key)) { console.error(`lane-run: duplicate batch slug: ${slug}`); process.exit(2); }
  seen.add(key);
}
if (args.includes("--wait")) {
  if (!opt.wait.length || opt.detach || opt.analyze || specs.length || opt.wait.some((slug) => !slug || /[/\\]/.test(slug) || slug === "." || slug === "..")) {
    console.error("lane-run: --wait requires lane slugs, without --detach, --spec, --batch or --analyze"); process.exit(2);
  }
  const timeout = args.includes("--timeout") ? Number(args[args.indexOf("--timeout") + 1]) : 540;
  if (!Number.isFinite(timeout) || timeout <= 0) { console.error("lane-run: --timeout must be positive"); process.exit(2); }
  const started = Date.now();
  while (true) {
    const statuses = opt.wait.map((slug) => {
      const status = readStatus(slug);
      if (!status || String(status.phase || "").startsWith("done ")) return status;
      const pid = status.pid;
      let dead = false;
      if (Number.isInteger(pid) && pid > 0 && pid <= 2147483647) {
        try { process.kill(pid, 0); } catch (error) { dead = error.code === "ESRCH"; }
      } else {
        let updated = Date.parse(status.updated_at);
        if (!Number.isFinite(updated)) {
          try { updated = fs.statSync(path.join(statusDir, `${slug}.status.json`)).mtimeMs; } catch { return status; }
        }
        dead = Date.now() - updated > 60000;
      }
      if (!dead) return status;
      failedReport(status.spec || `${slug}.md`, `driver exited without report (pid ${pid})`, slug);
      return readStatus(slug);
    });
    const reports = statuses.map((status, index) => {
      if (!String(status?.phase || "").startsWith("done ") || status.exit == null) return null;
      try { return fs.readFileSync(reportFileFor(opt.wait[index]), "utf8"); } catch { return null; }
    });
    if (reports.every((report) => report !== null)) {
      await new Promise((resolve, reject) => process.stdout.write(reports.join(""), (error) => error ? reject(error) : resolve()));
      process.exit(statuses.some((status) => status.exit !== 0 && status.exit !== 5) ? 2 : statuses.some((status) => status.exit === 5) ? 5 : 0);
    }
    const elapsed = Date.now() - started;
    const missing = opt.wait.filter((slug, index) => !statuses[index]);
    if (elapsed >= 30000 && missing.length) {
      for (const slug of missing) console.log(`MISSING ${slug}`);
      process.exit(4);
    }
    if (elapsed >= timeout * 1000) {
      for (const [index, slug] of opt.wait.entries()) {
        const status = statuses[index] || {};
        const seconds = Math.max(0, Math.floor(String(status.phase || "").startsWith("done ") ? Number(status.elapsed_s || 0) : (Date.now() - (Date.parse(status.started_at) || started)) / 1000));
        const last = String(status.last_message || "").replace(/[\x00-\x1f\x7f"\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
        console.log(`RUNNING ${slug} phase=${status.phase || "pending"} elapsed=${Math.floor(seconds / 60)}m ${seconds % 60}s in=${Number(status.tokens?.in || 0)} cached=${Number(status.tokens?.cached || 0)} out=${Number(status.tokens?.out || 0)} session=${status.session || "unknown"} last="${last}"`);
      }
      process.exit(10);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(3000, timeout * 1000 - elapsed, missing.length && elapsed < 30000 ? 30000 - elapsed : 3000)));
  }
}

const analyzeSlug = opt.analyze ? process.env.LANE_RUN_ANALYZE_SLUG || (opt.out ? slugFor(opt.out) : `analyze-${Date.now()}-${process.pid}`) : null;
if (!opt.detach && process.env.LANE_RUN_LOG_FILE) {
  for (const slug of opt.analyze ? [analyzeSlug] : slugs) writeStatus(path.join(statusDir, `${slug}.status.json`), { pid: process.pid });
}
dashboard = specs.length || opt.analyze ? await startDashboard(statusDir) : null;
if (opt.detach) {
  if (!specs.length && !opt.analyze) { console.error("lane-run: --detach requires --spec, --batch or --analyze"); process.exit(2); }
  const detachedSlugs = opt.analyze ? [analyzeSlug] : slugs;
  const logFile = logFileFor(detachedSlugs[0]);
  fs.mkdirSync(statusDir, { recursive: true });
  for (const [index, slug] of detachedSlugs.entries()) {
    fs.rmSync(reportFileFor(slug), { force: true });
    writeStatus(path.join(statusDir, `${slug}.status.json`), { slug, mode: opt.analyze ? "analyze" : "implement", spec: opt.analyze || specs[index], phase: "queued", log_file: logFile, pid: null }, true);
  }
  const childArgs = opt.analyze ? ["--analyze", opt.analyze] : opt.batch.length ? ["--batch", ...specs] : ["--spec", specs[0]];
  childArgs.push("--status-dir", statusDir, "--no-watch", "--timeout", String(opt.timeout), "--max-resumes", String(opt.maxResumes), "--lockfile-max-lines", String(opt.lockMax), "--concurrency", String(opt.concurrency));
  if (opt.cwd) childArgs.push("--cwd", opt.cwd);
  if (opt.effort) childArgs.push("--effort", opt.effort);
  if (opt.out) childArgs.push("--out", opt.out);
  if (opt.json) childArgs.push("--json");
  const launcher = buildDetachedLauncher({ args: [fileURLToPath(import.meta.url), ...childArgs], logFile });
  const env = { ...process.env, LANE_RUN_ANALYZE_SLUG: analyzeSlug || "", LANE_RUN_LOG_FILE: logFile };
  let child, pid;
  try {
    if (process.platform === "win32") {
      const result = spawnSync(launcher.command, launcher.args, { ...launcher.options, env, stdio: "ignore", timeout: 15000 });
      if (result.error || result.status !== 0) throw new Error(result.error?.message || "hidden driver did not start");
    } else {
      const out = fs.openSync(logFile, "w");
      try { child = spawn(launcher.command, launcher.args, { ...launcher.options, stdio: ["ignore", out, out], env }); }
      finally { fs.closeSync(out); }
      await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      pid = child.pid;
    }
  } catch (error) { console.error(`lane-run: detach failed: ${error.message}`); process.exit(2); }
  for (const slug of detachedSlugs) {
    const file = path.join(statusDir, `${slug}.status.json`);
    if (pid && readStatus(slug)?.phase === "queued") writeStatus(file, { pid });
    if (!opt.json) { console.log(`SLUG: ${slug}`); console.log(`STATUS_FILE: ${file}`); }
  }
  if (opt.json) console.log(JSON.stringify({ slugs: detachedSlugs, status_files: detachedSlugs.map((slug) => path.join(statusDir, `${slug}.status.json`)), watch: watchLine, dashboard }, null, 2));
  else { console.log(watchLine); if (dashboard) console.log(`DASHBOARD: ${dashboard}`); }
  for (const slug of detachedSlugs) {
    const session = readStatus(slug)?.session;
    if (!opt.json && session && session !== "unknown") console.log(`RESUME: codex resume ${session}`);
  }
  child?.unref();
  process.exit(0);
}
if (!opt.noWatch) {
  (opt.json ? console.error : console.log)(watchLine);
  if (dashboard) (opt.json ? console.error : console.log)(`DASHBOARD: ${dashboard}`);
}

const run = (cmd, cwd, timeoutSec) => {
  const r = spawnSync("bash", ["-lc", cmd], { cwd, windowsHide: true, encoding: "utf8", timeout: timeoutSec * 1000, maxBuffer: 64 * 1024 * 1024, env: process.env });
  const out = (r.stdout || "") + (r.stderr || "");
  return { status: r.status ?? (r.signal ? 124 : 1), out };
};
const tail = (s, n) => s.trim().split(/\r?\n/).slice(-n).join("\n");
const laneField = (out, key) => (out.match(new RegExp(`^${key}: ?(.*)$`, "m")) || [])[1]?.trim() || "";

const updateFromOutput = (file, output) => {
  const tokens = laneField(output, "TOKENS");
  const values = Object.fromEntries([...tokens.matchAll(/(in|cached|out)=(\d+)/g)].map((match) => [match[1], Number(match[2])]));
  writeStatus(file, { session: laneField(output, "SESSION"), tokens: values });
};

// ---------------------------------------------------------------- analyze mode
if (opt.analyze) {
  const cwd = opt.cwd || process.cwd();
  const analyzeStatus = path.join(statusDir, `${analyzeSlug}.status.json`);
  fs.rmSync(reportFileFor(analyzeSlug), { force: true });
  writeStatus(analyzeStatus, { slug: analyzeSlug, mode: "analyze", spec: opt.analyze, phase: "running", last_message: opt.analyze }, true);
  const cmd = `bash "${winPath(LANE_SH)}" --analyze ${JSON.stringify(opt.analyze)}${opt.effort ? ` --effort ${opt.effort}` : ""} --timeout ${opt.timeout} --status-file "${winPath(analyzeStatus)}"${opt.out ? ` --out "${winPath(opt.out)}"` : ""}`;
  const r = run(cmd, cwd, opt.timeout + 60);
  updateFromOutput(analyzeStatus, r.out);
  const status = laneField(r.out, "STATUS") || (r.status === 0 ? "ran" : "failed");
  const session = laneField(r.out, "SESSION") || "unknown";
  const report = `LANE REPORT\nLANE: codex-analyst · driver: lane-run.mjs (no LLM supervisor)\nSTATUS: ${status === "ran" ? "complete" : status}\n${r.out.trimEnd()}\n${session !== "unknown" ? `RESUME: codex resume ${session}\n` : ""}`;
  fs.writeFileSync(reportFileFor(analyzeSlug), report, "utf8");
  writeStatus(analyzeStatus, { phase: `done ${status}`, exit: r.status });
  if (opt.json) console.log(JSON.stringify({ status, status_file: analyzeStatus, session: laneField(r.out, "SESSION") || "unknown", dashboard, output: r.out }, null, 2));
  else process.stdout.write(r.out.endsWith("\n") ? r.out : r.out + "\n");
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

  const statusFile = statusFileFor(specAbs);
  const report = { spec: specAbs, status: "unavailable", status_file: statusFile, dashboard, changes: [], verified: [], modelSaid: "", rounds: [], judgment: "", gaps: [], reason: "", session: "unknown", lane: "" };
  fs.rmSync(reportFileFor(slugFor(specAbs)), { force: true });
  writeStatus(statusFile, { slug: slugFor(specAbs), mode: "implement", spec: specAbs, phase: "lint" }, true);
  const finish = () => {
    fs.writeFileSync(reportFileFor(slugFor(specAbs)), format(report) + "\n", "utf8");
    writeStatus(statusFile, { phase: `done ${report.status}`, exit: statusExit(report.status), session: report.session, last_message: report.reason || report.modelSaid });
    return report;
  };
  let text;
  try { text = fs.readFileSync(specAbs, "utf8"); } catch (error) { report.reason = error.message; return finish(); }
  const lint = lintSpec(text, opt.cwd || process.cwd());
  const s = lint.sections;
  const worktree = (s.WORKTREE || "").trim() || opt.cwd || process.cwd();
  const effort = (s.REASONING || "").trim().split(/\s+/)[0]?.toLowerCase() || "";
  const model = (s.MODEL || "").trim();
  const files = lint.files.map((f) => f.split(/\s+/)[0].replace(/[`'"]/g, ""));
  const fileArg = files.join(",");
  report.lane = `codex-implementer (relay model, effort: ${effort || "default"})`;

  if (!lint.ok) { report.status = "refused"; report.reason = "spec incomplete — " + lint.problems.join("; "); return finish(); }
  if (!fs.existsSync(worktree)) { report.status = "refused"; report.reason = `WORKTREE does not exist: ${worktree}`; return finish(); }
  if (effort && !["low", "medium", "high", "xhigh"].includes(effort)) { report.status = "unavailable"; report.reason = `effort ${effort} not supported`; return finish(); }
  writeStatus(statusFile, { effort: effort || "default", ...(model ? { model } : {}) });
  const before = snapshotFiles(worktree);

  const verifs = parseVerification(s.VERIFICATION || "");
  const baseCmd = `bash "${winPath(LANE_SH)}" --files "${fileArg}"${effort ? ` --effort ${effort}` : ""}${model ? ` --model ${model}` : ""} --timeout ${opt.timeout} --status-file "${winPath(statusFile)}"`;

  let promptFile = specAbs;
  let resume = "";
  for (let round = 0; round <= opt.maxResumes; round++) {
    writeStatus(statusFile, { phase: round === 0 ? "running" : `resume ${round}/${opt.maxResumes}`, last_message: round === 0 ? "codex lane" : `resume ${round}/${opt.maxResumes}` });
    const cmd = `${baseCmd} --spec "${winPath(promptFile)}"${resume ? ` --resume ${resume}` : ""}`;
    const r = run(cmd, worktree, opt.timeout + 120);
    if (before) report.changes = changedFiles(before, snapshotFiles(worktree));
    updateFromOutput(statusFile, r.out);
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
      return finish();
    }
    const changedBlock = (r.out.split("----- changed by this run -----")[1] || "").split(/\n(?=[A-Z ]+:)/)[0];
    if (!before) report.changes = [...new Set([...report.changes, ...changedBlock.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^(SCOPE VIOLATION|WROTE OUTSIDE|STATUS|SESSION|TOKENS)/.test(l))])];
    const viol = laneField(r.out, "SCOPE VIOLATION");
    if (viol) report.gaps.push(`scope violation: ${viol}`);
    const stray = laneField(r.out, "WROTE OUTSIDE WORKTREE");
    if (stray) report.gaps.push(`model wrote outside the worktree (moved back): ${stray}`);

    // independent verification
    report.verified = [];
    let allPass = true;
    writeStatus(statusFile, { phase: "verifying" });
    for (const v of verifs) {
      writeStatus(statusFile, { phase: "verifying", last_message: v.cmd });
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
  return finish();
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
  if (r.session && r.session !== "unknown") L.push(`RESUME: codex resume ${r.session}`);
  L.push(`GAPS: ${r.gaps.length ? r.gaps.join("; ") : "none"}`);
  if (r.reason) L.push(`REASON: ${r.reason}`);
  return L.join("\n");
}

function failedReport(spec, reason, slug = slugFor(spec)) {
  const report = { spec: path.resolve(spec), status: "unavailable", status_file: path.join(statusDir, `${slug}.status.json`), dashboard, reason, changes: [], verified: [], rounds: [], gaps: [], lane: "driver", session: "unknown", modelSaid: "" };
  fs.writeFileSync(reportFileFor(slug), format(report) + "\n", "utf8");
  writeStatus(report.status_file, { slug, spec: report.spec, phase: "done unavailable", exit: 2, last_message: reason });
  return report;
}

if (!specs.length) { console.error("lane-run: --spec <file> | --batch <files...> | --analyze <task>"); process.exit(1); }

if (specs.length === 1) {
  const r = await runSpec(specs[0]).catch((error) => failedReport(specs[0], error.message));
  appendUsage({ lane: "claude", model: "none", effort: null, status: "driver", in: 0, out: 0, duration: 0, project: process.cwd() });
  console.log(opt.json ? JSON.stringify(r, null, 2) : format(r));
  process.exit(r.status === "complete" ? 0 : r.status === "partial" ? 5 : 2);
} else {
  // batch: bounded child-process workers preserve input order while limiting relay pressure
  const runChild = (sp) => new Promise((res) => {
    const childArgs = [fileURLToPath(import.meta.url), "--spec", sp, "--max-resumes", String(opt.maxResumes), "--timeout", String(opt.timeout), "--lockfile-max-lines", String(opt.lockMax), "--status-dir", statusDir, "--no-watch", "--json"];
    if (opt.cwd) childArgs.push("--cwd", opt.cwd);
    const c = spawn(process.execPath, childArgs, { windowsHide: true, encoding: "utf8", env: process.env });
    let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (data) => process.stderr.write(data));
    c.on("error", (error) => { out += error.message; });
    c.on("close", (code) => { try { res({ code, r: JSON.parse(out) }); } catch { res({ code: 2, r: failedReport(sp, tail(out, 5)) }); } });
  });
  const results = Array(specs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(opt.concurrency, specs.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= specs.length) return;
      results[index] = await runChild(specs[index]);
    }
  });
  await Promise.all(workers);
  if (opt.json) console.log(JSON.stringify(results.map((x) => x.r), null, 2));
  else console.log(results.map((x) => format(x.r)).join("\n\n"));
  process.exit(results.every((x) => x.code === 0) ? 0 : 5);
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
