#!/usr/bin/env node
/**
 * agy-dart Stop hook (v1.4.0):
 * Lightweight (<5ms), fail-open lifecycle hook that marks the per-conversation
 * Sidecar Stall Watchdog lease (`watchdog_lease:<directConvId>`) as `IDLE`
 * when an agent turn completes cleanly.
 *
 * Strictly zero-prefix-pollution (emits `{"decision":"allow"}\n`, 0 bytes stderr)
 * and never creates a brand-new SQLite DB when none exists.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enableVersionedCompileCache } from "./compile-cache.mjs";
import { getEffectiveConfig } from "../context/lib/config.js";

const STOP_ALLOW_OUTPUT = '{"decision":"allow"}\n';

function readStdin(timeoutMs = 1000) {
  return new Promise((resolve) => {
    let data = "";
    let settled = false;
    const onData = (chunk) => {
      data += chunk;
    };
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.off("end", done);
      process.stdin.off("error", done);
      try {
        process.stdin.pause();
        process.stdin.unref?.();
      } catch {}
      resolve(data);
    };
    const timer = setTimeout(done, timeoutMs);
    timer.unref();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

function resolveSessionId(payload = {}) {
  return (
    payload.rootConversationId ||
    payload.root_conversation_id ||
    payload.parentConversationId ||
    payload.parent_conversation_id ||
    payload.conversationId ||
    payload.conversation_id ||
    payload.sessionId ||
    payload.session_id ||
    process.env.ANTIGRAVITY_ROOT_CONVERSATION_ID ||
    process.env.ANTIGRAVITY_PARENT_CONVERSATION_ID ||
    process.env.ANTIGRAVITY_CONVERSATION_ID ||
    "default"
  );
}

function resolveDirectConversationId(payload = {}) {
  return (
    payload.conversationId ||
    payload.conversation_id ||
    payload.sessionId ||
    payload.session_id ||
    process.env.ANTIGRAVITY_CONVERSATION_ID ||
    "default"
  );
}

export async function handleStopPayload(payload = {}, options = {}) {
  const safePayload = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const safeOptions = options && typeof options === "object" && !Array.isArray(options) ? options : {};
  const effectiveCfg = safeOptions.effectiveCfg || getEffectiveConfig();
  const directConvId = resolveDirectConversationId(safePayload);
  if (!directConvId || directConvId === "default") {
    return { updated: false, reason: "no_conversation_id" };
  }
  const resolvedDbPath = safeOptions.dbPath || effectiveCfg.dbPath || path.join(os.homedir(), ".agy-dart", "context.db");
  if (!safeOptions.store && !fs.existsSync(resolvedDbPath)) {
    return { updated: false, reason: "no_db" };
  }

  let ownedStore = null;
  try {
    const { readWatchdogLease, recordHookLeaseTransition, WATCHDOG_PHASES } = await import(
      "../context/lib/watchdog-lease.js"
    );
    let store = safeOptions.store || null;
    if (!store) {
      const { ContextModeStore } = await import("../context/lib/store.js");
      ownedStore = new ContextModeStore({
        dbPath: resolvedDbPath,
        hookMode: true,
        maxBusyRetries: 4,
        maxRetryDeadlineMs: 800
      });
      store = ownedStore;
    }
    const watchdogActive = Boolean(
      effectiveCfg.stallWatchdog &&
        (typeof store.isWatchdogEnabled !== "function" || store.isWatchdogEnabled())
    );
    const ttlNotifyActive = Boolean(
      typeof store.isTtlDesktopNotifyEnabled === "function"
        ? store.isTtlDesktopNotifyEnabled()
        : effectiveCfg.ttlDesktopNotify
    );
    const watermarkNotifyActive =
      effectiveCfg.watermarkDesktopNotify === true ||
      (effectiveCfg.watermarkDesktopNotify === null && ttlNotifyActive);
    const existing = readWatchdogLease(store, directConvId);
    if (!watchdogActive && !ttlNotifyActive && !watermarkNotifyActive) {
      if (!existing || existing.phase === WATCHDOG_PHASES.IDLE) {
        return { updated: false, reason: "disabled" };
      }
    }
    const sessionId = resolveSessionId(safePayload);
    let stopModifiedPaths = [];
    if (
      existing?.cwd &&
      (!existing.workspaceLabel || !existing.workspaceLabel.includes("/")) &&
      typeof store.getSessionCheckpoint === "function"
    ) {
      try {
        const cp = store.getSessionCheckpoint(directConvId) || store.getSessionCheckpoint(sessionId);
        if (Array.isArray(cp?.modifiedFiles)) {
          stopModifiedPaths = cp.modifiedFiles
            .map((f) => (typeof f === "string" ? f : f?.path || ""))
            .filter(Boolean);
        }
      } catch {}
    }
    const lease = recordHookLeaseTransition(store, "Stop", safePayload, {
      directConvId,
      rootSessionId: sessionId,
      cwd: safePayload.cwd || "",
      ...(stopModifiedPaths.length > 0 ? { modifiedOrReadPaths: stopModifiedPaths } : {}),
      ...(safeOptions.stopReason !== undefined ? { stopReason: safeOptions.stopReason } : {}),
      ...(safeOptions.fullyIdle !== undefined ? { fullyIdle: safeOptions.fullyIdle } : {}),
      ...(safeOptions.error !== undefined ? { error: safeOptions.error } : {})
    });
    return { updated: Boolean(lease), lease };
  } catch {
    return { updated: false, reason: "fail_open" };
  } finally {
    if (ownedStore) {
      try {
        ownedStore.close();
      } catch {}
    }
  }
}

async function main() {
  enableVersionedCompileCache();
  const effectiveCfg = getEffectiveConfig();
  const resolvedDbPath = effectiveCfg.dbPath || path.join(os.homedir(), ".agy-dart", "context.db");
  if (!fs.existsSync(resolvedDbPath)) {
    process.stdout.write(STOP_ALLOW_OUTPUT);
    return;
  }

  const raw = (await readStdin()).trim();
  if (!raw) {
    process.stdout.write(STOP_ALLOW_OUTPUT);
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stdout.write(STOP_ALLOW_OUTPUT);
    return;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    process.stdout.write(STOP_ALLOW_OUTPUT);
    return;
  }

  await handleStopPayload(payload, { effectiveCfg });
  process.stdout.write(STOP_ALLOW_OUTPUT);
}

const __selfPath = path.resolve(fileURLToPath(import.meta.url));
function isSameFilePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => {
    const resolved = path.resolve(p);
    let real = resolved;
    try {
      real = fs.realpathSync(resolved);
    } catch {}
    return process.platform === "win32" ? real.toLowerCase() : real;
  };
  return norm(a) === norm(b);
}
const isDirectRun = Boolean(process.argv[1] && isSameFilePath(process.argv[1], __selfPath));
if (isDirectRun) {
  main().catch(() => {
    process.stdout.write(STOP_ALLOW_OUTPUT);
  });
}
