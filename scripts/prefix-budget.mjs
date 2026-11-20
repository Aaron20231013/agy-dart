#!/usr/bin/env node
/**
 * agy-dart Turn-0 Prefix Budget & Schema Determinism Auditor.
 * Measures the 4 always-loaded prompt prefix blocks:
 *   1. brake     (rules/AGENTS.md)
 *   2. reference (skills/agy-dart/SKILL.md YAML frontmatter vs on-demand body)
 *   3. tools     (live JSON-RPC tools/list from fast/mcp-server.mjs & context/server.js + SHA-256 fingerprints)
 *   4. startup   (live hooks/session-start.mjs output split into stable prefix vs volatile Git tail)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  extractStepTokenUsage,
  findTranscriptForConversation,
  parseTranscriptLines
} from "../context/lib/cache-analyzer.js";
import { sha256Hex, stableSortObject, stableStringify } from "../context/lib/stable-json.js";
import { getEffectiveConfig } from "../context/lib/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const TOKEN_WARN_LIMIT = 4000;

function isCjkCodePoint(cp) {
  return (
    (cp >= 0x2e80 && cp <= 0x9fff) || // CJK radicals, punctuation, Kana, Bopomofo, Unified Ideographs & Ext A
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compatibility Forms
    (cp >= 0xff00 && cp <= 0xffef) || // Fullwidth & Halfwidth Forms
    (cp >= 0x20000 && cp <= 0x2fa1f)  // CJK Ext B-F & Compat Supplement
  );
}

/**
 * CJK/UTF-8 aware token estimator (zero-dependency):
 * - Pure ASCII: 0.25 tok/char (exact match to chars/4)
 * - CJK / Kana / Hangul / fullwidth: 1.25 tok/char (within empirical ~1.0-1.5 tok/char range)
 * - Other non-ASCII BMP (accented Latin, Cyrillic, symbols): 1.0 tok/char
 * - Supplementary plane / emoji (> 0xFFFF, non-CJK): 1.5 tok/char
 * - Numeric fallback: Math.ceil(Math.max(0, n) / 4)
 */
export function estimateTokens(input) {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input <= 0) return 0;
    return Math.ceil(input / 4);
  }
  if (typeof input !== "string" || input.length === 0) {
    return 0;
  }
  // Track in quarter-token integers (exact, zero IEEE-754 rounding drift)
  let quarterTokens = 0;
  for (let i = 0; i < input.length; ) {
    const cp = input.codePointAt(i);
    i += cp > 0xffff ? 2 : 1;
    if (cp <= 0x7f) {
      quarterTokens += 1; // 0.25 tok/char
    } else if (isCjkCodePoint(cp)) {
      quarterTokens += 5; // 1.25 tok/char
    } else if (cp > 0xffff) {
      quarterTokens += 6; // 1.50 tok/char (emoji / astral symbols)
    } else {
      quarterTokens += 4; // 1.00 tok/char (other non-ASCII)
    }
  }
  return Math.ceil(quarterTokens / 4);
}

/**
 * Empirical cross-script calibration corpus with reference BPE/SentencePiece token counts
 * (measured across cl100k_base / Claude / Gemini tokenizers). Used to quantify estimator
 * error bounds and prevent hidden Turn-0 budget overruns.
 */
