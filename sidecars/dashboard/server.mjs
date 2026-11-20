import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { suppressSqliteExperimentalWarning } from "../../hooks/compile-cache.mjs";
suppressSqliteExperimentalWarning();
import { getEffectiveConfig } from "../../context/lib/config.js";
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

const __selfPath = path.resolve(fileURLToPath(import.meta.url));
const __dirname = path.dirname(__selfPath);
const store = new ContextModeStore();
const HTML_FILE = path.join(__dirname, "index.html");
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const SIDECAR_CSRF_TOKEN = crypto.randomBytes(24).toString("hex");

const LOCAL_HOST_RE = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;
const LOCAL_ORIGIN_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;

export function isAllowedHostHeader(hostHeader) {
  if (typeof hostHeader !== "string") return false;
  return LOCAL_HOST_RE.test(hostHeader.trim());
}

export function isAllowedOriginHeader(originHeader) {
  if (originHeader === undefined || originHeader === null || originHeader === "") return true;
  if (typeof originHeader !== "string") return false;
  return LOCAL_ORIGIN_RE.test(originHeader.trim());
}

export function isCrossSiteFetchHeader(secFetchSite) {
  return typeof secFetchSite === "string" && secFetchSite.trim().toLowerCase() === "cross-site";
}

export function isJsonContentType(contentType) {
  return typeof contentType === "string" && /^application\/json(?:\s*;|$)/i.test(contentType.trim());
}

export function timingSafeTokenMatch(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string" || !provided || !expected) {
    return false;
  }
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function readBoundedJsonBody(req, maxBytes = MAX_REQUEST_BODY_BYTES) {
  return new Promise((resolve) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    let overflowed = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on("data", (chunk) => {
      if (overflowed) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      totalBytes += buf.length;
      if (totalBytes > maxBytes) {
        overflowed = true;
        chunks.length = 0;
        req.resume();
        finish({ ok: false, status: 413, error: `Request body exceeds ${Math.round(maxBytes / 1024)} KB limit` });
        return;
      }
      chunks.push(buf);
    });

    req.on("end", () => {
      if (overflowed || settled) return;
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        finish({ ok: true, data: {} });
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          finish({ ok: false, status: 400, error: "Request body must be a JSON object" });
          return;
        }
        finish({ ok: true, data: parsed });
      } catch (err) {
        finish({ ok: false, status: 400, error: err instanceof Error ? err.message : "Invalid JSON body" });
      }
    });

    req.on("error", (err) => {
      finish({ ok: false, status: 400, error: err instanceof Error ? err.message : "Request stream error" });
    });
  });
}

function getPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"));
    if (pkg.version) return pkg.version;
  } catch {}
  return "1.2.0";
}

