import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resetConfigCache } from "../context/lib/config.js";
import { ContextModeStore } from "../context/lib/store.js";
import { WatchdogMonitor, readWatchdogLease, writeWatchdogLease, WATCHDOG_PHASES } from "../context/lib/watchdog.js";
import { isTtlKeepalivePrompt } from "../context/lib/watchdog-lease.js";
import {
  closeRuntimeStore,
  createStandaloneServer,
  sendSidecarKeepaliveMessage
} from "../sidecars/dashboard/server.mjs";
import vm from "node:vm";
import { suppressSqliteExperimentalWarning } from "../hooks/compile-cache.mjs";

suppressSqliteExperimentalWarning();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 25));

function httpJsonRequest(port, reqPath, { method = "POST", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body !== null ? JSON.stringify(body) : "";
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: reqPath,
        method,
        headers: {
          ...headers,
          ...(payload ? { "Content-Length": Buffer.byteLength(payload, "utf8") } : {})
        }
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, raw, json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test("v1.5.4-ka-1: Default 3x per-conversation TTL auto-keepalive (no 60k threshold), per-session isolation, failure rollback & desktop notify coordination", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ka-unit-"));
  const dbPath = path.join(tmpDir, "context.db");
  const store = new ContextModeStore({ dbPath });
  store.open();
  store.setUiLang("zh");

  let nowMs = 1_700_000_000_000;
  let monoNs = 1_000_000_000n;
  const sentKeepalives = [];
  const sentNotifications = [];
  let failNextSend = false;

  const monitor = new WatchdogMonitor({
    getStore: () => store,
    nowFn: () => nowMs,
    monoNsFn: () => monoNs,
    keepaliveSendFn: async (payload) => {
      if (failNextSend) {
        failNextSend = false;
        return { ok: false, error: "simulated_rpc_failure" };
      }
      sentKeepalives.push(payload);
      return { ok: true };
    },
    notifyFn: (payload) => {
      sentNotifications.push(payload);
      return { dispatched: true };
    }
  });

  try {
    assert.equal(store.isTtlKeepaliveEnabled(), true, "Auto-keepalive defaults to ON");
    assert.equal(store.getTtlKeepaliveMaxCount(), 3, "Default max keepalive count is 3");

    const seedStoppedLease = (convId, anchorTs, ctxTokens = 8500, extra = {}) => {
      writeWatchdogLease(store, {
        conversationId: convId,
        rootSessionId: convId,
        phase: WATCHDOG_PHASES.IDLE,
        subphase: "stopped",
        stopReason: "NO_TOOL_CALL",
        contextTokens: ctxTokens,
        cacheTtlSec: 240,
        idleAnchorTs: anchorTs,
        phaseChangedTs: anchorTs,
        updatedTs: anchorTs,
        lastHeartbeatTs: anchorTs,
        lastUserInput: "继续推进清洗",
        ...extra
      });
    };

    // 1. Small context (8.5k < 60k, even with ttlDesktopNotify OFF by default) triggers 1/3, 2/3, 3/3 silently (0 popups, even on in-flight ticks after 3/3!), and pops up ONLY AFTER 3/3 on the 4th expiring cycle!
    for (let round = 1; round <= 4; round++) {
      const anchor = nowMs;
      seedStoppedLease("conv-small-ctx", anchor, 8500);
      // At 190s idle (50s left <= 60s notify lead, > 30s keepalive lead): must NOT pop up while rounds 1..3 are still ahead!
      if (round <= 3) {
        nowMs = anchor + 190_000;
        monoNs += 190_000_000_000n;
        monitor.tick();
        await flushMicrotasks();
        assert.equal(sentNotifications.length, 0, `Round ${round} at 50s left must suppress popup before keepalive`);
        nowMs = anchor + 215_000;
        monoNs += 25_000_000_000n;
      } else {
        nowMs = anchor + 215_000;
        monoNs += 215_000_000_000n;
      }
      monitor.tick();
      await flushMicrotasks();

      if (round <= 3) {
        assert.equal(sentKeepalives.length, round, `Round ${round} must fire keepalive`);
        assert.ok(isTtlKeepalivePrompt(sentKeepalives[round - 1].message));
        assert.ok(sentKeepalives[round - 1].message.includes(`${round}/3`));
        assert.equal(store.getTtlKeepaliveState("conv-small-ctx").usedCount, round);
        assert.equal(sentNotifications.length, 0, `Round ${round} must NOT pop up`);

        // Simulate a 2nd Watchdog tick 5s later (20s left) on the SAME idleAnchorTs while keepalive #round is still in-flight!
        nowMs += 5_000;
        monoNs += 5_000_000_000n;
        monitor.tick();
        await flushMicrotasks();
        assert.equal(sentNotifications.length, 0, `In-flight tick right after keepalive ${round}/3 must NOT pop up early`);
      } else {
        assert.equal(sentKeepalives.length, 3, "4th idle cycle must NOT exceed maxCount=3");
        assert.equal(store.getTtlKeepaliveState("conv-small-ctx").usedCount, 3);
        assert.equal(sentNotifications.length, 1, "4th cycle (after 3rd auto-warming) MUST pop up desktop alert");
        assert.ok(sentNotifications[0].title.includes("3/3"));
        assert.ok(sentNotifications[0].body.includes("3/3"));
      }
      nowMs += 30_000;
      monoNs += 30_000_000_000n;
    }

    // 2. High-context conversation B has its OWN independent 0/3 budget, suppresses desktop alert throughout 1..3, and alerts after 3/3!
    const notifBeforeB = sentNotifications.length;
    for (let round = 1; round <= 3; round++) {
      const anchor = nowMs;
      seedStoppedLease("conv-high-ctx", anchor, 95_000);
      nowMs = anchor + 215_000;
      monoNs += 215_000_000_000n;
      monitor.tick();
      await flushMicrotasks();
      assert.equal(sentNotifications.length, notifBeforeB, `Desktop TTL alert suppressed while keepalive ${round}/3 is active`);
      // Also check 5s in-flight tick on round 3!
      nowMs += 5_000;
      monoNs += 5_000_000_000n;
      monitor.tick();
      await flushMicrotasks();
      assert.equal(sentNotifications.length, notifBeforeB, `No premature popup while keepalive ${round}/3 is in transit`);
      nowMs += 30_000;
      monoNs += 30_000_000_000n;
    }
    assert.equal(store.getTtlKeepaliveState("conv-high-ctx").usedCount, 3);

    // On 4th cycle of conv-high-ctx (keepalive exhausted 3/3), desktop TTL alert fires!
    seedStoppedLease("conv-high-ctx", nowMs, 95_000);
    nowMs += 215_000;
    monoNs += 215_000_000_000n;
    monitor.tick();
    await flushMicrotasks();
    assert.equal(sentNotifications.length, notifBeforeB + 1, "Desktop TTL alert fires once 3/3 keepalives are exhausted");
    assert.ok(sentNotifications[sentNotifications.length - 1].title.includes("3/3"));

    // 3. Background pending subphase & subagent leases are strictly skipped
    const beforeCount = sentKeepalives.length;
    seedStoppedLease("conv-bg-workflow", nowMs, 80_000, { subphase: "stopped_bg_pending" });
    seedStoppedLease("conv-worker-sub", nowMs, 80_000, { isSubagent: true });
    nowMs += 215_000;
    monoNs += 215_000_000_000n;
    monitor.tick();
    await flushMicrotasks();
    assert.equal(sentKeepalives.length, beforeCount, "Background workflow pending & subagents must never auto-keepalive");

    // 4. Failed send rolls back usedCount so quota is not lost
    failNextSend = true;
    seedStoppedLease("conv-rollback", nowMs, 50_000);
    nowMs += 215_000;
    monoNs += 215_000_000_000n;
    monitor.tick();
    await flushMicrotasks();
    const rbState = store.getTtlKeepaliveState("conv-rollback");
    assert.equal(rbState.usedCount, 0, "Failed send must roll back usedCount to 0");
    assert.ok(rbState.lastError.includes("simulated_rpc_failure"));
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("v1.5.4-ka-2: PreInvocation preserves lastUserInput on keepalive turn, resets counter to 0 on genuine user message, and UI/Server actions adjust maxCount", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ka-hook-"));
  const dbPath = path.join(tmpDir, "context.db");
  const cfgPath = path.join(tmpDir, "config.json");
  fs.writeFileSync(cfgPath, "{}", "utf8");

  const prevDbEnv = process.env.AGY_DART_DB_PATH;
  const prevCfgEnv = process.env.AGY_DART_CONFIG_PATH;
  const prevProjEnv = process.env.ANTIGRAVITY_PROJECT_ID;
  process.env.AGY_DART_DB_PATH = dbPath;
  process.env.AGY_DART_CONFIG_PATH = cfgPath;
  resetConfigCache();

  const runPreHook = (payload) =>
    spawnSync(process.execPath, [path.join(ROOT, "hooks", "pre-invocation.mjs")], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, AGY_DART_DB_PATH: dbPath, AGY_DART_CONFIG_PATH: cfgPath }
    });

  let srv = null;
  try {
    // Seed initial user turn + keepalive state = 2/3
    const store = new ContextModeStore({ dbPath });
    store.open();
    writeWatchdogLease(store, {
      conversationId: "conv-ka-reset",
      rootSessionId: "conv-ka-reset",
      phase: WATCHDOG_PHASES.IDLE,
      subphase: "stopped",
      lastUserInput: "请清洗第 10 组文稿",
      updatedTs: Date.now()
    });
    store.setTtlKeepaliveState("conv-ka-reset", {
      usedCount: 2,
      lastIdleAnchorTs: Date.now() - 220_000,
      lastSentTs: Date.now() - 2_000,
      pendingAck: true
    });
    const seqBeforeKa = store.getConversationTurnSeq("conv-ka-reset");
    store.close();

    // 1. Keepalive turn in PreInvocation MUST NOT reset usedCount, MUST NOT clobber lastUserInput, and MUST NOT bump conv_turn_seq!
    const rKa = runPreHook({
      conversationId: "conv-ka-reset",
      invocationNum: 0,
      lastUserInput: "[agy-dart TTL保活 2/3] 仅回复 OK 以保持上下文缓存热度，请勿调用任何工具或修改任何内容。"
    });
    assert.equal(rKa.status, 0);
    assert.equal(rKa.stdout.trim(), "{}");

    const verifyStore1 = new ContextModeStore({ dbPath });
    try {
      assert.equal(verifyStore1.getTtlKeepaliveState("conv-ka-reset").usedCount, 2, "Keepalive turn must keep usedCount=2");
      assert.equal(verifyStore1.getTtlKeepaliveState("conv-ka-reset").pendingAck, false);
      assert.equal(readWatchdogLease(verifyStore1, "conv-ka-reset").lastUserInput, "请清洗第 10 组文稿");
      assert.equal(verifyStore1.getConversationTurnSeq("conv-ka-reset"), seqBeforeKa, "Keepalive turn must not age conv_turn_seq");
    } finally {
      verifyStore1.close();
    }

    // 2. Genuine user message resets usedCount -> 0, updates lastUserInput, and bumps conv_turn_seq!
    const rUser = runPreHook({
      conversationId: "conv-ka-reset",
      invocationNum: 0,
      lastUserInput: "继续推进第 11 组"
    });
    assert.equal(rUser.status, 0);

    const verifyStore2 = new ContextModeStore({ dbPath });
    try {
      assert.equal(verifyStore2.getTtlKeepaliveState("conv-ka-reset").usedCount, 0, "Real user turn resets usedCount -> 0");
      assert.equal(readWatchdogLease(verifyStore2, "conv-ka-reset").lastUserInput, "继续推进第 11 组");
      assert.equal(verifyStore2.getConversationTurnSeq("conv-ka-reset"), seqBeforeKa + 1);
      verifyStore2.setTtlKeepaliveState("conv-ka-reset", { usedCount: 2, updatedTs: Date.now() });
    } finally {
      verifyStore2.close();
    }

    // 3. Server API setTtlKeepalive (toggle + maxCount 1..20 validation + app-scope parity + resetTtlKeepalive) & multi-window sendSidecarKeepaliveMessage
    const token = "test-v154-csrf-0123456789abcdef";
    srv = createStandaloneServer({ csrfToken: token });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;
    const headers = { Host: `127.0.0.1:${port}`, "Content-Type": "application/json", "X-Agy-Dart-Token": token };

    for (const invalidMax of [99, 0, -1, 2.5, true, [5], "", null]) {
      const badMax = await httpJsonRequest(port, "/api/watchdog/action", {
        headers,
        body: { action: "setTtlKeepalive", maxCount: invalidMax, conversationId: "conv-ka-reset" }
      });
      assert.equal(badMax.status, 400, `maxCount=${JSON.stringify(invalidMax)} must be rejected with 400`);
    }

    // Verify /api/cache-diag and /api/watchdog agree on usedCount even when scope="app"
    const appCacheDiag = await httpJsonRequest(port, "/api/cache-diag", {
      headers,
      body: { scope: "app", conversationId: "conv-ka-reset" }
    });
    const appWatchdog = await httpJsonRequest(port, "/api/watchdog", {
      headers,
      body: { scope: "app", conversationId: "conv-ka-reset" }
    });
    assert.equal(appCacheDiag.status, 200);
    assert.equal(appWatchdog.status, 200);
    assert.equal(appCacheDiag.json.ttlKeepalive.usedCount, 2);
    assert.equal(appWatchdog.json.ttlKeepalive.usedCount, 2);

    const setFive = await httpJsonRequest(port, "/api/watchdog/action", {
      headers,
      body: { action: "setTtlKeepalive", enabled: true, maxCount: 5, conversationId: "conv-ka-reset" }
    });
    assert.equal(setFive.status, 200);
    assert.equal(setFive.json.ttlKeepaliveEnabled, true);
    assert.equal(setFive.json.ttlKeepaliveMaxCount, 5);
    assert.equal(setFive.json.status.ttlKeepalive.maxCount, 5);

    const resetRes = await httpJsonRequest(port, "/api/watchdog/action", {
      headers,
      body: { action: "resetTtlKeepalive", scope: "app", conversationId: "conv-ka-reset" }
    });
    assert.equal(resetRes.status, 200);
    assert.equal(resetRes.json.status.ttlKeepalive.usedCount, 0);

    const setOff = await httpJsonRequest(port, "/api/watchdog/action", {
      headers,
      body: { action: "setTtlKeepalive", enabled: false, conversationId: "conv-ka-reset" }
    });
    assert.equal(setOff.status, 200);
    assert.equal(setOff.json.ttlKeepaliveEnabled, false);

    // Verify sendSidecarKeepaliveMessage resolves per-conversation projectId EVEN when ANTIGRAVITY_PROJECT_ID is set to another window's project
    process.env.ANTIGRAVITY_PROJECT_ID = "proj-ambient-window-a";
    const badSend = await sendSidecarKeepaliveMessage("--evil-flag", "OK", { execFn: async () => ({}) });
    assert.equal(badSend.ok, false);

    const calls = [];
    const okSend = await sendSidecarKeepaliveMessage("41eec010-b5dd-4b19-9ac5-b7e9b0b951c9", "[agy-dart TTL保活 1/3] OK", {
      execFn: async (args, opts) => {
        calls.push({ args, projectId: opts.projectId });
        if (args[0] === "get-conversation-metadata") {
          return { response: { conversationMetadata: { metadata: { projectId: "proj-test-123" } } } };
        }
        return { ok: true };
      }
    });
    assert.equal(okSend.ok, true);
    assert.equal(calls.length, 2, "Must query get-conversation-metadata first even when ANTIGRAVITY_PROJECT_ID exists");
    assert.equal(calls[1].projectId, "proj-test-123");

    // When get-conversation-metadata fails, falls back cleanly to ambient ANTIGRAVITY_PROJECT_ID
    const fallbackCalls = [];
    const fbSend = await sendSidecarKeepaliveMessage("552f7955-908a-476e-aaf2-bcdba7254f92", "[agy-dart TTL保活 1/3] OK", {
      execFn: async (args, opts) => {
        fallbackCalls.push({ args, projectId: opts.projectId });
        if (args[0] === "get-conversation-metadata") {
          throw new Error("metadata_rpc_offline");
        }
        return { ok: true };
      }
    });
    assert.equal(fbSend.ok, true);
    assert.equal(fallbackCalls.length, 2);
    assert.equal(fallbackCalls[1].projectId, "proj-ambient-window-a");
  } finally {
    if (srv) await new Promise((resolve) => srv.close(resolve));
    closeRuntimeStore();
    if (prevDbEnv === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDbEnv;
    if (prevCfgEnv === undefined) delete process.env.AGY_DART_CONFIG_PATH;
    else process.env.AGY_DART_CONFIG_PATH = prevCfgEnv;
    if (prevProjEnv === undefined) delete process.env.ANTIGRAVITY_PROJECT_ID;
    else process.env.ANTIGRAVITY_PROJECT_ID = prevProjEnv;
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.5.4-ka-3: Edge cases — un-flushed transcript PLANNER_RESPONSE boundary, array content + SYSTEM_MESSAGE shadowing, and decoupled default-ON keepalive with stallWatchdog disabled", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ka-edge-"));
  const dbPath = path.join(tmpDir, "context.db");
  const cfgPath = path.join(tmpDir, "config.json");
  const txPath = path.join(tmpDir, "transcript_full.jsonl");
  fs.writeFileSync(cfgPath, "{}", "utf8");

  const runHook = (relHook, payload, extraEnv = {}) =>
    spawnSync(process.execPath, [path.join(ROOT, relHook)], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, AGY_DART_DB_PATH: dbPath, AGY_DART_CONFIG_PATH: cfgPath, ...extraEnv }
    });

  try {
    // Write a realistic transcript ending at previous turn's PLANNER_RESPONSE (new USER_INPUT not yet flushed)
    const baseSteps = [
      {
        step_index: 1,
        type: "USER_INPUT",
        created_at: "2026-11-22T13:50:00.000Z",
        content: "<USER_REQUEST>\n请清洗第 10 组文稿\n</USER_REQUEST>"
      },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-22T13:50:10.000Z",
        model: "claude-sonnet-4-5",
        input_tokens: 4000,
        cache_read_tokens: 68000,
        output_tokens: 300,
        content: "已完成第 10 组清洗。"
      }
    ];
    fs.writeFileSync(txPath, baseSteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");

    const store = new ContextModeStore({ dbPath });
    store.open();
    writeWatchdogLease(store, {
      conversationId: "conv-unflushed",
      rootSessionId: "conv-unflushed",
      phase: WATCHDOG_PHASES.IDLE,
      subphase: "stopped",
      lastUserInput: "请清洗第 10 组文稿",
      updatedTs: Date.now()
    });
    store.setTtlKeepaliveState("conv-unflushed", {
      usedCount: 1,
      lastIdleAnchorTs: Date.now() - 230_000,
      lastSentTs: Date.now() - 1_500,
      pendingAck: true
    });
    store.close();

    // 1. No lastUserInput + un-flushed transcript: MUST stop at PLANNER_RESPONSE and acknowledge pendingAck without resetting usedCount!
    const rUnflushed = runHook("hooks/pre-invocation.mjs", {
      conversationId: "conv-unflushed",
      transcriptPath: txPath,
      invocationNum: 0
    });
    assert.equal(rUnflushed.status, 0);
    {
      const st = new ContextModeStore({ dbPath });
      try {
        assert.equal(st.getTtlKeepaliveState("conv-unflushed").usedCount, 1, "Must NOT scan past PLANNER_RESPONSE and reset usedCount");
        assert.equal(st.getTtlKeepaliveState("conv-unflushed").pendingAck, false);
        assert.equal(readWatchdogLease(st, "conv-unflushed").lastUserInput, "请清洗第 10 组文稿");
      } finally {
        st.close();
      }
    }

    // 2. Array content block USER_INPUT + trailing SYSTEM_MESSAGE without payload.lastUserInput -> still recognized as keepalive!
    const arraySteps = [
      ...baseSteps,
      {
        step_index: 3,
        type: "USER_INPUT",
        created_at: "2026-11-22T13:54:00.000Z",
        content: [{ type: "text", text: "[agy-dart TTL保活 2/3] 仅回复 OK 以保持上下文缓存热度，请勿调用任何工具或修改任何内容。" }]
      },
      {
        step_index: 4,
        type: "SYSTEM_MESSAGE",
        created_at: "2026-11-22T13:54:01.000Z",
        content: "Injected runtime reminder after USER_INPUT"
      }
    ];
    fs.writeFileSync(txPath, arraySteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
    {
      const st = new ContextModeStore({ dbPath });
      st.setTtlKeepaliveState("conv-unflushed", {
        usedCount: 2,
        lastSentTs: Date.now() - 1_000,
        pendingAck: true
      });
      st.close();
    }
    const rArray = runHook("hooks/pre-invocation.mjs", {
      conversationId: "conv-unflushed",
      transcriptPath: txPath,
      invocationNum: 0
    });
    assert.equal(rArray.status, 0);
    {
      const st = new ContextModeStore({ dbPath });
      try {
        assert.equal(st.getTtlKeepaliveState("conv-unflushed").usedCount, 2, "Array content + trailing SYSTEM_MESSAGE must preserve usedCount=2");
        assert.equal(st.getTtlKeepaliveState("conv-unflushed").pendingAck, false);
      } finally {
        st.close();
      }
    }

    // 3. Decoupled Auto-Keepalive when AGY_DART_DISABLE_STALL_WATCHDOG=1 + AGY_DART_TTL_KEEPALIVE=1
    const decoupledEnv = { AGY_DART_DISABLE_STALL_WATCHDOG: "1", AGY_DART_TTL_KEEPALIVE: "1" };
    const rDecPre = runHook(
      "hooks/pre-invocation.mjs",
      {
        conversationId: "conv-decoupled-ka",
        transcriptPath: txPath,
        invocationNum: 0,
        lastUserInput: "测试关闭看门狗后默认自动续温"
      },
      decoupledEnv
    );
    assert.equal(rDecPre.status, 0);
    const rDecStop = runHook(
      "hooks/stop.mjs",
      { conversationId: "conv-decoupled-ka", terminationReason: "NO_TOOL_CALL" },
      decoupledEnv
    );
    assert.equal(rDecStop.status, 0);
    assert.equal(rDecStop.stdout, '{"decision":"allow"}\n');

    const stDec = new ContextModeStore({ dbPath });
    try {
      const decLease = readWatchdogLease(stDec, "conv-decoupled-ka");
      assert.ok(decLease, "Default-ON auto-keepalive must still record lease when stallWatchdog is disabled");
      assert.equal(decLease.phase, WATCHDOG_PHASES.IDLE);
      assert.equal(decLease.subphase, "stopped");
      assert.ok(decLease.idleAnchorTs > 0);

      const sent = [];
      const simNow = decLease.idleAnchorTs + 280_000; // 20s left on 300s Claude TTL (<= 30s lead)
      const mon = new WatchdogMonitor({
        getStore: () => stDec,
        getConfig: () => ({ stallWatchdog: false, ttlDesktopNotify: false }),
        nowFn: () => simNow,
        monoNsFn: () => 10_000_000_000n,
        keepaliveSendFn: async (p) => {
          sent.push(p);
          return { ok: true };
        }
      });
      mon.tick();
      await flushMicrotasks();
      assert.equal(sent.length, 1, "WatchdogMonitor with stallWatchdog=false must still fire default-ON keepalive");
      assert.equal(sent[0].conversationId, "conv-decoupled-ka");
    } finally {
      stDec.close();
    }
  } finally {
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.5.4-ka-4: Sidecar index.html VM test — renderKeepaliveControls (ZH/EN), toggle, maxCount clamping & multi-window reset target", async () => {
  const htmlSrc = fs.readFileSync(path.join(ROOT, "sidecars", "dashboard", "index.html"), "utf8");
  const scriptMatch = htmlSrc.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch && scriptMatch[1]);

  const elements = new Map();
  const apiCalls = [];
  let langPref = "zh";
  let watchdogState = {
    ok: true,
    enabled: true,
    desktopNotifyEnabled: false,
    ttlDesktopNotifyEnabled: false,
    ttlKeepalive: { enabled: true, supported: true, maxCount: 3, usedCount: 2, leadSec: 30, lastSentTs: 1000, lastError: "" },
    uiLang: "zh",
    uiLangSource: "sqlite",
    pendingJump: null,
    current: { conversationId: "conv-other-window", phase: "LLM_INFLIGHT", severity: "suspect", cwd: "e:\\other" },
    sessions: [],
    alertingSessions: []
  };

  const makeEl = (id) => ({
    id,
    textContent: "",
    innerText: "",
    innerHTML: "",
    title: "",
    value: "3",
    className: "",
    style: {},
    dataset: { enabled: "1", used: "0", max: "3" },
    options: [],
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() { return false; } },
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getAttribute() { return ""; },
    setAttribute() {}
  });
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, makeEl(id));
    return elements.get(id);
  };

  const handleFetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : {};
    apiCalls.push({ url, body });
    if (url === "/api/watchdog/action") {
      if (body.action === "setTtlKeepalive") {
        const nextEnabled = body.enabled !== undefined ? Boolean(body.enabled) : watchdogState.ttlKeepalive.enabled;
        const nextMax = body.maxCount !== undefined ? body.maxCount : watchdogState.ttlKeepalive.maxCount;
        watchdogState = {
          ...watchdogState,
          ttlKeepalive: { ...watchdogState.ttlKeepalive, enabled: nextEnabled, maxCount: nextMax }
        };
      } else if (body.action === "resetTtlKeepalive") {
        watchdogState = {
          ...watchdogState,
          ttlKeepalive: { ...watchdogState.ttlKeepalive, usedCount: 0 }
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, status: watchdogState }) };
    }
    if (url === "/api/watchdog") {
      return { ok: true, status: 200, json: async () => watchdogState };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const ctx = vm.createContext({
    window: {
      location: { search: "?conversationId=conv-active-tab", href: "http://127.0.0.1:4321/?conversationId=conv-active-tab" },
      addEventListener() {}
    },
    document: {
      hidden: false,
      activeElement: null,
      documentElement: { lang: "zh-CN" },
      getElementById: getEl,
      querySelector: () => ({ getAttribute: () => "csrf-tok" }),
      querySelectorAll: () => [],
      addEventListener() {}
    },
    localStorage: { getItem: () => langPref, setItem: (_k, v) => { langPref = v; } },
    navigator: { language: "zh-CN", clipboard: { writeText: async () => {} } },
    fetch: handleFetch,
    Headers,
    URLSearchParams,
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
    Date,
    Math,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
    Map,
    Promise,
    Error,
    RegExp,
    parseInt,
    parseFloat,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    console: { error() {}, log() {}, warn() {} }
  });

  vm.runInContext(scriptMatch[1], ctx);
  await flushMicrotasks();

  const btn = getEl("kv-keepalive-btn");
  const resetBtn = getEl("kv-keepalive-reset-btn");
  const maxInput = getEl("kv-keepalive-max");

  assert.equal(btn.innerText, "自动续温：2/3");
  assert.equal(resetBtn.className, "keepalive-reset-btn", "Reset button visible when usedCount > 0");

  // Error tooltip surfaces lastError cleanly
  ctx.renderKeepaliveControls({ enabled: true, maxCount: 3, usedCount: 1, lastError: "rpc_timeout" });
  assert.ok(btn.title.includes("rpc_timeout"));

  // Clamp maxCount input (99 -> 20)
  await ctx.changeTtlKeepaliveMax("99");
  assert.equal(maxInput.value, "20");
  assert.equal(btn.innerText, "自动续温：2/20");

  // Reset targets active tab conversationId ('conv-active-tab'), NOT another window's suspect session ('conv-other-window')!
  apiCalls.length = 0;
  await ctx.resetTtlKeepalive();
  const resetCall = apiCalls.find((c) => c.url === "/api/watchdog/action" && c.body.action === "resetTtlKeepalive");
  assert.ok(resetCall);
  assert.equal(resetCall.body.conversationId, "conv-active-tab");
  assert.equal(btn.innerText, "自动续温：0/20");
  assert.ok(resetBtn.className.includes("hidden"), "Reset button hides once usedCount returns to 0");

  // Toggle OFF in Chinese & switch to English
  await ctx.toggleTtlKeepalive();
  assert.equal(btn.innerText, "自动续温：关");
  ctx.setLanguage("en", true);
  assert.equal(btn.innerText, "Auto-Keepalive: OFF");
});