export const TOKEN_CALIBRATION_CORPUS = Object.freeze([
  {
    id: "ascii-js-code",
    text: 'export function computeBudget(items) {\n  return items.reduce((acc, item) => acc + Math.max(0, item.bytes), 0);\n}\n',
    actualTokens: 29
  },
  {
    id: "mcp-json-schema",
    text: '{"name":"batch_search","description":"Run 1-20 concurrent search queries","inputSchema":{"type":"object","properties":{"queries":{"type":"array"}},"required":["queries"]}}',
    actualTokens: 43
  },
  {
    id: "markdown-rules",
    text: "# Tool Routing\n- Use `batch_search` for >=2 text/regex/glob queries.\n- Use `apply_edits` for multi-file edits + inline verify.\n- Keep inline output <= 8.8 KB UTF-8.\n",
    actualTokens: 44
  },
  {
    id: "cjk-prose",
    text: "本项目面向原生一体化插件，提供极速批处理、沙盒过滤、上下文护栏与服务端缓存诊断，严格遵循零运行期依赖约束。",
    actualTokens: 58
  },
  {
    id: "mixed-cjk-code",
    text: "调用 `ctx_execute({ language: 'python' })` 过滤超大日志（>16 KB），输出严格控制在 <= 8.8 KB 内联预算。",
    actualTokens: 46
  }
]);

export const ESTIMATOR_ERROR_BAND_PCT = 15;

/**
 * Evaluate `estimateTokens` against a set of `{ id, text, actualTokens }` samples
 * (either built-in corpus or real transcript `usageMetadata` samples).
 */
export function calibrateTokenEstimator(samples = TOKEN_CALIBRATION_CORPUS) {
  const details = [];
  let absErrSum = 0;
  let relErrSum = 0;
  let signedRelSum = 0;
  let maxRelErr = 0;

  for (const s of samples) {
    if (!s || typeof s.text !== "string" || !Number.isFinite(s.actualTokens) || s.actualTokens <= 0) {
      continue;
    }
    const estimated = estimateTokens(s.text);
    const diff = estimated - s.actualTokens;
    const relErr = Math.abs(diff) / s.actualTokens;
    const signedRel = diff / s.actualTokens;
    absErrSum += Math.abs(diff);
    relErrSum += relErr;
    signedRelSum += signedRel;
    if (relErr > maxRelErr) maxRelErr = relErr;
    details.push({
      id: s.id || "sample",
      actualTokens: s.actualTokens,
      estimatedTokens: estimated,
      errorTokens: diff,
      relErrorPct: Number((relErr * 100).toFixed(1))
    });
  }

  const n = details.length;
  return {
    sampleCount: n,
    maeTokens: n > 0 ? Number((absErrSum / n).toFixed(2)) : 0,
    mapePct: n > 0 ? Number(((relErrSum / n) * 100).toFixed(1)) : 0,
    maxRelErrorPct: Number((maxRelErr * 100).toFixed(1)),
    meanBiasPct: n > 0 ? Number(((signedRelSum / n) * 100).toFixed(1)) : 0,
    recommendedErrorBandPct: ESTIMATOR_ERROR_BAND_PCT,
    samples: details
  };
}

function collectStepVisibleText(step) {
  if (!step || typeof step !== "object") return { text: "", hasMedia: false };
  const hasMedia = Boolean(
    step.media ||
      step.images ||
      step.type === "image" ||
      (Array.isArray(step.content) &&
        step.content.some((p) => p && typeof p === "object" && (p.type === "image" || p.type === "image_url" || p.type === "media")))
  );
  const parts = [];
  for (const key of ["content", "output", "result", "user_input", "text"]) {
    const val = step[key];
    if (typeof val === "string" && val) {
      parts.push(val);
    } else if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === "string") parts.push(item);
        else if (item && typeof item === "object" && typeof item.text === "string") parts.push(item.text);
      }
    }
  }
  if (step.tool_result !== undefined) {
    parts.push(typeof step.tool_result === "string" ? step.tool_result : JSON.stringify(step.tool_result));
  }
  return { text: parts.join("\n"), hasMedia };
}

/**
 * Extract empirical `{ id, text, actualTokens }` calibration pairs from real transcript
 * steps using actual provider `usageMetadata` / `input_tokens` context deltas between turns.
 */
