import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  formatEffectiveConfigLines,
  getConfigSnapshot,
  getEffectiveConfig,
  resetConfigCache
} from "../context/lib/config.js";
import { ContextModeStore } from "../context/lib/store.js";
import { createTools } from "../context/lib/tools.js";
import {
  isAllowedHostHeader,
  isAllowedOriginHeader,
  isJsonContentType,
  timingSafeTokenMatch
} from "../sidecars/dashboard/server.mjs";
import {
  auditPrefixBudget,
  calibrateFromTranscript,
  calibrateTokenEstimator
} from "../scripts/prefix-budget.mjs";
import { extractLocalSpecifiers, verifyPackageManifest } from "../scripts/verify-package-graph.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function runHookRaw(scriptRel, payload, dbPath, extraEnv = {}) {
  const hook = path.join(ROOT, scriptRel);
  return spawnSync(process.execPath, [hook], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      AGY_DART_DB_PATH: dbPath,
      ...extraEnv
    }
  });
}

function makeNumberedLines(count) {
  return Array.from({ length: count }, (_, i) => `export const item_${i + 1} = "payload_${String(i + 1).padStart(4, "0")}_xxxxxxxxxxxxxxxxxxxx";`);
}

function writeAndBumpMtime(filePath, content, bumpSec = 5) {
  fs.writeFileSync(filePath, content, "utf8");
  const t = Math.floor(Date.now() / 1000) + bumpSec;
  fs.utimesSync(filePath, t, t);
}

