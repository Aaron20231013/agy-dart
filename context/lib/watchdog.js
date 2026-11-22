/**
 * agy-dart Sidecar Stall Watchdog Engine (v1.4.0)
 *
 * Dual-source fusion state machine combining:
 *   1. Execution leases written by lifecycle hooks (PreInvocation / PreToolUse / PostToolUse / Stop)
 *      via `context/lib/watchdog-lease.js` into SQLite `meta` under `watchdog_lease:<directConvId>`.
 *   2. Low-frequency Sidecar polling + `transcript.jsonl` stat (`mtimeMs`/`size`) & bounded tail
 *      self-healing (catches missing `Stop` hooks and extends silence timers while transcript grows).
 *
 * Design invariants:
 *   - Strictly zero-dependency, fail-open, zero CDP, never kills host/user processes.
 *   - Zero `fs.statSync` calls when all leases are IDLE.
 *   - Sleep/lid-close drift guard prevents false red alerts after OS suspend/resume.
 *   - Pre-generates redacted Rescue Handoff Brief + 1-2 targeted troubleshooting tips on red `stalled`.
 *   - Desktop OS notifications are opt-in (default OFF) and debounced per incident/cooldown.
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import { getEffectiveConfig, parseUiLang } from "./config.js";
import { buildHandoffBrief, inferWorkspaceFromStore, isSafeWorkspaceDir } from "./handoff.js";
import {
  DEFAULT_CACHE_TTL_SEC,
  estimateCalibratedTtl,
  extractStepTokenUsage,
  findTranscriptForConversation,
  isSlashCompactText,
  isSubagentStep,
  readTranscriptTail,
  resolveModelProfile
} from "./cache-analyzer.js";
import {
  HEADLESS_FINISH_PROMPT_RE,
  WATCHDOG_LEASE_PREFIX,
  WATCHDOG_PHASES,
  KNOWN_MCP_TOOL_RE,
  LONG_MCP_TOOL_RE,
  classifyToolExecutionKind,
  deriveLlmSubphase,
  extractBareToolName,
  getToolTimeoutTier,
  getWatchdogLeaseKey,
  isHeadlessWorkerPrompt,
  isSubagentLeasePayload,
  listWatchdogLeases,
  normalizeWatchdogLease,
  parseMaybeJsonObj,
  readWatchdogLease,
  recordHookLeaseTransition,
  sanitizeConversationId,
  sanitizeWatchdogText,
  writeWatchdogLease,
  writeWatchdogLeaseIfUnchanged
} from "./watchdog-lease.js";

export {
  HEADLESS_FINISH_PROMPT_RE,
  WATCHDOG_LEASE_PREFIX,
  WATCHDOG_PHASES,
  classifyToolExecutionKind,
  getToolTimeoutTier,
  getWatchdogLeaseKey,
  isHeadlessWorkerPrompt,
  isSubagentLeasePayload,
  listWatchdogLeases,
  normalizeWatchdogLease,
  readWatchdogLease,
  recordHookLeaseTransition,
  sanitizeConversationId,
  sanitizeWatchdogText,
  writeWatchdogLease,
  writeWatchdogLeaseIfUnchanged
};

export const DEFAULT_STALE_LEASE_MS = 2 * 60 * 60 * 1000; // 2 hours
export const DEFAULT_ORPHAN_TURN0_MS = 15 * 60 * 1000; // 15 minutes
const MAX_IDLE_LEASE_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours
const TERMINAL_STOP_REASON_RE =
  /^(?:end_turn|stop|completed|finish|finished|max_tokens|cancelled|canceled|aborted|interrupted|error|failed)$/i;
const ABORT_REASON_RE = /^(?:cancelled|canceled|aborted|interrupted)$/i;

/**
 * State-aware dynamic timeout matrix (zero false positives).
 * Distinguishes:
 *   - IDLE
 *   - LLM_INFLIGHT: <120k normal, >=120k or /compact high_ctx, >=150k multimodal
 *   - TOOL_RUNNING: sync run_command / long MCP vs read_file / fast MCP
 *   - SUBAGENT_BG: async background tasks / subagents
 */
export function resolveDynamicThresholds(lease, cfg = getEffectiveConfig()) {
  if (!lease || lease.phase === WATCHDOG_PHASES.IDLE) {
    return {
      phase: WATCHDOG_PHASES.IDLE,
      bucket: "idle",
      suspectSec: 0,
      stalledSec: 0
    };
  }

  const rawRatio = Number(cfg?.watchdogSuspectRatio);
  const ratio = Number.isFinite(rawRatio) ? Math.min(0.95, Math.max(0.25, rawRatio)) : 0.6;

  let stalledSec;
  let bucket;

  if (lease.phase === WATCHDOG_PHASES.SUBAGENT_BG) {
    stalledSec = Number(cfg?.watchdogSubagentSec) || 600;
    bucket = "subagent_bg";
  } else if (lease.phase === WATCHDOG_PHASES.TOOL_RUNNING) {
    const isSlowCmd =
      lease.activeToolKind === "sync_cmd" ||
      lease.activeToolKind === "mcp_long" ||
      lease.activeTool === "run_command" ||
      LONG_MCP_TOOL_RE.test(lease.activeTool || "");
    if (isSlowCmd) {
      stalledSec = Number(cfg?.watchdogToolCmdSec) || 300;
      bucket = lease.activeToolKind === "mcp_long" ? "tool_mcp_long" : "tool_sync_cmd";
    } else {
      stalledSec = Number(cfg?.watchdogToolFastSec) || 90;
      bucket =
        lease.activeToolKind === "read"
          ? "tool_read"
          : lease.activeToolKind === "host"
            ? "tool_host"
            : "tool_mcp_fast";
    }
  } else {
    const ctx = Number(lease.contextTokens || 0);
    const media = Number(lease.mediaCount || 0);
    if (ctx >= 150000 && media > 0) {
      stalledSec = Number(cfg?.watchdogLlmMultimodalSec) || 360;
      bucket = "llm_multimodal_high_ctx";
    } else if (ctx >= 120000 || lease.isCompactCmd) {
      stalledSec = Number(cfg?.watchdogLlmHighSec) || 240;
      bucket = lease.isCompactCmd ? "llm_compact" : "llm_high_ctx";
    } else {
      stalledSec = Number(cfg?.watchdogLlmLowSec) || 120;
      bucket = "llm_low_ctx";
    }
    if (lease.isSubagent) {
      const subFloor = Number(cfg?.watchdogSubagentSec) || 600;
      stalledSec = Math.max(stalledSec, subFloor);
      bucket = "subagent_llm";
    }
  }

  const safeStalled = Math.max(10, Math.round(stalledSec));
  const suspectSec = Math.max(5, Math.min(safeStalled - 1, Math.round(safeStalled * ratio)));
  return {
    phase: lease.phase,
    bucket,
    suspectSec,
    stalledSec: safeStalled
  };
}

function parseStepTimestampMs(step) {
  if (!step || typeof step !== "object") return null;
  for (const field of ["updated_at", "completed_at", "created_at", "timestamp", "ts"]) {
    const v = step[field];
    if (typeof v === "number" && Number.isFinite(v) && v > 1e11) return Math.floor(v);
    if (typeof v === "string" && v.trim()) {
      const ms = Date.parse(v);
      if (Number.isFinite(ms) && ms > 0) return ms;
    }
  }
  return null;
}

function isNonSubstantiveSystemStep(step) {
  if (!step || typeof step !== "object") return false;
  const sys = step.systemMessage || step.system_message;
  if (sys && typeof sys === "object" && sys.systemMessage === "" && sys.metadata?.user_markdown) {
    return true;
  }
  const t = String(step.type || "").toUpperCase();
  if (t === "SYSTEM_MESSAGE" || t === "SYSTEM_INJECTION") {
    return true;
  }
  return false;
}

function extractStepToolCalls(step) {
  if (!step || typeof step !== "object") return [];
  const calls = [];
  for (const arr of [step.tool_calls, step.toolCalls, step.function_calls, step.functionCalls]) {
    if (Array.isArray(arr)) {
      for (const c of arr) {
        if (c && typeof c === "object") calls.push(c);
      }
    }
  }
  if (Array.isArray(step.content)) {
    for (const part of step.content) {
      if (
        part &&
        typeof part === "object" &&
        (part.type === "tool_use" || part.type === "tool_call" || part.type === "function_call")
      ) {
        calls.push(part);
      }
    }
  }
  for (const single of [step.tool_call, step.toolCall, step.function_call, step.functionCall]) {
    if (single && typeof single === "object") calls.push(single);
  }
  return calls;
}

function extractCallNameAndArgs(call) {
  if (!call || typeof call !== "object") return { name: "", args: {}, id: "" };
  const fn = call.function && typeof call.function === "object" ? call.function : null;
  const name = String(call.name || fn?.name || call.tool || "").trim();
  const args = parseMaybeJsonObj(call.args ?? call.arguments ?? call.input ?? fn?.arguments);
  const id = String(call.id ?? call.call_id ?? call.tool_call_id ?? "").trim();
  return { name, args, id };
}