export function extractTranscriptCalibrationSamples(steps = [], { minActualTokens = 50, minChars = 100 } = {}) {
  const samples = [];
  if (!Array.isArray(steps) || steps.length === 0) return samples;

  let prevCtx = null;
  let prevOut = 0;
  let accParts = [];
  let sawMedia = false;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step || typeof step !== "object") continue;

    // Direct single-step labeled sample (e.g. `{ text, usageMetadata: { promptTokenCount } }`)
    if (typeof step.text === "string" && step.text.length >= minChars && step.usageMetadata && !prevCtx) {
      const directTok = Number(
        step.usageMetadata.promptTokenCount ??
          step.usageMetadata.input_tokens ??
          step.usageMetadata.totalTokenCount ??
          0
      );
      if (Number.isFinite(directTok) && directTok >= minActualTokens && accParts.length === 0) {
        samples.push({
          id: String(step.id || `step#${step.step_index ?? i}`),
          text: step.text,
          actualTokens: Math.round(directTok)
        });
        continue;
      }
    }

    const usage = extractStepTokenUsage(step);
    const hasUsage = Boolean(usage && usage.contextTokens > 0);
    if (hasUsage) {
      if (prevCtx !== null && usage.contextTokens > prevCtx && accParts.length > 0 && !sawMedia) {
        const text = accParts.join("\n");
        const actualDelta = usage.contextTokens - prevCtx - prevOut;
        if (actualDelta >= minActualTokens && text.length >= minChars) {
          samples.push({
            id: `turn#${step.step_index ?? i}`,
            text,
            actualTokens: Math.round(actualDelta)
          });
        }
      }
      prevCtx = usage.contextTokens;
      prevOut = (usage.outputTokens || 0) + (usage.thinkingTokens || 0);
      accParts = [];
      sawMedia = false;
    } else {
      const { text, hasMedia } = collectStepVisibleText(step);
      if (hasMedia) sawMedia = true;
      if (text) accParts.push(text);
    }
  }

  return samples;
}

/**
 * Calibrate `estimateTokens` against a real transcript JSONL file (or pre-parsed steps array).
 * Falls back transparently to `TOKEN_CALIBRATION_CORPUS` if the transcript has no usable pairs.
 */
export function calibrateFromTranscript(transcriptPathOrSteps) {
  let steps = [];
  let transcriptPath = null;
  if (typeof transcriptPathOrSteps === "string") {
    transcriptPath = path.resolve(transcriptPathOrSteps);
    if (fs.existsSync(transcriptPath)) {
      steps = parseTranscriptLines(fs.readFileSync(transcriptPath, "utf8"));
    }
  } else if (Array.isArray(transcriptPathOrSteps)) {
    steps = transcriptPathOrSteps;
  }

  const extracted = extractTranscriptCalibrationSamples(steps);
  if (extracted.length > 0) {
    const metrics = calibrateTokenEstimator(extracted);
    const recommendedBand = Math.max(
      ESTIMATOR_ERROR_BAND_PCT,
      Math.min(50, Math.ceil(metrics.mapePct / 5) * 5)
    );
    return {
      source: "transcript",
      transcriptPath,
      fallbackUsed: false,
      ...metrics,
      recommendedErrorBandPct: recommendedBand
    };
  }

  return {
    source: "reference_corpus",
    transcriptPath,
    fallbackUsed: true,
    ...calibrateTokenEstimator(TOKEN_CALIBRATION_CORPUS)
  };
}

function splitFrontmatter(markdown) {
  const normalized = String(markdown || "");
  const match = normalized.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return { frontmatter: "", body: normalized };
  }
  const frontmatter = match[0];
  const body = normalized.slice(frontmatter.length);
  return { frontmatter, body };
}

