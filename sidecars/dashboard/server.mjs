import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ContextModeStore, FILE_CATEGORIES } from "../../context/lib/store.js";
import { buildHandoffBrief, inferWorkspaceFromStore } from "../../context/lib/handoff.js";
import {
  analyzeTranscriptCache,
  computeCacheWarmth,
  CONTEXT_CRITICAL_TOKENS,
  CONTEXT_WARN_TOKENS,
  createEmptyContextComposition,
  createEmptySubagentBreakdown,
  DEFAULT_CACHE_TTL_SEC,
  findTranscriptForConversation,
  MIN_CACHEABLE_CONTEXT_TOKENS,
  parseTranscriptLines,
  readTranscriptTail,
  resolveModelProfile
} from "../../context/lib/cache-analyzer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const store = new ContextModeStore();
const HTML_FILE = path.join(__dirname, "index.html");

function getPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"));
    if (pkg.version) return pkg.version;
  } catch {}
  return "1.0.0";
}

function getRenderedHtml() {
  const raw = fs.readFileSync(HTML_FILE, "utf8");
  const ver = getPackageVersion();
  return raw.replace('id="dashboard-version">--</span>', `id="dashboard-version">v${ver}</span>`);
}

let appStartTime = null;
if (process.platform === "win32") {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "(Get-Process -Name language_server, Antigravity | Measure-Object -Property StartTime -Minimum).Minimum.ToUniversalTime().ToString(\'yyyy-MM-ddTHH:mm:ss.fffZ\')"',
      { encoding: "utf8", timeout: 3000, windowsHide: true }
    );
    const ts = new Date(out.trim()).getTime();
    if (!Number.isNaN(ts) && ts > 0) appStartTime = ts;
  } catch {}
}
if (!appStartTime) {
  appStartTime = Date.now() - Math.round(process.uptime() * 1000);
}

// Clear session-level overrides on app session restart
try {
  const recordedSessionTime = store.getMeta("app_session_start_time");
  if (!recordedSessionTime || recordedSessionTime !== String(appStartTime)) {
    store.clearSessionOverrides();
    store.setMeta("app_session_start_time", String(appStartTime));
  }
} catch {}

function resolveTargetSession(data, defaultConvId = "default") {
  const scope = data.scope || (data.sessionId === "all" ? "lifetime" : (data.sessionId === "app" ? "app" : "conversation"));
  const convId = data.conversationId || (data.sessionId !== "all" && data.sessionId !== "app" && data.sessionId ? data.sessionId : (defaultConvId || "default"));
  let targetSid = convId;
  if (scope === "lifetime" || scope === "all") targetSid = "all";
  else if (scope === "app" || scope === "session") targetSid = "app";
  return { scope, convId, targetSid };
}

function getStatsPayload(data, defaultConvId = "default") {
  const { scope, convId, targetSid } = resolveTargetSession(data, defaultConvId);
  let stats;
  if (scope === "lifetime" || scope === "all") {
    stats = store.getStats("all");
  } else if (scope === "app" || scope === "session") {
    stats = store.getStats("app", { sinceTs: appStartTime });
  } else {
    stats = store.getStats(convId);
  }

  stats.scope = scope;
  stats.conversationId = convId;
  stats.appStartTime = appStartTime;
  stats.conversationCutoffBytes = store.getCutoff(convId);
  stats.appCutoffBytes = store.getCutoff("app");
  stats.globalCutoffBytes = store.getCutoff(null);
  stats.hasConversationCutoffOverride = store.hasCutoffOverride(convId);
  stats.hasAppCutoffOverride = store.hasCutoffOverride("app");
  stats.cutoffBytes = scope === "lifetime"
    ? stats.globalCutoffBytes
    : (scope === "app" ? stats.appCutoffBytes : stats.conversationCutoffBytes);

  stats.conversationExemptExtensions = store.getExemptExtensions(convId);
  stats.appExemptExtensions = store.getExemptExtensions("app");
  stats.globalExemptExtensions = store.getExemptExtensions(null);
  stats.exemptExtensions = scope === "lifetime"
    ? stats.globalExemptExtensions
    : (scope === "app" ? stats.appExemptExtensions : stats.conversationExemptExtensions);

  stats.fileCategories = Object.values(FILE_CATEGORIES);
  stats.conversationExemptCategories = store.getExemptCategories(convId);
  stats.appExemptCategories = store.getExemptCategories("app");
  stats.globalExemptCategories = store.getExemptCategories(null);
  stats.exemptCategories = scope === "lifetime"
    ? stats.globalExemptCategories
    : (scope === "app" ? stats.appExemptCategories : stats.conversationExemptCategories);

  stats.conversationCustomExtensions = store.getCustomExemptExtensions(convId);
  stats.appCustomExtensions = store.getCustomExemptExtensions("app");
  stats.globalCustomExtensions = store.getCustomExemptExtensions(null);
  stats.customExtensions = scope === "lifetime"
    ? stats.globalCustomExtensions
    : (scope === "app" ? stats.appCustomExtensions : stats.conversationCustomExtensions);

  // Sandbox preview cap is double cutoff, hard-capped at 8100 B to prevent Antigravity MCP output.txt spills
  stats.sandboxCapBytes = Math.min(
    8100,
    stats.cutoffBytes > 0
      ? stats.cutoffBytes * 2
      : parseInt(process.env.CONTEXT_MODE_MAX_OUTPUT_BYTES || "8100", 10)
  );
  stats.isPaused = store.isPaused(targetSid);
  stats.cliFilterEnabled = store.isCliFilterEnabled(targetSid);
  stats.readDedupEnabled = store.isReadDedupEnabled(targetSid);
  stats.ghost = store.getGhostStats(
    targetSid,
    scope === "app" || scope === "session" ? { sinceTs: appStartTime } : {}
  );

  stats.version = getPackageVersion();

  return stats;
}