test("P0-Hardening 1: Sidecar CSRF, DNS-rebinding Host/Origin guards, POST-only mutations, 64KB body cap & XSS escaping", async () => {
  // Unit checks for security helpers
  assert.equal(isAllowedHostHeader("127.0.0.1:8765"), true);
  assert.equal(isAllowedHostHeader("localhost:8765"), true);
  assert.equal(isAllowedHostHeader("[::1]:8765"), true);
  assert.equal(isAllowedHostHeader("evil.rebinding.test:8765"), false);
  assert.equal(isAllowedHostHeader("127.0.0.1.evil.com"), false);
  assert.equal(isAllowedHostHeader(""), false);

  assert.equal(isAllowedOriginHeader(undefined), true);
  assert.equal(isAllowedOriginHeader("http://127.0.0.1:8765"), true);
  assert.equal(isAllowedOriginHeader("http://localhost:8765"), true);
  assert.equal(isAllowedOriginHeader("http://127.0.0.1:8765", "127.0.0.1:8765"), true);
  assert.equal(isAllowedOriginHeader("http://localhost:3000", "127.0.0.1:8765"), false);
  assert.equal(isAllowedOriginHeader("https://evil.example"), false);
  assert.equal(isAllowedOriginHeader("null"), false);

  assert.equal(isJsonContentType("application/json"), true);
  assert.equal(isJsonContentType("application/json; charset=utf-8"), true);
  assert.equal(isJsonContentType("text/plain"), false);
  assert.equal(isJsonContentType("application/x-www-form-urlencoded"), false);

  assert.equal(timingSafeTokenMatch("abc123", "abc123"), true);
  assert.equal(timingSafeTokenMatch("abc123", "abc124"), false);
  assert.equal(timingSafeTokenMatch("short", "longer"), false);
  assert.equal(timingSafeTokenMatch("", ""), false);

  // Static audit: SidecarApp mode MUST NOT register GET on any mutating route
  const serverSrc = fs.readFileSync(path.join(ROOT, "sidecars", "dashboard", "server.mjs"), "utf8");
  for (const route of ["/api/cutoff", "/api/exemptions", "/api/toggle-active", "/api/paused", "/api/purge", "/api/maintenance", "/api/cli-filter", "/api/read-dedup"]) {
    const badRe = new RegExp(`app\\.api\\(["']${route.replace("/", "\\/")}["'][\\s\\S]{0,120},\\s*["']GET["']\\)`);
    assert.equal(badRe.test(serverSrc), false, `SidecarApp must NOT register GET for mutating route ${route}`);
  }

  // Static audit: index.html escapes custom extensions and sends POST + CSRF token
  const htmlSrc = fs.readFileSync(path.join(ROOT, "sidecars", "dashboard", "index.html"), "utf8");
  assert.ok(htmlSrc.includes('meta[name="agy-dart-token"]'), "index.html must read CSRF meta token");
  assert.ok(htmlSrc.includes("X-Agy-Dart-Token"), "index.html must attach X-Agy-Dart-Token header");
  assert.ok(!htmlSrc.includes("removeExemption('${ext}')"), "index.html must not interpolate raw ext into onclick");
  assert.ok(htmlSrc.includes("data-ext=\"${safeExt}\""), "index.html must use escaped data-ext attribute");
  assert.ok(htmlSrc.includes("${escapeHtml(scopeLabel)}"), "index.html must escape scopeLabel in telemetry-source");

  // Live standalone server attack simulation
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-sidecar-sec-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const port = 29400 + Math.floor(Math.random() * 500);

  const seed = new ContextModeStore({ dbPath: tmpDb });
  seed.indexContent({ sessionId: "sec-s1", worktree: tmpDir, kind: "file", label: "precious.txt", content: "do not wipe via CSRF" });
  seed.close();

  const child = spawn(process.execPath, [path.join(ROOT, "sidecars", "dashboard", "server.mjs")], {
    cwd: ROOT,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(port),
      AGY_DART_DB_PATH: tmpDb,
      SIDECAR_FORCE_HTTP: "1",
      AGY_DART_DISABLE_COMPILE_CACHE: "1"
    }
  });

  const rawReq = (urlPath, { method = "GET", headers = {}, body = null } = {}) =>
    new Promise((resolve, reject) => {
      const reqHeaders = { Host: `127.0.0.1:${port}`, ...headers };
      if (body !== null && reqHeaders["Content-Length"] === undefined) {
        reqHeaders["Content-Length"] = Buffer.byteLength(body, "utf8");
      }
      const req = http.request({ hostname: "127.0.0.1", port, path: urlPath, method, headers: reqHeaders }, (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
      });
      req.on("error", reject);
      if (body !== null) req.write(body);
      req.end();
    });

  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Sidecar startup timeout")), 5000);
      child.stdout.on("data", (d) => {
        if (d.toString("utf8").includes("listening at")) {
          clearTimeout(t);
          resolve();
        }
      });
      child.on("exit", (c) => {
        clearTimeout(t);
        reject(new Error(`Sidecar exited early: ${c}`));
      });
    });

    const page = await rawReq("/");
    assert.equal(page.status, 200);
    const token = page.body.match(/<meta name="agy-dart-token" content="([a-f0-9]+)">/i)?.[1];
    assert.ok(token && token.length >= 32, "Must inject high-entropy CSRF token");

    // 1. Cross-site <img> GET attacks on all mutating endpoints -> 405 Method Not Allowed
    for (const ep of [
      "/api/purge?scope=all",
      "/api/toggle-active?paused=true",
      "/api/paused?paused=true",
      "/api/cutoff?cutoff=0",
      "/api/exemptions?action=reset",
      "/api/maintenance?action=vacuum",
      "/api/cli-filter?enabled=false",
      "/api/read-dedup?enabled=false"
    ]) {
      const r = await rawReq(ep, { method: "GET" });
      assert.equal(r.status, 405, `GET ${ep} must return 405, got ${r.status}`);
      assert.equal(r.headers.allow, "POST");
    }

    // 2. DNS rebinding Host header -> 403
    const rebind = await rawReq("/api/stats", { headers: { Host: `evil.attacker.test:${port}` } });
    assert.equal(rebind.status, 403);

    // 3. Cross-origin / null Origin / cross-port Origin / Sec-Fetch-Site: cross-site -> 403
    assert.equal((await rawReq("/api/stats", { headers: { Origin: "https://evil.example" } })).status, 403);
    assert.equal((await rawReq("/api/stats", { headers: { Origin: "http://localhost:3000" } })).status, 403);
    assert.equal((await rawReq("/api/stats", { headers: { Origin: "null" } })).status, 403);
    assert.equal((await rawReq("/api/stats", { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);

    // 4. POST /api/search and mutating endpoints without token or wrong token -> 403
    const searchNoTok = await rawReq("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "precious" })
    });
    assert.equal(searchNoTok.status, 403, "POST /api/search must require X-Agy-Dart-Token");

    const searchWithTok = await rawReq("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agy-Dart-Token": token },
      body: JSON.stringify({ query: "precious" })
    });
    assert.equal(searchWithTok.status, 200);

    const noTok = await rawReq("/api/purge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "all" })
    });
    assert.equal(noTok.status, 403);

    const badTok = await rawReq("/api/purge", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agy-Dart-Token": "0".repeat(token.length) },
      body: JSON.stringify({ scope: "all" })
    });
    assert.equal(badTok.status, 403);

    // 5. Simple CORS text/plain POST even with valid token -> 415 Unsupported Media Type
    const wrongCt = await rawReq("/api/purge", {
      method: "POST",
      headers: { "Content-Type": "text/plain", "X-Agy-Dart-Token": token },
      body: JSON.stringify({ scope: "all" })
    });
    assert.equal(wrongCt.status, 415);

    // 6. Oversized > 64 KB body -> 413 Payload Too Large
    const hugeBody = JSON.stringify({ query: "x".repeat(80 * 1024) });
    const tooBig = await rawReq("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agy-Dart-Token": token },
      body: hugeBody
    });
    assert.equal(tooBig.status, 413);

    // Verify none of the blocked attacks wiped our DB!
    const statsBefore = JSON.parse((await rawReq("/api/stats?scope=lifetime")).body);
    assert.equal(statsBefore.sourcesCount, 1, "Blocked CSRF attacks must NOT mutate database");

    // 7. Legitimate authenticated JSON POST succeeds & XSS custom extension payload is rejected by store sanitizer
    const validToggle = await rawReq("/api/toggle-active", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agy-Dart-Token": token },
      body: JSON.stringify({ scope: "lifetime", paused: true })
    });
    assert.equal(validToggle.status, 200);
    assert.equal(JSON.parse(validToggle.body).isPaused, true);

    const xssExtRes = await rawReq("/api/exemptions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agy-Dart-Token": token },
      body: JSON.stringify({ action: "add", ext: ".foo'\"><img src=x onerror=alert(1)>" })
    });
    assert.equal(xssExtRes.status, 200);
    assert.deepEqual(JSON.parse(xssExtRes.body).customExtensions, [], "XSS payload must not be stored as custom extension");

    const goodExtRes = await rawReq("/api/exemptions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agy-Dart-Token": token },
      body: JSON.stringify({ action: "add", ext: ".mdx" })
    });
    assert.equal(goodExtRes.status, 200);
    assert.ok(JSON.parse(goodExtRes.body).customExtensions.includes(".mdx"));
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 150));
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  // Live SidecarApp mode smoke test when host Antigravity sidecar_sdk is present
  const userSdkPath = path.join(os.homedir(), ".gemini", "config", "node_modules", "sidecar_sdk", "index.mjs");
  if (fs.existsSync(userSdkPath)) {
    const sdkTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-sidecar-sdk-"));
    const sdkDb = path.join(sdkTmpDir, "context.db");
    const sdkPort = 29500 + Math.floor(Math.random() * 400);
    const uiToken = "sidecar-test-ui-token-778899";
    const sdkChild = spawn(process.execPath, [path.join(ROOT, "sidecars", "dashboard", "server.mjs")], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        AGY_DART_DB_PATH: sdkDb,
        ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:1",
        ANTIGRAVITY_CSRF_TOKEN: "dummy-csrf",
        ANTIGRAVITY_SIDECAR_WEB_PORT: String(sdkPort),
        ANTIGRAVITY_SIDECAR_UI_TOKEN: uiToken,
        ANTIGRAVITY_CONVERSATION_ID: "sdk-conv-1",
        AGY_DART_DISABLE_COMPILE_CACHE: "1"
      }
    });
    let sdkStderr = "";
    sdkChild.stderr.on("data", (d) => (sdkStderr += d.toString("utf8")));
    const sdkReq = (urlPath, { method = "GET", headers = {}, body = null } = {}) =>
      new Promise((resolve, reject) => {
        const reqHeaders = { Host: `127.0.0.1:${sdkPort}`, ...headers };
        if (body !== null) reqHeaders["Content-Length"] = Buffer.byteLength(body, "utf8");
        const req = http.request({ hostname: "127.0.0.1", port: sdkPort, path: urlPath, method, headers: reqHeaders }, (res) => {
          let out = "";
          res.on("data", (c) => (out += c));
          res.on("end", () => resolve({ status: res.statusCode, body: out }));
        });
        req.on("error", reject);
        if (body !== null) req.write(body);
        req.end();
      });
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("SidecarApp startup timeout")), 5000);
        sdkChild.stdout.on("data", (d) => {
          const s = d.toString("utf8");
          if (s.includes("listening on") || s.includes("registered and running")) {
            clearTimeout(t);
            resolve();
          }
        });
        sdkChild.on("exit", (c) => {
          clearTimeout(t);
          reject(new Error(`SidecarApp exited early: ${c} ${sdkStderr}`));
        });
      });
      assert.equal((await sdkReq("/api/purge?scope=all", { method: "GET" })).status, 405);
      assert.equal(
        (await sdkReq("/api/toggle-active", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paused: true }) })).status,
        401,
        "SidecarApp mode must reject POST without X-Sidecar-Token"
      );
      const okPost = await sdkReq("/api/toggle-active", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Sidecar-Token": uiToken },
        body: JSON.stringify({ paused: true })
      });
      assert.equal(okPost.status, 200);
      assert.equal(JSON.parse(okPost.body).isPaused, true);
      assert.equal(Buffer.byteLength(sdkStderr, "utf8"), 0, `SidecarApp emitted stderr: ${sdkStderr}`);
    } finally {
      sdkChild.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 150));
      fs.rmSync(sdkTmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
});