function splitStartupStability(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  const lines = normalized ? normalized.split("\n") : [];
  const volatileIdx = lines.findIndex((line) =>
    /^(?:Git:|Working tree:|Modified \(|Recent commits:)/.test(line)
  );
  if (volatileIdx === -1) {
    return { stableText: normalized, volatileText: "" };
  }
  return {
    stableText: lines.slice(0, volatileIdx).join("\n"),
    volatileText: lines.slice(volatileIdx).join("\n")
  };
}

function fetchMcpTools(scriptPath, extraEnv = {}, baseEnv = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...baseEnv, ...extraEnv }
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`MCP tools/list timed out: ${scriptPath}`));
    }, 6000);
    timer.unref();

    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const lines = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length < 2) {
        return reject(new Error(`Incomplete MCP response (exit ${code}): ${stderr || stdout}`));
      }
      try {
        const listResp = JSON.parse(lines[1]);
        const tools = listResp?.result?.tools;
        if (!Array.isArray(tools)) {
          return reject(new Error(`Invalid MCP tools/list response from ${scriptPath}`));
        }
        resolve({
          rawLine: lines[1],
          tools
        });
      } catch (err) {
        reject(err);
      }
    });

    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "agy-dart-prefix-budget", version: "1.0" }
        }
      }) + "\n"
    );
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    child.stdin.end();
  });
}

function runSessionStartHook(rootDir, dbPath, options = {}) {
  const hookScript = path.join(rootDir, "hooks", "session-start.mjs");
  const childEnv = { ...(options.env || process.env), AGY_DART_DB_PATH: dbPath };
  // Prevent inherited subagent env markers from silently stripping volatile Git tail
  // when prefix-budget audits a top-level Turn-0 session from inside a worker/subagent.
  if (!options.env || !Object.prototype.hasOwnProperty.call(options.env, "ANTIGRAVITY_PARENT_CONVERSATION_ID")) {
    delete childEnv.ANTIGRAVITY_PARENT_CONVERSATION_ID;
  }
  if (!options.env || !Object.prototype.hasOwnProperty.call(options.env, "ANTIGRAVITY_SUBAGENT")) {
    delete childEnv.ANTIGRAVITY_SUBAGENT;
  }
  if (options.configPath) {
    childEnv.AGY_DART_CONFIG_PATH = options.configPath;
  }
  if (options.stableOnly === true) {
    childEnv.AGY_DART_STABLE_PREFIX_ONLY = "1";
  } else if (options.stableOnly === false) {
    childEnv.AGY_DART_STABLE_PREFIX_ONLY = "0";
  }
  const res = spawnSync(process.execPath, [hookScript], {
    input: JSON.stringify({
      cwd: rootDir,
      workspacePaths: [rootDir],
      hookEventName: "SessionStart"
    }),
    encoding: "utf8",
    timeout: 8000,
    windowsHide: true,
    env: childEnv
  });
  if (res.error || res.status !== 0) {
    throw new Error(`SessionStart hook failed: ${res.stderr || res.error?.message || `exit ${res.status}`}`);
  }
  const parsed = JSON.parse(res.stdout.trim());
  return parsed?.injectSteps?.[0]?.systemMessage?.systemMessage || "";
}