const LATEST_SCAN_TTL_MS = 10000;
let cachedLatestScan = { ts: 0, path: null };
const parsedDiagCache = new Map(); // key -> { mtimeMs, size, ttlSec, diag }

function parseSafeMaxAgeDays(raw, fallback = 14) {
  if (raw === undefined || raw === null) return fallback;
  const trimmed = String(raw).trim();
  if (!trimmed) return fallback;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parseOptionalPositiveNumber(raw) {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function refreshWallClockTtl(diag, explicitTtlSec) {
  const nowMs = Date.now();
  if (!diag || !diag.lastPlannerAt) return diag ? { ...diag, serverNowMs: nowMs } : diag;
  const safeTtl =
    parseOptionalPositiveNumber(explicitTtlSec) ??
    parseOptionalPositiveNumber(diag.cacheTtlSec) ??
    DEFAULT_CACHE_TTL_SEC;
  const lastMs = Date.parse(diag.lastPlannerAt);
  if (!Number.isFinite(lastMs)) return { ...diag, serverNowMs: nowMs };
  const idleSeconds = Math.max(0, Math.round((nowMs - lastMs) / 1000));
  const ttlRemainingSec = Math.max(0, safeTtl - idleSeconds);
  const currentContextTokens = diag.currentContextTokens || 0;
  let ttlStatus = "cold";
  if (currentContextTokens >= MIN_CACHEABLE_CONTEXT_TOKENS) {
    if (idleSeconds >= safeTtl) ttlStatus = "expired";
    else if (ttlRemainingSec <= 60) ttlStatus = "expiring";
    else ttlStatus = "warm";
  }
  const { cacheTemperature, compactAdvice } = computeCacheWarmth({
    currentContextTokens,
    idleSeconds,
    ttlSec: safeTtl,
    weightedHitRate: diag.weightedHitRate || 0,
    criticalTokens: diag.criticalTokens || CONTEXT_CRITICAL_TOKENS,
    coldCompactTokens: diag.coldCompactTokens || 60000,
    delayHotMinTokens: diag.delayHotMinTokens || 30000
  });
  return {
    ...diag,
    cacheTtlSec: safeTtl,
    idleSeconds,
    ttlRemainingSec,
    ttlStatus,
    cacheTemperature,
    compactAdvice,
    serverNowMs: nowMs
  };
}

function getCacheDiagPayload(data, defaultConvId = "default") {
  const { scope, convId } = resolveTargetSession(data, defaultConvId);
  const rawTtl = data.ttl !== undefined && data.ttl !== "" ? data.ttl : process.env.AGY_DART_CACHE_TTL_SEC;
  const explicitTtlSec = parseOptionalPositiveNumber(rawTtl);
  const envWindowTokens = parseOptionalPositiveNumber(process.env.AGY_DART_WINDOW_TOKENS);
  const envWarnTokens = parseOptionalPositiveNumber(process.env.AGY_DART_WARN_TOKENS);
  const envCritTokens = parseOptionalPositiveNumber(process.env.AGY_DART_CRITICAL_TOKENS);
  const isSpecificConv = scope === "conversation" && convId && convId !== "default" && convId !== "all" && convId !== "app";
  let transcriptPath = null;
  if (isSpecificConv) {
    transcriptPath = findTranscriptForConversation(convId, { exactOnly: true });
  } else {
    const now = Date.now();
    if (now - cachedLatestScan.ts < LATEST_SCAN_TTL_MS && cachedLatestScan.path && fs.existsSync(cachedLatestScan.path)) {
      transcriptPath = cachedLatestScan.path;
    } else {
      transcriptPath = findTranscriptForConversation(null);
      cachedLatestScan = { ts: now, path: transcriptPath };
    }
  }
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    const defProfile = resolveModelProfile(null);
    const effectiveWindow = envWindowTokens ?? defProfile.windowTokens;
    const windowSource = envWindowTokens !== undefined ? "explicit" : "profile";
    const ttlSource = explicitTtlSec !== undefined ? "explicit" : "profile";
    return {
      ok: true,
      transcriptFound: false,
      scope,
      conversationId: convId,
      serverNowMs: Date.now(),
      cacheTtlSec: explicitTtlSec ?? defProfile.ttlSec,
      ttlSource,
      maxWarmHitGapSec: null,
      ttlStatus: "cold",
      cacheTemperature: "cold",
      compactAdvice: "none",
      estimatedCostSavingsPct: 0,
      estimatedInputCostUsd: 0,
      estimatedSavedUsd: 0,
      estimatedWastedUsd: 0,
      cacheCreationTokensTotal: 0,
      thinkingTokensTotal: 0,
      cacheWriteMultiplier: defProfile.cacheWriteMultiplier,
      windowSource,
      watermark: "ok",
      warnTokens: envWarnTokens ?? Math.round(effectiveWindow * 0.65),
      criticalTokens: envCritTokens ?? Math.round(effectiveWindow * 0.80),
      contextUtilization: 0,
      modelProfile: {
        id: defProfile.id,
        windowTokens: effectiveWindow,
        windowSource,
        defaultTtlSec: defProfile.ttlSec,
        cacheDiscountRate: defProfile.cacheDiscountRate,
        inputPer1M: defProfile.inputPer1M,
        cacheWriteMultiplier: defProfile.cacheWriteMultiplier,
        cacheWrite1hMultiplier: defProfile.cacheWrite1hMultiplier
      },
      weightedHitRate: 0,
      avgTurnHitRate: 0,
      currentContextTokens: 0,
      peakContextTokens: 0,
      bustCount: 0,
      bustsByCause: {
        ttl_idle_expiry: 0,
        model_switch: 0,
        compaction_or_truncation: 0,
        system_injection: 0,
        multimodal_media: 0,
        prefix_drift: 0
      },
      wastedTokensTotal: 0,
      duplicateReadCount: 0,
      loopWatch: {
        status: "ok",
        windowSize: 0,
        repeatRate: 0,
        maxRepeatCount: 0,
        topRepeatedCall: null,
        editFailOscillations: 0,
        oscillatingFiles: [],
        reason: null
      },
      contextComposition: createEmptyContextComposition(),
      subagentBreakdown: createEmptySubagentBreakdown(),
      recentTurns: [],
      topContextDeltas: []
    };
  }
  try {
    const st = fs.statSync(transcriptPath);
    const cacheKey = `${transcriptPath}:${explicitTtlSec ?? "auto"}:${envWindowTokens ?? ""}:${envWarnTokens ?? ""}:${envCritTokens ?? ""}`;
    const cached = parsedDiagCache.get(cacheKey);
    let diag;
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      diag = refreshWallClockTtl(cached.diag, explicitTtlSec);
    } else {
      const steps =
        st.size <= 2 * 1024 * 1024
          ? parseTranscriptLines(fs.readFileSync(transcriptPath, "utf8"))
          : readTranscriptTail(transcriptPath, 524288);
      const nowMs = Date.now();
      const diagOpts = { nowMs };
      if (explicitTtlSec !== undefined) diagOpts.ttlSec = explicitTtlSec;
      if (envWindowTokens !== undefined) diagOpts.windowTokens = envWindowTokens;
      if (envWarnTokens !== undefined) diagOpts.warnTokens = envWarnTokens;
      if (envCritTokens !== undefined) diagOpts.criticalTokens = envCritTokens;
      diag = analyzeTranscriptCache(steps, diagOpts);
      if (parsedDiagCache.size > 16) parsedDiagCache.clear();
      parsedDiagCache.set(cacheKey, { mtimeMs: st.mtimeMs, size: st.size, ttlSec: explicitTtlSec, diag });
      diag = { ...diag, serverNowMs: nowMs };
    }
    return {
      ok: true,
      transcriptFound: true,
      scope,
      conversationId: convId,
      ...diag,
      contextComposition: diag.contextComposition ?? createEmptyContextComposition(),
      subagentBreakdown: diag.subagentBreakdown ?? createEmptySubagentBreakdown(),
      serverNowMs: diag.serverNowMs ?? Date.now()
    };
  } catch (err) {
    return {
      ok: false,
      transcriptFound: false,
      serverNowMs: Date.now(),
      contextComposition: createEmptyContextComposition(),
      subagentBreakdown: createEmptySubagentBreakdown(),
      error: err?.message || String(err)
    };
  }
}