function extractVisibleText(step) {
  if (!step || typeof step !== "object") return "";
  for (const key of ["content", "text", "response", "output", "message"]) {
    const val = step[key];
    if (typeof val === "string" && val.trim()) return val.trim();
    if (Array.isArray(val)) {
      const joined = val
        .map((p) => {
          if (typeof p === "string") return p;
          if (p && typeof p === "object" && (p.type === "text" || !p.type) && typeof p.text === "string") {
            return p.text;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n")
        .trim();
      if (joined) return joined;
    }
  }
  return "";
}

function countMediaInStep(s) {
  if (!s || typeof s !== "object") return 0;
  let count = 0;
  if (Array.isArray(s.media)) count += s.media.length;
  if (Array.isArray(s.images)) count += s.images.length;
  if (Array.isArray(s.content)) {
    for (const p of s.content) {
      if (p && typeof p === "object" && (p.type === "image" || p.type === "image_url" || p.type === "media")) {
        count += 1;
      }
    }
  }
  return count;
}

/**
 * Inspect the tail of a conversation's transcript.jsonl to:
 *   1. Self-heal leases when the tail already reached a terminal assistant/aborted step (missing Stop hook).
 *   2. Enrich phase & tool metadata (e.g. pending MCP/subagent calls not covered by PreToolUse).
 *   3. Capture latest contextTokens, mediaCount, model, and user input.
 */
export function inspectTranscriptTailForWatchdog(steps = [], options = {}) {
  const treatAsSubagent = Boolean(options?.isSubagent);
  const result = {
    hasSteps: false,
    hasAssistantSteps: false,
    detectedSubagent: treatAsSubagent,
    lastStepTs: null,
    lastStepType: "",
    isTerminal: false,
    terminalReason: "",
    hasPendingToolCalls: false,
    pendingTool: null,
    inferredPhase: null,
    latestUserInput: "",
    isCompactCmd: false,
    contextTokens: 0,
    mediaCount: 0,
    model: ""
  };
  if (!Array.isArray(steps) || steps.length === 0) return result;

  let lastSubstantiveStep = null;
  let lastSubstantiveIdx = -1;
  let lastSubstantiveIsToolResult = false;
  let lastPlannerIdx = -1;
  let lastPlannerActiveCalls = [];
  let lastPlannerOnlyFinish = false;
  let onlyToolResultsAfterPlanner = false;
  const completedCallIds = new Set();
  let completedResultsAfterPlanner = 0;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step || typeof step !== "object" || isNonSubstantiveSystemStep(step)) continue;
    // Embedded subagent steps inside a parent transcript must NOT pollute parent contextTokens
    // or falsely self-heal the parent conversation to IDLE.
    if (!treatAsSubagent && isSubagentStep(step)) continue;

    result.mediaCount += countMediaInStep(step);
    lastSubstantiveStep = step;
    lastSubstantiveIdx = i;

    const usage = extractStepTokenUsage(step);
    if (usage && usage.contextTokens > 0) {
      result.contextTokens = usage.contextTokens;
    }
    if (typeof step.model === "string" && step.model.trim()) {
      result.model = step.model.trim().slice(0, 96);
    }

    const typeUpper = String(step.type || "").toUpperCase();
    const roleLower = String(step.role || "").toLowerCase();

    if (
      typeUpper === "USER_INPUT" ||
      roleLower === "user" ||
      (typeof step.user_input === "string" && step.user_input.trim())
    ) {
      const userTxt =
        typeof step.user_input === "string" ? step.user_input : extractVisibleText(step);
      if (userTxt.trim()) {
        if (isHeadlessWorkerPrompt(userTxt)) {
          result.detectedSubagent = true;
        }
        result.latestUserInput = sanitizeWatchdogText(userTxt, 240);
        result.isCompactCmd = isSlashCompactText(userTxt);
      }
      lastSubstantiveIsToolResult = false;
      lastPlannerIdx = -1;
      lastPlannerActiveCalls = [];
      lastPlannerOnlyFinish = false;
      onlyToolResultsAfterPlanner = false;
      completedCallIds.clear();
      completedResultsAfterPlanner = 0;
      continue;
    }

    const isToolResult =
      typeUpper === "GENERIC" ||
      typeUpper === "TOOL_OUTPUT" ||
      typeUpper === "TOOL_RESULT" ||
      roleLower === "tool" ||
      step.tool_result !== undefined ||
      step.tool_call_id !== undefined ||
      step.toolCallId !== undefined ||
      step.call_id !== undefined;
    if (isToolResult) {
      lastSubstantiveIsToolResult = true;
      if (lastPlannerIdx >= 0) {
        completedResultsAfterPlanner += 1;
        const rid = String(step.tool_call_id ?? step.call_id ?? step.toolCallId ?? "").trim();
        if (rid) completedCallIds.add(rid);
      }
      continue;
    }

    const calls = extractStepToolCalls(step);
    const isAssistant =
      typeUpper === "PLANNER_RESPONSE" ||
      typeUpper === "ASSISTANT" ||
      roleLower === "assistant" ||
      roleLower === "model" ||
      calls.length > 0 ||
      Boolean(usage && (usage.contextTokens > 0 || usage.outputTokens > 0));

    if (isAssistant) {
      result.hasAssistantSteps = true;
      lastSubstantiveIsToolResult = false;
      const parsedCalls = calls.map(extractCallNameAndArgs).filter((c) => c.name);
      if (parsedCalls.some((c) => extractBareToolName(c.name) === "finish")) {
        result.detectedSubagent = true;
      }
      const allFinish =
        parsedCalls.length > 0 && parsedCalls.every((c) => extractBareToolName(c.name) === "finish");
      const activeCalls = parsedCalls.filter((c) => extractBareToolName(c.name) !== "finish");
      lastPlannerIdx = i;
      lastPlannerActiveCalls = activeCalls;
      lastPlannerOnlyFinish = allFinish;
      onlyToolResultsAfterPlanner = true;
      completedCallIds.clear();
      completedResultsAfterPlanner = 0;
    } else {
      lastSubstantiveIsToolResult = false;
      onlyToolResultsAfterPlanner = false;
    }
  }

  if (!lastSubstantiveStep) return result;
  result.hasSteps = true;
  result.lastStepTs = parseStepTimestampMs(lastSubstantiveStep);
  result.lastStepType = String(lastSubstantiveStep.type || lastSubstantiveStep.role || "").slice(0, 48);

  const typeUpper = String(lastSubstantiveStep.type || "").toUpperCase();
  const roleLower = String(lastSubstantiveStep.role || "").toLowerCase();
  const stopReason = String(
    lastSubstantiveStep.stop_reason ??
      lastSubstantiveStep.stopReason ??
      lastSubstantiveStep.finish_reason ??
      lastSubstantiveStep.finishReason ??
      lastSubstantiveStep.status ??
      ""
  ).trim();
  const isAborted = Boolean(
    lastSubstantiveStep.aborted === true ||
      lastSubstantiveStep.cancelled === true ||
      lastSubstantiveStep.canceled === true ||
      ABORT_REASON_RE.test(stopReason)
  );
  const isTerminalErrorStep =
    !lastSubstantiveIsToolResult &&
    (/^(?:ERROR_MESSAGE|ERROR|STREAM_ERROR|FATAL_ERROR)$/i.test(typeUpper) ||
      /^error$/i.test(stopReason) ||
      Boolean(lastSubstantiveStep.error));

  if (
    isAborted ||
    isTerminalErrorStep ||
    /^(?:STOP|TURN_END|CANCELLED|CANCELED|ABORTED|TURN_ABORTED|USER_CANCEL|TASK_COMPLETE|FINAL_RESPONSE)$/i.test(typeUpper)
  ) {
    result.isTerminal = true;
    const cleanStop = stopReason && !/^done$/i.test(stopReason) ? stopReason : "";
    result.terminalReason =
      cleanStop || typeUpper.toLowerCase() || (isTerminalErrorStep ? "error_message" : "aborted");
    result.inferredPhase = WATCHDOG_PHASES.IDLE;
    return result;
  }

  if (typeUpper === "USER_INPUT" || roleLower === "user") {
    result.inferredPhase = WATCHDOG_PHASES.LLM_INFLIGHT;
    return result;
  }

  if (
    lastPlannerIdx >= 0 &&
    lastPlannerOnlyFinish &&
    (lastSubstantiveIdx === lastPlannerIdx || onlyToolResultsAfterPlanner)
  ) {
    result.isTerminal = true;
    result.terminalReason = "finish_tool";
    result.inferredPhase = WATCHDOG_PHASES.IDLE;
    return result;
  }

  if (lastPlannerIdx >= 0 && lastPlannerActiveCalls.length > 0) {
    const unmatched = lastPlannerActiveCalls.filter((c, idx) => {
      if (c.id) return !completedCallIds.has(c.id);
      return idx >= completedResultsAfterPlanner;
    });
    if (unmatched.length > 0) {
      // When multiple tool calls run in parallel, pick the highest timeout tier
      // (SUBAGENT_BG > sync_cmd/mcp_long > mcp > read) to prevent premature false alerts.
      let bestCls = null;
      let bestTier = -1;
      for (const call of unmatched) {
        const cls = classifyToolExecutionKind(call.name, call.args);
        const tier = getToolTimeoutTier(
          cls.activeToolKind,
          cls.isBackground ? WATCHDOG_PHASES.SUBAGENT_BG : WATCHDOG_PHASES.TOOL_RUNNING
        );
        if (tier >= bestTier) {
          bestTier = tier;
          bestCls = cls;
        }
      }
      result.hasPendingToolCalls = true;
      result.pendingTool = bestCls;
      result.inferredPhase = bestCls.isBackground ? WATCHDOG_PHASES.SUBAGENT_BG : WATCHDOG_PHASES.TOOL_RUNNING;
      return result;
    }
    result.inferredPhase = WATCHDOG_PHASES.LLM_INFLIGHT;
    return result;
  }

  if (lastSubstantiveIdx === lastPlannerIdx) {
    const visible = extractVisibleText(lastSubstantiveStep);
    const usage = extractStepTokenUsage(lastSubstantiveStep);
    const calls = extractStepToolCalls(lastSubstantiveStep);
    const onlyFinish =
      calls.length > 0 && calls.every((c) => extractBareToolName(extractCallNameAndArgs(c).name) === "finish");
    if (
      onlyFinish ||
      TERMINAL_STOP_REASON_RE.test(stopReason) ||
      visible.length > 0 ||
      (usage && usage.outputTokens > 0)
    ) {
      result.isTerminal = true;
      result.terminalReason = stopReason || (onlyFinish ? "finish_tool" : "assistant_final_turn");
      result.inferredPhase = WATCHDOG_PHASES.IDLE;
      return result;
    }
  }

  return result;
}

/**
 * Attribute a suspect/stalled incident to one of 6 concrete root causes
 * and return 1-2 targeted, jailbreak-free troubleshooting tips (EN + ZH).
 */
export function diagnoseStallCause(lease = {}, options = {}) {
  const safeLease = lease && typeof lease === "object" && !Array.isArray(lease) ? lease : {};
  const safeOpts = options && typeof options === "object" && !Array.isArray(options) ? options : {};
  const phase = safeLease.phase || WATCHDOG_PHASES.LLM_INFLIGHT;
  const ctx = Number(safeLease.contextTokens || 0);
  const media = Number(safeLease.mediaCount || 0);
  const isCompact = Boolean(safeLease.isCompactCmd || safeLease.subphase === "compact");
  const activeTool = String(safeLease.activeTool || "");
  const safeTool = sanitizeWatchdogText(activeTool, 64);
  const activeToolKind = String(safeLease.activeToolKind || "");
  const platform = safeOpts.platform || process.platform;

  if (
    phase === WATCHDOG_PHASES.TOOL_RUNNING &&
    (activeToolKind === "sync_cmd" || activeTool === "run_command")
  ) {
    const winTag =
      platform === "win32" ? "Windows PowerShell/CMD EOF or interactive prompt" : "terminal interactive prompt / pager";
    return {
      causeId: "terminal_eof_or_interactive",
      label: platform === "win32" ? "Windows Terminal EOF / Interactive Hang" : "Terminal Interactive / EOF Block",
      labelZh: platform === "win32" ? "Windows 终端 EOF 或交互阻塞" : "终端交互提示或标准输入阻塞",
      tips: [
        `Check the terminal pane for a waiting ${winTag} ([y/N], password, pager) and cancel the step or press Ctrl+C.`,
        "Re-run long/interactive commands with non-interactive flags (--yes, CI=1, GIT_PAGER=cat) or async background mode (WaitMsBeforeAsync <= 2000)."
      ],
      tipsZh: [
        `检查终端面板是否停在 ${platform === "win32" ? "Windows 终端 EOF / [y/N] / 密码 / 分页器" : "交互确认 / 分页器"} 等待输入，手动 Ctrl+C 或在 Antigravity 中取消当前步骤。`,
        "对长耗时或易交互命令改用非交互参数（--yes、CI=1、GIT_PAGER=cat）或后台模式（WaitMsBeforeAsync <= 2000 / IsDaemon: true）。"
      ]
    };
  }

  const isExplicitNonMcp = activeToolKind === "read" || activeToolKind === "host" || activeToolKind === "sync_cmd";
  const colonIdx = activeTool.lastIndexOf(":");
  const colonPrefix = colonIdx > 0 ? activeTool.slice(0, colonIdx).trim() : "";
  const hasMcpName =
    /^(?:call_mcp_tool|mcp_|ctx_)/i.test(activeTool) ||
    (colonIdx > 0 && !/^(?:default_api|builtin|host|antigravity|core|native)$/i.test(colonPrefix)) ||
    KNOWN_MCP_TOOL_RE.test(extractBareToolName(activeTool));
  if (
    phase === WATCHDOG_PHASES.TOOL_RUNNING &&
    (activeToolKind === "mcp" || activeToolKind === "mcp_long" || (!isExplicitNonMcp && hasMcpName))
  ) {
    return {
      causeId: "mcp_tool_blocked",
      label: "MCP Tool / Server Blocked",
      labelZh: "MCP 工具或服务端阻塞",
      tips: [
        `Cancel the stalled MCP step (${safeTool || "MCP tool"}) in Antigravity and verify MCP server health (run 'npm run doctor' or reload MCP servers).`,
        "Copy the Rescue Handoff Brief first so modified files, last verification result, and FTS5 handles are preserved."
      ],
      tipsZh: [
        `在 Antigravity 中取消卡住的 MCP 步骤（${safeTool || "MCP 工具"}），并检查对应 MCP 服务健康状态（运行 npm run doctor 或在设置中重连 MCP）。`,
        "建议先一键复制下方的抢救版 Handoff Brief，确保已改文件、测试状态与 FTS5 句柄不丢失。"
      ]
    };
  }

  if (phase === WATCHDOG_PHASES.TOOL_RUNNING) {
    const isReadTool = activeToolKind === "read" || /^(?:read_file|view_file)$/i.test(activeTool);
    return {
      causeId: "host_tool_blocked",
      label: isReadTool ? "File Read / Host Tool Blocked" : "Host Tool Execution Blocked",
      labelZh: isReadTool ? "文件读取或宿主工具阻塞" : "宿主工具执行阻塞",
      tips: [
        isReadTool
          ? `Cancel the stalled file-read step (${safeTool || "read_file"}) in Antigravity and check whether the target file is oversized, locked, on a slow network mount, or hanging the host runtime.`
          : `Cancel the stalled tool step (${safeTool || "host tool"}) in Antigravity and check target file access or host tool responsiveness.`,
        "Copy the Rescue Handoff Brief below before stopping or restarting the session so modified files, checkpoints, and FTS5 handles are preserved."
      ],
      tipsZh: [
        isReadTool
          ? `在 Antigravity 中取消卡住的读文件步骤（${safeTool || "read_file"}），并检查目标文件是否过大、被进程占用、位于慢速网络盘或导致宿主工具卡死。`
          : `在 Antigravity 中取消卡住的工具步骤（${safeTool || "宿主工具"}），并检查目标文件权限/占用状态或宿主工具运行是否异常。`,
        "取消或重开会话前请先一键复制下方的抢救版 Handoff Brief，确保已改文件、检查点与 FTS5 句柄零丢失。"
      ]
    };
  }

  if (
    phase === WATCHDOG_PHASES.SUBAGENT_BG ||
    (safeLease.isSubagent && phase === WATCHDOG_PHASES.LLM_INFLIGHT)
  ) {
    const isHeadlessLlm = phase !== WATCHDOG_PHASES.SUBAGENT_BG && Boolean(safeLease.isSubagent);
    return {
      causeId: "subagent_or_bg_stalled",
      label: isHeadlessLlm
        ? "Background Worker / Subagent Unresponsive"
        : "Background Task / Subagent Unresponsive",
      labelZh: isHeadlessLlm ? "后台工作流节点 / 子代理长时间无响应" : "后台任务 / 子代理长时间无响应",
      tips: [
        isHeadlessLlm
          ? "Inspect the parent workflow or subagent status; parallel high-context workers may queue on model capacity, or cancel and retry the stuck worker."
          : `Inspect running background tasks or subagent status${safeTool ? ` (${safeTool})` : ""} and cancel the stuck background job in Antigravity if it is no longer making progress.`,
        "Copy the Rescue Handoff Brief below before stopping or starting a fresh session so workspace edits, checkpoints, and FTS5 handles are preserved."
      ],
      tipsZh: [
        isHeadlessLlm
          ? "检查父级工作流（run_workflow）或子代理状态；多路高上下文 Worker 并发可能正在排队等待配额，若确认无进度可在宿主取消重试。"
          : `检查当前后台任务或子代理状态${safeTool ? `（${safeTool}）` : ""}，若已无进度请在 Antigravity 中取消卡住的后台作业。`,
        "终止或重开会话前请先一键复制下方的抢救版 Handoff Brief，确保工作区变更、检查点与 FTS5 句柄零丢失。"
      ]
    };
  }

  if (
    phase === WATCHDOG_PHASES.LLM_INFLIGHT &&
    (isCompact || ctx >= 120000 || safeLease.subphase === "high_ctx" || safeLease.subphase === "multimodal_high_ctx")
  ) {
    const mediaNote = media > 0 && ctx >= 150000;
    return {
      causeId: "auto_compact_deadlock",
      label: mediaNote
        ? "High-Context Multimodal / Compaction Stall"
        : "Background Auto-Compaction / High-Context Deadlock",
      labelZh: mediaNote ? "高上下文多模态 / 自动压缩卡死" : "后台自动压缩死锁 / 高上下文无响应",
      tips: [
        "Copy the Rescue Handoff Brief below, cancel the hung turn, then open a fresh session (or run /compact) and paste the brief + call ctx_resume({}).",
        mediaNote
          ? "Avoid keeping screenshots/images in >=150k threads (3-7x TTFT cliff); delegate visual checks to a fresh subagent."
          : "Keep large logs/diffs in agy-dart sandbox (ctx_execute / read_slices) to stay below high-context compaction cliffs."
      ],
      tipsZh: [
        "先复制下方预生成的抢救版 Handoff Brief，点击停止/取消当前卡死轮次，在新对话粘贴该简报并调用 ctx_resume({}) 无缝续接。",
        mediaNote
          ? "当前会话 >=150k 且含多模态图片（TTFT 悬崖风险），建议改由独立文本子代理分流排查，避免主会话继续堆积图片。"
          : "大日志与源码优先走 agy-dart 沙盒与切片（ctx_execute / read_slices），避免上下文再次逼近后台自动压缩死锁区间。"
      ]
    };
  }

  return {
    causeId: "oauth_ghost_or_network",
    label: "OAuth Ghost Session or Network Stall",
    labelZh: "OAuth Ghost Session 或网络断连",
    tips: [
      "Check proxy/VPN connectivity and Antigravity OAuth login state; cancel the silent turn or reload the window to clear a ghost session.",
      "Copy the Rescue Handoff Brief below before opening a new thread so no workspace progress is lost."
    ],
    tipsZh: [
      "检查代理/VPN 网络连通性与 Antigravity OAuth 会话状态；取消当前静默轮次，必要时重载窗口以清除 Ghost Session。",
      "新开会话前请先一键复制下方的抢救版 Handoff Brief，零丢失恢复当前工作区进度。"
    ]
  };
}

/**
 * Pure OS desktop notification command builder (env-var indirection on Windows,
 * strict argv-only dispatch on macOS/Linux — zero dynamic shell interpolation).
 */
export function buildDesktopNotificationCommand({
  title = "agy-dart Stall Watchdog",
  body = "",
  platform = process.platform,
  baseEnv = process.env
} = {}) {
  // Windows NotifyIcon.BalloonTipTitle throws if > 63 chars; cap safely at 60 bytes.
  const safeTitle = sanitizeWatchdogText(title, 60) || "agy-dart Stall Watchdog";
  const safeBody =
    sanitizeWatchdogText(body, 220) || "Session appears stalled. Open agy-dart Sidecar for Rescue Brief.";

  let cmd = "";
  let args = [];
  const env = { ...baseEnv };

  if (platform === "win32") {
    env.AGY_DART_NOTIFY_TITLE = safeTitle;
    env.AGY_DART_NOTIFY_BODY = safeBody;
    const psScript = [
      "$t = [Environment]::GetEnvironmentVariable('AGY_DART_NOTIFY_TITLE');",
      "$b = [Environment]::GetEnvironmentVariable('AGY_DART_NOTIFY_BODY');",
      "try {",
      "  Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop;",
      "  Add-Type -AssemblyName System.Drawing -ErrorAction Stop;",
      "  $ni = New-Object System.Windows.Forms.NotifyIcon;",
      "  $ni.Icon = [System.Drawing.SystemIcons]::Warning;",
      "  $ni.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Warning;",
      "  $ni.BalloonTipTitle = $t;",
      "  $ni.BalloonTipText = $b;",
      "  $ni.Visible = $true;",
      "  $ni.ShowBalloonTip(5000);",
      "  Start-Sleep -Milliseconds 4000;",
      "  $ni.Dispose();",
      "} catch {}"
    ].join(" ");
    cmd = "powershell.exe";
    args = ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", psScript];
  } else if (platform === "darwin") {
    cmd = "osascript";
    args = [
      "-e",
      "on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run",
      "--",
      safeTitle,
      safeBody
    ];
  } else {
    cmd = "notify-send";
    args = ["--app-name=agy-dart", "--urgency=normal", "--", safeTitle, safeBody];
  }

  return { cmd, args, env, safeTitle, safeBody, platform };
}

/**
 * Safe, zero-dependency, fail-open OS desktop notification helper (opt-in only).
 */
export function sendDesktopNotification({
  title = "agy-dart Stall Watchdog",
  body = "",
  platform = process.platform
} = {}) {
  try {
    const spec = buildDesktopNotificationCommand({ title, body, platform });
    const child = spawn(spec.cmd, spec.args, {
      stdio: "ignore",
      windowsHide: true,
      env: spec.env
    });
    child.on("error", () => {});
    const killTimer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
    }, 12000);
    killTimer.unref?.();
    child.on("exit", () => clearTimeout(killTimer));
    child.unref?.();
    return { dispatched: true, platform };
  } catch {
    return { dispatched: false, platform };
  }
}