export async function auditPrefixBudget(rootDir = REPO_ROOT, options = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-prefix-budget-"));
  const tmpDb = path.join(tmpDir, "prefix-budget.db");
  const cfgOpts = {};
  if (options.configPath) cfgOpts.configPath = options.configPath;
  if (options.env) cfgOpts.env = options.env;
  const effectiveCfg = getEffectiveConfig(cfgOpts);
  const stablePrefixOnly =
    options.stableOnly !== undefined
      ? Boolean(options.stableOnly)
      : Boolean(effectiveCfg.stablePrefixOnly);

  try {
    // 1. brake: rules/AGENTS.md
    const agentsPath = path.join(rootDir, "rules", "AGENTS.md");
    const agentsText = fs.readFileSync(agentsPath, "utf8");
    const brake = {
      file: "rules/AGENTS.md",
      bytes: Buffer.byteLength(agentsText, "utf8"),
      chars: agentsText.length,
      tokens: estimateTokens(agentsText),
      sha256: sha256Hex(agentsText)
    };

    // 2. reference: skills/agy-dart/SKILL.md (only YAML frontmatter counts toward Turn-0 resident total)
    const skillPath = path.join(rootDir, "skills", "agy-dart", "SKILL.md");
    const skillText = fs.readFileSync(skillPath, "utf8");
    const { frontmatter, body } = splitFrontmatter(skillText);
    const reference = {
      file: "skills/agy-dart/SKILL.md",
      frontmatterBytes: Buffer.byteLength(frontmatter, "utf8"),
      frontmatterChars: frontmatter.length,
      frontmatterTokens: estimateTokens(frontmatter),
      bodyBytes: Buffer.byteLength(body, "utf8"),
      bodyChars: body.length,
      bodyTokens: estimateTokens(body),
      totalBytes: Buffer.byteLength(skillText, "utf8"),
      frontmatterSha256: sha256Hex(frontmatter)
    };

    // 3. tools: live JSON-RPC handshake with both MCP servers
    const mcpBaseEnv = options.env || process.env;
    const mcpExtra = options.configPath ? { AGY_DART_CONFIG_PATH: options.configPath } : {};
    const [fastRes, ctxRes] = await Promise.all([
      fetchMcpTools(path.join(rootDir, "fast", "mcp-server.mjs"), mcpExtra, mcpBaseEnv),
      fetchMcpTools(path.join(rootDir, "context", "server.js"), { ...mcpExtra, AGY_DART_DB_PATH: tmpDb }, mcpBaseEnv)
    ]);

    const isSortedByName = (list) => {
      if (!Array.isArray(list) || list.length === 0) return false;
      for (let i = 1; i < list.length; i++) {
        if (String(list[i - 1]?.name ?? "") >= String(list[i]?.name ?? "")) {
          return false;
        }
      }
      return true;
    };

    const fastJson = JSON.stringify(fastRes.tools);
    const ctxJson = JSON.stringify(ctxRes.tools);
    const combinedToolsJson = stableStringify({
      context: ctxRes.tools,
      fast: fastRes.tools
    });
    const fastCanonicalMatch = isSortedByName(fastRes.tools) && fastJson === stableStringify(fastRes.tools);
    const ctxCanonicalMatch = isSortedByName(ctxRes.tools) && ctxJson === stableStringify(ctxRes.tools);

    const fastMeta = {
      toolCount: fastRes.tools.length,
      names: fastRes.tools.map((t) => t.name),
      bytes: Buffer.byteLength(fastJson, "utf8"),
      chars: fastJson.length,
      tokens: estimateTokens(fastJson),
      canonical: fastCanonicalMatch,
      sha256: sha256Hex(fastJson)
    };

    const ctxMeta = {
      toolCount: ctxRes.tools.length,
      names: ctxRes.tools.map((t) => t.name),
      bytes: Buffer.byteLength(ctxJson, "utf8"),
      chars: ctxJson.length,
      tokens: estimateTokens(ctxJson),
      canonical: ctxCanonicalMatch,
      sha256: sha256Hex(ctxJson)
    };

    const toolsFingerprint = sha256Hex(combinedToolsJson);
    const tools = {
      toolCount: fastMeta.toolCount + ctxMeta.toolCount,
      bytes: fastMeta.bytes + ctxMeta.bytes,
      chars: fastMeta.chars + ctxMeta.chars,
      tokens: fastMeta.tokens + ctxMeta.tokens,
      canonical: fastCanonicalMatch && ctxCanonicalMatch,
      fingerprint: toolsFingerprint,
      fast: fastMeta,
      context: ctxMeta
    };

    // 4. startup: live hooks/session-start.mjs output split into stable vs volatile Git tail
    const startupText = runSessionStartHook(rootDir, tmpDb, {
      stableOnly: stablePrefixOnly,
      configPath: options.configPath,
      env: options.env
    });
    const { stableText, volatileText } = splitStartupStability(startupText);
    const startupTotalBytes = Buffer.byteLength(startupText, "utf8");
    const stableBytes = Buffer.byteLength(stableText, "utf8");
    const volatileBytes = Buffer.byteLength(volatileText, "utf8");
    const denom = stableBytes + volatileBytes;
    const stablePct = denom > 0 ? Number(((stableBytes / denom) * 100).toFixed(1)) : 100;
    const volatilePct = denom > 0 ? Number(((volatileBytes / denom) * 100).toFixed(1)) : 0;
    const stableTokens = estimateTokens(stableText);

    const startup = {
      bytes: startupTotalBytes,
      chars: startupText.length,
      tokens: estimateTokens(startupText),
      stableTokens,
      stablePrefixOnly,
      stableBytes,
      volatileBytes,
      stablePct,
      volatilePct,
      stableSha256: sha256Hex(stableText),
      fullSha256: sha256Hex(startupText)
    };

    const totalBytes = brake.bytes + reference.frontmatterBytes + tools.bytes + startup.bytes;
    const totalChars = brake.chars + reference.frontmatterChars + tools.chars + startup.chars;
    const totalTokens = brake.tokens + reference.frontmatterTokens + tools.tokens + startup.tokens;
    const stableOnlyTokens = brake.tokens + reference.frontmatterTokens + tools.tokens + stableTokens;
    const errorBandPct = ESTIMATOR_ERROR_BAND_PCT;
    const upperBoundTokens = Math.ceil(totalTokens * (1 + errorBandPct / 100));
    const exceedsBudget = totalTokens > TOKEN_WARN_LIMIT;
    const exceedsUpperBound = upperBoundTokens > TOKEN_WARN_LIMIT;
    const warnings = [];
    if (exceedsBudget) {
      warnings.push(`Turn-0 resident prefix (${totalTokens} est. tokens) exceeds recommended ${TOKEN_WARN_LIMIT}-token budget.`);
    } else if (exceedsUpperBound) {
      warnings.push(`Turn-0 resident prefix upper bound (${upperBoundTokens} tok at +${errorBandPct}%) exceeds ${TOKEN_WARN_LIMIT}-token budget.`);
    }
    if (!tools.canonical) {
      warnings.push("MCP tools/list output is not canonically sorted/serialized.");
    }
    const warning = warnings.length > 0 ? warnings.join(" ") : null;

    return stableSortObject({
      rootDir,
      budgetLimitTokens: TOKEN_WARN_LIMIT,
      stablePrefixOnly,
      stableOnlyTokens,
      totalBytes,
      totalChars,
      totalTokens,
      errorBandPct,
      upperBoundTokens,
      exceedsBudget,
      exceedsUpperBound,
      warning,
      toolsFingerprint,
      blocks: {
        brake,
        reference,
        tools,
        startup
      }
    });
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {}
  }
}