test("P0-Hardening 2: Diff-read is OFF by default, enforces direct conversation ownership (no subagent leak) & turn/age freshness bounds", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-diff-safe-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const cfgPath = path.join(tmpDir, "config.json");
  const modFile = path.join(tmpDir, "target.js");
  const otherFile = path.join(tmpDir, "other.js");
  const v1 = makeNumberedLines(100);
  const v2 = [...v1];
  v2[20] = 'export const item_21 = "MODIFIED_V2";';

  try {
    writeAndBumpMtime(modFile, v1.join("\n") + "\n", 0);
    writeAndBumpMtime(otherFile, makeNumberedLines(40).join("\n") + "\n", 0);

    // 1. DEFAULT (no AGY_DART_ENABLE_DIFF_READ, no config.json): diff-read MUST be OFF!
    const cleanEnv = {
      AGY_DART_CONFIG_PATH: cfgPath,
      AGY_DART_DISABLE_COMPILE_CACHE: "1",
      AGY_DART_ENABLE_DIFF_READ: "",
      AGY_DART_DISABLE_DIFF_READ: ""
    };
    const r1 = JSON.parse(
      runHookRaw("hooks/pre-tool-use.mjs", { conversationId: "def-conv", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: modFile } } }, tmpDb, cleanEnv).stdout
    );
    assert.equal(r1.decision, "allow");

    // Unchanged State-2 read-dedup is STILL active by default
    const rUnchanged = JSON.parse(
      runHookRaw("hooks/pre-tool-use.mjs", { conversationId: "def-conv", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: modFile } } }, tmpDb, cleanEnv).stdout
    );
    assert.equal(rUnchanged.decision, "deny");
    assert.ok(rUnchanged.reason.includes("[agy-dart read-dedup]"));

    // Modify file -> because diffRead defaults OFF, hook MUST return full-file allow!
    writeAndBumpMtime(modFile, v2.join("\n") + "\n", 10);
    const rModDefault = JSON.parse(
      runHookRaw("hooks/pre-tool-use.mjs", { conversationId: "def-conv", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: modFile } } }, tmpDb, cleanEnv).stdout
    );
    assert.equal(rModDefault.decision, "allow", "Diff-read must be OFF by default and allow full file on modification");

    // 2. Opt-in via config.json (`diffRead: true`): enables diff-read with baseline header & bilingual hint
    fs.writeFileSync(cfgPath, JSON.stringify({ diffRead: true, diffReadMaxTurns: 3 }), "utf8");
    const v3 = [...v2];
    v3[30] = 'export const item_31 = "MODIFIED_V3";';
    // Capture baseline in parent conversation
    const p1 = JSON.parse(
      runHookRaw("hooks/pre-tool-use.mjs", { conversationId: "parent-conv", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: modFile } } }, tmpDb, cleanEnv).stdout
    );
    assert.equal(p1.decision, "allow");

    writeAndBumpMtime(modFile, v3.join("\n") + "\n", 20);

    // 3. Subagent sharing parentConversationId MUST NOT receive parent's diff!
    const subRead = JSON.parse(
      runHookRaw(
        "hooks/pre-tool-use.mjs",
        {
          parentConversationId: "parent-conv",
          conversationId: "child-worker-1",
          cwd: tmpDir,
          toolCall: { name: "read_file", args: { Path: modFile } }
        },
        tmpDb,
        cleanEnv
      ).stdout
    );
    assert.equal(subRead.decision, "allow", "Subagent with distinct conversationId must NOT receive parent's diff");

    // Subagent without distinct conversationId (marked subagent: true) also MUST NOT receive parent's diff!
    const subSameId = JSON.parse(
      runHookRaw(
        "hooks/pre-tool-use.mjs",
        {
          conversationId: "parent-conv",
          subagent: true,
          cwd: tmpDir,
          toolCall: { name: "read_file", args: { Path: modFile } }
        },
        tmpDb,
        cleanEnv
      ).stdout
    );
    assert.equal(subSameId.decision, "allow", "Subagent sharing parent conversationId must NOT receive diff");

    // Parent itself (same conversation, within 3 turns) DOES receive diff with baseline hash & bilingual hint!
    const pDiff = JSON.parse(
      runHookRaw("hooks/pre-tool-use.mjs", { conversationId: "parent-conv", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: modFile } } }, tmpDb, cleanEnv).stdout
    );
    assert.equal(pDiff.decision, "deny");
    assert.ok(pDiff.reason.includes("[agy-dart diff-read]"));
    assert.ok(pDiff.reason.includes("changed since baseline "));
    assert.ok(pDiff.reason.includes("如需全文请重读"));

    // 4. Turn-gap staleness: exceed diffReadMaxTurns (3) -> must fall back safely to full-file allow!
    for (let i = 0; i < 4; i++) {
      writeAndBumpMtime(otherFile, makeNumberedLines(40 + i).join("\n") + "\n", 25 + i);
      runHookRaw("hooks/pre-tool-use.mjs", { conversationId: "parent-conv", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: otherFile } } }, tmpDb, cleanEnv);
    }
    const v4 = [...v3];
    v4[50] = 'export const item_51 = "MODIFIED_AFTER_STALE_TURNS";';
    writeAndBumpMtime(modFile, v4.join("\n") + "\n", 40);
    const pStaleTurns = JSON.parse(
      runHookRaw("hooks/pre-tool-use.mjs", { conversationId: "parent-conv", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: modFile } } }, tmpDb, cleanEnv).stdout
    );
    assert.equal(pStaleTurns.decision, "allow", "Snapshot older than diffReadMaxTurns must fall back to full file allow");

    // 5. Age staleness: backdate full_read_ts beyond diffReadMaxAgeMs -> must fall back to full-file allow!
    const store = new ContextModeStore({ dbPath: tmpDb });
    store.open();
    store.db
      .prepare("UPDATE file_snapshots SET full_read_ts = ?, updated_ts = ? WHERE session_id = ?")
      .run(Date.now() - 30 * 60 * 1000, Date.now() - 30 * 60 * 1000, "parent-conv");
    store.close();

    const v5 = [...v4];
    v5[60] = 'export const item_61 = "MODIFIED_AFTER_STALE_AGE";';
    writeAndBumpMtime(modFile, v5.join("\n") + "\n", 50);
    const pStaleAge = JSON.parse(
      runHookRaw("hooks/pre-tool-use.mjs", { conversationId: "parent-conv", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: modFile } } }, tmpDb, cleanEnv).stdout
    );
    assert.equal(pStaleAge.decision, "allow", "Snapshot older than diffReadMaxAgeMs must fall back to full file allow");

    // 6. Non-read LLM turns via PreInvocation also advance conv_turn_seq and expire diff baselines
    for (let i = 0; i < 4; i++) {
      const pi = runHookRaw("hooks/pre-invocation.mjs", { conversationId: "parent-conv", cwd: tmpDir }, tmpDb, cleanEnv);
      assert.equal(pi.status, 0);
    }
    const v6 = [...v5];
    v6[70] = 'export const item_71 = "MODIFIED_AFTER_PREINV_TURNS";';
    writeAndBumpMtime(modFile, v6.join("\n") + "\n", 60);
    const pStalePreInv = JSON.parse(
      runHookRaw("hooks/pre-tool-use.mjs", { conversationId: "parent-conv", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: modFile } } }, tmpDb, cleanEnv).stdout
    );
    assert.equal(pStalePreInv.decision, "allow", "PreInvocation turns must advance conv_turn_seq and expire stale diff baselines");

    // 7. Concurrent multi-process conv_turn_seq atomicity (10 parallel pre-tool-use hooks, zero lost updates)
    const parallelProcs = [];
    for (let i = 0; i < 10; i++) {
      const pf = path.join(tmpDir, `par_${i}.js`);
      writeAndBumpMtime(pf, makeNumberedLines(45).join("\n") + "\n", 0);
      parallelProcs.push(
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [path.join(ROOT, "hooks", "pre-tool-use.mjs")], {
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            env: { ...process.env, AGY_DART_DB_PATH: tmpDb, ...cleanEnv }
          });
          let stderr = "";
          child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, stderr }));
          child.stdin.end(
            JSON.stringify({ conversationId: "par-conv", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: pf } } })
          );
        })
      );
    }
    const parResults = await Promise.all(parallelProcs);
    assert.ok(parResults.every((r) => r.code === 0 && r.stderr === ""));
    const verifyStore = new ContextModeStore({ dbPath: tmpDb });
    assert.equal(verifyStore.getConversationTurnSeq("par-conv"), 10, "10 concurrent hooks must increment conv_turn_seq atomically with 0 lost updates");

    // 8. ctx_resume invalidates both shared root sessionId AND direct conversationId snapshots
    const resumeTools = createTools({
      store: verifyStore,
      getCwd: () => tmpDir,
      getSessionId: () => "root-sess-x",
      getDirectConversationId: () => "par-conv"
    });
    assert.ok(verifyStore.findFileSnapshot({ sessionId: "par-conv", filePath: path.join(tmpDir, "par_0.js") }));
    await resumeTools.ctx_resume();
    assert.equal(
      verifyStore.findFileSnapshot({ sessionId: "par-conv", filePath: path.join(tmpDir, "par_0.js") }),
      null,
      "ctx_resume must clear directConvId snapshots too"
    );
    verifyStore.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("P1-Hardening 3: Static import-graph verification proves RUNTIME_FILES completeness and zero devtools leakage", () => {
  const report = verifyPackageManifest(ROOT);
  assert.equal(report.ok, true, `Package manifest verification failed: ${JSON.stringify(report, null, 2)}`);
  assert.deepEqual(report.missingOnDisk, []);
  assert.deepEqual(report.overlap, []);
  assert.deepEqual(report.missingFromRuntimeManifest, []);
  assert.deepEqual(report.devtoolsLeakedIntoRuntime, []);
  assert.deepEqual(report.missingFromFullManifest, []);
  assert.ok(report.runtimeEntrypoints.length >= 8);
  assert.ok(report.runtimeReachableCount >= 25);

  // Regression: `export const ...;` must NOT swallow a following side-effect `import "./side-effect.js";`
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-vpg-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "side-effect.js"), "", "utf8");
    fs.writeFileSync(path.join(tmpDir, "alpha.js"), "", "utf8");
    fs.writeFileSync(path.join(tmpDir, "asset.json"), "{}", "utf8");
    const entry = path.join(tmpDir, "entry.js");
    const src = `export const X = 1;\nimport "./side-effect.js";\nimport { a } from "./alpha.js";\nconst u = new URL("./asset.json", import.meta.url);\n`;
    const deps = extractLocalSpecifiers(src, entry, tmpDir);
    assert.deepEqual(deps, ["alpha.js", "asset.json", "side-effect.js"]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("P1-Hardening 4: Unified config.json loader, env override precedence, malformed fail-open & doctor/ctx_doctor reporting", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-cfg-"));
  const cfgPath = path.join(tmpDir, "config.json");
  const tmpDb = path.join(tmpDir, "context.db");

  try {
    resetConfigCache();
    // 1. Missing file -> defaults
    const defSnap = getConfigSnapshot({ configPath: cfgPath, env: {} });
    assert.equal(defSnap.fileExists, false);
    assert.equal(defSnap.configError, null);
    assert.equal(defSnap.values.diffRead, false);
    assert.equal(defSnap.values.readDedup, true);
    assert.equal(defSnap.sources.diffRead, "default");

    // 2. Valid config.json overrides defaults, env overrides config.json
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        diffRead: true,
        diffReadMaxTurns: 8,
        stablePrefixOnly: true,
        sensitiveFileGuard: "warn",
        cacheTtlSec: 600
      }),
      "utf8"
    );
    const cfgSnap = getConfigSnapshot({
      configPath: cfgPath,
      env: { AGY_DART_DISABLE_DIFF_READ: "1", AGY_DART_CACHE_TTL_SEC: "900" }
    });
    assert.equal(cfgSnap.fileExists, true);
    assert.equal(cfgSnap.values.diffRead, false);
    assert.equal(cfgSnap.sources.diffRead, "env");
    assert.equal(cfgSnap.values.diffReadMaxTurns, 8);
    assert.equal(cfgSnap.sources.diffReadMaxTurns, "config");
    assert.equal(cfgSnap.values.stablePrefixOnly, true);
    assert.equal(cfgSnap.values.sensitiveFileGuard, "warn");
    assert.equal(cfgSnap.values.cacheTtlSec, 900);
    assert.equal(cfgSnap.sources.cacheTtlSec, "env");

    // Explicit AGY_DART_DISABLE_*=0 env var must override config.json false
    fs.writeFileSync(cfgPath, JSON.stringify({ compileCache: false, readDedup: false, cliFilter: false, maxReadBytes: 8192 }), "utf8");
    resetConfigCache();
    const envEnableSnap = getConfigSnapshot({
      configPath: cfgPath,
      env: {
        AGY_DART_DISABLE_COMPILE_CACHE: "0",
        AGY_DART_DISABLE_READ_DEDUP: "0",
        AGY_DART_DISABLE_CLI_FILTER: "0",
        CONTEXT_MODE_MAX_READ_BYTES: "32768",
        CONTEXT_MODE_MAX_LINE_RANGE: "600",
        CONTEXT_MODE_MAX_OUTPUT_BYTES: "7500"
      }
    });
    assert.equal(envEnableSnap.values.compileCache, true);
    assert.equal(envEnableSnap.sources.compileCache, "env");
    assert.equal(envEnableSnap.values.readDedup, true);
    assert.equal(envEnableSnap.values.cliFilter, true);
    assert.equal(envEnableSnap.values.maxReadBytes, 32768);
    assert.equal(envEnableSnap.values.maxLineRange, 600);
    assert.equal(envEnableSnap.values.maxOutputBytes, 7500);

    const lines = formatEffectiveConfigLines(cfgSnap);
    assert.ok(lines.some((l) => l.includes("Config file")));
    assert.ok(lines.some((l) => l.includes("Overrides")));

    // 3. Malformed JSON fails open and exposes configError
    fs.writeFileSync(cfgPath, "{ not valid json", "utf8");
    resetConfigCache();
    const badSnap = getConfigSnapshot({ configPath: cfgPath, env: {} });
    assert.equal(badSnap.fileExists, true);
    assert.ok(badSnap.configError);
    assert.equal(badSnap.values.readHook, true);

    // 4. ctx_doctor reports config state & diffReadEnabled
    fs.writeFileSync(cfgPath, JSON.stringify({ diffRead: true }), "utf8");
    const prevCfg = process.env.AGY_DART_CONFIG_PATH;
    process.env.AGY_DART_CONFIG_PATH = cfgPath;
    resetConfigCache();
    try {
      const store = new ContextModeStore({ dbPath: tmpDb });
      const tools = createTools({ store, getCwd: () => tmpDir, getSessionId: () => "cfg-sess" });
      const doc = await tools.ctx_doctor();
      assert.equal(doc.features.diffReadEnabled, true);
      assert.equal(doc.config.loaded, true);
      assert.equal(doc.config.overrides.diffRead.source, "config");
      store.close();
    } finally {
      if (prevCfg === undefined) delete process.env.AGY_DART_CONFIG_PATH;
      else process.env.AGY_DART_CONFIG_PATH = prevCfg;
      resetConfigCache();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("P1-Hardening 5: Exact 0-byte stderr across MCP servers and all 4 lifecycle hooks + SQLite ExperimentalWarning filter", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-stderr0-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const sampleFile = path.join(tmpDir, "hello.js");
  fs.writeFileSync(sampleFile, "export const hello = 'world';\n", "utf8");

  const runMcp = (rel) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(ROOT, rel)], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, AGY_DART_DB_PATH: tmpDb, AGY_DART_DISABLE_COMPILE_CACHE: "1" }
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.on("error", reject);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} } }) + "\n");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
      child.stdin.end();
    });

  try {
    for (const mcp of ["fast/mcp-server.mjs", "context/server.js"]) {
      const r = await runMcp(mcp);
      assert.equal(r.code, 0, `${mcp} failed: ${r.stderr}`);
      assert.equal(Buffer.byteLength(r.stderr, "utf8"), 0, `${mcp} emitted non-empty stderr: ${JSON.stringify(r.stderr)}`);
    }

    const hookRuns = [
      ["hooks/session-start.mjs", { cwd: tmpDir, workspacePaths: [tmpDir], hookEventName: "SessionStart" }],
      ["hooks/pre-tool-use.mjs", { conversationId: "z0", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: sampleFile } } }],
      ["hooks/post-tool-use.mjs", { conversationId: "z0", cwd: tmpDir, toolCall: { name: "edit_file", args: { Path: sampleFile } } }],
      ["hooks/pre-invocation.mjs", { conversationId: "z0", cwd: tmpDir }]
    ];
    for (const [rel, payload] of hookRuns) {
      const res = runHookRaw(rel, payload, tmpDb, { AGY_DART_DISABLE_COMPILE_CACHE: "1" });
      assert.equal(res.status, 0, `${rel} failed: ${res.stderr}`);
      assert.equal(Buffer.byteLength(res.stderr || "", "utf8"), 0, `${rel} emitted stderr: ${JSON.stringify(res.stderr)}`);
    }

    // Synthetic Node 22 SQLite ExperimentalWarning suppression check (must drop SQLite warning, keep non-SQLite warning)
    const probe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { suppressSqliteExperimentalWarning } from ${JSON.stringify("file:///" + path.join(ROOT, "hooks", "compile-cache.mjs").replace(/\\/g, "/"))};