function severityRank(sev) {
  if (sev === "stalled") return 4;
  if (sev === "suspect") return 3;
  if (sev === "snoozed") return 2;
  if (sev === "active") return 1;
  return 0;
}

/**
 * Low-frequency Sidecar Stall Watchdog monitor.
 * Purely injectable clocks/fs/notifier so unit tests run deterministically in milliseconds.
 */
export class WatchdogMonitor {
  constructor(options = {}) {
    this.getStore = options.getStore;
    this.getAppStartTime = options.getAppStartTime || (() => 0);
    this._hasCustomConfig = typeof options.getConfig === "function";
    this.getConfig = options.getConfig || (() => getEffectiveConfig());
    this.nowFn = options.nowFn || (() => Date.now());
    this.monoNsFn = options.monoNsFn || (() => process.hrtime.bigint());
    this.statFn = options.statFn || ((p) => fs.statSync(p));
    this.readTailFn = options.readTailFn || ((p, bytes) => readTranscriptTail(p, bytes, { minUsageSteps: 1 }));
    this.findTranscriptFn =
      options.findTranscriptFn || ((convId) => findTranscriptForConversation(convId, { exactOnly: true }));
    this.notifyFn = options.notifyFn || sendDesktopNotification;
    this.buildHandoffFn = options.buildHandoffFn || buildHandoffBrief;
    this.staleLeaseMs =
      Number.isFinite(options.staleLeaseMs) && options.staleLeaseMs > 0
        ? options.staleLeaseMs
        : DEFAULT_STALE_LEASE_MS;
    this.orphanTurn0Ms =
      Number.isFinite(options.orphanTurn0Ms) && options.orphanTurn0Ms > 0
        ? options.orphanTurn0Ms
        : DEFAULT_ORPHAN_TURN0_MS;
    this.platform = options.platform || process.platform;

    this._timer = null;
    this._startupCleaned = false;
    this._lastTickWallMs = null;
    this._lastTickMonoNs = null;
    this._sleepGuardCount = 0;
    this._lastSleepDriftAt = null;
    this._lastSleepJumpMs = 0;

    this._convState = new Map();
    this._lastEvaluated = new Map();
    this._ttlNotifiedKeys = new Map();
    this._lastTtlNotifyGlobalTs = 0;
    this.statSyncCount = 0;
    this.tailReadCount = 0;
    this.notificationCount = 0;
    this.ttlNotificationCount = 0;
  }