function formatHumanReport(report) {
  const { brake, reference, tools, startup } = report.blocks;
  const startupModeNote = report.stablePrefixOnly ? " [stable-only]" : "";
  const lines = [
    "# agy-dart Turn-0 Prefix Budget & Determinism Audit",
    "",
    "| Block | Scope | Bytes | Chars | Est. Tokens | Notes |",
    "| :--- | :--- | ---: | ---: | ---: | :--- |",
    `| 1. brake | \`${brake.file}\` | ${brake.bytes} | ${brake.chars} | ${brake.tokens} | sha256:${brake.sha256.slice(0, 12)} |`,
    `| 2. reference | \`${reference.file}\` (frontmatter) | ${reference.frontmatterBytes} | ${reference.frontmatterChars} | ${reference.frontmatterTokens} | on-demand body: ${reference.bodyBytes} B (${reference.bodyTokens} tok, excluded) |`,
    `| 3. tools (fast) | \`fast/mcp-server.mjs\` (${tools.fast.toolCount} tools) | ${tools.fast.bytes} | ${tools.fast.chars} | ${tools.fast.tokens} | sha256:${tools.fast.sha256.slice(0, 12)} |`,
    `| 3. tools (context) | \`context/server.js\` (${tools.context.toolCount} tools) | ${tools.context.bytes} | ${tools.context.chars} | ${tools.context.tokens} | sha256:${tools.context.sha256.slice(0, 12)} |`,
    `| 4. startup | \`hooks/session-start.mjs\`${startupModeNote} | ${startup.bytes} | ${startup.chars} | ${startup.tokens} | stable: ${startup.stablePct}% (${startup.stableBytes} B) / volatile Git tail: ${startup.volatilePct}% (${startup.volatileBytes} B) |`,
    `| **TOTAL (Turn-0)** | **Always-loaded prefix** | **${report.totalBytes}** | **${report.totalChars}** | **${report.totalTokens}** | budget <= ${report.budgetLimitTokens} tok (±${report.errorBandPct}% band -> <= ${report.upperBoundTokens} tok; stable-only: ${report.stableOnlyTokens} tok) |`,
    "",
    `Tools Fingerprint (SHA-256): ${report.toolsFingerprint}`,
    `  - fast    : ${tools.fast.sha256} (canonical=${tools.fast.canonical})`,
    `  - context : ${tools.context.sha256} (canonical=${tools.context.canonical})`
  ];

  if (report.warning) {
    lines.push("", `WARNING: ${report.warning}`);
  }
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const stableOnly = args.includes("--stable-only");
  const calibrate = args.includes("--calibrate");
  const autoTranscript = args.includes("--auto-transcript");
  let transcriptPath = "";
  const trIdx = args.indexOf("--transcript");
  if (trIdx !== -1 && args[trIdx + 1]) {
    transcriptPath = path.resolve(args[trIdx + 1]);
  } else if (autoTranscript) {
    transcriptPath = findTranscriptForConversation() || "";
  }
  let rootDir = REPO_ROOT;
  const targetIdx = args.indexOf("--target");
  if (targetIdx !== -1 && args[targetIdx + 1]) {
    rootDir = path.resolve(args[targetIdx + 1]);
  }

  if (calibrate) {
    const cal = transcriptPath ? calibrateFromTranscript(transcriptPath) : calibrateTokenEstimator();
    if (asJson) {
      process.stdout.write(JSON.stringify(cal, null, 2) + "\n");
    } else {
      const label =
        cal.source === "transcript"
          ? `${cal.sampleCount} transcript usageMetadata turns (${path.basename(cal.transcriptPath || "transcript")})`
          : `${cal.sampleCount} cross-script samples`;
      console.log(`Token estimator calibration (${label}):`);
      console.log(`  - MAE          : ${cal.maeTokens} tokens`);
      console.log(`  - MAPE         : ${cal.mapePct}% (max rel error: ${cal.maxRelErrorPct}%)`);
      console.log(`  - Mean bias    : ${cal.meanBiasPct >= 0 ? "+" : ""}${cal.meanBiasPct}%`);
      console.log(`  - Safety band  : ±${cal.recommendedErrorBandPct}%`);
    }
    return;
  }

  const report = await auditPrefixBudget(rootDir, stableOnly ? { stableOnly: true } : {});
  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(formatHumanReport(report) + "\n");
  }
  if (report.exceedsBudget || report.exceedsUpperBound || !report.blocks?.tools?.canonical) {
    process.exitCode = 1;
  }
}

const selfPath = path.resolve(fileURLToPath(import.meta.url));
const isDirectRun = Boolean(
  process.argv[1] &&
    (process.platform === "win32"
      ? path.resolve(process.argv[1]).toLowerCase() === selfPath.toLowerCase()
      : path.resolve(process.argv[1]) === selfPath)
);
if (isDirectRun) {
  main().catch((err) => {
    console.error(`prefix:budget error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