function getRenderedHtml(csrfToken = SIDECAR_CSRF_TOKEN) {
  const raw = fs.readFileSync(HTML_FILE, "utf8");
  const ver = getPackageVersion();
  const withVer = raw.replace('id="dashboard-version">--</span>', `id="dashboard-version">v${ver}</span>`);
  const tokenMeta = `  <meta name="agy-dart-token" content="${csrfToken}">\n</head>`;
  return withVer.includes("</head>") ? withVer.replace("</head>", tokenMeta) : withVer;
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
  stats.featureRoi = store.getFeatureRoi(
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
  const cfg = getEffectiveConfig();
  const rawTtl = data.ttl !== undefined && data.ttl !== "" ? data.ttl : cfg.cacheTtlSec;
  const explicitTtlSec = parseOptionalPositiveNumber(rawTtl);
  const envWindowTokens = parseOptionalPositiveNumber(cfg.windowTokens);
  const envWarnTokens = parseOptionalPositiveNumber(cfg.warnTokens);
  const envCritTokens = parseOptionalPositiveNumber(cfg.criticalTokens);
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

const isDirectRun = Boolean(
  process.argv[1] &&
    (process.platform === "win32"
      ? path.resolve(process.argv[1]).toLowerCase() === __selfPath.toLowerCase()
      : path.resolve(process.argv[1]) === __selfPath)
);

function handleCutoffMutation(data, defaultConvId = "default") {
  const { scope, targetSid, convId } = resolveTargetSession(data, defaultConvId);
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
}

function handleExemptionsMutation(data, defaultConvId = "default") {
  const { scope, targetSid } = resolveTargetSession(data, defaultConvId);
  const action = data.action || "get";
  if (action === "toggleCategory" && data.category) {
    store.toggleExemptCategory(
      data.category,
      data.enabled !== undefined ? (data.enabled === true || data.enabled === "true" || data.enabled === "1") : null,
      targetSid
    );
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
}

function handleToggleActiveMutation(data, defaultConvId = "default") {
  const { scope, targetSid } = resolveTargetSession(data, defaultConvId);
  const current = store.isPaused(targetSid);
  const newPaused =
    data.paused !== undefined ? (data.paused === true || data.paused === "true" || data.paused === "1") : !current;
  const saved = store.setPaused(newPaused, targetSid);
  return { ok: true, isPaused: saved, scope, sessionId: targetSid };
}

function handlePurgeMutation(data, defaultConvId = "default") {
  const { scope, convId } = resolveTargetSession(data, defaultConvId);
  if (scope === "lifetime" || scope === "all") {
    return store.purge({ scope: "all" });
  } else if (scope === "app" || scope === "session") {
    return store.purge({ scope: "app", sinceTs: appStartTime });
  }
  return store.purge({ scope: "conversation", sessionId: convId });
}

function handleMaintenanceMutation(data) {
  const action = data.action || "prune";
  const maxAgeDays = parseSafeMaxAgeDays(data.maxAgeDays, 14);
  const vacuum = action === "vacuum" || data.vacuum === true || data.vacuum === "true" || data.vacuum === "1";
  return store.pruneByTtl({ maxAgeDays, vacuum });
}

function handleFeatureToggleMutation(isCli, data, defaultConvId = "default") {
  const { scope, targetSid } = resolveTargetSession(data, defaultConvId);
  const cur = isCli ? store.isCliFilterEnabled(targetSid) : store.isReadDedupEnabled(targetSid);
  const next = data.enabled !== undefined ? (data.enabled === true || data.enabled === "true" || data.enabled === "1") : !cur;
  const saved = isCli ? store.setCliFilterEnabled(next, targetSid) : store.setReadDedupEnabled(next, targetSid);
  return { ok: true, [isCli ? "cliFilterEnabled" : "readDedupEnabled"]: saved, scope, sessionId: targetSid };
}

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(JSON.stringify(payload));
}

const MUTATING_ENDPOINTS = new Set([
  "/api/cutoff",
  "/api/exemptions",
  "/api/toggle-active",
  "/api/paused",
  "/api/purge",
  "/api/maintenance",
  "/api/cli-filter",
  "/api/read-dedup"
]);

export function createStandaloneServer({ csrfToken = SIDECAR_CSRF_TOKEN, maxBodyBytes = MAX_REQUEST_BODY_BYTES } = {}) {
  return http.createServer(async (req, res) => {
    // 1. Anti-DNS-rebinding Host validation & anti-CSRF Origin/Sec-Fetch-Site validation
    if (!isAllowedHostHeader(req.headers.host)) {
      sendJson(res, 403, { error: "Forbidden host header" });
      return;
    }
    if (!isAllowedOriginHeader(req.headers.origin) || isCrossSiteFetchHeader(req.headers["sec-fetch-site"])) {
      sendJson(res, 403, { error: "Cross-origin request blocked" });
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store"
      });
      res.end(getRenderedHtml(csrfToken));
      return;
    }

    // 2. Read-only GET API endpoints
    if (req.method === "GET" && url.pathname === "/api/stats") {
      const data = Object.fromEntries(url.searchParams.entries());
      sendJson(res, 200, getStatsPayload(data));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/doctor") {
      sendJson(res, 200, store.doctor());
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
      sendJson(res, 200, resume);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/source-chunks") {
      const sourceId = url.searchParams.get("sourceId");
      const chunks = store.getSourceChunks(sourceId);
      sendJson(res, 200, { ok: true, sourceId, chunks });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/cache-diag") {
      const data = Object.fromEntries(url.searchParams.entries());
      sendJson(res, 200, getCacheDiagPayload(data));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/handoff") {
      const data = Object.fromEntries(url.searchParams.entries());
      sendJson(res, 200, getHandoffPayload(data));
      return;
    }

    // 3. POST-only /api/search (read-only query, bounded JSON body)
    if (url.pathname === "/api/search") {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "Method Not Allowed: use POST with application/json" }, { Allow: "POST" });
        return;
      }
      if (!isJsonContentType(req.headers["content-type"])) {
        sendJson(res, 415, { error: "Content-Type must be application/json" });
        return;
      }
      const parsed = await readBoundedJsonBody(req, maxBodyBytes);
      if (!parsed.ok) {
        sendJson(res, parsed.status, { error: parsed.error });
        return;
      }
      const queries = Array.isArray(parsed.data.queries) ? parsed.data.queries : [parsed.data.query || ""];
      sendJson(res, 200, store.search({ queries, limit: 5 }));
      return;
    }

    // 4. Mutating endpoints: strictly POST + application/json + per-process CSRF token + <= 64 KB body
    if (MUTATING_ENDPOINTS.has(url.pathname)) {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "Method Not Allowed: mutating endpoints require POST" }, { Allow: "POST" });
        return;
      }
      if (!timingSafeTokenMatch(req.headers["x-agy-dart-token"], csrfToken)) {
        sendJson(res, 403, { error: "Invalid or missing X-Agy-Dart-Token" });
        return;
      }
      if (!isJsonContentType(req.headers["content-type"])) {
        sendJson(res, 415, { error: "Content-Type must be application/json" });
        return;
      }
      const parsed = await readBoundedJsonBody(req, maxBodyBytes);
      if (!parsed.ok) {
        sendJson(res, parsed.status, { error: parsed.error });
        return;
      }
      const data = parsed.data;
      if (url.pathname === "/api/cutoff") {
        sendJson(res, 200, handleCutoffMutation(data));
      } else if (url.pathname === "/api/toggle-active" || url.pathname === "/api/paused") {
        sendJson(res, 200, handleToggleActiveMutation(data));
      } else if (url.pathname === "/api/exemptions") {
        sendJson(res, 200, handleExemptionsMutation(data));
      } else if (url.pathname === "/api/purge") {
        sendJson(res, 200, handlePurgeMutation(data));
      } else if (url.pathname === "/api/maintenance") {
        sendJson(res, 200, handleMaintenanceMutation(data));
      } else if (url.pathname === "/api/cli-filter" || url.pathname === "/api/read-dedup") {
        sendJson(res, 200, handleFeatureToggleMutation(url.pathname === "/api/cli-filter", data));
      }
      return;
    }

    res.writeHead(404, { "X-Content-Type-Options": "nosniff" });
    res.end("Not Found");
  });
}