test("v1.5.4-ka-5: Empirical TTL floor (>= profileTtl) prevents premature ~90s keepalive & SYSTEM_MESSAGE keepalive with stale lastUserInput preserves 1/3 -> 2/3 -> 3/3", async () => {
  const { estimateCalibratedTtl, resolveModelProfile } = await import("../context/lib/cache-analyzer.js");
  const geminiProfile = resolveModelProfile("gemini-4-carbon-high");
  assert.equal(geminiProfile.id, "gemini-4-512k");
  assert.equal(geminiProfile.ttlSec, 300);

  // 1. Reproduce production `ttl_calibration:v1:gemini-4-512k` with sub-300s replica/drift misses (147s..281s)
  //    interleaved alongside 308s..393s misses and long warm hits up to 1741s -> MUST NEVER shrink below 300s!
  const nowMs = 1_795_358_400_000;
  const prodHistory = {
    v: 1,
    profileId: "gemini-4-512k",
    warm: [
      { gapSec: 438, atMs: nowMs - 6_760_000, conv: "c1" },
      { gapSec: 207, atMs: nowMs - 6_252_000, conv: "c2" },
      { gapSec: 1730, atMs: nowMs - 4_819_000, conv: "c3" },
      { gapSec: 607, atMs: nowMs - 2_179_000, conv: "c4" },
      { gapSec: 1597, atMs: nowMs - 553_000, conv: "c4" },
      { gapSec: 1741, atMs: nowMs - 328_000, conv: "c2" }
    ],
    cold: [
      { gapSec: 248, atMs: nowMs - 13_851_000, conv: "m1" },
      { gapSec: 191, atMs: nowMs - 13_502_000, conv: "m2" },
      { gapSec: 181, atMs: nowMs - 3_695_000, conv: "m3" },
      { gapSec: 323, atMs: nowMs - 3_500_000, conv: "m4" },
      { gapSec: 308, atMs: nowMs - 2_885_000, conv: "m5" },
      { gapSec: 260, atMs: nowMs - 1_086_000, conv: "m6" },
      { gapSec: 169, atMs: nowMs - 945_000, conv: "m7" },
      { gapSec: 147, atMs: nowMs - 92_000, conv: "m8" }
    ],
    seen1hWrite: false,
    updatedTs: nowMs - 18_000
  };
  const cal = estimateCalibratedTtl(geminiProfile, { historyRecord: prodHistory, nowMs });
  assert.ok(cal.ttlSec >= 300, `Empirical TTL must never drop below 300s profile floor, got ${cal.ttlSec}s`);
  assert.equal(cal.ttlSec, 300);

  // Pure sub-300s cold misses alone across multiple conversations also stay at 300s profile floor
  const subFloorOnly = estimateCalibratedTtl(geminiProfile, {
    historyRecord: {
      v: 1,
      profileId: "gemini-4-512k",
      warm: [],
      cold: [
        { gapSec: 147, atMs: nowMs - 50_000, conv: "x1" },
        { gapSec: 169, atMs: nowMs - 40_000, conv: "x2" },
        { gapSec: 185, atMs: nowMs - 30_000, conv: "x3" }
      ],
      updatedTs: nowMs
    },
    nowMs
  });
  assert.equal(subFloorOnly.ttlSec, 300);
  assert.equal(subFloorOnly.ttlSource, "profile");

  // Explicit user override (<300s) is still respected
  const explicitShort = estimateCalibratedTtl(geminiProfile, {
    explicitTtlSec: 180,
    historyRecord: prodHistory,
    nowMs
  });
  assert.equal(explicitShort.ttlSec, 180);
  assert.equal(explicitShort.ttlSource, "explicit");

  // 2. Watchdog clamps legacy stale lease `{ cacheTtlSec: 120, ttlSource: "empirical" }` to >=300s (no 90s trigger!)
  //    AND PreInvocation preserves 1/3 -> 2/3 -> 3/3 when `agentapi send-message` injects SYSTEM_MESSAGE with stale `lastUserInput`!
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ka-sysmsg-"));
  const dbPath = path.join(tmpDir, "context.db");
  const cfgPath = path.join(tmpDir, "config.json");
  const txPath = path.join(tmpDir, "transcript_full.jsonl");
  fs.writeFileSync(cfgPath, "{}", "utf8");

  const runHook = (relHook, payload) =>
    spawnSync(process.execPath, [path.join(ROOT, relHook)], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, AGY_DART_DB_PATH: dbPath, AGY_DART_CONFIG_PATH: cfgPath }
    });

  try {
    const store = new ContextModeStore({ dbPath });
    store.open();
    store.setUiLang("zh");
    store.setMeta("ttl_calibration:v1:gemini-4-512k", JSON.stringify(prodHistory));

    let simNow = nowMs;
    let simMono = 1_000_000_000n;
    const sent = [];
    const monitor = new WatchdogMonitor({
      getStore: () => store,
      nowFn: () => simNow,
      monoNsFn: () => simMono,
      keepaliveSendFn: async (p) => {
        sent.push(p);
        return { ok: true };
      }
    });

    // Seed stale empirical 120s lease like live `f7b3aa5c` before fix
    writeWatchdogLease(store, {
      conversationId: "conv-gemini-live",
      rootSessionId: "conv-gemini-live",
      phase: WATCHDOG_PHASES.IDLE,
      subphase: "stopped",
      stopReason: "NO_TOOL_CALL",
      model: "gemini-4-carbon-high",
      contextTokens: 420_000,
      cacheTtlSec: 120,
      ttlSource: "empirical",
      idleAnchorTs: simNow,
      phaseChangedTs: simNow,
      updatedTs: simNow,
      lastHeartbeatTs: simNow,
      lastUserInput: "/compact"
    });

    // At 110s idle (1m50s, when old bug fired!): MUST NOT fire keepalive because effective TTL is 300s (remSec=190s > 30s)
    simNow += 110_000;
    simMono += 110_000_000_000n;
    monitor.tick();
    await flushMicrotasks();
    assert.equal(sent.length, 0, "Must NOT trigger keepalive after 1m50s on 5m Gemini profile");

    // At 272s idle (4m32s, 28s left <= 30s lead): fires keepalive 1/3!
    simNow += 162_000;
    simMono += 162_000_000_000n;
    monitor.tick();
    await flushMicrotasks();
    assert.equal(sent.length, 1, "Must trigger keepalive 1/3 at 4m32s (28s before 5m TTL)");
    assert.ok(sent[0].message.includes("1/3"));
    assert.equal(store.getTtlKeepaliveState("conv-gemini-live").usedCount, 1);

    store.close();

    // First complete the `/compact` turn so `compact_invalidated:<conv>` is stamped, then record a post-compact file read
    const priorCompactSteps = [
      { step_index: 1, type: "USER_INPUT", created_at: "2026-11-22T14:40:00Z", content: "/compact" },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-22T14:40:07Z",
        model: "gemini-4-carbon-high",
        input_tokens: 2406,
        cache_read_tokens: 389955,
        output_tokens: 120,
        content: "已完成。"
      }
    ];
    fs.writeFileSync(txPath, priorCompactSteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
    runHook("hooks/pre-invocation.mjs", {
      conversationId: "conv-gemini-live",
      transcriptPath: txPath,
      invocationNum: 0,
      initialNumSteps: 1,
      lastUserInput: "/compact"
    });

    const sampleFile = path.join(tmpDir, "sample.txt");
    fs.writeFileSync(sampleFile, "hello", "utf8");
    const fstat = fs.statSync(sampleFile);
    let seqBefore = 0;
    {
      const stSeed = new ContextModeStore({ dbPath });
      stSeed.open();
      stSeed.recordFileRead({
        sessionId: "conv-gemini-live",
        filePath: sampleFile,
        mtimeMs: fstat.mtimeMs,
        fileSize: fstat.size,
        stepIdx: 2
      });
      stSeed.setTtlKeepaliveState("conv-gemini-live", {
        usedCount: 1,
        lastIdleAnchorTs: Date.now() - 275_000,
        lastSentTs: Date.now() - 2_000,
        pendingAck: true
      });
      seqBefore = stSeed.getConversationTurnSeq("conv-gemini-live");
      stSeed.close();
    }

    // Case A: Flushed SYSTEM_MESSAGE keepalive 1/3 in transcript WHILE `payload.lastUserInput` STILL carries prior user's `"/compact"` (with advanced initialNumSteps=3)!
    const stepsRound1 = [
      ...priorCompactSteps,
      {
        step_index: 3,
        type: "SYSTEM_MESSAGE",
        source: "SYSTEM",
        created_at: "2026-11-22T14:44:39Z",
        content:
          "The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-22T14:44:39Z sender=system priority=MESSAGE_PRIORITY_HIGH content=" +
          sent[0].message +
          "\n</SYSTEM_MESSAGE>"
      }
    ];
    fs.writeFileSync(txPath, stepsRound1.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");

    const rPre1 = runHook("hooks/pre-invocation.mjs", {
      conversationId: "conv-gemini-live",
      transcriptPath: txPath,
      invocationNum: 0,
      initialNumSteps: 3,
      lastUserInput: "/compact"
    });
    assert.equal(rPre1.status, 0);

    {
      const st = new ContextModeStore({ dbPath });
      st.open();
      try {
        assert.equal(st.getTtlKeepaliveState("conv-gemini-live").usedCount, 1, "Flushed SYSTEM_MESSAGE keepalive must keep usedCount=1 despite non-empty stale lastUserInput");
        assert.equal(st.getTtlKeepaliveState("conv-gemini-live").pendingAck, false);
        const remainingReads = st.db.prepare("SELECT COUNT(*) AS cnt FROM file_reads WHERE session_id = ?").get("conv-gemini-live")?.cnt || 0;
        assert.equal(remainingReads, 1, "Stale `/compact` in lastUserInput during keepalive turn must NOT wipe post-compact file_reads");
        assert.equal(st.getConversationTurnSeq("conv-gemini-live"), seqBefore, "Keepalive turn must not bump conv_turn_seq");

        // Now simulate round 2/3 UN-FLUSHED (transcript ends at PLANNER_RESPONSE "OK", pendingAck=true, lastUserInput still unchanged)
        st.setTtlKeepaliveState("conv-gemini-live", {
          usedCount: 2,
          lastIdleAnchorTs: Date.now() - 275_000,
          lastSentTs: Date.now() - 2_000,
          pendingAck: true
        });
      } finally {
        st.close();
      }
    }

    const stepsRound2Unflushed = [
      ...stepsRound1,
      {
        step_index: 4,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-22T14:44:40Z",
        model: "gemini-4-carbon-high",
        input_tokens: 2200,
        cache_read_tokens: 390312,
        output_tokens: 2,
        content: "OK"
      }
    ];
    fs.writeFileSync(txPath, stepsRound2Unflushed.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");

    const rPre2 = runHook("hooks/pre-invocation.mjs", {
      conversationId: "conv-gemini-live",
      transcriptPath: txPath,
      invocationNum: 0,
      initialNumSteps: 5,
      lastUserInput: "/compact"
    });
    assert.equal(rPre2.status, 0);

    {
      const st = new ContextModeStore({ dbPath });
      try {
        assert.equal(st.getTtlKeepaliveState("conv-gemini-live").usedCount, 2, "Un-flushed pendingAck keepalive with unchanged lastUserInput must keep usedCount=2");
        assert.equal(st.getTtlKeepaliveState("conv-gemini-live").pendingAck, false);
      } finally {
        st.close();
      }
    }

    // Finally, genuine new user message resets usedCount -> 0!
    const stepsUserReply = [
      ...stepsRound2Unflushed,
      {
        step_index: 5,
        type: "USER_INPUT",
        source: "USER_EXPLICIT",
        created_at: "2026-11-22T14:46:00Z",
        content: "<USER_REQUEST>\n继续推进下一批\n</USER_REQUEST>"
      }
    ];
    fs.writeFileSync(txPath, stepsUserReply.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");

    const rPreUser = runHook("hooks/pre-invocation.mjs", {
      conversationId: "conv-gemini-live",
      transcriptPath: txPath,
      invocationNum: 0,
      initialNumSteps: 6,
      lastUserInput: "继续推进下一批"
    });
    assert.equal(rPreUser.status, 0);

    {
      const st = new ContextModeStore({ dbPath });
      try {
        assert.equal(st.getTtlKeepaliveState("conv-gemini-live").usedCount, 0, "Genuine user prompt after SYSTEM_MESSAGE keepalive resets usedCount to 0");
      } finally {
        st.close();
      }
    }
  } finally {
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.5.4-ka-6: Sidecar index.html — hidden scope bar (conversation-only), Band 1 framed Current Context spotlight with distinct background & synthesized metrics", async () => {
  const htmlSrc = fs.readFileSync(path.join(ROOT, "sidecars", "dashboard", "index.html"), "utf8");

  // 1. Scope bar & telemetry scope banner are hidden; Band 1 is #kv-cache-card with #ctx-overview-box & #ctx-spotlight-box
  assert.match(htmlSrc, /<div id="scope-switcher-row"[^>]*class="[^"]*\bhidden\b[^"]*"[^>]*\bhidden\b/);
  assert.match(htmlSrc, /<div id="telemetry-banner"[^>]*class="[^"]*\bhidden\b[^"]*"[^>]*\bhidden\b/);
  assert.match(htmlSrc, /<div id="exempt-scope-explain"[^>]*class="[^"]*\bhidden\b[^"]*"[^>]*\bhidden\b/);

  const idxKvCard = htmlSrc.indexOf('id="kv-cache-card"');
  const idxWatchdogCard = htmlSrc.indexOf('id="watchdog-card"');
  const idxSavingsCard = htmlSrc.indexOf('id="savings-breakdown-card"');
  const idxSearchCard = htmlSrc.indexOf('id="search-inspector-card"');
  assert.ok(idxKvCard > 0 && idxWatchdogCard > 0 && idxSavingsCard > 0 && idxSearchCard > 0);
  assert.ok(idxKvCard < idxWatchdogCard, "#kv-cache-card (Current Context) must be placed in Band 1 above #watchdog-card");
  assert.ok(idxKvCard < idxSavingsCard, "#kv-cache-card (Current Context) must be placed in Band 1 above #savings-breakdown-card");
  assert.ok(htmlSrc.includes('id="ctx-overview-box"'));
  assert.ok(htmlSrc.includes('id="ctx-spotlight-box"'));
  assert.ok(htmlSrc.includes(".ctx-overview-box {") && htmlSrc.includes("linear-gradient("), "Context box must have distinct non-white background");

  // 2. VM execution verifying synthesized Band 1 rendering & watermark color state transitions in ZH/EN
  const scriptMatch = htmlSrc.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch && scriptMatch[1]);

  const elements = new Map();
  const makeEl = (id) => ({
    id,
    textContent: "",
    innerText: "",
    innerHTML: "",
    title: "",
    value: "46080",
    className: "",
    style: {},
    dataset: { enabled: "1", used: "0", max: "3" },
    options: [],
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() { return false; } },
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getAttribute() { return ""; },
    setAttribute() {}
  });
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, makeEl(id));
    return elements.get(id);
  };

  let nativeConvId = "conv-first";
  const apiScopes = [];
  const ctx = vm.createContext({
    window: {
      sidecar: {
        get conversationId() {
          return nativeConvId;
        },
        ui: { toggleConversation() {} }
      },
      location: { search: "", href: "http://127.0.0.1:4321/" },
      addEventListener() {}
    },
    document: {
      hidden: false,
      activeElement: null,
      documentElement: { lang: "zh-CN" },
      getElementById: getEl,
      querySelector: () => ({ getAttribute: () => "csrf-tok" }),
      querySelectorAll: () => [],
      addEventListener() {}
    },
    localStorage: { getItem: () => "zh", setItem() {} },
    navigator: { language: "zh-CN", clipboard: { writeText: async () => {} } },
    fetch: async (url, opts = {}) => {
      const body = opts.body ? JSON.parse(opts.body) : {};
      if (body.scope) apiScopes.push({ url, scope: body.scope, conversationId: body.conversationId });
      if (url === "/api/stats") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            totalRawBytes: 100_000,
            totalReturnedBytes: 20_000,
            keptOutBytes: 80_000,
            tokensKeptOut: 20_000,
            savingsPercent: 80,
            chunksCount: 12,
            sourcesCount: 2
          })
        };
      }
      if (url === "/api/cache-diag") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            transcriptFound: true,
            turnsWithUsage: 6,
            weightedHitRate: 0.94,
            currentContextTokens: 420_000,
            watermark: "critical",
            warnTokens: 332_800,
            criticalTokens: 409_600,
            modelProfile: { id: "gemini-4-512k", windowTokens: 512_000 },
            cacheTtlSec: 300,
            idleSeconds: 20,
            ttlRemainingSec: 280,
            ttlStatus: "warm",
            ttlSource: "profile",
            cacheTemperature: "hot",
            lastPlannerAt: new Date(Date.now() - 20_000).toISOString(),
            serverNowMs: Date.now()
          })
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
    Headers,
    URLSearchParams,
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
    Date,
    Math,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
    Map,
    Promise,
    Error,
    RegExp,
    parseInt,
    parseFloat,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    console: { error() {}, log() {}, warn() {} }
  });

  vm.runInContext(scriptMatch[1], ctx);
  await flushMicrotasks();

  // Only conversation scope is queried by default ("只统计本次对话")
  assert.ok(apiScopes.length >= 2);
  assert.ok(apiScopes.every((s) => s.scope === "conversation"));

  assert.equal(getEl("kv-ctx-tokens").innerText, "420k / 512k");
  assert.equal(getEl("kv-ctx-pct").textContent, "82.0%");
  assert.equal(getEl("kv-ctx-bar-fill").style.width, "82.0%");
  assert.equal(getEl("ctx-overview-box").className, "ctx-overview-box is-critical");
  assert.equal(getEl("kv-saved-summary").innerText, "~20,000 tok");
  assert.equal(getEl("kv-saved-sub").innerText, "已省 80.0%");
  assert.ok(getEl("kv-ctx-synth-note").textContent.includes("窗口已用 82.0%"));
  assert.ok(getEl("kv-ctx-synth-note").textContent.includes("20,000"));

  // Switch to warn & ok watermarks + English localization
  ctx.renderKvCacheCard({
    transcriptFound: true,
    turnsWithUsage: 3,
    weightedHitRate: 0.9,
    currentContextTokens: 350_000,
    watermark: "warn",
    warnTokens: 332_800,
    criticalTokens: 409_600,
    modelProfile: { id: "gemini-4-512k", windowTokens: 512_000 }
  });
  assert.equal(getEl("ctx-overview-box").className, "ctx-overview-box is-warn");

  ctx.setLanguage("en", false);
  assert.ok(getEl("kv-ctx-synth-note").textContent.includes("Window 68.4% used"));
  assert.equal(getEl("kv-saved-sub").innerText, "80.0% filtered");

  // Native host conversation switch clears any prior jump override so stats always track the active conversation
  await ctx.jumpToConversation("conv-jumped-temp", { fromPendingJump: true, jumpId: "j1" });
  assert.equal(ctx.getActiveConversationId(), "conv-jumped-temp");
  nativeConvId = "conv-second-native";
  assert.equal(ctx.getActiveConversationId(), "conv-second-native");
});