  start() {
    if (this._timer) return;
    const cfg = this.getConfig() || {};
    const pollMs = Math.min(60000, Math.max(1000, Number(cfg.watchdogPollMs) || 5000));
    try {
      this.cleanupStaleLeasesOnStartup();
    } catch {}
    this._lastTickWallMs = this.nowFn();
    this._lastTickMonoNs = this.monoNsFn();
    this._timer = setInterval(() => {
      try {
        this.tick();
      } catch {
        // Fail-open background poller
      }
    }, pollMs);
    this._timer.unref?.();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  cleanupStaleLeasesOnStartup(nowMs = this.nowFn()) {
    this._startupCleaned = true;
    const store = this.getStore?.();
    if (!store) return { cleaned: 0, deleted: 0 };
    const appStartTs = Number(this.getAppStartTime?.() || 0);
    const leases = listWatchdogLeases(store);
    let cleaned = 0;
    let deleted = 0;

    for (const lease of leases) {
      const ageMs = nowMs - (lease.updatedTs || 0);
      if (lease.phase === WATCHDOG_PHASES.IDLE) {
        if (ageMs > MAX_IDLE_LEASE_RETENTION_MS || lease.updatedTs <= 0) {
          try {
            store.deleteMeta(getWatchdogLeaseKey(lease.conversationId));
            deleted += 1;
          } catch {}
        }
        continue;
      }

      const fromPriorApp = appStartTs > 0 && lease.updatedTs > 0 && lease.updatedTs < appStartTs - 5000;
      const tooOld = ageMs > this.staleLeaseMs;
      if (fromPriorApp || tooOld || lease.updatedTs <= 0) {
        try {
          const cas = writeWatchdogLeaseIfUnchanged(store, lease.updatedTs, lease.phase, {
            ...lease,
            phase: WATCHDOG_PHASES.IDLE,
            subphase: "stale_cleanup",
            activeTool: "",
            activeToolKind: "",
            activeToolSummary: "",
            activeToolCallId: "",
            pendingSlowCalls: [],
            transcriptSize: 0,
            transcriptMtimeMs: 0,
            stopReason: fromPriorApp ? "stale_prior_app_restart" : "stale_cleanup_on_restart",
            phaseChangedTs: nowMs,
            updatedTs: nowMs,
            lastHeartbeatTs: nowMs,
            hookEvent: "SidecarStartupCleanup",
            ackedUntilTs: 0
          });
          if (cas.written) cleaned += 1;
        } catch {}
      }
    }

    return { cleaned, deleted };
  }

  clearActiveLeasesOnDisable(nowMs = this.nowFn()) {
    const store = this.getStore?.();
    this._convState.clear();
    this._lastEvaluated.clear();
    if (!store) return 0;
    const leases = listWatchdogLeases(store);
    let cleared = 0;
    for (const lease of leases) {
      if (lease.phase === WATCHDOG_PHASES.IDLE) continue;
      try {
        const cas = writeWatchdogLeaseIfUnchanged(store, lease.updatedTs, lease.phase, {
          ...lease,
          phase: WATCHDOG_PHASES.IDLE,
          subphase: "disabled",
          activeTool: "",
          activeToolKind: "",
          activeToolSummary: "",
          activeToolCallId: "",
          pendingSlowCalls: [],
          transcriptSize: 0,
          transcriptMtimeMs: 0,
          stopReason: "watchdog_disabled",
          phaseChangedTs: nowMs,
          updatedTs: nowMs,
          lastHeartbeatTs: nowMs,
          hookEvent: "UserDisable",
          ackedUntilTs: 0
        });
        if (cas.written) cleared += 1;
      } catch {}
    }
    return cleared;
  }

  _checkSleepDrift(nowWallMs, nowMonoNs, pollMs) {
    if (this._lastTickWallMs === null || this._lastTickMonoNs === null) {
      this._lastTickWallMs = nowWallMs;
      this._lastTickMonoNs = nowMonoNs;
      return 0;
    }

    const wallDeltaMs = nowWallMs - this._lastTickWallMs;
    const monoDeltaMs = Number(nowMonoNs - this._lastTickMonoNs) / 1e6;
    this._lastTickWallMs = nowWallMs;
    this._lastTickMonoNs = nowMonoNs;

    const jumpThresholdMs = Math.max(pollMs * 4, 30000);
    const clockDivergenceMs = Math.abs(wallDeltaMs - monoDeltaMs);
    const hasActivePoller = this._timer !== null;

    // Signed drift compensation:
    //   - Positive driftMs (OS suspend/wake or forward clock jump) subtracts skipped wall time.
    //   - Negative driftMs (backward NTP/timezone jump) cancels the wall-clock reduction so
    //     active turns still measure true monotonic elapsed time instead of going blind.
    let driftMs = 0;
    if (wallDeltaMs < -5000) {
      driftMs = wallDeltaMs - Math.max(0, monoDeltaMs);
    } else if (clockDivergenceMs > 15000 && wallDeltaMs > 15000) {
      driftMs = Math.max(30000, wallDeltaMs - Math.max(0, monoDeltaMs));
    } else if (hasActivePoller && wallDeltaMs > jumpThresholdMs) {
      driftMs = Math.max(30000, wallDeltaMs - pollMs);
    }

    if (driftMs !== 0) {
      this._sleepGuardCount += 1;
      this._lastSleepDriftAt = nowWallMs;
      this._lastSleepJumpMs = Math.round(Math.abs(driftMs));
      for (const state of this._convState.values()) {
        state.sleepGraceMs = (state.sleepGraceMs || 0) + driftMs;
      }
    }
    return driftMs;
  }

  _getOrCreateConvState(convId) {
    let st = this._convState.get(convId);
    if (!st) {
      st = {
        transcriptPath: "",
        lastStatMtimeMs: 0,
        lastStatSize: -1,
        lastTranscriptGrowthTs: 0,
        lastInspectedMtimeMs: 0,
        lastInspectedSize: -1,
        lastTailInfo: null,
        sleepGraceMs: 0,
        lastLeaseUpdatedTs: 0,
        rescueBriefKey: "",
        rescueBrief: null,
        lastNotifyKey: "",
        lastNotifyTs: 0
      };
      this._convState.set(convId, st);
    }
    return st;
  }

  _resolveWatchdogEnabled(store, cfg) {
    if (this._hasCustomConfig) {
      if (store && typeof store.getMeta === "function") {
        const raw = store.getMeta("watchdog:enabled", null);
        if (raw !== null) return raw !== "false" && raw !== "0";
      }
      return cfg.stallWatchdog !== false;
    }
    if (store && typeof store.isWatchdogEnabled === "function") {
      return store.isWatchdogEnabled();
    }
    return cfg.stallWatchdog !== false;
  }

  _resolveDesktopNotifyEnabled(store, cfg) {
    if (this._hasCustomConfig) {
      if (store && typeof store.getMeta === "function") {
        const raw = store.getMeta("watchdog:desktop_notify", null);
        if (raw !== null) return raw === "true" || raw === "1";
      }
      return Boolean(cfg.watchdogDesktopNotify);
    }
    if (store && typeof store.isWatchdogDesktopNotifyEnabled === "function") {
      return store.isWatchdogDesktopNotifyEnabled();
    }
    return Boolean(cfg.watchdogDesktopNotify);
  }

  _resolveTtlDesktopNotifyEnabled(store, cfg) {
    const envRaw = process.env.AGY_DART_TTL_DESKTOP_NOTIFY;
    if (typeof envRaw === "string" && envRaw.trim() !== "") {
      const s = envRaw.trim().toLowerCase();
      if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
      if (s === "0" || s === "false" || s === "no" || s === "off") return false;
    }
    if (this._hasCustomConfig) {
      if (store && typeof store.getMeta === "function") {
        const raw = store.getMeta("cache:ttl_desktop_notify", null);
        if (raw !== null) return raw === "true" || raw === "1";
      }
      return Boolean(cfg.ttlDesktopNotify);
    }
    if (store && typeof store.isTtlDesktopNotifyEnabled === "function") {
      return store.isTtlDesktopNotifyEnabled();
    }
    return Boolean(cfg.ttlDesktopNotify);
  }

  _resolveUiLangInfo(store, cfg) {
    const envParsed = parseUiLang(process.env.AGY_DART_LANG);
    if (envParsed) {
      return { lang: envParsed, source: "env" };
    }
    if (this._hasCustomConfig) {
      if (store && typeof store.getMeta === "function") {
        const raw = parseUiLang(store.getMeta("ui:lang", null));
        if (raw) return { lang: raw, source: "sqlite" };
      }
      const cfgParsed = parseUiLang(cfg.uiLang);
      if (cfgParsed) return { lang: cfgParsed, source: "config" };
      return { lang: "en", source: "default" };
    }
    if (store && typeof store.getUiLangInfo === "function") {
      return store.getUiLangInfo();
    }
    const cfgParsed = parseUiLang(cfg.uiLang);
    return { lang: cfgParsed || "en", source: cfgParsed ? "config" : "default" };
  }

  _resolveLeaseEffectiveTtlSec(store, lease, cfg, nowWallMs) {
    if (Number.isFinite(cfg.cacheTtlSec) && cfg.cacheTtlSec > 0) {
      return Math.floor(cfg.cacheTtlSec);
    }
    const profile = resolveModelProfile(lease?.model || null);
    if (store && typeof store.getModelTtlCalibration === "function") {
      try {
        const hist = store.getModelTtlCalibration(profile.id, nowWallMs);
        if (hist && ((hist.warm && hist.warm.length > 0) || (hist.cold && hist.cold.length > 0) || hist.seen1hWrite)) {
          const cal = estimateCalibratedTtl(profile, { historyRecord: hist, nowMs: nowWallMs });
          if (cal && cal.ttlSource === "empirical" && cal.ttlSec > 0) {
            return Math.floor(cal.ttlSec);
          }
        }
      } catch {}
    }
    if (Number.isFinite(lease?.cacheTtlSec) && lease.cacheTtlSec > 0) {
      return Math.floor(lease.cacheTtlSec);
    }
    return profile?.ttlSec || DEFAULT_CACHE_TTL_SEC;
  }

  _evaluateIdleTtlNotifications(store, leases, { nowWallMs, cfg, ttlDesktopNotifyEnabled, uiLang = "en", sleepJumpMs }) {
    if (!ttlDesktopNotifyEnabled || !Array.isArray(leases) || leases.length === 0) return;
    const minTokens = Math.min(500000, Math.max(4000, Math.floor(Number(cfg.ttlNotifyMinTokens) || 60000)));
    const leadSec = Math.min(300, Math.max(15, Math.floor(Number(cfg.ttlNotifyLeadSec) || 60)));

    if (sleepJumpMs !== 0) {
      for (const lease of leases) {
        if (!lease || lease.phase !== WATCHDOG_PHASES.IDLE || lease.isSubagent) continue;
        const idleAnchorTs = lease.idleAnchorTs || lease.phaseChangedTs || lease.updatedTs || 0;
        if (idleAnchorTs > 0) {
          this._ttlNotifiedKeys.set(lease.conversationId, `${lease.conversationId}:${idleAnchorTs}`);
        }
      }
      return;
    }

    const fmtDur = (sec) => {
      if (sec >= 3600 && sec % 3600 === 0) return `${sec / 3600}h`;
      if (sec >= 60 && sec % 60 === 0) return `${sec / 60}m`;
      if (sec >= 60) return `${Math.floor(sec / 60)}m${sec % 60}s`;
      return `${sec}s`;
    };

    for (const lease of leases) {
      if (!lease || lease.phase !== WATCHDOG_PHASES.IDLE || lease.isSubagent) continue;
      if (lease.subphase !== "stopped" && lease.subphase !== "stopped_bg_pending") continue;
      const stopReason = String(lease.stopReason || "").trim();
      if (/^(?:EXECUTOR_TERMINATION_REASON_)?(?:USER_CANCELED|USER_CANCELLED|CANCELED|CANCELLED|ABORTED|ERROR)\b/i.test(stopReason)) {
        continue;
      }
      const ctxTokens = Number(lease.contextTokens || 0);
      if (ctxTokens < minTokens) continue;

      const effectiveTtlSec = this._resolveLeaseEffectiveTtlSec(store, lease, cfg, nowWallMs);
      if (!(effectiveTtlSec > leadSec)) continue;

      const idleAnchorTs = lease.idleAnchorTs || lease.phaseChangedTs || lease.updatedTs || 0;
      if (idleAnchorTs <= 0 || nowWallMs < idleAnchorTs) continue;
      const idleSec = Math.floor((nowWallMs - idleAnchorTs) / 1000);
      const remSec = effectiveTtlSec - idleSec;
      if (!(remSec > 0 && remSec <= leadSec)) continue;

      const dedupKey = `${lease.conversationId}:${idleAnchorTs}`;
      if (this._ttlNotifiedKeys.get(lease.conversationId) === dedupKey) continue;
      if (this._lastTtlNotifyGlobalTs > 0 && nowWallMs - this._lastTtlNotifyGlobalTs < 60_000) continue;

      const isZh = uiLang === "zh";
      const title = isZh ? "agy-dart：缓存即将过期" : "agy-dart: KV-Cache Expiring";
      const body = sanitizeWatchdogText(
        isZh
          ? `${Math.round(ctxTokens / 1000)}k 上下文热缓存约 ${remSec} 秒后过期（TTL ${fmtDur(effectiveTtlSec)}）。继续发消息可保热，或等过期后执行 /compact。`
          : `${Math.round(ctxTokens / 1000)}k context warm cache expires in ~${remSec}s (TTL ${fmtDur(effectiveTtlSec)}). Reply to keep warm or /compact after expiry.`,
        220
      );
      this._ttlNotifiedKeys.set(lease.conversationId, dedupKey);
      this._lastTtlNotifyGlobalTs = nowWallMs;
      try {
        const res = this.notifyFn({
          title,
          body,
          platform: this.platform,
          kind: "ttl_expiring",
          conversationId: lease.conversationId
        });
        if (!res || res.dispatched !== false) {
          this.ttlNotificationCount += 1;
        }
      } catch {}
    }
  }

  tick() {
    const nowWallMs = this.nowFn();
    const nowMonoNs = this.monoNsFn();
    const cfg = this.getConfig() || {};
    const pollMs = Math.min(60000, Math.max(1000, Number(cfg.watchdogPollMs) || 5000));
    const store = this.getStore?.();

    if (!this._startupCleaned && store) {
      try {
        this.cleanupStaleLeasesOnStartup(nowWallMs);
      } catch {}
    }

    const enabled = this._resolveWatchdogEnabled(store, cfg);
    const desktopNotifyEnabled = this._resolveDesktopNotifyEnabled(store, cfg);
    const ttlDesktopNotifyEnabled = this._resolveTtlDesktopNotifyEnabled(store, cfg);
    const langInfo = this._resolveUiLangInfo(store, cfg);
    const uiLang = langInfo.lang;
    const sleepJumpMs = this._checkSleepDrift(nowWallMs, nowMonoNs, pollMs);

    if (!store || (!enabled && !ttlDesktopNotifyEnabled)) {
      this._convState.clear();
      this._lastEvaluated.clear();
      return {
        enabled,
        desktopNotifyEnabled,
        ttlDesktopNotifyEnabled,
        uiLang,
        uiLangSource: langInfo.source,
        serverNowMs: nowWallMs,
        evaluated: []
      };
    }

    const leases = listWatchdogLeases(store);
    if (!enabled) {
      this._convState.clear();
      this._lastEvaluated.clear();
      const liveIds = new Set(leases.map((l) => l.conversationId));
      for (const id of this._ttlNotifiedKeys.keys()) {
        if (!liveIds.has(id)) this._ttlNotifiedKeys.delete(id);
      }
      this._evaluateIdleTtlNotifications(store, leases, {
        nowWallMs,
        cfg,
        ttlDesktopNotifyEnabled,
        uiLang,
        sleepJumpMs
      });
      return {
        enabled,
        desktopNotifyEnabled,
        ttlDesktopNotifyEnabled,
        uiLang,
        uiLangSource: langInfo.source,
        serverNowMs: nowWallMs,
        evaluated: []
      };
    }

    const activeLeases = leases.filter((l) => l.phase !== WATCHDOG_PHASES.IDLE);

    // Zero statSync fast path when ALL leases are IDLE (or none exist)
    if (activeLeases.length === 0) {
      const evaluated = leases.map((lease) => this._buildIdleEvaluation(lease, nowWallMs));
      this._lastEvaluated.clear();
      for (const item of evaluated) this._lastEvaluated.set(item.conversationId, item);
      const liveIds = new Set(leases.map((l) => l.conversationId));
      for (const [id, st] of this._convState.entries()) {
        if (!liveIds.has(id)) {
          this._convState.delete(id);
        } else {
          st.sleepGraceMs = 0;
          st.lastTranscriptGrowthTs = 0;
          st.rescueBriefKey = "";
          st.rescueBrief = null;
        }
      }
      for (const id of this._ttlNotifiedKeys.keys()) {
        if (!liveIds.has(id)) this._ttlNotifiedKeys.delete(id);
      }
      this._evaluateIdleTtlNotifications(store, leases, {
        nowWallMs,
        cfg,
        ttlDesktopNotifyEnabled,
        uiLang,
        sleepJumpMs
      });
      return {
        enabled,
        desktopNotifyEnabled,
        ttlDesktopNotifyEnabled,
        uiLang,
        uiLangSource: langInfo.source,
        serverNowMs: nowWallMs,
        evaluated
      };
    }

    const evaluated = [];
    const seenIds = new Set();

    for (const lease of leases) {
      seenIds.add(lease.conversationId);
      if (lease.phase === WATCHDOG_PHASES.IDLE) {
        const st = this._convState.get(lease.conversationId);
        if (st) {
          st.sleepGraceMs = 0;
          st.lastTranscriptGrowthTs = 0;
          st.rescueBriefKey = "";
          st.rescueBrief = null;
        }
        evaluated.push(this._buildIdleEvaluation(lease, nowWallMs));
        continue;
      }

      evaluated.push(
        this._evaluateActiveLease(store, lease, {
          nowWallMs,
          cfg,
          desktopNotifyEnabled,
          uiLang,
          sleepJumpMs
        })
      );
    }

    for (const id of this._convState.keys()) {
      if (!seenIds.has(id)) this._convState.delete(id);
    }
    for (const id of this._ttlNotifiedKeys.keys()) {
      if (!seenIds.has(id)) this._ttlNotifiedKeys.delete(id);
    }

    this._evaluateIdleTtlNotifications(
      store,
      leases.filter((l) => l.phase === WATCHDOG_PHASES.IDLE),
      {
        nowWallMs,
        cfg,
        ttlDesktopNotifyEnabled,
        uiLang,
        sleepJumpMs
      }
    );

    this._lastEvaluated.clear();
    for (const item of evaluated) {
      this._lastEvaluated.set(item.conversationId, item);
    }

    return {
      enabled,
      desktopNotifyEnabled,
      ttlDesktopNotifyEnabled,
      uiLang,
      uiLangSource: langInfo.source,
      serverNowMs: nowWallMs,
      evaluated
    };
  }

  _buildIdleEvaluation(lease, nowWallMs) {
    return {
      conversationId: lease.conversationId,
      rootSessionId: lease.rootSessionId,
      parentConversationId: lease.parentConversationId,
      isSubagent: lease.isSubagent,
      phase: WATCHDOG_PHASES.IDLE,
      subphase: lease.subphase || "idle",
      bucket: "idle",
      severity: "idle",
      rawSeverity: "idle",
      silentSec: 0,
      suspectSec: 0,
      stalledSec: 0,
      progressPct: 0,
      lastActivityTs: lease.lastHeartbeatTs || lease.updatedTs || nowWallMs,
      startedTs: lease.startedTs || lease.updatedTs || nowWallMs,
      phaseChangedTs: lease.phaseChangedTs || lease.updatedTs || nowWallMs,
      activeTool: "",
      activeToolKind: "",
      activeToolSummary: "",
      lastCompletedTool: lease.lastCompletedTool || "",
      lastUserInput: lease.lastUserInput || "",
      contextTokens: lease.contextTokens || 0,
      mediaCount: lease.mediaCount || 0,
      model: lease.model || "",
      stopReason: lease.stopReason || "",
      selfHealed: lease.hookEvent === "SidecarHeal",
      transcriptGrowing: false,
      snoozedUntilTs: 0,
      diagnosis: null,
      rescueBrief: null
    };
  }

  _applyTailEnrichment(lease, tailInfo, tailIsFresh) {
    if (!tailInfo) return;
    if (tailInfo.detectedSubagent && !lease.isSubagent) {
      lease.isSubagent = true;
    }
    if (tailInfo.contextTokens > 0 && (tailIsFresh || !lease.contextTokens)) {
      lease.contextTokens = tailInfo.contextTokens;
    }
    if (tailInfo.mediaCount > 0) {
      lease.mediaCount = Math.max(lease.mediaCount || 0, tailInfo.mediaCount);
    }
    if (tailInfo.model && !lease.model) lease.model = tailInfo.model;
    if (tailInfo.latestUserInput && !lease.lastUserInput) {
      lease.lastUserInput = tailInfo.latestUserInput;
      lease.isCompactCmd = lease.isCompactCmd || tailInfo.isCompactCmd;
    }
    if (!tailIsFresh || tailInfo.isTerminal) return;

    if (tailInfo.hasPendingToolCalls && tailInfo.pendingTool) {
      const pt = tailInfo.pendingTool;
      const curTier = getToolTimeoutTier(lease.activeToolKind, lease.phase);
      const nextPhase = pt.isBackground ? WATCHDOG_PHASES.SUBAGENT_BG : WATCHDOG_PHASES.TOOL_RUNNING;
      const nextTier = getToolTimeoutTier(pt.activeToolKind, nextPhase);

      if (pt.isBackground) {
        lease.phase = WATCHDOG_PHASES.SUBAGENT_BG;
        lease.subphase = pt.activeToolKind || "subagent_bg";
        lease.activeTool = pt.activeTool;
        lease.activeToolKind = pt.activeToolKind;
        lease.activeToolSummary = pt.summary || lease.activeToolSummary;
      } else if (
        lease.phase === WATCHDOG_PHASES.LLM_INFLIGHT ||
        (lease.phase === WATCHDOG_PHASES.TOOL_RUNNING && nextTier > curTier)
      ) {
        lease.phase = WATCHDOG_PHASES.TOOL_RUNNING;
        lease.subphase =
          pt.activeToolKind === "sync_cmd" || pt.activeToolKind === "mcp_long" ? "sync_cmd" : "read_or_mcp";
        lease.activeTool = pt.activeTool;
        lease.activeToolKind = pt.activeToolKind;
        lease.activeToolSummary = pt.summary || lease.activeToolSummary;
      } else if (!lease.activeTool) {
        lease.activeTool = pt.activeTool;
        lease.activeToolKind = pt.activeToolKind;
        lease.activeToolSummary = pt.summary || lease.activeToolSummary;
      }
    } else if (
      tailInfo.inferredPhase === WATCHDOG_PHASES.LLM_INFLIGHT &&
      lease.phase === WATCHDOG_PHASES.TOOL_RUNNING &&
      (lease.activeToolKind === "read" || lease.activeToolKind === "host")
    ) {
      // read_file/view_file and non-PostToolUse native host tools do not register PostToolUse; once
      // the transcript confirms all tool calls have results (GENERIC / TOOL_RESULT), return to LLM_INFLIGHT.
      lease.phase = WATCHDOG_PHASES.LLM_INFLIGHT;
      lease.activeTool = "";
      lease.activeToolKind = "";
      lease.activeToolSummary = "";
      lease.activeToolCallId = "";
      lease.pendingSlowCalls = [];
    }
  }

  _evaluateActiveLease(store, leaseInput, { nowWallMs, cfg, desktopNotifyEnabled, uiLang = "en", sleepJumpMs, _retryDepth = 0 }) {
    let lease = { ...leaseInput };
    const st = this._getOrCreateConvState(lease.conversationId);

    if (lease.updatedTs !== st.lastLeaseUpdatedTs) {
      st.lastLeaseUpdatedTs = lease.updatedTs;
      const pollMs = Math.min(60000, Math.max(1000, Number(cfg.watchdogPollMs) || 5000));
      if (sleepJumpMs > 0 && lease.updatedTs < nowWallMs - pollMs) {
        st.sleepGraceMs = Math.min(sleepJumpMs, Math.max(0, nowWallMs - lease.updatedTs - 1000));
      } else if (sleepJumpMs < 0 && lease.updatedTs > nowWallMs) {
        st.sleepGraceMs = Math.max(sleepJumpMs, nowWallMs - lease.updatedTs);
      } else {
        st.sleepGraceMs = 0;
      }
      st.lastTranscriptGrowthTs = 0;
      st.lastTailInfo = null;
      st.lastTailFresh = false;
      st.rescueBriefKey = "";
      st.rescueBrief = null;
      if (lease.hookEvent === "PreInvocation") {
        // Fresh PreInvocation stat baseline (handles /compact transcript shrinkage cleanly)
        st.lastStatSize = lease.transcriptSize > 0 ? lease.transcriptSize : -1;
        st.lastStatMtimeMs = lease.transcriptSize > 0 ? lease.transcriptMtimeMs || 0 : 0;
      } else if (lease.transcriptSize > 0 && st.lastStatSize < 0) {
        st.lastStatSize = lease.transcriptSize;
        st.lastStatMtimeMs = lease.transcriptMtimeMs || 0;
      }
    }

    let txPath = lease.transcriptPath || st.transcriptPath || "";
    if (!txPath) {
      try {
        txPath = this.findTranscriptFn(lease.conversationId) || "";
      } catch {
        txPath = "";
      }
    }
    if (txPath) st.transcriptPath = txPath;

    let transcriptGrowing = false;
    let statOk = false;
    let curMtimeMs = 0;
    let curSize = -1;

    if (txPath) {
      try {
        this.statSyncCount += 1;
        const fstat = this.statFn(txPath);
        if (fstat && (typeof fstat.isFile !== "function" || fstat.isFile())) {
          statOk = true;
          curMtimeMs = Number(fstat.mtimeMs || 0);
          curSize = Number(fstat.size || 0);

          const baselineSize = Math.max(st.lastStatSize >= 0 ? st.lastStatSize : 0, lease.transcriptSize || 0);
          const baselineMtime = Math.max(st.lastStatMtimeMs || 0, lease.transcriptMtimeMs || 0);

          const grewBySize = curSize > baselineSize && (st.lastStatSize >= 0 || lease.transcriptSize > 0);
          const grewByMtime =
            curMtimeMs > baselineMtime + 50 && (st.lastStatMtimeMs > 0 || lease.transcriptMtimeMs > 0);

          if (grewBySize || grewByMtime) {
            transcriptGrowing = true;
            const effectiveGrowthTs =
              curMtimeMs > 0 ? Math.min(nowWallMs, Math.max(curMtimeMs, nowWallMs - 1000)) : nowWallMs;
            st.lastTranscriptGrowthTs = Math.max(st.lastTranscriptGrowthTs || 0, effectiveGrowthTs);
          }

          st.lastStatSize = curSize;
          st.lastStatMtimeMs = curMtimeMs;
        }
      } catch {
        // Transcript missing or temporarily locked -> fail-open to hook heartbeat
      }
    }

    const preActivityTs = Math.max(
      lease.lastHeartbeatTs || lease.updatedTs || nowWallMs,
      st.lastTranscriptGrowthTs || 0
    );
    const preThresholds = resolveDynamicThresholds(lease, cfg);
    const preSilentSec = Math.max(0, Math.round((nowWallMs - preActivityTs - (st.sleepGraceMs || 0)) / 1000));

    const transcriptChangedSinceInspect =
      statOk && (curSize !== st.lastInspectedSize || curMtimeMs !== st.lastInspectedMtimeMs);
    const approachingAlert =
      preThresholds.suspectSec > 0 && preSilentSec >= Math.max(5, Math.floor(preThresholds.suspectSec * 0.5));

    if (statOk && txPath && curSize > 0 && (transcriptChangedSinceInspect || (approachingAlert && !st.lastTailInfo))) {
      try {
        this.tailReadCount += 1;
        const steps = this.readTailFn(txPath, 65536);
        const tailInfo = inspectTranscriptTailForWatchdog(steps, { isSubagent: lease.isSubagent });
        st.lastInspectedSize = curSize;
        st.lastInspectedMtimeMs = curMtimeMs;
        st.lastTailInfo = tailInfo;

        const hasLeaseBaseline = lease.transcriptSize > 0 || lease.transcriptMtimeMs > 0;
        let tailIsFresh = false;
        if (hasLeaseBaseline) {
          // Hard veto: if the file neither grew nor advanced mtime since the hook snapshotted it,
          // any terminal step at the tail belongs to a PRIOR turn (even if <2s earlier!).
          const fileGrew = lease.transcriptSize > 0 && curSize > lease.transcriptSize;
          const fileMtimeAdvanced = lease.transcriptMtimeMs > 0 && curMtimeMs > lease.transcriptMtimeMs + 50;
          const stepNotOlder = tailInfo.lastStepTs === null || tailInfo.lastStepTs >= (lease.updatedTs || 0) - 2000;
          tailIsFresh = Boolean((fileGrew || fileMtimeAdvanced) && stepNotOlder);
        } else {
          const mtimeAfterLease = curMtimeMs > (lease.updatedTs || 0) + 250;
          const stepStrictlyAfter =
            tailInfo.lastStepTs !== null && tailInfo.lastStepTs >= (lease.updatedTs || 0) + 250;
          const stepNotStale = tailInfo.lastStepTs === null || tailInfo.lastStepTs >= (lease.updatedTs || 0) - 1000;
          tailIsFresh = Boolean((mtimeAfterLease || stepStrictlyAfter) && stepNotStale);
        }
        st.lastTailFresh = tailIsFresh;

        this._applyTailEnrichment(lease, tailInfo, tailIsFresh);

        if (tailInfo.isTerminal && tailIsFresh) {
          const healedLease = {
            ...lease,
            phase: WATCHDOG_PHASES.IDLE,
            subphase: "self_healed",
            activeTool: "",
            activeToolKind: "",
            activeToolSummary: "",
            activeToolCallId: "",
            pendingSlowCalls: [],
            stopReason: tailInfo.terminalReason || "transcript_terminal_self_heal",
            transcriptPath: txPath,
            transcriptMtimeMs: curMtimeMs,
            transcriptSize: curSize,
            phaseChangedTs: nowWallMs,
            updatedTs: nowWallMs,
            lastHeartbeatTs: nowWallMs,
            hookEvent: "SidecarHeal",
            ackedUntilTs: 0
          };
          let cas = { written: true, current: healedLease };
          try {
            cas = writeWatchdogLeaseIfUnchanged(store, leaseInput.updatedTs, leaseInput.phase, healedLease);
          } catch {}
          if (!cas.written && cas.current && cas.current.phase !== WATCHDOG_PHASES.IDLE && _retryDepth < 1) {
            // Concurrent hook started a brand-new turn while we were inspecting disk — DO NOT heal it!
            return this._evaluateActiveLease(store, cas.current, {
              nowWallMs,
              cfg,
              desktopNotifyEnabled,
              sleepJumpMs: 0,
              _retryDepth: _retryDepth + 1
            });
          }
          if (cas.written) {
            st.lastLeaseUpdatedTs = nowWallMs;
            st.sleepGraceMs = 0;
            st.lastTranscriptGrowthTs = 0;
            st.rescueBriefKey = "";
            st.rescueBrief = null;
            return {
              ...this._buildIdleEvaluation(healedLease, nowWallMs),
              selfHealed: true
            };
          }
        }
      } catch {
        // Fail-open on unreadable transcript
      }
    } else if (st.lastTailInfo) {
      this._applyTailEnrichment(lease, st.lastTailInfo, Boolean(st.lastTailFresh));
    }

    if (lease.phase === WATCHDOG_PHASES.LLM_INFLIGHT) {
      lease.subphase = deriveLlmSubphase({
        contextTokens: lease.contextTokens,
        mediaCount: lease.mediaCount,
        isCompactCmd: lease.isCompactCmd
      });
    }
    const thresholds = resolveDynamicThresholds(lease, cfg);
    const lastActivityTs = Math.max(
      lease.lastHeartbeatTs || lease.updatedTs || nowWallMs,
      st.lastTranscriptGrowthTs || 0
    );
    const activeSilentMs = Math.max(0, nowWallMs - lastActivityTs - (st.sleepGraceMs || 0));
    const silentSec = Math.max(0, Math.round(activeSilentMs / 1000));

    // Auto-retire runtime stale active leases (> staleLeaseMs) and abandoned Turn-0 zero-output
    // orphan leases (>= orphanTurn0Ms with 0 assistant steps / 0 context tokens) via CAS so
    // long-running Sidecars recover the 0-statSync IDLE fast path automatically.
    const isRuntimeStale = this.staleLeaseMs > 0 && activeSilentMs >= this.staleLeaseMs;
    const minOrphanMs = Math.max((thresholds.stalledSec || 120) * 1000 + 60_000, this.orphanTurn0Ms);
    const isAbandonedTurn0Orphan =
      !isRuntimeStale &&
      this.orphanTurn0Ms > 0 &&
      lease.phase === WATCHDOG_PHASES.LLM_INFLIGHT &&
      (lease.invocationNum === 0 || lease.invocationNum === null) &&
      (lease.contextTokens || 0) === 0 &&
      !lease.lastCompletedTool &&
      !lease.activeTool &&
      !transcriptGrowing &&
      (!st.lastTailInfo || !st.lastTailInfo.hasAssistantSteps) &&
      lease.ackedUntilTs <= nowWallMs &&
      activeSilentMs >= minOrphanMs;

    if (isRuntimeStale || isAbandonedTurn0Orphan) {
      const retiredLease = {
        ...lease,
        phase: WATCHDOG_PHASES.IDLE,
        subphase: "stale_cleanup",
        activeTool: "",
        activeToolKind: "",
        activeToolSummary: "",
        activeToolCallId: "",
        pendingSlowCalls: [],
        transcriptSize: 0,
        transcriptMtimeMs: 0,
        stopReason: isRuntimeStale ? "stale_lease_expired" : "orphan_turn0_abandoned",
        phaseChangedTs: nowWallMs,
        updatedTs: nowWallMs,
        lastHeartbeatTs: nowWallMs,
        hookEvent: "SidecarHeal",
        ackedUntilTs: 0
      };
      let cas = { written: true, current: retiredLease };
      try {
        cas = writeWatchdogLeaseIfUnchanged(store, leaseInput.updatedTs, leaseInput.phase, retiredLease);
      } catch {}
      if (!cas.written && cas.current && cas.current.phase !== WATCHDOG_PHASES.IDLE && _retryDepth < 1) {
        return this._evaluateActiveLease(store, cas.current, {
          nowWallMs,
          cfg,
          desktopNotifyEnabled,
          uiLang,
          sleepJumpMs: 0,
          _retryDepth: _retryDepth + 1
        });
      }
      if (cas.written) {
        st.lastLeaseUpdatedTs = nowWallMs;
        st.sleepGraceMs = 0;
        st.lastTranscriptGrowthTs = 0;
        st.rescueBriefKey = "";
        st.rescueBrief = null;
        return {
          ...this._buildIdleEvaluation(retiredLease, nowWallMs),
          selfHealed: true
        };
      }
    }

    const progressPct =
      thresholds.stalledSec > 0
        ? Math.min(100, Number(((silentSec / thresholds.stalledSec) * 100).toFixed(1)))
        : 0;

    let rawSeverity = "active";
    if (silentSec >= thresholds.stalledSec) {
      rawSeverity = "stalled";
    } else if (silentSec >= thresholds.suspectSec) {
      rawSeverity = "suspect";
    }

    const isSnoozed = rawSeverity !== "active" && lease.ackedUntilTs > nowWallMs;
    const severity = isSnoozed ? "snoozed" : rawSeverity;

    let diagnosis = null;
    let rescueBrief = null;

    if (rawSeverity === "suspect" || rawSeverity === "stalled") {
      diagnosis = diagnoseStallCause(lease, { platform: this.platform });
    }

    if (rawSeverity === "stalled") {
      const incidentKey = `${lease.conversationId}:${lease.phaseChangedTs || lease.updatedTs}:${lease.phase}:${diagnosis?.causeId || "unknown"}`;
      if (st.rescueBriefKey === incidentKey && st.rescueBrief) {
        rescueBrief = st.rescueBrief;
      } else {
        try {
          const safeLeaseCwd = isSafeWorkspaceDir(lease.cwd) ? lease.cwd : "";
          const workDir = safeLeaseCwd || inferWorkspaceFromStore(store, lease.rootSessionId || lease.conversationId);
          const stallContext = {
            severity: "stalled",
            phase: lease.phase,
            subphase: lease.subphase,
            silentSec,
            stalledThresholdSec: thresholds.stalledSec,
            activeTool: lease.activeTool,
            activeToolSummary: lease.activeToolSummary,
            lastCompletedTool: lease.lastCompletedTool,
            lastUserInput: lease.lastUserInput,
            contextTokens: lease.contextTokens || 0,
            model: lease.model || "",
            causeId: diagnosis?.causeId || "",
            causeLabel: diagnosis?.label || "",
            tips: diagnosis?.tips || []
          };
          const brief = this.buildHandoffFn({
            store,
            sessionId: lease.rootSessionId || lease.conversationId,
            cwd: workDir,
            cacheDiag: null,
            maxBytes: 5800,
            stallContext
          });
          rescueBrief = {
            markdown: brief.markdown,
            summary: brief.summary,
            bytes: brief.bytes,
            truncated: brief.truncated,
            generatedAt: nowWallMs,
            incidentKey
          };
          st.rescueBriefKey = incidentKey;
          st.rescueBrief = rescueBrief;
        } catch {
          rescueBrief = null;
        }
      }

      if (desktopNotifyEnabled && !isSnoozed && !lease.isSubagent) {
        const cooldownMs = Math.max(30, Number(cfg.watchdogNotifyCooldownSec) || 300) * 1000;
        const sameIncidentAlreadySent = st.lastNotifyKey === incidentKey;
        const inCooldown = st.lastNotifyTs > 0 && nowWallMs - st.lastNotifyTs < cooldownMs;
        if (!sameIncidentAlreadySent && !inCooldown) {
          st.lastNotifyKey = incidentKey;
          st.lastNotifyTs = nowWallMs;
          this.notificationCount += 1;
          try {
            const isZh = uiLang === "zh";
            this.notifyFn({
              title: isZh ? "agy-dart：对话疑似卡住" : "agy-dart: Session Stalled",
              body: isZh
                ? `${diagnosis?.labelZh || diagnosis?.label || lease.phase}（已无响应 ${silentSec} 秒）。请打开右侧 agy-dart 面板复制抢救简报。`
                : `${diagnosis?.label || lease.phase} (silent ${silentSec}s). Open Sidecar to copy Rescue Handoff Brief.`,
              conversationId: lease.conversationId,
              causeId: diagnosis?.causeId || "",
              silentSec,
              platform: this.platform
            });
          } catch {}
        }
      }
    }

    return {
      conversationId: lease.conversationId,
      rootSessionId: lease.rootSessionId,
      parentConversationId: lease.parentConversationId,
      isSubagent: lease.isSubagent,
      phase: lease.phase,
      subphase: lease.subphase,
      bucket: thresholds.bucket,
      severity,
      rawSeverity,
      silentSec,
      suspectSec: thresholds.suspectSec,
      stalledSec: thresholds.stalledSec,
      progressPct,
      lastActivityTs,
      startedTs: lease.startedTs || lease.updatedTs || nowWallMs,
      phaseChangedTs: lease.phaseChangedTs || lease.updatedTs || nowWallMs,
      activeTool: lease.activeTool || "",
      activeToolKind: lease.activeToolKind || "",
      activeToolSummary: lease.activeToolSummary || "",
      lastCompletedTool: lease.lastCompletedTool || "",
      lastUserInput: lease.lastUserInput || "",
      contextTokens: lease.contextTokens || 0,
      mediaCount: lease.mediaCount || 0,
      model: lease.model || "",
      stopReason: lease.stopReason || "",
      selfHealed: false,
      transcriptGrowing,
      snoozedUntilTs: isSnoozed ? lease.ackedUntilTs : 0,
      diagnosis,
      rescueBrief
    };
  }

  getStatus({ conversationId = "", scope = "conversation", refresh = true } = {}) {
    const tickRes = refresh ? this.tick() : null;
    const nowWallMs = tickRes ? tickRes.serverNowMs : this.nowFn();
    const cfg = this.getConfig() || {};
    const store = this.getStore?.();
    const enabled = tickRes ? tickRes.enabled : this._resolveWatchdogEnabled(store, cfg);
    const desktopNotifyEnabled = tickRes
      ? tickRes.desktopNotifyEnabled
      : this._resolveDesktopNotifyEnabled(store, cfg);
    const ttlDesktopNotifyEnabled = tickRes
      ? tickRes.ttlDesktopNotifyEnabled
      : this._resolveTtlDesktopNotifyEnabled(store, cfg);
    const langInfo = tickRes
      ? { lang: tickRes.uiLang || "en", source: tickRes.uiLangSource || "default" }
      : this._resolveUiLangInfo(store, cfg);
    const ttlNotifyLeadSec = Math.min(300, Math.max(15, Math.floor(Number(cfg.ttlNotifyLeadSec) || 60)));
    const ttlNotifyMinTokens = Math.min(500000, Math.max(4000, Math.floor(Number(cfg.ttlNotifyMinTokens) || 60000)));

    const sessions = Array.from(this._lastEvaluated.values()).sort((a, b) => {
      const rankDiff = severityRank(b.severity) - severityRank(a.severity);
      if (rankDiff !== 0) return rankDiff;
      return (b.lastActivityTs || 0) - (a.lastActivityTs || 0);
    });

    const safeConvId = sanitizeConversationId(conversationId);
    let current = null;
    if (safeConvId && scope === "conversation") {
      current = this._lastEvaluated.get(safeConvId) || null;
    } else if (safeConvId) {
      current = this._lastEvaluated.get(safeConvId) || sessions[0] || null;
    } else {
      current = sessions.find((s) => s.phase !== WATCHDOG_PHASES.IDLE) || sessions[0] || null;
    }

    const alertingSessions = sessions.filter((s) => s.severity === "stalled" || s.severity === "suspect");
    const activeCount = sessions.filter((s) => s.phase !== WATCHDOG_PHASES.IDLE).length;
    const suspectCount = sessions.filter((s) => s.severity === "suspect").length;
    const stalledCount = sessions.filter((s) => s.severity === "stalled").length;

    return {
      ok: true,
      enabled,
      desktopNotifyEnabled,
      ttlDesktopNotifyEnabled,
      uiLang: langInfo.lang,
      uiLangSource: langInfo.source,
      ttlNotifyLeadSec,
      ttlNotifyMinTokens,
      serverNowMs: nowWallMs,
      pollMs: Math.min(60000, Math.max(1000, Number(cfg.watchdogPollMs) || 5000)),
      thresholds: {
        suspectRatio: cfg.watchdogSuspectRatio ?? 0.6,
        llmLowSec: cfg.watchdogLlmLowSec ?? 120,
        llmHighSec: cfg.watchdogLlmHighSec ?? 240,
        llmMultimodalSec: cfg.watchdogLlmMultimodalSec ?? 360,
        toolFastSec: cfg.watchdogToolFastSec ?? 90,
        toolCmdSec: cfg.watchdogToolCmdSec ?? 300,
        subagentSec: cfg.watchdogSubagentSec ?? 600
      },
      sleepGuard: {
        triggeredCount: this._sleepGuardCount,
        lastDriftAt: this._lastSleepDriftAt,
        lastJumpMs: this._lastSleepJumpMs
      },
      current,
      sessions: sessions.slice(0, 20),
      alertingSessions: alertingSessions.slice(0, 10),
      stats: {
        totalTracked: sessions.length,
        activeCount,
        suspectCount,
        stalledCount,
        statSyncCount: this.statSyncCount,
        tailReadCount: this.tailReadCount,
        notificationCount: this.notificationCount,
        ttlNotificationCount: this.ttlNotificationCount
      }
    };
  }

  getStallContextForConversation(conversationId) {
    const safeId = sanitizeConversationId(conversationId);
    if (!safeId) return null;
    const item = this._lastEvaluated.get(safeId);
    if (!item || (item.rawSeverity !== "stalled" && item.rawSeverity !== "suspect")) {
      return null;
    }
    return {
      severity: item.rawSeverity,
      phase: item.phase,
      subphase: item.subphase,
      silentSec: item.silentSec,
      stalledThresholdSec: item.stalledSec,
      activeTool: item.activeTool,
      activeToolSummary: item.activeToolSummary,
      lastCompletedTool: item.lastCompletedTool,
      lastUserInput: item.lastUserInput,
      contextTokens: item.contextTokens || 0,
      model: item.model || "",
      causeId: item.diagnosis?.causeId || "",
      causeLabel: item.diagnosis?.label || "",
      tips: item.diagnosis?.tips || []
    };
  }

  getTopAlertingStallContext() {
    const sessions = Array.from(this._lastEvaluated.values()).sort((a, b) => {
      const rankDiff = severityRank(b.severity) - severityRank(a.severity);
      if (rankDiff !== 0) return rankDiff;
      return (b.lastActivityTs || 0) - (a.lastActivityTs || 0);
    });
    const top = sessions.find((s) => s.rawSeverity === "stalled" || s.rawSeverity === "suspect");
    return top ? this.getStallContextForConversation(top.conversationId) : null;
  }

  acknowledge(conversationId, snoozeSec = 300) {
    const store = this.getStore?.();
    const safeId = sanitizeConversationId(conversationId);
    if (!store || !safeId) return { ok: false, error: "Valid conversationId is required" };
    const lease = readWatchdogLease(store, safeId);
    if (!lease) return { ok: false, error: "No watchdog lease found for conversation" };
    const now = this.nowFn();
    const sec = Math.min(3600, Math.max(30, Number(snoozeSec) || 300));
    const updated = writeWatchdogLease(store, {
      ...lease,
      ackedUntilTs: now + sec * 1000
    });
    this.tick();
    return { ok: true, conversationId: safeId, snoozedUntilTs: updated?.ackedUntilTs || 0 };
  }

  markIdle(conversationId, reason = "user_marked_idle") {
    const store = this.getStore?.();
    const safeId = sanitizeConversationId(conversationId);
    if (!store || !safeId) return { ok: false, error: "Valid conversationId is required" };
    const lease = readWatchdogLease(store, safeId);
    if (!lease) return { ok: true, conversationId: safeId, phase: WATCHDOG_PHASES.IDLE };
    const now = this.nowFn();
    writeWatchdogLease(store, {
      ...lease,
      phase: WATCHDOG_PHASES.IDLE,
      subphase: "user_cleared",
      activeTool: "",
      activeToolKind: "",
      activeToolSummary: "",
      activeToolCallId: "",
      pendingSlowCalls: [],
      transcriptSize: 0,
      transcriptMtimeMs: 0,
      stopReason: sanitizeWatchdogText(reason, 64),
      phaseChangedTs: now,
      updatedTs: now,
      lastHeartbeatTs: now,
      hookEvent: "UserAck",
      ackedUntilTs: 0
    });
    const st = this._convState.get(safeId);
    if (st) {
      st.rescueBriefKey = "";
      st.rescueBrief = null;
      st.sleepGraceMs = 0;
      st.lastTranscriptGrowthTs = 0;
    }
    this.tick();
    return { ok: true, conversationId: safeId, phase: WATCHDOG_PHASES.IDLE };
  }
}
