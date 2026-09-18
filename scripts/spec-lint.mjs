#!/usr/bin/env node
// Static check of a six-part spec before a lane spends money on it.
//   node spec-lint.mjs <spec-file> [--root <repo-root>] [--json]
// Exit 0 and "SPEC OK" when it passes; exit 1 with one problem per line otherwise.
// Checks: all six parts present and non-empty; REASONING is low|medium|high|xhigh;
// FILES lists at least one path and existing paths really exist (new files are fine);
// fenced code totals <= MAX_CODE_LINES (more means the architect is dictating the
// implementation instead of delegating it); optional MODEL/PROTOCOL/WORKTREE lines are sane.
import fs from "node:fs";
import path from "node:path";

const MAX_CODE_LINES = 15;
const REQUIRED = ["OBJECTIVE", "FILES", "INTERFACES", "CONSTRAINTS", "VERIFICATION", "REASONING"];
const OPTIONAL = ["MODEL", "PROTOCOL", "WORKTREE"];
const EFFORTS = ["low", "medium", "high", "xhigh"];

export function lintSpec(text, root = process.cwd()) {
  const problems = [];
  const sections = {};
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const m = /^([A-Z][A-Z _-]{2,20}):\s*(.*)$/.exec(raw);
    if (m && (REQUIRED.includes(m[1]) || OPTIONAL.includes(m[1]))) { cur = m[1]; sections[cur] = (m[2] || "").trim(); continue; }
    if (cur) sections[cur] += (sections[cur] ? "\n" : "") + raw;
  }
  for (const k of REQUIRED) {
    const v = (sections[k] || "").trim();
    if (!v) problems.push(`${k}: missing or empty`);
  }
  const reasoning = (sections.REASONING || "").trim().split(/\s+/)[0]?.toLowerCase();
  if (reasoning && !EFFORTS.includes(reasoning)) problems.push(`REASONING: "${reasoning}" is not one of ${EFFORTS.join("|")}`);

  const files = (sections.FILES || "").split(/[\n,]/).map((s) => s.trim().replace(/^[-*]\s*/, "")).filter((s) => s && !/^(none|n\/a)$/i.test(s));
  if (sections.FILES !== undefined && !files.length) problems.push("FILES: list at least one path (or the lane cannot fence its edits)");
  for (const f of files) {
    const clean = f.split(/\s+/)[0].replace(/[`'"]/g, "");
    if (/[*?{]/.test(clean)) { problems.push(`FILES: "${clean}" is a glob; list concrete paths`); continue; }
    const marked = /\((new|create)\)/i.test(f) || /\bnew\b/i.test(f.slice(clean.length));
    const abs = path.isAbsolute(clean) ? clean : path.join(root, clean);
    if (!marked && !fs.existsSync(abs) && !fs.existsSync(path.dirname(abs))) problems.push(`FILES: "${clean}" — neither the file nor its directory exists (mark new files with "(new)")`);
  }

  const fences = text.match(/```[\s\S]*?```/g) || [];
  const codeLines = fences.reduce((n, f) => n + Math.max(0, f.split("\n").length - 2), 0);
  if (codeLines > MAX_CODE_LINES) problems.push(`code: ${codeLines} fenced lines (> ${MAX_CODE_LINES}) — that is an implementation being dictated, not a spec; describe the behaviour and let the lane write it`);

  const proto = (sections.PROTOCOL || "").trim();
  if (proto && !/^(four-phase|spec)$/i.test(proto)) problems.push(`PROTOCOL: "${proto}" is not four-phase|spec`);
  const wt = (sections.WORKTREE || "").trim();
  if (wt && !fs.existsSync(wt)) problems.push(`WORKTREE: "${wt}" does not exist (create it with scripts/lane-worktree.sh create <slug>)`);
  const ver = (sections.VERIFICATION || "").trim();
  if (ver && !/[`$]|\b(npm|node|pytest|go|cargo|make|dotnet|mvn|gradle|yarn|pnpm|bun|test|tsc|lint)\b/i.test(ver)) problems.push("VERIFICATION: no runnable command found — name the exact command(s)");

  return { ok: problems.length === 0, problems, sections, files, codeLines };
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
  const a = process.argv.slice(2);
  let file = null, root = process.cwd(), json = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--root") root = a[++i];
    else if (a[i] === "--json") json = true;
    else file = a[i];
  }
  if (!file || !fs.existsSync(file)) { console.error("spec-lint: usage: node spec-lint.mjs <spec-file> [--root dir]"); process.exit(2); }
  const r = lintSpec(fs.readFileSync(file, "utf8"), root);
  if (json) console.log(JSON.stringify(r, null, 2));
  else if (r.ok) console.log("SPEC OK");
  else { console.log("SPEC INCOMPLETE"); for (const p of r.problems) console.log("- " + p); }
  process.exit(r.ok ? 0 : 1);
}