test("v1.5.4-ka-7: Review hardening — cold ring-buffer eviction guard, SYSTEM_MESSAGE keepalive cold-miss convergence, USER_INPUT+keepalive collision, empty-lease fallback & Band 1 dark-host/standalone parity", async () => {
  const { analyzeTranscriptCache, estimateCalibratedTtl, resolveModelProfile } = await import(
    "../context/lib/cache-analyzer.js"
  );
  const geminiProfile = resolveModelProfile("gemini-4-carbon-high");
  const t0 = Date.parse("2026-11-22T12:00:00Z");
  const iso = (ms) => new Date(ms).toISOString();

  // 1. Ring-buffer eviction guard: 25 sub-300s replica/drift misses MUST NOT evict a genuine 540s (9m) cold miss
  //    or corrupt minColdMissGapSec / origin!
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ka-review-"));
  const dbPath = path.join(tmpDir, "context.db");
  const cfgPath = path.join(tmpDir, "config.json");
  fs.writeFileSync(cfgPath, "{}", "utf8");

  try {
    const store = new ContextModeStore({ dbPath });
    store.open();

    // Seed an 840s warm hit + a 540s genuine cold miss (downward convergence -> 480s)
    store.recordModelTtlObservations(
      {
        "gemini-4-512k": {
          profileId: "gemini-4-512k",
          warm: [{ gapSec: 840, atMs: t0, conv: "c-warm" }],
          cold: [{ gapSec: 540, atMs: t0 + 100_000, conv: "c-real-cold" }]
        }
      },
      "c-real-cold",
      t0 + 100_000
    );

    // Flood 25 sub-300s replica/drift misses across 25 sessions via analyzeTranscriptCache + recordModelTtlObservations
    for (let i = 0; i < 25; i++) {
      const baseT = t0 + (200 + i * 200) * 1000;
      const gap = 130 + (i % 150); // 130s..279s (< 300s floor)
      const steps = [
        { type: "PLANNER_RESPONSE", step_index: 1, created_at: iso(baseT), model: "gemini-4-carbon-high", input_tokens: 60000, cache_read_tokens: 0 },
        { type: "PLANNER_RESPONSE", step_index: 2, created_at: iso(baseT + gap * 1000), model: "gemini-4-carbon-high", input_tokens: 62000, cache_read_tokens: 0 }
      ];
      const d = analyzeTranscriptCache(steps, { nowMs: baseT + (gap + 5) * 1000, conversationId: `c-noise-${i}` });
      store.recordModelTtlObservations(d.ttlObservations, `c-noise-${i}`, baseT + (gap + 5) * 1000);
    }

    const histAfterNoise = store.getModelTtlCalibration("gemini-4-512k", t0 + 6_000_000);
    assert.equal(histAfterNoise.cold.length, 1, "Sub-300s replica misses must NOT enter or evict >=300s cold ring buffer");
    assert.equal(histAfterNoise.cold[0].gapSec, 540);
    const calAfterNoise = estimateCalibratedTtl(geminiProfile, { historyRecord: histAfterNoise, nowMs: t0 + 6_000_000 });
    assert.equal(calAfterNoise.ttlSec, 480, "Downward convergence to 480s must survive 25 sub-300s replica misses");
    assert.equal(calAfterNoise.ttlCalibration.minColdMissGapSec, 540);
    assert.equal(calAfterNoise.ttlCalibration.coldSamples, 1);

    // Origin check when history has ONLY legacy sub-floor cold noise while current session has an 840s warm hit
    const sessOnlyOrigin = estimateCalibratedTtl(geminiProfile, {
      sessionWarmSamples: [{ gapSec: 840, atMs: t0 + 7_000_000, conv: "c-sess" }],
      historyRecord: {
        v: 1,
        profileId: "gemini-4-512k",
        warm: [],
        cold: [{ gapSec: 147, atMs: t0 + 6_500_000, conv: "c-old-noise" }],
        updatedTs: t0 + 6_500_000
      },
      nowMs: t0 + 7_000_000
    });
    assert.equal(sessOnlyOrigin.ttlSec, 840);
    assert.equal(sessOnlyOrigin.ttlCalibration.origin, "session", "Filtered-out sub-floor history noise must not misattribute session warm hit as history");
    assert.equal(sessOnlyOrigin.ttlCalibration.minColdMissGapSec, null);

    // 2. SYSTEM_MESSAGE keepalive experiencing a genuine >=300s cold miss (e.g. 540s after server shrank 14m TTL)
    //    must NOT be blocked by `systemMsgSincePrev` -> records cold miss & converges 840s -> 480s!
    const kaColdSteps = [
      { type: "PLANNER_RESPONSE", step_index: 1, created_at: iso(t0), model: "gemini-4-carbon-high", input_tokens: 70000, cache_read_tokens: 0 },
      { type: "PLANNER_RESPONSE", step_index: 2, created_at: iso(t0 + 840_000), model: "gemini-4-carbon-high", input_tokens: 2000, cache_read_tokens: 69000 },
      {
        type: "SYSTEM_MESSAGE",
        step_index: 3,
        created_at: iso(t0 + 1_380_000),
        content: "<SYSTEM_MESSAGE>\n[Message] content=[agy-dart TTL保活 1/3] 仅回复 OK 以保持上下文缓存热度，请勿调用任何工具或修改任何内容。\n</SYSTEM_MESSAGE>"
      },
      { type: "PLANNER_RESPONSE", step_index: 4, created_at: iso(t0 + 1_380_000), model: "gemini-4-carbon-high", input_tokens: 72000, cache_read_tokens: 0 }
    ];
    const diagKaCold = analyzeTranscriptCache(kaColdSteps, { nowMs: t0 + 1_390_000, conversationId: "c-ka-cold" });
    assert.equal(diagKaCold.cacheTtlSec, 480, "Genuine 540s cold miss on SYSTEM_MESSAGE keepalive must converge 840s -> 480s");
    assert.equal(diagKaCold.bustsByCause.system_injection, 0, "Tail keepalive SYSTEM_MESSAGE must not misattribute bust to system_injection");

    // 3. sanitizeModelTtlState() scrubs legacy polluted SQLite records & empirical <300s leases in-place
    store.setMeta(
      "ttl_calibration:v1:gemini-4-512k",
      JSON.stringify({
        v: 1,
        profileId: "gemini-4-512k",
        warm: [{ gapSec: 600, atMs: t0, conv: "c1" }],
        cold: [
          { gapSec: 147, atMs: t0, conv: "c2" },
          { gapSec: 360, atMs: t0, conv: "c3" }
        ],
        seen1hWrite: false,
        updatedTs: t0
      })
    );
    writeWatchdogLease(store, {
      conversationId: "conv-legacy-120",
      rootSessionId: "conv-legacy-120",
      phase: WATCHDOG_PHASES.IDLE,
      subphase: "stopped",
      model: "gemini-4-carbon-high",
      cacheTtlSec: 120,
      ttlSource: "empirical",
      updatedTs: t0
    });
    const sanRes = store.sanitizeModelTtlState();
    assert.equal(sanRes.scrubbedCalibrations, 1);
    assert.equal(sanRes.clampedLeases, 1);
    assert.deepEqual(JSON.parse(store.getMeta("ttl_calibration:v1:gemini-4-512k")).cold.map((c) => c.gapSec), [360]);
    assert.equal(readWatchdogLease(store, "conv-legacy-120").cacheTtlSec, 300);

    // 4. PreInvocation edge cases:
    //    (4a) Empty existingLease.lastUserInput (Stop-created lease) + un-flushed keepalive turn preserves usedCount=1 via prior <USER_REQUEST>
    //    (4b) Real USER_INPUT + SYSTEM_MESSAGE keepalive in same trailing batch resets usedCount -> 0 and bumps turnSeq!
    const txPath = path.join(tmpDir, "transcript_edge.jsonl");
    const runHook = (payload) =>
      spawnSync(process.execPath, [path.join(ROOT, "hooks", "pre-invocation.mjs")], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, AGY_DART_DB_PATH: dbPath, AGY_DART_CONFIG_PATH: cfgPath }
      });

    writeWatchdogLease(store, {
      conversationId: "conv-stop-only",
      rootSessionId: "conv-stop-only",
      phase: WATCHDOG_PHASES.IDLE,
      subphase: "stopped",
      lastUserInput: "",
      updatedTs: Date.now()
    });
    store.setTtlKeepaliveState("conv-stop-only", {
      usedCount: 1,
      lastSentTs: Date.now() - 2_000,
      pendingAck: true
    });
    const seq0 = store.getConversationTurnSeq("conv-stop-only");
    store.close();

    const stopOnlySteps = [
      { step_index: 1, type: "USER_INPUT", created_at: iso(t0), content: "<USER_REQUEST>\n分析这段日志\n</USER_REQUEST>\n<ADDITIONAL_METADATA>meta</ADDITIONAL_METADATA>" },
      { step_index: 2, type: "PLANNER_RESPONSE", created_at: iso(t0 + 5_000), model: "gemini-4-carbon-high", input_tokens: 8000, cache_read_tokens: 0, content: "好的" }
    ];
    fs.writeFileSync(txPath, stopOnlySteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");

    // (4a) Un-flushed keepalive with empty lease.lastUserInput + stale payload.lastUserInput matching step 1
    assert.equal(
      runHook({ conversationId: "conv-stop-only", transcriptPath: txPath, invocationNum: 0, lastUserInput: "分析这段日志" }).status,
      0
    );
    {
      const st = new ContextModeStore({ dbPath });
      try {
        assert.equal(st.getTtlKeepaliveState("conv-stop-only").usedCount, 1, "Must preserve usedCount=1 via prior <USER_REQUEST> match");
        assert.equal(st.getConversationTurnSeq("conv-stop-only"), seq0);
        st.setTtlKeepaliveState("conv-stop-only", { usedCount: 2, lastSentTs: Date.now() - 1_000, pendingAck: true });
      } finally {
        st.close();
      }
    }

    // (4b) Trailing USER_INPUT followed by SYSTEM_MESSAGE keepalive -> real user turn MUST win and reset usedCount -> 0!
    const collidedSteps = [
      ...stopOnlySteps,
      { step_index: 3, type: "USER_INPUT", created_at: iso(t0 + 275_000), content: "<USER_REQUEST>\n继续下一步\n</USER_REQUEST>" },
      {
        step_index: 4,
        type: "SYSTEM_MESSAGE",
        created_at: iso(t0 + 275_100),
        content: "<SYSTEM_MESSAGE>\n[Message] content=[agy-dart TTL保活 2/3] 仅回复 OK 以保持上下文缓存热度，请勿调用任何工具或修改任何内容。\n</SYSTEM_MESSAGE>"
      }
    ];
    fs.writeFileSync(txPath, collidedSteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
    assert.equal(
      runHook({ conversationId: "conv-stop-only", transcriptPath: txPath, invocationNum: 0, lastUserInput: "继续下一步" }).status,
      0
    );
    {
      const st = new ContextModeStore({ dbPath });
      try {
        assert.equal(st.getTtlKeepaliveState("conv-stop-only").usedCount, 0, "Real USER_INPUT alongside SYSTEM_MESSAGE keepalive must reset usedCount -> 0");
        assert.equal(st.getConversationTurnSeq("conv-stop-only"), seq0 + 1, "Real USER_INPUT alongside SYSTEM_MESSAGE keepalive must bump turnSeq");
        assert.equal(readWatchdogLease(st, "conv-stop-only").lastUserInput, "继续下一步");
      } finally {
        st.close();
      }
    }

    // 5. Band 1 strict position above #star-milestone-banner & Dark-Host CSS color inheritance guard
    const htmlSrc = fs.readFileSync(path.join(ROOT, "sidecars", "dashboard", "index.html"), "utf8");
    assert.ok(
      htmlSrc.indexOf('id="kv-cache-card"') < htmlSrc.indexOf('id="star-milestone-banner"'),
      "#kv-cache-card must appear strictly above #star-milestone-banner as Band 1"
    );
    assert.match(htmlSrc, /\.shell\s*\{[^}]*color:\s*var\(--text-primary\)/, ".shell must explicitly guard text color against dark-host body inline styles");
  } finally {
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
