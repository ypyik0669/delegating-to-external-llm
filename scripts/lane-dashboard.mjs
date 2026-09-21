#!/usr/bin/env node
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SLUG = /^[A-Za-z0-9._-]+$/;
const WEEK = 7 * 86400000;
const read = async (file) => { try { return await fs.readFile(file, "utf8"); } catch { return null; } };
const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const lines = (text) => (text || "").split(/\r?\n/).flatMap((line) => { const value = parse(line); return object(value) ? [value] : []; });

export function defaultStatusDir() {
  return path.resolve(process.env.LANE_STATUS_DIR || (process.env.CLAUDE_SCRATCHPAD_DIR ? path.join(process.env.CLAUDE_SCRATCHPAD_DIR, "lanes") : path.join(os.homedir(), ".claude", "lane-status")));
}

export async function dashboardSettings() {
  const text = await read(path.join(os.homedir(), ".claude", "llm-relay.env"));
  const settings = Object.fromEntries((text || "").split(/\r?\n/).filter((line) => line.includes("=") && !line.trim().startsWith("#")).map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
  }));
  return { ...settings, ...process.env };
}

export function parseApplyPatchFiles(commandText) {
  if (typeof commandText !== "string") return [];
  const files = [];
  for (const patch of commandText.split("*** Begin Patch").slice(1)) {
    const body = patch.split("*** End Patch")[0];
    for (const match of body.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+?)\s*$/gm)) {
      files.push({ path: match[2], kind: match[1].toLowerCase() });
    }
  }
  return files;
}

function derivedPatchFiles(item) {
  const completed = item.status === "completed" && item.exit_code === 0;
  return parseApplyPatchFiles(item.command).map((file) => completed ? file : { ...file, kind: "failed" });
}

async function eventSlice(file, from = 0) {
  const text = await read(file) || "";
  const physical = text ? text.split(/\r?\n/) : [];
  if (physical.length && !object(parse(physical.at(-1)))) physical.pop();
  return { next: physical.length, events: physical.slice(from > physical.length ? 0 : from).flatMap((line) => {
    const value = parse(line);
    if (!object(value)) return [];
    if (value.item?.type === "command_execution" && value.item.command?.includes("*** Begin Patch")) value.derived_files = derivedPatchFiles(value.item);
    return [value];
  }) };
}

async function logTail(file) {
  let handle;
  try {
    handle = await fs.open(file, "r");
    const { size } = await handle.stat();
    const start = Math.max(0, size - 65536);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return start ? text.slice(text.indexOf("\n") + 1) : text;
  } catch { return null; }
  finally { await handle?.close(); }
}

async function usageSummary(since) {
  const duration = /^(\d+)([hdm])$/.exec(since);
  if (since !== "all" && !duration) return null;
  const cutoff = duration ? Date.now() - Number(duration[1]) * { h: 3600000, d: 86400000, m: 60000 }[duration[2]] : 0;
  const settings = await dashboardSettings();
  const log = settings.LLM_USAGE_LOG || path.join(os.homedir(), ".claude", "llm-usage.jsonl");
  const rows = lines(await read(log)).filter((row) => Date.parse(row.ts) >= cutoff);
  const sum = (records, key) => records.reduce((total, row) => total + (Number(row[key]) || 0), 0);
  const line = (label, records) => ({ label, calls: records.length, prompt_tokens: sum(records, "prompt_tokens"), cached_tokens: sum(records, "cached_tokens"), completion_tokens: sum(records, "completion_tokens"), minutes: Math.round(sum(records, "duration_ms") / 6000) / 10 });
  const group = (key) => {
    const groups = new Map();
    for (const row of rows) { const label = row[key] ?? "?"; if (!groups.has(label)) groups.set(label, []); groups.get(label).push(row); }
    return [...groups].map(([label, records]) => line(label, records));
  };
  const external = line("external", rows.filter((row) => row.lane !== "claude" && row.status !== "driver"));
  const claude = line("claude", rows.filter((row) => row.lane === "claude"));
  const price = Object.fromEntries(["LLM_PRICE_IN", "LLM_PRICE_CACHED", "LLM_PRICE_OUT", "CLAUDE_PRICE_IN", "CLAUDE_PRICE_OUT"].map((key) => [key, Number(settings[key] || 0)]));
  const usd = (total, input, cached, output) => ((total.prompt_tokens - total.cached_tokens) * input + total.cached_tokens * cached + total.completion_tokens * output) / 1e6;
  const externalTokens = external.prompt_tokens + external.completion_tokens;
  return { log, since, project: null, total: line("total", rows), external, claude, ratio_claude_to_external: externalTokens ? (claude.prompt_tokens + claude.completion_tokens) / externalTokens : null,
    usd: { external: usd(external, price.LLM_PRICE_IN, price.LLM_PRICE_CACHED, price.LLM_PRICE_OUT), claude: usd(claude, price.CLAUDE_PRICE_IN, price.CLAUDE_PRICE_IN, price.CLAUDE_PRICE_OUT), priced: Object.values(price).some((value) => value > 0) },
    by_lane: group("lane"), by_status: group("status"), by_project: group("project").sort((first, second) => second.calls - first.calls).slice(0, 10), recent: rows.slice(-10).reverse() };
}