function getHandoffPayload(data = {}, defaultConvId = "default") {
  const { scope, convId, targetSid } = resolveTargetSession(data, defaultConvId);
  const sinceTs = scope === "app" || scope === "session" ? appStartTime : null;
  const rawCwd = typeof data.cwd === "string" ? data.cwd.trim() : "";
  const cwd = rawCwd && !rawCwd.includes("\0")
    ? rawCwd
    : inferWorkspaceFromStore(store, targetSid, sinceTs);
  const rawMaxBytes = parseOptionalPositiveNumber(data.maxBytes);
  const maxBytes = rawMaxBytes !== undefined
    ? Math.min(16384, Math.max(256, Math.floor(rawMaxBytes)))
    : 5800;
  let cacheDiag = null;
  try {
    const diag = getCacheDiagPayload(data, defaultConvId);
    if (diag && diag.ok && diag.transcriptFound) {
      cacheDiag = diag;
    }
  } catch {}
  const brief = buildHandoffBrief({
    store,
    sessionId: targetSid,
    cwd,
    cacheDiag,
    maxBytes,
    sinceTs
  });
  return {
    ok: true,
    scope,
    conversationId: convId,
    sessionId: targetSid,
    markdown: brief.markdown,
    summary: brief.summary,
    bytes: brief.bytes,
    truncated: brief.truncated
  };
}