if (isDirectRun) {
  let SidecarApp = null;

  try {
    const userSdkPath = path.join(os.homedir(), ".gemini", "config", "node_modules", "sidecar_sdk", "index.mjs");
    const sdkModule = await import(pathToFileURL(userSdkPath).href);
    SidecarApp = sdkModule.SidecarApp;
  } catch {
    try {
      const sdkModule = await import("sidecar_sdk");
      SidecarApp = sdkModule.SidecarApp;
    } catch {
      // Standalone fallback
    }
  }

  const isSidecarEnv = Boolean(
    process.env.ANTIGRAVITY_LS_ADDRESS &&
    process.env.ANTIGRAVITY_CSRF_TOKEN &&
    process.env.ANTIGRAVITY_SIDECAR_WEB_PORT &&
    process.env.SIDECAR_FORCE_HTTP !== "1" &&
    SidecarApp
  );

  if (isSidecarEnv) {
    const app = new SidecarApp();

    app.page("/", () => {
      return getRenderedHtml(SIDECAR_CSRF_TOKEN);
    });

    // Strictly read-only GET routes
    app.api("/api/stats", (data) => getStatsPayload(data, app.config.conversationId), "GET");
    app.api("/api/doctor", () => store.doctor(), "GET");
    app.api("/api/resume", (data) => {
      const { scope, convId } = resolveTargetSession(data, app.config.conversationId);
      if (scope === "lifetime" || scope === "all") return store.getResumeState("all", 10);
      if (scope === "app" || scope === "session") return store.getResumeState("app", 10, { sinceTs: appStartTime });
      return store.getResumeState(convId, 10);
    }, "GET");
    app.api("/api/source-chunks", (data) => {
      const sourceId = data.sourceId;
      if (!sourceId) return { ok: false, chunks: [] };
      return { ok: true, sourceId, chunks: store.getSourceChunks(sourceId) };
    }, "GET");
    app.api("/api/cache-diag", (data) => getCacheDiagPayload(data, app.config.conversationId), "GET");
    app.api("/api/handoff", (data) => getHandoffPayload(data, app.config.conversationId), "GET");

    // POST-only routes so sidecar_sdk always enforces X-Sidecar-Token validation (non-GET)
    app.api("/api/search", (data) => {
      const queries = Array.isArray(data.queries) ? data.queries : [data.query || ""];
      return store.search({ queries, limit: 5 });
    }, "POST");
    app.api("/api/cutoff", (data) => handleCutoffMutation(data, app.config.conversationId), "POST");
    app.api("/api/exemptions", (data) => handleExemptionsMutation(data, app.config.conversationId), "POST");
    app.api("/api/toggle-active", (data) => handleToggleActiveMutation(data, app.config.conversationId), "POST");
    app.api("/api/paused", (data) => handleToggleActiveMutation(data, app.config.conversationId), "POST");
    app.api("/api/purge", (data) => handlePurgeMutation(data, app.config.conversationId), "POST");
    app.api("/api/maintenance", (data) => handleMaintenanceMutation(data), "POST");
    app.api("/api/cli-filter", (data) => handleFeatureToggleMutation(true, data, app.config.conversationId), "POST");
    app.api("/api/read-dedup", (data) => handleFeatureToggleMutation(false, data, app.config.conversationId), "POST");

    await app.run();
    console.log(`[context-mode sidecar] registered and running`);
  } else {
    const port = process.env.PORT || 8765;
    const server = createStandaloneServer();
    server.listen(port, "127.0.0.1", () => {
      console.log(`[context-mode dashboard] standalone server listening at http://127.0.0.1:${port}`);
    });
  }
}