export function createServer({ dir = defaultStatusDir() } = {}) {
  dir = path.resolve(dir);
  const status = async (slug) => {
    const value = parse(await read(path.join(dir, `${slug}.status.json`)));
    return object(value) ? { ...value, slug } : null;
  };
  const enriched = async (lane) => ({ ...lane, has_report: await read(path.join(dir, `${lane.slug}.report.txt`)) !== null, events_count: (await eventSlice(path.join(dir, `${lane.slug}.events.jsonl`))).events.length });
  return http.createServer(async (request, response) => {
    const json = (code, value) => { response.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); response.end(JSON.stringify(value)); };
    try {
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(request.headers.host || "") || (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`)) return json(403, { error: "Local requests only" });
      if (request.method !== "GET") return json(405, { error: "GET required" });
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (url.pathname === "/api/ping") return json(200, { app: "lane-dashboard" });
      if (url.pathname === "/") {
        const html = await read(path.join(HERE, "../assets/dashboard.html"));
        if (html === null) return json(404, { error: "Dashboard asset missing" });
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
        return response.end(html);
      }
      if (url.pathname === "/api/lanes") {
        let names = []; try { names = await fs.readdir(dir); } catch {}
        const lanes = await Promise.all(names.filter((name) => name.endsWith(".status.json") && SLUG.test(name.slice(0, -12))).map((name) => status(name.slice(0, -12))));
        const recent = lanes.filter((lane) => lane && Date.parse(lane.updated_at) >= Date.now() - WEEK).sort((first, second) => Date.parse(second.updated_at) - Date.parse(first.updated_at));
        return json(200, await Promise.all(recent.map(enriched)));
      }
      if (url.pathname === "/api/usage") {
        const summary = await usageSummary(url.searchParams.get("since") || "7d");
        return json(summary ? 200 : 400, summary || { error: "Invalid since window" });
      }
      const route = /^\/api\/lanes\/([^/]+)(\/events)?$/.exec(url.pathname);
      if (route) {
        let slug; try { slug = decodeURIComponent(route[1]); } catch { return json(400, { error: "Invalid slug" }); }
        if (!SLUG.test(slug)) return json(400, { error: "Invalid slug" });
        const lane = await status(slug);
        if (!lane) return json(404, { error: "Unknown lane" });
        if (route[2]) {
          const from = url.searchParams.get("from") || "0";
          if (!/^\d+$/.test(from) || !Number.isSafeInteger(Number(from))) return json(400, { error: "Invalid from index" });
          return json(200, await eventSlice(path.join(dir, `${slug}.events.jsonl`), Number(from)));
        }
        const [report, spec_text, log] = await Promise.all([read(path.join(dir, `${slug}.report.txt`)), lane.mode === "analyze" ? Promise.resolve(lane.spec || null) : typeof lane.spec === "string" ? read(lane.spec) : null, logTail(lane.log_file || path.join(dir, `${slug}.log`))]);
        return json(200, { ...await enriched(lane), report, spec_text, log, watch: `node "${path.join(HERE, "lane-status.mjs")}" --watch --dir "${dir}"` });
      }
      json(404, { error: "Not found" });
    } catch { json(500, { error: "Unable to read lane data" }); }
  });
}

export function isDashboardRunning(port) {
  return new Promise((resolve) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: "/api/ping", timeout: 400 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; if (body.length > 4096) request.destroy(); });
      response.on("end", () => resolve(response.statusCode === 200 && parse(body)?.app === "lane-dashboard"));
      response.on("error", () => resolve(false));
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

export async function startDashboard(dir) {
  const settings = await dashboardSettings();
  if (settings.LLM_DASHBOARD === "0") return null;
  const port = Number(settings.LLM_DASHBOARD_PORT || 7788);
  if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error("lane-run: invalid LLM_DASHBOARD_PORT"); return null; }
  const url = `http://127.0.0.1:${port}`;
  if (await isDashboardRunning(port)) return url;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--port", String(port), "--dir", dir], { detached: process.platform !== "win32", windowsHide: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (await isDashboardRunning(port)) return url;
    if (child.exitCode !== null) break;
  }
  console.error(`lane-run: dashboard unavailable at ${url}; lane continues`);
  return null;
}

function openBrowser(url) {
  const command = process.platform === "win32" ? "cmd.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/d", "/c", "start", "", url] : [url];
  const child = spawn(command, args, { windowsHide: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

async function main() {
  const settings = await dashboardSettings();
  let port = Number(settings.LLM_DASHBOARD_PORT || 7788), dir = defaultStatusDir(), open = false;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--port" && args[index + 1]) port = Number(args[++index]);
    else if (args[index] === "--dir" && args[index + 1]) dir = path.resolve(args[++index]);
    else if (args[index] === "--open") open = true;
    else throw new Error("Usage: lane-dashboard.mjs [--port 7788] [--dir <statusdir>] [--open]");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port");
  const server = createServer({ dir });
  if (!port || !await isDashboardRunning(port)) {
    try { await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); }); }
    catch (error) { if (error.code !== "EADDRINUSE" || !await isDashboardRunning(port)) throw error; }
  }
  port = server.address()?.port || port;
  const url = `http://127.0.0.1:${port}`;
  console.log(`DASHBOARD: ${url}`);
  if (open) openBrowser(url);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`lane-dashboard: ${error.message}`); process.exitCode = 1; });
}