let SidecarApp = null;
let ResponseClass = null;

try {
  const userSdkPath = path.join(os.homedir(), ".gemini", "config", "node_modules", "sidecar_sdk", "index.mjs");
  const sdkModule = await import(pathToFileURL(userSdkPath).href);
  SidecarApp = sdkModule.SidecarApp;
  ResponseClass = sdkModule.Response;
} catch {
  try {
    const sdkModule = await import("sidecar_sdk");
    SidecarApp = sdkModule.SidecarApp;
    ResponseClass = sdkModule.Response;
  } catch {
    // Standalone fallback
  }
}

const isSidecarEnv = Boolean(
  process.env.ANTIGRAVITY_LS_ADDRESS &&
  process.env.ANTIGRAVITY_CSRF_TOKEN &&
  process.env.ANTIGRAVITY_SIDECAR_WEB_PORT &&
  SidecarApp
);

if (isSidecarEnv) {
  const app = new SidecarApp();

  app.page("/", () => {
    return getRenderedHtml();
  });

  app.api("/api/stats", (data) => {
    return getStatsPayload(data, app.config.conversationId);
  }, "GET");

  const handleCutoff = (data) => {
    const { scope, targetSid, convId } = resolveTargetSession(data, app.config.conversationId);
    const cutoffBytes = data.cutoff === "none" || data.cutoff === 0 || data.cutoff === "0" ? 0 : parseInt(data.cutoff, 10);
    const saved = store.setCutoff(cutoffBytes, targetSid);
    return {
      ok: true,
      cutoffBytes: saved,
      scope,
      sessionId: targetSid,
      globalCutoffBytes: store.getCutoff(null),
      appCutoffBytes: store.getCutoff("app"),
      conversationCutoffBytes: store.getCutoff(convId)
    };
  };
  app.api("/api/cutoff", handleCutoff, "GET");
  app.api("/api/cutoff", handleCutoff, "POST");

  const handleExemptions = (data) => {
    const { scope, targetSid } = resolveTargetSession(data, app.config.conversationId);
    const action = data.action || "get";
    if (action === "toggleCategory" && data.category) {
      store.toggleExemptCategory(data.category, data.enabled !== undefined ? (data.enabled === true || data.enabled === "true" || data.enabled === "1") : null, targetSid);
    } else if (action === "setCategories" && Array.isArray(data.categories)) {
      store.setExemptCategories(data.categories, targetSid);
    } else if (action === "add" && data.ext) {
      store.addCustomExemptExtension(data.ext, targetSid);
    } else if (action === "remove" && data.ext) {
      store.removeCustomExemptExtension(data.ext, targetSid);
    } else if (action === "reset") {
      store.setExemptCategories(null, targetSid);
      store.setCustomExemptExtensions([], targetSid);
    } else if (action === "set" && Array.isArray(data.extensions)) {
      store.setExemptExtensions(data.extensions, targetSid);
    }
    return {
      ok: true,
      exemptCategories: store.getExemptCategories(targetSid),
      customExtensions: store.getCustomExemptExtensions(targetSid),
      exemptExtensions: store.getExemptExtensions(targetSid),
      scope,
      sessionId: targetSid
    };
  };
  app.api("/api/exemptions", handleExemptions, "GET");
  app.api("/api/exemptions", handleExemptions, "POST");

  const handleToggleActive = (data) => {
    const { scope, targetSid } = resolveTargetSession(data, app.config.conversationId);
    const current = store.isPaused(targetSid);
    const newPaused = data.paused !== undefined ? (data.paused === true || data.paused === "true" || data.paused === "1") : !current;
    const saved = store.setPaused(newPaused, targetSid);
    return { ok: true, isPaused: saved, scope, sessionId: targetSid };
  };
  app.api("/api/toggle-active", handleToggleActive, "GET");
  app.api("/api/toggle-active", handleToggleActive, "POST");
  app.api("/api/paused", handleToggleActive, "GET");
  app.api("/api/paused", handleToggleActive, "POST");

  app.api("/api/doctor", () => {
    return store.doctor();
  }, "GET");

  const handleResume = (data) => {
    const { scope, convId } = resolveTargetSession(data, app.config.conversationId);
    if (scope === "lifetime" || scope === "all") {
      return store.getResumeState("all", 10);
    } else if (scope === "app" || scope === "session") {
      return store.getResumeState("app", 10, { sinceTs: appStartTime });
    } else {
      return store.getResumeState(convId, 10);
    }
  };
  app.api("/api/resume", handleResume, "GET");

  const handleSourceChunks = (data) => {
    const sourceId = data.sourceId;
    if (!sourceId) return { ok: false, chunks: [] };
    const chunks = store.getSourceChunks(sourceId);
    return { ok: true, sourceId, chunks };
  };
  app.api("/api/source-chunks", handleSourceChunks, "GET");

  const handleSearch = (data) => {
    const queries = Array.isArray(data.queries) ? data.queries : [data.query || ""];
    return store.search({ queries, limit: 5 });
  };
  app.api("/api/search", handleSearch, "GET");
  app.api("/api/search", handleSearch, "POST");

  const handlePurge = (data) => {
    const { scope, convId } = resolveTargetSession(data, app.config.conversationId);
    if (scope === "lifetime" || scope === "all") {
      return store.purge({ scope: "all" });
    } else if (scope === "app" || scope === "session") {
      return store.purge({ scope: "app", sinceTs: appStartTime });
    } else {
      return store.purge({ scope: "conversation", sessionId: convId });
    }
  };
  app.api("/api/purge", handlePurge, "GET");
  app.api("/api/purge", handlePurge, "POST");

  app.api("/api/cache-diag", (data) => {
    return getCacheDiagPayload(data, app.config.conversationId);
  }, "GET");

  app.api("/api/handoff", (data) => {
    return getHandoffPayload(data, app.config.conversationId);
  }, "GET");

  const handleMaintenance = (data) => {
    const action = data.action || "prune";
    const maxAgeDays = parseSafeMaxAgeDays(data.maxAgeDays, 14);
    const vacuum = action === "vacuum" || data.vacuum === true || data.vacuum === "true" || data.vacuum === "1";
    return store.pruneByTtl({ maxAgeDays, vacuum });
  };
  app.api("/api/maintenance", handleMaintenance, "GET");
  app.api("/api/maintenance", handleMaintenance, "POST");

  const handleCliFilter = (data) => {
    const { scope, targetSid } = resolveTargetSession(data, app.config.conversationId);
    const current = store.isCliFilterEnabled(targetSid);
    const next = data.enabled !== undefined ? (data.enabled === true || data.enabled === "true" || data.enabled === "1") : !current;
    const saved = store.setCliFilterEnabled(next, targetSid);
    return { ok: true, cliFilterEnabled: saved, scope, sessionId: targetSid };
  };
  app.api("/api/cli-filter", handleCliFilter, "GET");
  app.api("/api/cli-filter", handleCliFilter, "POST");

  const handleReadDedup = (data) => {
    const { scope, targetSid } = resolveTargetSession(data, app.config.conversationId);
    const current = store.isReadDedupEnabled(targetSid);
    const next = data.enabled !== undefined ? (data.enabled === true || data.enabled === "true" || data.enabled === "1") : !current;
    const saved = store.setReadDedupEnabled(next, targetSid);
    return { ok: true, readDedupEnabled: saved, scope, sessionId: targetSid };
  };
  app.api("/api/read-dedup", handleReadDedup, "GET");
  app.api("/api/read-dedup", handleReadDedup, "POST");

  await app.run();
  console.log(`[context-mode sidecar] registered and running`);
} else {
  // Standalone HTTP server for preview/testing
  const port = process.env.PORT || 8765;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getRenderedHtml());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/stats") {
      const data = Object.fromEntries(url.searchParams.entries());
      const stats = getStatsPayload(data);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(stats));
      return;
    }

    if ((req.method === "GET" || req.method === "POST") && url.pathname === "/api/cutoff") {
      const handleCutoffReq = (data) => {
        const { scope, targetSid, convId } = resolveTargetSession(data);
        const cutoffBytes = data.cutoff === "none" || data.cutoff === 0 || data.cutoff === "0" ? 0 : parseInt(data.cutoff, 10);
        const saved = store.setCutoff(cutoffBytes, targetSid);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            cutoffBytes: saved,
            scope,
            sessionId: targetSid,
            globalCutoffBytes: store.getCutoff(null),
            appCutoffBytes: store.getCutoff("app"),
            conversationCutoffBytes: store.getCutoff(convId)
          })
        );
      };
      if (req.method === "GET") {
        const data = Object.fromEntries(url.searchParams.entries());
        handleCutoffReq(data);
      } else {
        const queryData = Object.fromEntries(url.searchParams.entries());
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            handleCutoffReq({ ...queryData, ...JSON.parse(body || "{}") });
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      }
      return;
    }

    if ((req.method === "GET" || req.method === "POST") && (url.pathname === "/api/toggle-active" || url.pathname === "/api/paused")) {
      const handleToggleReq = (data) => {
        const { scope, targetSid } = resolveTargetSession(data);
        const current = store.isPaused(targetSid);
        const newPaused = data.paused !== undefined ? (data.paused === true || data.paused === "true" || data.paused === "1") : !current;
        const saved = store.setPaused(newPaused, targetSid);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, isPaused: saved, scope, sessionId: targetSid }));
      };
      if (req.method === "GET") {
        const data = Object.fromEntries(url.searchParams.entries());
        handleToggleReq(data);
      } else {
        const queryData = Object.fromEntries(url.searchParams.entries());
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            handleToggleReq({ ...queryData, ...JSON.parse(body || "{}") });
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      }
      return;
    }

    if ((req.method === "GET" || req.method === "POST") && url.pathname === "/api/exemptions") {
      const handleExemptReq = (data) => {
        const { scope, targetSid } = resolveTargetSession(data);
        const action = data.action || "get";
        if (action === "toggleCategory" && data.category) {
          store.toggleExemptCategory(data.category, data.enabled !== undefined ? (data.enabled === true || data.enabled === "true" || data.enabled === "1") : null, targetSid);
        } else if (action === "setCategories" && Array.isArray(data.categories)) {
          store.setExemptCategories(data.categories, targetSid);
        } else if (action === "add" && data.ext) {
          store.addCustomExemptExtension(data.ext, targetSid);
        } else if (action === "remove" && data.ext) {
          store.removeCustomExemptExtension(data.ext, targetSid);
        } else if (action === "reset") {
          store.setExemptCategories(null, targetSid);
          store.setCustomExemptExtensions([], targetSid);
        } else if (action === "set" && Array.isArray(data.extensions)) {
          store.setExemptExtensions(data.extensions, targetSid);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          exemptCategories: store.getExemptCategories(targetSid),
          customExtensions: store.getCustomExemptExtensions(targetSid),
          exemptExtensions: store.getExemptExtensions(targetSid),
          scope,
          sessionId: targetSid
        }));
      };
      if (req.method === "GET") {
        const data = Object.fromEntries(url.searchParams.entries());
        handleExemptReq(data);
      } else {
        const queryData = Object.fromEntries(url.searchParams.entries());
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            handleExemptReq({ ...queryData, ...JSON.parse(body || "{}") });
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      }
      return;
    }
    if ((req.method === "GET" || req.method === "POST") && url.pathname === "/api/purge") {
      const handlePurgeReq = (data) => {
        const { scope, convId } = resolveTargetSession(data);
        let result;
        if (scope === "lifetime" || scope === "all") {
          result = store.purge({ scope: "all" });
        } else if (scope === "app" || scope === "session") {
          result = store.purge({ scope: "app", sinceTs: appStartTime });
        } else {
          result = store.purge({ scope: "conversation", sessionId: convId });
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      };
      if (req.method === "GET") {
        const data = Object.fromEntries(url.searchParams.entries());
        handlePurgeReq(data);
      } else {
        const queryData = Object.fromEntries(url.searchParams.entries());
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            handlePurgeReq({ ...queryData, ...JSON.parse(body || "{}") });
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/doctor") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(store.doctor()));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/resume") {
      const data = Object.fromEntries(url.searchParams.entries());
      const { scope, convId } = resolveTargetSession(data);
      let resume;
      if (scope === "lifetime" || scope === "all") {
        resume = store.getResumeState("all", 10);
      } else if (scope === "app" || scope === "session") {
        resume = store.getResumeState("app", 10, { sinceTs: appStartTime });
      } else {
        resume = store.getResumeState(convId, 10);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(resume));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/source-chunks") {
      const sourceId = url.searchParams.get("sourceId");
      const chunks = store.getSourceChunks(sourceId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, sourceId, chunks }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/search") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const data = JSON.parse(body || "{}");
          const queries = Array.isArray(data.queries) ? data.queries : [data.query || ""];
          const result = store.search({ queries, limit: 5 });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/cache-diag") {
      const data = Object.fromEntries(url.searchParams.entries());
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(getCacheDiagPayload(data)));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/handoff") {
      const data = Object.fromEntries(url.searchParams.entries());
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(getHandoffPayload(data)));
      return;
    }

    if ((req.method === "GET" || req.method === "POST") && url.pathname === "/api/maintenance") {
      const queryData = Object.fromEntries(url.searchParams.entries());
      const handleMaintReq = (data) => {
        const action = data.action || "prune";
        const maxAgeDays = parseSafeMaxAgeDays(data.maxAgeDays, 14);
        const vacuum = action === "vacuum" || data.vacuum === true || data.vacuum === "true" || data.vacuum === "1";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(store.pruneByTtl({ maxAgeDays, vacuum })));
      };
      if (req.method === "GET") {
        handleMaintReq(queryData);
      } else {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try { handleMaintReq({ ...queryData, ...JSON.parse(body || "{}") }); } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      }
      return;
    }

    if ((req.method === "GET" || req.method === "POST") && (url.pathname === "/api/cli-filter" || url.pathname === "/api/read-dedup")) {
      const isCli = url.pathname === "/api/cli-filter";
      const queryData = Object.fromEntries(url.searchParams.entries());
      const handleFeatureReq = (data) => {
        const { scope, targetSid } = resolveTargetSession(data);
        const cur = isCli ? store.isCliFilterEnabled(targetSid) : store.isReadDedupEnabled(targetSid);
        const next = data.enabled !== undefined ? (data.enabled === true || data.enabled === "true" || data.enabled === "1") : !cur;
        const saved = isCli ? store.setCliFilterEnabled(next, targetSid) : store.setReadDedupEnabled(next, targetSid);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, [isCli ? "cliFilterEnabled" : "readDedupEnabled"]: saved, scope, sessionId: targetSid }));
      };
      if (req.method === "GET") {
        handleFeatureReq(queryData);
      } else {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try { handleFeatureReq({ ...queryData, ...JSON.parse(body || "{}") }); } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      }
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`[context-mode dashboard] standalone server listening at http://127.0.0.1:${port}`);
  });
}
