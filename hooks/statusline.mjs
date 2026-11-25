#!/usr/bin/env node
/**
 * Official Antigravity CLI `statusLine` bridge for agy-dart.
 *
 * Reads the documented Antigravity CLI statusLine JSON payload from `stdin`,
 * persists the sanitized quota snapshot into `~/.agy-dart/context.db` (`meta`),
 * and writes a concise single-line status string to `stdout`.
 *
 * Usage in `~/.gemini/antigravity-cli/settings.json`:
 *   {
 *     "statusLine": {
 *       "type": "command",
 *       "command": "node \"~/.gemini/config/plugins/agy-dart/hooks/statusline.mjs\"",
 *       "enabled": true,
 *       "stack_with_default": true
 *     }
 *   }
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { enableVersionedCompileCache, suppressSqliteExperimentalWarning } from "./compile-cache.mjs";
import {
  buildStatusLineSetupInfo,
  collectLocalRollingUsage,
  disableCliStatusLineBridge,
  enableCliStatusLineBridge,
  formatResetDuration,
  formatStatusLineOutput,
  MAX_STATUSLINE_STDIN_BYTES,
  normalizeStatusLineQuotaPayload,
  projectQuotaSnapshot,
  readStatusLineQuotaSnapshot,
  saveStatusLineQuotaSnapshot
} from "../context/lib/quota.js";

suppressSqliteExperimentalWarning();
enableVersionedCompileCache();

const __selfPath = path.resolve(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(path.dirname(__selfPath), "..");

function readBoundedStdin(maxBytes = MAX_STATUSLINE_STDIN_BYTES, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const chunks = [];
    let totalBytes = 0;
    let overflowed = false;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.off("end", finish);
      process.stdin.off("error", finish);
      try {
        process.stdin.pause();
        process.stdin.unref?.();
      } catch {}
      if (overflowed) {
        resolve("");
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    };

    const onData = (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      totalBytes += buf.length;
      if (totalBytes > maxBytes) {
        overflowed = true;
        finish();
        return;
      }
      chunks.push(buf);
    };

    const timer = setTimeout(finish, timeoutMs);
    timer.unref();
    process.stdin.on("data", onData);
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

export async function handleStatusLineInput(rawInput, { nowMs = Date.now(), dbPath = null, persist = true } = {}) {
  const normalized = normalizeStatusLineQuotaPayload(rawInput, { nowMs });
  let saved = false;
  let storedSnapshot = normalized;

  if (normalized && persist) {
    let store = null;
    try {
      const { ContextModeStore } = await import("../context/lib/store.js");
      store = new ContextModeStore(dbPath ? { dbPath, hookMode: true } : { hookMode: true });
      store.open();
      const res = saveStatusLineQuotaSnapshot(store, normalized, { nowMs });
      saved = res.saved;
      if (res.snapshot) storedSnapshot = res.snapshot;
    } catch {
      // Fail-open: never block or crash the Antigravity CLI status line
    } finally {
      if (store) {
        try {
          store.close();
        } catch {}
      }
    }
  }

  const projected = projectQuotaSnapshot(storedSnapshot, { nowMs });
  const line = formatStatusLineOutput(storedSnapshot, { nowMs });
  return { ok: Boolean(normalized), saved, line, projected };
}

export async function buildQuotaReport({ nowMs = Date.now(), dbPath = null } = {}) {
  let snap = null;
  let store = null;
  try {
    const { ContextModeStore } = await import("../context/lib/store.js");
    store = new ContextModeStore(dbPath ? { dbPath, hookMode: true } : { hookMode: true });
    store.open();
    snap = readStatusLineQuotaSnapshot(store, { nowMs });
  } catch {
    snap = null;
  } finally {
    if (store) {
      try {
        store.close();
      } catch {}
    }
  }
  const official = projectQuotaSnapshot(snap, { nowMs });
  const envRootsRaw =
    typeof process.env.AGY_DART_QUOTA_BRAIN_ROOTS === "string"
      ? process.env.AGY_DART_QUOTA_BRAIN_ROOTS.trim()
      : "";
  const localOpts = envRootsRaw
    ? { roots: envRootsRaw.split(path.delimiter).filter(Boolean), includeDefaultRoots: false, nowMs }
    : { nowMs };
  const local = collectLocalRollingUsage(localOpts);
  const setup = buildStatusLineSetupInfo(PLUGIN_ROOT);
  return { ok: true, official, local, setup };
}

function formatQuotaReportText(report) {
  const { official, local } = report;
  const fmtTok = (n) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  const fmtFams = (byFam) => {
    const parts = [];
    for (const [k, label] of [
      ["gemini", "Gemini"],
      ["claude", "Claude"],
      ["gpt", "GPT"],
      ["other", "Other"]
    ]) {
      const f = byFam?.[k];
      if (f && f.totalTokens > 0) parts.push(`${label} ${fmtTok(f.totalTokens)} (${f.turns}t)`);
    }
    return parts.length ? ` | ${parts.join(", ")}` : "";
  };

  const lines = [];
  if (official.available) {
    lines.push(`Official Quota (CLI statusLine · ${official.freshness}, updated ${official.capturedAt}):`);
    for (const b of official.buckets) {
      const resetPart = b.remainingResetSec !== null ? ` · resets in ${formatResetDuration(b.remainingResetSec)}` : "";
      lines.push(`  - ${b.label} (${b.id}): ${b.remainingPercent.toFixed(1)}%${resetPart}`);
    }
  } else {
    lines.push(
      "Official Quota: no CLI statusLine snapshot yet (App/IDE: Settings > Models; CLI: /usage or run with --setup-snippet)."
    );
  }
  lines.push(
    `Local Spend (5h): ${fmtTok(local.window5h.totalTokens)} total (${fmtTok(local.window5h.nonCachedTokens)} non-cached, ${fmtTok(local.window5h.cacheReadTokens)} cache read, ${local.window5h.turns} turns / ${local.window5h.sessions} chats, ref ~$${local.window5h.estimatedUsd.toFixed(2)})${fmtFams(local.window5h.byFamily)}`
  );
  lines.push(
    `Local Spend (7d): ${fmtTok(local.window7d.totalTokens)} total (${fmtTok(local.window7d.nonCachedTokens)} non-cached, ${fmtTok(local.window7d.cacheReadTokens)} cache read, ${local.window7d.turns} turns / ${local.window7d.sessions} chats, ref ~$${local.window7d.estimatedUsd.toFixed(2)})${fmtFams(local.window7d.byFamily)}`
  );
  if (local.rateLimitHits7d > 0) {
    lines.push(`Local rate-limit events: ${local.rateLimitHits5h} (5h) / ${local.rateLimitHits7d} (7d)`);
  }
  return lines.join("\n");
}

export function forwardStatusLineToChainScript(rawInput, chainScriptPath, { timeoutMs = 1500 } = {}) {
  if (typeof chainScriptPath !== "string" || !chainScriptPath.trim()) {
    return { ok: false, stdout: "" };
  }
  if (Number(process.env.AGY_DART_STATUSLINE_CHAIN_DEPTH || 0) >= 1) {
    return { ok: false, stdout: "" };
  }
  let resolved;
  try {
    resolved = path.resolve(chainScriptPath.trim());
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return { ok: false, stdout: "" };
    }
    const realSelf = fs.realpathSync(__selfPath);
    const realTarget = fs.realpathSync(resolved);
    const sameFile =
      process.platform === "win32"
        ? realSelf.toLowerCase() === realTarget.toLowerCase()
        : realSelf === realTarget;
    if (sameFile) {
      return { ok: false, stdout: "" };
    }
  } catch {
    return { ok: false, stdout: "" };
  }
  try {
    const r = spawnSync(process.execPath, [resolved], {
      input: typeof rawInput === "string" ? rawInput : "",
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, AGY_DART_STATUSLINE_CHAIN_DEPTH: "1" }
    });
    if (!r.error && !r.signal && r.status === 0 && typeof r.stdout === "string" && r.stdout.trim()) {
      return { ok: true, stdout: r.stdout.replace(/\r?\n$/, "") };
    }
  } catch {
    // Fail-open: fall back to agy-dart status line output
  }
  return { ok: false, stdout: "" };
}

function parseFlagValue(args, flagName) {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === flagName && i + 1 < args.length) {
      return args[i + 1];
    }
    if (a.startsWith(`${flagName}=`)) {
      return a.slice(flagName.length + 1);
    }
  }
  return "";
}

function parseChainScriptArg(args) {
  return parseFlagValue(args, "--chain-script");
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === __selfPath;

if (isDirectRun) {
  const args = process.argv.slice(2);
  const settingsPathOpt = parseFlagValue(args, "--settings-path") || undefined;
  const receiptPathOpt = parseFlagValue(args, "--receipt-path") || undefined;
  const asJson = args.includes("--json");

  if (args.includes("--setup-snippet")) {
    const setup = buildStatusLineSetupInfo(PLUGIN_ROOT, { settingsPath: settingsPathOpt });
    process.stdout.write(setup.snippetJson + "\n");
  } else if (args.includes("--enable")) {
    const res = enableCliStatusLineBridge({
      pluginRoot: PLUGIN_ROOT,
      ...(settingsPathOpt ? { settingsPath: settingsPathOpt } : {}),
      ...(receiptPathOpt ? { receiptPath: receiptPathOpt } : {}),
      force: args.includes("--force")
    });
    if (asJson) {
      process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    } else if (res.ok) {
      const chainNote = res.chainedScriptPath ? ` (chained with ${res.chainedScriptPath})` : "";
      process.stdout.write(`Enabled agy-dart CLI statusLine in ${res.settingsPath}${chainNote}\n`);
    } else {
      process.stderr.write((res.message || res.error || "Failed to enable statusLine") + "\n");
    }
    if (!res.ok) process.exitCode = 1;
  } else if (args.includes("--disable")) {
    const res = disableCliStatusLineBridge({
      pluginRoot: PLUGIN_ROOT,
      ...(settingsPathOpt ? { settingsPath: settingsPathOpt } : {}),
      ...(receiptPathOpt ? { receiptPath: receiptPathOpt } : {})
    });
    if (asJson) {
      process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    } else if (res.ok) {
      if (!res.changed) {
        process.stdout.write(`No agy-dart statusLine entry to remove in ${res.settingsPath}\n`);
      } else if (res.restored) {
        process.stdout.write(`Disabled agy-dart statusLine and restored previous statusLine in ${res.settingsPath}\n`);
      } else {
        process.stdout.write(`Removed agy-dart statusLine from ${res.settingsPath}\n`);
      }
    } else {
      process.stderr.write((res.message || res.error || "Failed to disable statusLine") + "\n");
    }
    if (!res.ok) process.exitCode = 1;
  } else if (args.includes("--report") || args.includes("--quota")) {
    const report = await buildQuotaReport();
    if (asJson) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else {
      process.stdout.write(formatQuotaReportText(report) + "\n");
    }
  } else {
    const raw = await readBoundedStdin();
    const res = await handleStatusLineInput(raw);
    const chainScript = parseChainScriptArg(args);
    const chained = chainScript ? forwardStatusLineToChainScript(raw, chainScript) : { ok: false, stdout: "" };
    if (asJson) {
      process.stdout.write(
        JSON.stringify({ ok: res.ok, saved: res.saved, chained: chained.ok, official: res.projected }, null, 2) + "\n"
      );
    } else {
      process.stdout.write((chained.ok ? chained.stdout : res.line) + "\n");
    }
  }
}