suppressSqliteExperimentalWarning();
process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");
process.stdout.write("OK");`
      ],
      { encoding: "utf8", windowsHide: true }
    );
    assert.equal(probe.status, 0);
    assert.equal(probe.stdout, "OK");
    assert.equal(Buffer.byteLength(probe.stderr || "", "utf8"), 0, `SQLite warning leaked to stderr: ${probe.stderr}`);

    const nonSqliteProbe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { suppressSqliteExperimentalWarning } from ${JSON.stringify("file:///" + path.join(ROOT, "hooks", "compile-cache.mjs").replace(/\\/g, "/"))};
suppressSqliteExperimentalWarning();
process.emitWarning("CUSTOM_NON_SQLITE_WARN", "DeprecationWarning");`
      ],
      { encoding: "utf8", windowsHide: true }
    );
    assert.ok(nonSqliteProbe.stderr.includes("CUSTOM_NON_SQLITE_WARN"), "Non-SQLite warnings must still pass through");

    // ESM import-hoisting regression: importing compile-cache.mjs FIRST must suppress SQLite warning
    // emitted at top-level of a subsequent static import (such as store.js -> node:sqlite in server.mjs).
    const hoistEmitter = path.join(tmpDir, "fake-sqlite.mjs");
    const hoistMain = path.join(tmpDir, "hoist-main.mjs");
    fs.writeFileSync(
      hoistEmitter,
      'process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");\nexport const READY = true;\n',
      "utf8"
    );
    fs.writeFileSync(
      hoistMain,
      `import ${JSON.stringify("file:///" + path.join(ROOT, "hooks", "compile-cache.mjs").replace(/\\/g, "/"))};\nimport { READY } from "./fake-sqlite.mjs";\nprocess.stdout.write(String(READY));\n`,
      "utf8"
    );
    const hoistProbe = spawnSync(process.execPath, [hoistMain], { encoding: "utf8", windowsHide: true });
    assert.equal(hoistProbe.status, 0);
    assert.equal(hoistProbe.stdout, "true");
    assert.equal(Buffer.byteLength(hoistProbe.stderr || "", "utf8"), 0, `ESM-hoisted SQLite warning leaked: ${hoistProbe.stderr}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("P1-Hardening 6: Hook latency budgets (0-SQLite fast path & SQLite read-cache path p50/p95)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-lat-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const skillFile = path.join(tmpDir, "SKILL.md");
  const smallFile = path.join(tmpDir, "mod.js");
  fs.writeFileSync(skillFile, "# skill\n", "utf8");
  fs.writeFileSync(smallFile, makeNumberedLines(60).join("\n") + "\n", "utf8");

  const measure = (payload, runs = 7) => {
    const times = [];
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      const res = runHookRaw("hooks/pre-tool-use.mjs", payload, tmpDb, { AGY_DART_DISABLE_COMPILE_CACHE: "0" });
      const dt = performance.now() - t0;
      assert.equal(res.status, 0, res.stderr);
      times.push(dt);
    }
    times.sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length / 2)];
    const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))];
    return { p50, p95, min: times[0], max: times[times.length - 1] };
  };

  try {
    // Warm up once
    runHookRaw("hooks/pre-tool-use.mjs", { conversationId: "lat-warm", toolCall: { name: "read_file", args: { Path: skillFile } } }, tmpDb);

    const fastStats = measure({ conversationId: "lat-fast", toolCall: { name: "read_file", args: { Path: skillFile } } });
    const dbStats = measure({ conversationId: "lat-db", toolCall: { name: "read_file", args: { Path: smallFile } } });

    // Generous multiplier on shared CI runners while still failing hard regressions
    const ciMult = process.env.CI ? 3 : 2;
    assert.ok(fastStats.p50 < 90 * ciMult, `0-SQLite fast path p50 too slow: ${fastStats.p50.toFixed(1)}ms`);
    assert.ok(fastStats.p95 < 180 * ciMult, `0-SQLite fast path p95 too slow: ${fastStats.p95.toFixed(1)}ms`);
    assert.ok(dbStats.p50 < 150 * ciMult, `SQLite read-cache path p50 too slow: ${dbStats.p50.toFixed(1)}ms`);
    assert.ok(dbStats.p95 < 300 * ciMult, `SQLite read-cache path p95 too slow: ${dbStats.p95.toFixed(1)}ms`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("P1-Hardening 7: Token estimator empirical calibration + per-feature ROI telemetry in store & ctx_stats", async () => {
  // 1. Calibration metrics
  const cal = calibrateTokenEstimator();
  assert.ok(cal.sampleCount >= 5);
  assert.ok(Number.isFinite(cal.maeTokens) && cal.maeTokens >= 0);
  assert.ok(cal.mapePct <= 15, `Expected MAPE <= 15%, got ${cal.mapePct}%`);
  assert.ok(cal.maxRelErrorPct <= 25, `Expected max rel error <= 25%, got ${cal.maxRelErrorPct}%`);

  const budget = await auditPrefixBudget(ROOT);
  assert.equal(budget.errorBandPct, 15);
  assert.ok(budget.upperBoundTokens >= budget.totalTokens);
  assert.ok(budget.upperBoundTokens <= 4000, `Even +15% upper bound (${budget.upperBoundTokens}) should stay <= 4000 tokens`);
  assert.equal(budget.exceedsUpperBound, false);

  // Real transcript usageMetadata delta calibration
  const syntheticSteps = [
    { step_index: 1, type: "PLANNER_RESPONSE", input_tokens: 10000, cache_read_tokens: 0, output_tokens: 200 },
    { step_index: 2, type: "TOOL_OUTPUT", content: "export function computeHash(data) { return data.length; }\n".repeat(12) },
    { step_index: 3, type: "PLANNER_RESPONSE", input_tokens: 380, cache_read_tokens: 10000, output_tokens: 150 },
    { step_index: 4, type: "TOOL_OUTPUT", content: "中文日志输出：测试服务端缓存校准精度与误差上界统计结果。\n".repeat(10) },
    { step_index: 5, type: "PLANNER_RESPONSE", usageMetadata: { promptTokenCount: 10870, cachedContentTokenCount: 10380, candidatesTokenCount: 100 } }
  ];
  const trCal = calibrateFromTranscript(syntheticSteps);
  assert.equal(trCal.source, "transcript");
  assert.equal(trCal.fallbackUsed, false);
  assert.equal(trCal.sampleCount, 2);
  assert.ok(Number.isFinite(trCal.mapePct) && trCal.mapePct < 30);

  // 2. Per-feature ROI telemetry
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-roi-"));
  const tmpDb = path.join(tmpDir, "context.db");
  try {
    const store = new ContextModeStore({ dbPath: tmpDb });
    store.recordEvent({ sessionId: "roi-s1", worktree: tmpDir, kind: "cli_filter", tool: "run_command", key: "test-runner", sandboxBytes: 24000, returnedBytes: 1200 });
    store.recordEvent({ sessionId: "roi-s1", worktree: tmpDir, kind: "dedup", tool: "read_file", key: "unchanged_reread", sandboxBytes: 12000, returnedBytes: 0 });
    store.recordEvent({ sessionId: "roi-s1", worktree: tmpDir, kind: "dedup", tool: "read_file", key: "modified_diff", sandboxBytes: 10000, returnedBytes: 1000 });
    store.recordEvent({ sessionId: "roi-s1", worktree: tmpDir, kind: "interception", tool: "read_file", key: "blocked", sandboxBytes: 40000, returnedBytes: 0 });
    store.recordGhostInterception({ sessionId: "roi-s1", filePath: path.join(tmpDir, "huge.log"), fileSize: 40000, cutoffBytes: 16384 });

    const tools = createTools({ store, getCwd: () => tmpDir, getSessionId: () => "roi-s1" });
    const statsRes = await tools.ctx_stats();
    assert.ok(statsRes.featureRoi && statsRes.featureRoi.features);
    const f = statsRes.featureRoi.features;
    assert.equal(f.cli_filter.calls, 1);
    assert.equal(f.cli_filter.savedBytes, 22800);
    assert.equal(f.cli_filter.status, "high_roi");
    assert.equal(f.read_dedup.calls, 1);
    assert.equal(f.read_dedup.savedBytes, 12000);
    assert.equal(f.diff_read.calls, 1);
    assert.equal(f.diff_read.savedBytes, 9000);
    assert.equal(f.large_file_guard.calls, 1);
    assert.equal(f.large_file_guard.evictionEfficiency, 1);
    assert.equal(f.sandbox_execute.status, "unused");
    store.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
