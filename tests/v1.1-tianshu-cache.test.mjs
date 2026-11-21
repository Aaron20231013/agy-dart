import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { ContextModeStore } from "../context/lib/store.js";
import { createTools } from "../context/lib/tools.js";
import { stableSortObject, stableStringify, sha256Hex } from "../context/lib/stable-json.js";
import {
  analyzeTranscriptCache,
  analyzeMultipleSessionsCache,
  formatCacheDiagMarkdown
} from "../context/lib/cache-analyzer.js";
import {
  sanitizeCacheTag,
  enableVersionedCompileCache,
  pruneStaleCompileCaches
} from "../hooks/compile-cache.mjs";
import { evaluateCacheAlerts } from "../hooks/pre-invocation.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function runHook(relPath, payload, dbPath, extraEnv = {}) {
  const res = spawnSync(process.execPath, [path.join(ROOT, relPath)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      AGY_DART_DB_PATH: dbPath,
      AGY_DART_DISABLE_COMPILE_CACHE: "1",
      ...extraEnv
    }
  });
  assert.equal(res.status, 0, `${relPath} failed: ${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

function mcpSession(scriptPath, requests, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, AGY_DART_DISABLE_COMPILE_CACHE: "1", ...extraEnv }
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`MCP session timeout: ${scriptPath}\nstderr=${stderr}`));
    }, 8000);

    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("close", (code) => {
      clearTimeout(timer);
      const rawLines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const responses = rawLines.map((l) => JSON.parse(l));
      resolve({ code, rawLines, responses, stderr });
    });

    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } }
      }) + "\n"
    );
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    for (const req of requests) {
      child.stdin.write(JSON.stringify(req) + "\n");
    }
    child.stdin.end();
  });
}

function createPersistentMcpClient(scriptPath, extraEnv = {}) {
  const child = spawn(process.execPath, [scriptPath], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, AGY_DART_DISABLE_COMPILE_CACHE: "1", ...extraEnv }
  });

  let buffer = "";
  let nextId = 1;
  const pending = new Map();

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timeout waiting for ${method} (id=${id})`));
      }, 6000);
      pending.set(id, { resolve, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  function close() {
    return new Promise((resolve) => {
      child.once("close", resolve);
      child.stdin.end();
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
        resolve();
      }, 2000).unref();
    });
  }

  return { request, close };
}

test("T1: compile-cache.mjs sanitizes tags, creates versioned dir, tolerates repeated calls, and prunes >3 versions", () => {
  assert.equal(sanitizeCacheTag("1.1.0"), "1.1.0");
  assert.equal(sanitizeCacheTag("1.1.0-rc_1"), "1.1.0-rc_1");
  assert.equal(sanitizeCacheTag("../../etc/passwd"), "etcpasswd");
  assert.equal(sanitizeCacheTag(".."), "default");
  assert.equal(sanitizeCacheTag("."), "default");
  assert.equal(sanitizeCacheTag(""), "default");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-cc-"));
  try {
    // Pre-seed 4 old version directories with staggered mtimes
    const oldVersions = ["1.0.0", "1.0.1", "1.0.2", "1.0.3"];
    const baseSec = Math.floor(Date.now() / 1000) - 100;
    oldVersions.forEach((v, idx) => {
      const dir = path.join(tmpRoot, v);
      fs.mkdirSync(dir, { recursive: true });
      const ts = baseSec + idx * 10;
      fs.utimesSync(dir, ts, ts);
    });

    // Respect AGY_DART_DISABLE_COMPILE_CACHE=1
    const prevDisable = process.env.AGY_DART_DISABLE_COMPILE_CACHE;
    process.env.AGY_DART_DISABLE_COMPILE_CACHE = "1";
    const disabledRes = enableVersionedCompileCache({ rootDir: tmpRoot, tag: "1.1.0" });
    assert.equal(disabledRes.enabled, false);
    assert.equal(disabledRes.reason, "disabled");
    assert.equal(fs.existsSync(path.join(tmpRoot, "1.1.0")), false);
    if (prevDisable === undefined) delete process.env.AGY_DART_DISABLE_COMPILE_CACHE;
    else process.env.AGY_DART_DISABLE_COMPILE_CACHE = prevDisable;

    // Enable in isolated root with tag 1.1.0 (Node 22.8+ creates dir & prunes oldest to keep 3 total)
    const r1 = enableVersionedCompileCache({ rootDir: tmpRoot, tag: "1.1.0", keepRecent: 3 });
    if (r1.reason !== "unsupported") {
      assert.equal(r1.enabled, true);
      assert.equal(r1.tag, "1.1.0");
      assert.ok(fs.existsSync(path.join(tmpRoot, "1.1.0")));

      const remaining = fs.readdirSync(tmpRoot).sort();
      assert.equal(remaining.length, 3, `Expected 3 version dirs kept, got: ${remaining.join(", ")}`);
      assert.ok(remaining.includes("1.1.0"));
      assert.ok(remaining.includes("1.0.3"));
      assert.ok(remaining.includes("1.0.2"));
      assert.ok(!remaining.includes("1.0.0"));
      assert.ok(!remaining.includes("1.0.1"));

      // Repeated call must succeed cleanly without throwing
      const r2 = enableVersionedCompileCache({ rootDir: tmpRoot, tag: "1.1.0", keepRecent: 3 });
      assert.equal(r2.enabled, true);
      assert.equal(r2.created, false);
    } else {
      // Even on Node 22.0-22.7 without enableCompileCache, direct pruneStaleCompileCaches still works
      fs.mkdirSync(path.join(tmpRoot, "1.1.0"), { recursive: true });
      const pruned = pruneStaleCompileCaches(tmpRoot, "1.1.0", 3);
      assert.equal(pruned.removed.length, 2);
      assert.equal(fs.readdirSync(tmpRoot).length, 3);
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("T1: PreToolUse 0-SQLite fast path allows SKILL.md, /.user_uploaded/, binary files, and disabled-read-hook without creating DB", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-zerosql-"));
  const bigSkill = path.join(tmpDir, "SKILL.md");
  const uploadDir = path.join(tmpDir, ".user_uploaded");
  const uploadedTxt = path.join(uploadDir, "huge_upload.txt");
  const bigPdf = path.join(tmpDir, "manual.pdf");
  const bigLog = path.join(tmpDir, "big.log");

  fs.mkdirSync(uploadDir, { recursive: true });
  fs.writeFileSync(bigSkill, "# Skill\n" + "instruction ".repeat(2500));
  fs.writeFileSync(uploadedTxt, "uploaded content ".repeat(2500));
  fs.writeFileSync(bigPdf, Buffer.from("%PDF-1.7\n" + "0".repeat(30000)));
  fs.writeFileSync(bigLog, "log line\n".repeat(4000));

  try {
    const cases = [
      { name: "SKILL.md", payload: { toolCall: { name: "read_file", args: { Path: bigSkill } } }, env: {} },
      { name: "user_uploaded", payload: { toolCall: { name: "read_file", args: { Path: uploadedTxt } } }, env: {} },
      { name: "binary_pdf", payload: { toolCall: { name: "view_file", args: { Path: bigPdf } } }, env: {} },
      {
        name: "disabled_read_hook",
        payload: { toolCall: { name: "read_file", args: { Path: bigLog } } },
        env: { AGY_DART_DISABLE_READ_HOOK: "1" }
      }
    ];

    for (const tc of cases) {
      const tmpDb = path.join(tmpDir, `no-db-${tc.name}.db`);
      const res = runHook("hooks/pre-tool-use.mjs", tc.payload, tmpDb, tc.env);
      assert.equal(res.decision, "allow", `${tc.name} should be allowed`);
      assert.equal(
        fs.existsSync(tmpDb),
        false,
        `${tc.name} MUST NOT open or create SQLite DB (${tmpDb})`
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("T2: ctx_index SHA-256 content dedup reuses sourceId without inflating chunks/stats and upgrades v3 DBs losslessly", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-dedup-idx-"));
  const tmpDb = path.join(tmpDir, "context.db");

  try {
    // Seed a legacy schema v3 database (no content_hash column, no ghost_interceptions table)
    const legacyDb = new DatabaseSync(tmpDb);
    legacyDb.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta(key, value) VALUES ('schema_version', '3');
      CREATE TABLE sources (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        worktree TEXT NOT NULL,
        agent TEXT NOT NULL,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        bytes_total INTEGER NOT NULL DEFAULT 0,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        created_ts INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        accessed_ts INTEGER NOT NULL
      );
    `);
    legacyDb.close();

    const store = new ContextModeStore({ dbPath: tmpDb });
    store.open();
    assert.equal(store.getMeta("schema_version"), "3");
    const cols = store.db.prepare("PRAGMA table_info(sources)").all();
    assert.ok(cols.some((c) => c.name === "content_hash"), "legacy v3 DB should gain content_hash column");
    const ghostTable = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ghost_interceptions'")
      .get();
    assert.ok(ghostTable, "legacy v3 DB should gain ghost_interceptions table");

    const tools = createTools({ store, getCwd: () => tmpDir, getSessionId: () => "dedup-idx-s1" });
    const docText = "# API Spec\n\n" + "Authentication bearer tokens expire after 3600 seconds.\n".repeat(120);

    const first = await tools.ctx_index({ content: docText, label: "spec-v1" });
    assert.equal(first.deduplicated, false);
    assert.ok(first.sourceId);
    assert.ok(first.chunkCount >= 1);

    const chunkCountAfterFirst = store.db.prepare("SELECT count(*) AS cnt FROM chunks").get().cnt;
    const statsAfterFirst = store.getStats("dedup-idx-s1");

    // Second index of exact same content in same session -> reused!
    const second = await tools.ctx_index({ content: docText, label: "spec-v1-copy" });
    assert.equal(second.deduplicated, true);
    assert.equal(second.sourceId, first.sourceId);
    assert.ok(second.message.includes("Reused existing indexed source"));

    const chunkCountAfterSecond = store.db.prepare("SELECT count(*) AS cnt FROM chunks").get().cnt;
    assert.equal(chunkCountAfterSecond, chunkCountAfterFirst, "Dedup hit must not write duplicate FTS5 chunks");

    const statsAfterSecond = store.getStats("dedup-idx-s1");
    assert.ok(
      statsAfterSecond.totalRawBytes < statsAfterFirst.totalRawBytes + first.bytesTotal,
      "Dedup hit must not double-count full bytesTotal in raw stats"
    );

    // Modified content -> creates a fresh sourceId
    const third = await tools.ctx_index({ content: docText + "\n## Addendum\nNew endpoint.\n", label: "spec-v2" });
    assert.equal(third.deduplicated, false);
    assert.notEqual(third.sourceId, first.sourceId);

    store.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("T2: read_slices({ outlines }) cross-call LRU cache hits on unchanged (mtimeMs, size) and invalidates immediately on change", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-outline-lru-"));
  const targetFile = path.join(tmpDir, "sample.js");
  const initialSrc = [
    "export function alphaWorker() {",
    "  return 1;",
    "}",
    "export function betaWorker() {",
    "  return 2;",
    "}",
    ""
  ].join("\n");
  const fixedSec = Math.floor(Date.now() / 1000) - 20;
  fs.writeFileSync(targetFile, initialSrc, "utf8");
  fs.utimesSync(targetFile, fixedSec, fixedSec);
  const origStat = fs.statSync(targetFile);

  const client = createPersistentMcpClient(path.join(ROOT, "fast", "mcp-server.mjs"));
  try {
    const initResp = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "lru-test", version: "1.0" }
    });
    assert.ok(initResp.result?.serverInfo);

    // 1. Cold miss populates LRU cache
    const r1 = await client.request("tools/call", {
      name: "read_slices",
      arguments: { cwd: tmpDir, outlines: ["sample.js"] }
    });
    const t1 = r1.result.content[0].text;
    assert.ok(t1.includes("alphaWorker"));
    assert.ok(t1.includes("L1-L3"));

    // 1b. Normal unchanged repeat call returns identical outline
    const r1Repeat = await client.request("tools/call", {
      name: "read_slices",
      arguments: { cwd: tmpDir, outlines: ["sample.js"] }
    });
    assert.equal(r1Repeat.result.content[0].text, t1);

    // 2. Prove true memory LRU hit: overwrite file with identical byte size & exact same mtime -> LRU returns cached symbol!
    const sameLenSrc = initialSrc.replace("alphaWorker", "gammaWorker");
    assert.equal(Buffer.byteLength(sameLenSrc, "utf8"), origStat.size);
    fs.writeFileSync(targetFile, sameLenSrc, "utf8");
    fs.utimesSync(targetFile, fixedSec, fixedSec);

    const rHit = await client.request("tools/call", {
      name: "read_slices",
      arguments: { cwd: tmpDir, outlines: ["sample.js"] }
    });
    assert.equal(rHit.result.content[0].text, t1, "Identical (mtimeMs, size) must serve from LRU cache");

    // 3. Modify file (new content, new size & mtimeMs) -> must immediately invalidate cache and reflect new line numbers
    const updatedSrc = [
      "// header comment",
      "// second comment",
      "export function deltaHandler() {",
      "  return 42;",
      "}",
      ""
    ].join("\n");
    fs.writeFileSync(targetFile, updatedSrc, "utf8");
    const bumpedSec = Math.floor(Date.now() / 1000) + 5;
    fs.utimesSync(targetFile, bumpedSec, bumpedSec);

    const rMiss = await client.request("tools/call", {
      name: "read_slices",
      arguments: { cwd: tmpDir, outlines: ["sample.js"] }
    });
    const tMiss = rMiss.result.content[0].text;
    assert.ok(tMiss.includes("deltaHandler"), `Expected updated symbol deltaHandler, got:\n${tMiss}`);
    assert.ok(tMiss.includes("L3-L5"), `Expected updated line range L3-L5, got:\n${tMiss}`);
    assert.ok(!tMiss.includes("alphaWorker"));
  } finally {
    await client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("T3: Dual MCP tools/list deterministic sorting & recursive keys + prefix-budget.mjs --json identical toolsFingerprint", async () => {
  // Unit-check stable-json helpers
  const unsorted = { z: 1, a: { d: 4, b: [3, { y: 2, x: 1 }] } };
  const expected = '{"a":{"b":[3,{"x":1,"y":2}],"d":4},"z":1}';
  assert.equal(stableStringify(unsorted), expected);
  assert.equal(sha256Hex(expected).length, 64);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-det-"));
  const tmpDb = path.join(tmpDir, "context.db");
  try {
    const fast1 = await mcpSession(path.join(ROOT, "fast", "mcp-server.mjs"), [{ jsonrpc: "2.0", id: 2, method: "tools/list" }]);
    const fast2 = await mcpSession(path.join(ROOT, "fast", "mcp-server.mjs"), [{ jsonrpc: "2.0", id: 2, method: "tools/list" }]);
    assert.equal(fast1.rawLines[1], fast2.rawLines[1], "fast tools/list must be byte-identical across processes");
    const fastTools = fast1.responses[1].result.tools;
    assert.deepEqual(
      fastTools.map((t) => t.name),
      ["apply_edits", "batch_search", "read_slices", "run_checks"]
    );
    assert.equal(JSON.stringify(fastTools), stableStringify(fastTools));

    const ctx1 = await mcpSession(
      path.join(ROOT, "context", "server.js"),
      [{ jsonrpc: "2.0", id: 2, method: "tools/list" }],
      { AGY_DART_DB_PATH: tmpDb }
    );
    const ctx2 = await mcpSession(
      path.join(ROOT, "context", "server.js"),
      [{ jsonrpc: "2.0", id: 2, method: "tools/list" }],
      { AGY_DART_DB_PATH: tmpDb }
    );
    assert.equal(ctx1.rawLines[1], ctx2.rawLines[1], "context tools/list must be byte-identical across processes");
    const ctxTools = ctx1.responses[1].result.tools;
    assert.deepEqual(
      ctxTools.map((t) => t.name),
      ["ctx_batch", "ctx_doctor", "ctx_execute", "ctx_index", "ctx_purge", "ctx_resume", "ctx_search", "ctx_stats"]
    );
    assert.equal(JSON.stringify(ctxTools), stableStringify(ctxTools));

    // Run scripts/prefix-budget.mjs --json twice and verify identical toolsFingerprint
    const runBudget = () => {
      const res = spawnSync(process.execPath, [path.join(ROOT, "scripts", "prefix-budget.mjs"), "--json"], {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, AGY_DART_DISABLE_COMPILE_CACHE: "1" }
      });
      assert.equal(res.status, 0, res.stderr);
      return JSON.parse(res.stdout);
    };

    const b1 = runBudget();
    const b2 = runBudget();
    assert.equal(b1.toolsFingerprint.length, 64);
    assert.equal(b1.toolsFingerprint, b2.toolsFingerprint);
    assert.equal(b1.blocks.tools.canonical, true);
    assert.ok(b1.blocks.brake.tokens > 0);
    assert.ok(b1.blocks.reference.frontmatterBytes > 0);
    assert.ok(b1.blocks.reference.bodyBytes > b1.blocks.reference.frontmatterBytes);
    assert.ok(b1.blocks.startup.stableBytes > 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("T4: Ghost Registry tracks paged recalls after large-file blocks, triggers host-45k recommendation under tight cutoff, and stays 1.0 when ctx_index is used", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-ghost-"));
  const tmpDb = path.join(tmpDir, "context.db");

  try {
    // Scenario A: Tight 16 KB cutoff blocks 3 ~24 KB source files, then each recalled via 2 paged read_file calls covering >=70%
    const sidRecall = "ghost-recall-session";
    const initStore = new ContextModeStore({ dbPath: tmpDb });
    try {
      initStore.setCutoff(16384, sidRecall);
    } finally {
      initStore.close();
    }
    for (let i = 1; i <= 3; i++) {
      const filePath = path.join(tmpDir, `large_${i}.ts`);
      // ~600 lines * ~40 bytes = ~24 KB (> 16 KB tight cutoff)
      const content = Array.from({ length: 600 }, (_, ln) => `export const row_${i}_${ln} = "payload_${ln.toString().padStart(4, "0")}";`).join("\n");
      fs.writeFileSync(filePath, content, "utf8");

      // Full read -> denied & recorded in ghost_interceptions
      const denied = runHook(
        "hooks/pre-tool-use.mjs",
        { conversationId: sidRecall, toolCall: { name: "read_file", args: { Path: filePath } } },
        tmpDb
      );
      assert.equal(denied.decision, "deny");

      // Paged read 1 (lines 1-300 -> est 13.5 KB) & Paged read 2 (lines 301-600 -> est 13.5 KB; total >= 70%)
      const p1 = runHook(
        "hooks/pre-tool-use.mjs",
        { conversationId: sidRecall, toolCall: { name: "read_file", args: { Path: filePath, StartLine: 1, EndLine: 300 } } },
        tmpDb
      );
      const p2 = runHook(
        "hooks/pre-tool-use.mjs",
        { conversationId: sidRecall, toolCall: { name: "read_file", args: { Path: filePath, StartLine: 301, EndLine: 600 } } },
        tmpDb
      );
      assert.equal(p1.decision, "allow");
      assert.equal(p2.decision, "allow");
    }

    const store = new ContextModeStore({ dbPath: tmpDb });
    const ghostA = store.getGhostStats(sidRecall);
    assert.equal(ghostA.totalBlocked, 3);
    assert.equal(ghostA.ghostRecalls, 3);
    assert.equal(ghostA.evictionEfficiency, 0);
    assert.equal(
      ghostA.recommendation,
      "Cutoff may be too tight for this repo; consider switching to 45 KB (host-45k)."
    );

    // Verify ctx_stats attaches ghost object and Ghost Efficiency line
    const toolsA = createTools({ store, getCwd: () => tmpDir, getSessionId: () => sidRecall });
    const statsOut = await toolsA.ctx_stats({});
    assert.equal(statsOut.ghost.totalBlocked, 3);
    assert.ok(statsOut.report.includes("Ghost Efficiency:"));
    assert.ok(statsOut.report.includes("0% (ghost recalls: 3/3)"));

    // Scenario B: large file blocked, then agent obeys guidance and uses ctx_index instead of paged read_file -> efficiency stays 1
    const sidClean = "ghost-clean-session";
    const logPath = path.join(tmpDir, "clean_big.log");
    fs.writeFileSync(logPath, "event log entry payload line\n".repeat(1000), "utf8");
    const deniedClean = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: sidClean, toolCall: { name: "read_file", args: { Path: logPath } } },
      tmpDb
    );
    assert.equal(deniedClean.decision, "deny");

    const toolsClean = createTools({ store, getCwd: () => tmpDir, getSessionId: () => sidClean });
    await toolsClean.ctx_index({ path: logPath, label: "clean_big.log" });

    const ghostB = store.getGhostStats(sidClean);
    assert.equal(ghostB.totalBlocked, 1);
    assert.equal(ghostB.ghostRecalls, 0);
    assert.equal(ghostB.evictionEfficiency, 1);
    assert.equal(ghostB.recommendation, null);

    // Verify session purge clears ghost_interceptions for that session only
    store.purge({ scope: "session", sessionId: sidRecall });
    assert.equal(store.getGhostStats(sidRecall).totalBlocked, 0);
    assert.equal(store.getGhostStats(sidClean).totalBlocked, 1);

    store.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("T5 & T6: SessionWarmth / compactAdvice / cost savings, PreInvocation hot-cache delay alert, and run_checks(compact) noise filter", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-warmth-"));
  const tmpDb = path.join(tmpDir, "context.db");

  try {
    const nowMs = Date.now();
    // 1. Hot cache at warn watermark (140k tokens, 92% cache hit, 20s idle) -> delay_hot_cache
    const hotSteps = [
      {
        type: "PLANNER_RESPONSE",
        step_index: 1,
        created_at: new Date(nowMs - 20 * 1000).toISOString(),
        model: "unknown-custom-model",
        input_tokens: 11200,
        cache_read_tokens: 128800,
        output_tokens: 300
      }
    ];
    const hotDiag = analyzeTranscriptCache(hotSteps, { ttlSec: 300, nowMs });
    assert.equal(hotDiag.watermark, "warn");
    assert.equal(hotDiag.cacheTemperature, "hot");
    assert.equal(hotDiag.compactAdvice, "delay_hot_cache");
    assert.equal(hotDiag.estimatedCostSavingsPct, 82.8);

    // 2. Cold cache at 80k tokens (400s idle > 300s TTL) -> opportunistic_cold_compact
    const coldSteps = [
      {
        type: "PLANNER_RESPONSE",
        step_index: 2,
        created_at: new Date(nowMs - 400 * 1000).toISOString(),
        model: "unknown-custom-model",
        input_tokens: 8000,
        cache_read_tokens: 72000,
        output_tokens: 200
      }
    ];
    const coldDiag = analyzeTranscriptCache(coldSteps, { ttlSec: 300, nowMs });
    assert.equal(coldDiag.cacheTemperature, "cold");
    assert.equal(coldDiag.compactAdvice, "opportunistic_cold_compact");

    // 3. Critical watermark (170k tokens, hot) -> critical_compact
    const critSteps = [
      {
        type: "PLANNER_RESPONSE",
        step_index: 3,
        created_at: new Date(nowMs - 10 * 1000).toISOString(),
        model: "unknown-custom-model",
        input_tokens: 10000,
        cache_read_tokens: 160000,
        output_tokens: 200
      }
    ];
    const critDiag = analyzeTranscriptCache(critSteps, { ttlSec: 300, nowMs });
    assert.equal(critDiag.cacheTemperature, "hot");
    assert.equal(critDiag.compactAdvice, "critical_compact");

    // 4. Multi-session aggregation & markdown report include estimatedCostSavingsPct
    const agg = analyzeMultipleSessionsCache([hotSteps, coldSteps], { ttlSec: 300, nowMs });
    assert.ok(agg.estimatedCostSavingsPct > 80);
    const md = formatCacheDiagMarkdown(agg);
    assert.ok(md.includes("| Est. input cost savings (at 90% cache discount) |"));

    // 5. PreInvocation evaluateCacheAlerts emits explicit "Delay `/compact`" guidance on warn + delay_hot_cache
    const store = new ContextModeStore({ dbPath: tmpDb });
    const hotAlerts = evaluateCacheAlerts(hotDiag, { sessionId: "warm-s1", store });
    assert.equal(hotAlerts.length, 1);
    assert.ok(hotAlerts[0].includes("cache **HOT**"));
    assert.ok(hotAlerts[0].includes("**Delay `/compact`**"));
    store.close();

    // 6. run_checks(compact) strips passing/progress noise lines while preserving all error/ERR!/assert/✖ lines
    const noiseScript = path.join(tmpDir, "emit-fail.mjs");
    fs.writeFileSync(
      noiseScript,
      [
        'console.log("✔ unit test alpha passes (1ms)");',
        'console.log("✓ unit test beta passes (2ms)");',
        'console.log("--- PASS: TestCompute (0.00s)");',
        'console.log("ok 1 - tap passing case");',
        'console.log("npm warn deprecated oldpkg@1.0.0: no longer maintained");',
        'console.log("42 packages are looking for funding");',
        'console.log("✔ error handler failed assertion check");',
        'console.log("npm ERR! code ELIFECYCLE");',
        'console.log("✖ broken test case");',
        'console.error("AssertionError: expected 2 to equal 3");',
        "process.exit(1);"
      ].join("\n"),
      "utf8"
    );

    const checkRes = await mcpSession(path.join(ROOT, "fast", "mcp-server.mjs"), [
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "run_checks",
          arguments: {
            cwd: tmpDir,
            outputMode: "compact",
            commands: [{ name: "noisy-fail", command: `node "${noiseScript}"` }]
          }
        }
      }
    ]);
    const checkText = checkRes.responses[1].result.content[0].text;
    assert.ok(!checkText.includes("unit test alpha passes"), "Pure ✔ passing line should be stripped");
    assert.ok(!checkText.includes("unit test beta passes"), "Pure ✓ passing line should be stripped");
    assert.ok(!checkText.includes("--- PASS: TestCompute"), "--- PASS line should be stripped");
    assert.ok(!checkText.includes("ok 1 - tap passing case"), "ok N line should be stripped");
    assert.ok(!checkText.includes("npm warn deprecated"), "npm warn deprecated should be stripped");
    assert.ok(!checkText.includes("looking for funding"), "funding noise should be stripped");

    assert.ok(checkText.includes("error handler failed assertion check"), "Line containing error/failed must be protected");
    assert.ok(checkText.includes("npm ERR! code ELIFECYCLE"), "npm ERR! line must be protected");
    assert.ok(checkText.includes("broken test case"), "✖ line must be protected");
    assert.ok(checkText.includes("AssertionError: expected 2 to equal 3"), "AssertionError must be preserved");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("T6: Installer copies runtime-only by default and devtools with --with-devtools, passing doctor with V8 CompileCache & config report", () => {
  const tmpTarget = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-t6-install-"));
  const installDir = path.join(tmpTarget, "agy-dart");
  const fullDir = path.join(tmpTarget, "agy-dart-full");
  try {
    // 1. Default runtime-only install omits offline devtools CLIs
    const res = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "install.mjs"), "install", "--target", installDir, "--mode", "balanced-16k"],
      {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, AGY_DART_DISABLE_COMPILE_CACHE: "1" }
      }
    );
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    assert.ok(fs.existsSync(path.join(installDir, "hooks", "compile-cache.mjs")));
    assert.ok(fs.existsSync(path.join(installDir, "context", "lib", "stable-json.js")));
    assert.ok(fs.existsSync(path.join(installDir, "context", "lib", "config.js")));
    assert.equal(fs.existsSync(path.join(installDir, "scripts", "prefix-budget.mjs")), false, "Default runtime install must omit devtools");
    assert.ok(res.stdout.includes("V8 CompileCache :"));
    assert.ok(res.stdout.includes("Config file   :"));
    assert.ok(res.stdout.includes("MCP [fast]    : OK (4 tools"));
    assert.ok(res.stdout.includes("MCP [context] : OK (8 tools"));

    // 2. --with-devtools includes offline audit/benchmark/prefix-budget CLIs
    const resFull = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "install.mjs"), "install", "--target", fullDir, "--mode", "balanced-16k", "--with-devtools"],
      {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, AGY_DART_DISABLE_COMPILE_CACHE: "1" }
      }
    );
    assert.equal(resFull.status, 0, `${resFull.stdout}\n${resFull.stderr}`);
    assert.ok(fs.existsSync(path.join(fullDir, "scripts", "prefix-budget.mjs")));
    assert.ok(resFull.stdout.includes("runtime + devtools"));
  } finally {
    fs.rmSync(tmpTarget, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Hardening: Ghost recall still tracks when read-dedup is off, pruneByTtl cleans stale ghosts, cli-filter deduplicates FTS5 sources, and Sidecar API exposes ghost & warmth fields", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-t-hardening-"));
  const tmpDb = path.join(tmpDir, "context.db");

  try {
    // 1. Ghost recall works even when read-dedup is disabled (tested at default 45 KiB cutoff)
    const store = new ContextModeStore({ dbPath: tmpDb });
    store.setReadDedupEnabled(false, "conversation", "no-dedup-sess");
    const bigFile = path.join(tmpDir, "big_nodedup.ts");
    fs.writeFileSync(
      bigFile,
      Array.from({ length: 1400 }, (_, i) => `export const item_${i} = "value_${i.toString().padStart(4, "0")}";`).join("\n"),
      "utf8"
    );
    const denied = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "no-dedup-sess", toolCall: { name: "read_file", args: { Path: bigFile } } },
      tmpDb
    );
    assert.equal(denied.decision, "deny");
    const p1 = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "no-dedup-sess", toolCall: { name: "read_file", args: { Path: bigFile, StartLine: 1, EndLine: 700 } } },
      tmpDb
    );
    const p2 = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "no-dedup-sess", toolCall: { name: "read_file", args: { Path: bigFile, StartLine: 701, EndLine: 1400 } } },
      tmpDb
    );
    assert.equal(p1.decision, "allow");
    assert.equal(p2.decision, "allow");
    const gs = store.getGhostStats("no-dedup-sess");
    assert.equal(gs.totalBlocked, 1);
    assert.equal(gs.ghostRecalls, 1);
    assert.equal(gs.evictionEfficiency, 0);

    // 2. pruneByTtl cleans stale ghost_interceptions
    const oldTs = Date.now() - 30 * 24 * 3600 * 1000;
    store.db
      .prepare("UPDATE ghost_interceptions SET blocked_ts = ? WHERE session_id = ?")
      .run(oldTs, "no-dedup-sess");
    const ttlRes = store.pruneByTtl({ maxAgeDays: 14, vacuum: false });
    assert.equal(ttlRes.deletedGhostInterceptions, 1);
    assert.equal(store.getGhostStats("no-dedup-sess").totalBlocked, 0);

    // 3. cli-filter.mjs SHA-256 dedup: identical output twice produces only 1 source row
    const noisyScript = path.join(tmpDir, "noisy.mjs");
    fs.writeFileSync(
      noisyScript,
      'for (let i = 0; i < 80; i++) console.log("passing log line number " + i + " " + "x".repeat(40));\n',
      "utf8"
    );
    const cmdB64 = `b:${Buffer.from(`node "${noisyScript}"`, "utf8").toString("base64url")}`;
    const sessB64 = `b:${Buffer.from("cli-dedup-sess", "utf8").toString("base64url")}`;
    const cliArgs = [path.join(ROOT, "hooks", "cli-filter.mjs"), "--rule", "test-runner", "--b64", cmdB64, "--session", sessB64];
    const c1 = spawnSync(process.execPath, cliArgs, {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, AGY_DART_DB_PATH: tmpDb, AGY_DART_DISABLE_COMPILE_CACHE: "1" }
    });
    const c2 = spawnSync(process.execPath, cliArgs, {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, AGY_DART_DB_PATH: tmpDb, AGY_DART_DISABLE_COMPILE_CACHE: "1" }
    });
    assert.equal(c1.status, 0, c1.stderr);
    assert.equal(c2.status, 0, c2.stderr);
    const cliSources = store.db
      .prepare("SELECT count(*) AS cnt FROM sources WHERE session_id = 'cli-dedup-sess'")
      .get().cnt;
    assert.equal(cliSources, 1, "cli-filter.mjs should reuse existing SHA-256 source instead of duplicating");

    // Seed a fresh ghost row for Sidecar /api/stats verification
    store.recordGhostInterception({ sessionId: "sidecar-ghost-sess", filePath: bigFile, fileSize: 25000, cutoffBytes: 16384 });
    store.close();

    // 4. Sidecar HTTP server exposes stats.ghost and /api/cache-diag warmth fields
    const port = 37400 + Math.floor(Math.random() * 500);
    const serverProc = spawn(process.execPath, [path.join(ROOT, "sidecars", "dashboard", "server.mjs")], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        AGY_DART_DB_PATH: tmpDb,
        AGY_DART_DISABLE_COMPILE_CACHE: "1",
        SIDECAR_FORCE_HTTP: "1",
        PORT: String(port)
      }
    });

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Sidecar startup timed out")), 5000);
        serverProc.stdout.on("data", (d) => {
          if (d.toString("utf8").includes("listening")) {
            clearTimeout(timer);
            resolve();
          }
        });
        serverProc.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`Sidecar exited prematurely: ${code}`));
        });
      });

      const htmlResp = await fetch(`http://127.0.0.1:${port}/`);
      const html = await htmlResp.text();
      const token = html.match(/<meta name="agy-dart-token" content="([a-f0-9]+)">/i)?.[1];
      assert.ok(token, "Sidecar HTML must inject agy-dart-token meta");
      const authHeaders = { headers: { "X-Agy-Dart-Token": token } };

      const statsResp = await fetch(`http://127.0.0.1:${port}/api/stats?scope=conversation&conversationId=sidecar-ghost-sess`, authHeaders);
      assert.equal(statsResp.status, 200);
      const statsJson = await statsResp.json();
      assert.equal(statsJson.ghost.totalBlocked, 1);
      assert.equal(statsJson.ghost.evictionEfficiency, 1);

      const kvResp = await fetch(`http://127.0.0.1:${port}/api/cache-diag?scope=conversation&conversationId=nonexistent-conv-id-xyz`, authHeaders);
      assert.equal(kvResp.status, 200);
      const kvJson = await kvResp.json();
      assert.equal(kvJson.cacheTemperature, "cold");
      assert.equal(kvJson.compactAdvice, "none");
      assert.equal(kvJson.estimatedCostSavingsPct, 0);

      assert.ok(html.includes('id="kv-temp-badge"'));
      assert.ok(html.includes('id="kv-cost-savings"'));
      assert.ok(html.includes('id="kv-ghost-row"'));
    } finally {
      serverProc.kill("SIGTERM");
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Review hardening: live V8 compile-cache artifacts, Windows case-safe pruning, exact Ghost byte scan, 129-file LRU eviction, error-class protection, and Sidecar live TTL aging", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-review-"));
  const tmpDb = path.join(tmpDir, "context.db");

  function listFilesRecursive(root, cur = root, out = []) {
    if (!fs.existsSync(cur)) return out;
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) listFilesRecursive(root, full, out);
      else out.push({ rel: path.relative(root, full), size: fs.statSync(full).size });
    }
    return out;
  }

  try {
    // 1. Live V8 compile-cache MUST persist actual bytecode files (not empty dir!) when running hooks
    const ccDir = path.join(tmpDir, "compile-cache");
    const smallFile = path.join(tmpDir, "small.js");
    fs.writeFileSync(smallFile, "export const x = 1;\n", "utf8");
    const hookCcRes = spawnSync(process.execPath, [path.join(ROOT, "hooks", "pre-tool-use.mjs")], {
      input: JSON.stringify({
        conversationId: "cc-live-sess",
        toolCall: { name: "read_file", args: { Path: smallFile } }
      }),
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        AGY_DART_DB_PATH: tmpDb,
        AGY_DART_COMPILE_CACHE_DIR: ccDir,
        AGY_DART_DISABLE_COMPILE_CACHE: ""
      }
    });
    assert.equal(hookCcRes.status, 0, hookCcRes.stderr);
    assert.equal(JSON.parse(hookCcRes.stdout.trim()).decision, "allow");
    const cachedFiles = listFilesRecursive(ccDir);
    assert.ok(
      cachedFiles.some((f) => f.size > 0),
      `Expected non-empty V8 bytecode files in ${ccDir}, got: ${JSON.stringify(cachedFiles)}`
    );

    // 1b. compile-cache unsupported (Node 22.0-22.7) fallback & fail-open error path + Windows case-safe pruning
    const unsupportedRes = enableVersionedCompileCache({ rootDir: ccDir, tag: "1.1.0", enableCompileCache: null });
    assert.equal(unsupportedRes.enabled, false);
    assert.equal(unsupportedRes.reason, "unsupported");
    const errRes = enableVersionedCompileCache({
      rootDir: ccDir,
      tag: "1.1.0",
      enableCompileCache: () => {
        throw new Error("boom");
      }
    });
    assert.equal(errRes.enabled, false);
    assert.equal(errRes.reason, "error");

    const caseCcRoot = path.join(tmpDir, "cc-case");
    fs.mkdirSync(path.join(caseCcRoot, "V1.1.0"), { recursive: true });
    fs.mkdirSync(path.join(caseCcRoot, "1.0.0"), { recursive: true });
    fs.mkdirSync(path.join(caseCcRoot, "1.0.1"), { recursive: true });
    fs.mkdirSync(path.join(caseCcRoot, "1.0.2"), { recursive: true });
    const ancientSec = Math.floor(Date.now() / 1000) - 500;
    fs.utimesSync(path.join(caseCcRoot, "V1.1.0"), ancientSec, ancientSec);
    if (process.platform === "win32") {
      const prunedCase = pruneStaleCompileCaches(caseCcRoot, "v1.1.0", 2);
      assert.ok(
        prunedCase.kept.some((n) => n.toLowerCase() === "v1.1.0"),
        `Windows active dir V1.1.0 must not be pruned: ${JSON.stringify(prunedCase)}`
      );
      assert.ok(fs.existsSync(path.join(caseCcRoot, "V1.1.0")));
    }

    // 1c. PreToolUse 0-SQLite fast path handles relative SKILL.md, file:/// URI + #L fragment, uppercase .PDF, and non-guarded tools
    const relSkill = path.join(tmpDir, "SKILL.md");
    fs.writeFileSync(relSkill, "# Skill\n" + "rule ".repeat(4000), "utf8");
    const upperPdf = path.join(tmpDir, "DOC.PDF");
    fs.writeFileSync(upperPdf, Buffer.from("%PDF-1.7\n" + "0".repeat(25000)));
    const fastEdgeCases = [
      { name: "rel-skill", payload: { cwd: tmpDir, toolCall: { name: "read_file", args: { Path: "SKILL.md" } } } },
      {
        name: "uri-upper-pdf",
        payload: { toolCall: { name: "view_file", args: { Path: `file:///${upperPdf.replace(/\\/g, "/")}#L1-L5` } } }
      },
      { name: "non-guarded", payload: { toolCall: { name: "edit_file", args: { Path: smallFile } } } }
    ];
    for (const tc of fastEdgeCases) {
      const zeroDb = path.join(tmpDir, `zero-${tc.name}.db`);
      const out = runHook("hooks/pre-tool-use.mjs", tc.payload, zeroDb);
      assert.equal(out.decision, "allow", `${tc.name} should allow`);
      assert.equal(fs.existsSync(zeroDb), false, `${tc.name} must stay 0-SQLite`);
    }

    // 2. Ghost Registry exact byte scan (at default 45 KiB cutoff):
    //    - Long-line file (400 lines * ~138B = ~55.5KB) 100% read in 2 slices MUST trigger ghost recall
    //    - Short-line file (2600 lines * 20B = ~52KB) ~29% read in 2 slices MUST NOT false-positive
    const longFile = path.join(tmpDir, "long_lines.ts");
    fs.writeFileSync(
      longFile,
      Array.from({ length: 400 }, (_, i) => `export const row_${i} = "${"A".repeat(110)}";`).join("\n"),
      "utf8"
    );
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "ghost-long", toolCall: { name: "read_file", args: { Path: longFile } } }, tmpDb).decision,
      "deny"
    );
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "ghost-long", toolCall: { name: "read_file", args: { Path: longFile, StartLine: 1, EndLine: 200 } } }, tmpDb).decision,
      "allow"
    );
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "ghost-long", toolCall: { name: "read_file", args: { Path: longFile, StartLine: 201, EndLine: 400 } } }, tmpDb).decision,
      "allow"
    );

    const shortFile = path.join(tmpDir, "short_lines.yaml");
    fs.writeFileSync(
      shortFile,
      Array.from({ length: 3000 }, (_, i) => `k_${String(i).padStart(4, "0")}: val_${String(i).padStart(4, "0")}`).join("\n"),
      "utf8"
    );
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "ghost-short", toolCall: { name: "read_file", args: { Path: shortFile } } }, tmpDb).decision,
      "deny"
    );
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "ghost-short", toolCall: { name: "read_file", args: { Path: shortFile, StartLine: 1, EndLine: 440 } } }, tmpDb).decision,
      "allow"
    );
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "ghost-short", toolCall: { name: "read_file", args: { Path: shortFile, StartLine: 1000, EndLine: 1439 } } }, tmpDb).decision,
      "allow"
    );

    const store = new ContextModeStore({ dbPath: tmpDb });
    const longStats = store.getGhostStats("ghost-long");
    assert.equal(longStats.totalBlocked, 1);
    assert.equal(longStats.ghostRecalls, 1, "100% recall of long-line file must be detected");
    const shortStats = store.getGhostStats("ghost-short");
    assert.equal(shortStats.totalBlocked, 1);
    assert.equal(shortStats.ghostRecalls, 0, "31% targeted recall of short-line file must not false-positive");
    store.close();

    // 3. stableSortObject preserves non-plain objects (Date)
    const sampleDate = new Date("2026-01-01T00:00:00.000Z");
    const sortedWithDate = stableSortObject({ z: sampleDate, a: 1 });
    assert.ok(sortedWithDate.z instanceof Date);
    assert.equal(sortedWithDate.z.toISOString(), "2026-01-01T00:00:00.000Z");

    // 4. OUTLINE_SYMBOL_CACHE: Windows case-insensitivity + 129-file LRU eviction
    const lruDir = path.join(tmpDir, "lru129");
    fs.mkdirSync(lruDir, { recursive: true });
    const caseFile = path.join(lruDir, "CaseSample.js");
    const fixedSec = Math.floor(Date.now() / 1000) - 40;
    fs.writeFileSync(caseFile, "export function origAlpha() { return 1; }\n", "utf8");
    fs.utimesSync(caseFile, fixedSec, fixedSec);

    const client = createPersistentMcpClient(path.join(ROOT, "fast", "mcp-server.mjs"));
    try {
      await client.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "lru-129-test", version: "1.0" }
      });
      const o1 = await client.request("tools/call", {
        name: "read_slices",
        arguments: { cwd: lruDir, outlines: ["CaseSample.js"] }
      });
      assert.ok(o1.result.content[0].text.includes("origAlpha"));

      // Overwrite with same size & exact same mtime
      fs.writeFileSync(caseFile, "export function nextOmega() { return 1; }\n", "utf8");
      fs.utimesSync(caseFile, fixedSec, fixedSec);

      if (process.platform === "win32") {
        const oCase = await client.request("tools/call", {
          name: "read_slices",
          arguments: { cwd: lruDir, outlines: ["casesample.js"] }
        });
        assert.ok(
          oCase.result.content[0].text.includes("origAlpha"),
          "Windows different-case path must hit the same LRU entry"
        );
      }

      // Insert 128 distinct files to evict CaseSample.js from the 128-entry LRU
      const batchNames = [];
      for (let i = 0; i < 128; i++) {
        const name = `f_${i}.js`;
        fs.writeFileSync(path.join(lruDir, name), `export function fn_${i}() { return ${i}; }\n`, "utf8");
        batchNames.push(name);
      }
      for (let i = 0; i < batchNames.length; i += 40) {
        await client.request("tools/call", {
          name: "read_slices",
          arguments: { cwd: lruDir, outlines: batchNames.slice(i, i + 40) }
        });
      }

      // CaseSample.js must now be evicted -> re-reading sees nextOmega!
      const oEvicted = await client.request("tools/call", {
        name: "read_slices",
        arguments: { cwd: lruDir, outlines: ["CaseSample.js"] }
      });
      assert.ok(
        oEvicted.result.content[0].text.includes("nextOmega"),
        "129th file must evict oldest LRU entry"
      );

      // 5. run_checks(compact) protects AssertionError / TypeError / failing while stripping pure passing noise
      const edgeFailScript = path.join(tmpDir, "edge-fail.mjs");
      fs.writeFileSync(
        edgeFailScript,
        [
          'console.log("✔ pure passing test one");',
          'console.log("✔ AssertionError: expected true to be false");',
          'console.log("✔ TypeError: Cannot read properties of undefined");',
          'console.log("✓ 10 passing, 2 failing");',
          'console.log("summary footer line");',
          "process.exit(1);"
        ].join("\n"),
        "utf8"
      );
      const rcEdge = await client.request("tools/call", {
        name: "run_checks",
        arguments: {
          cwd: tmpDir,
          outputMode: "compact",
          commands: [{ name: "edge-err", command: `node "${edgeFailScript}"` }]
        }
      });
      const rcText = rcEdge.result.content[0].text;
      assert.ok(!rcText.includes("pure passing test one"), "Pure passing ✔ line must be stripped");
      assert.ok(rcText.includes("AssertionError"), "✔ AssertionError must be protected");
      assert.ok(rcText.includes("TypeError"), "✔ TypeError must be protected");
      assert.ok(rcText.includes("2 failing"), "✓ 10 passing, 2 failing must be protected");
    } finally {
      await client.close();
    }

    // 6. Sidecar /api/cache-diag: live refreshWallClockTtl aging (hot -> warm & hot -> cold) + negative TTL sanitization on cache hit
    const fakeHome = path.join(tmpDir, "fake-home");
    const convHotCold = "live-ttl-hot-cold";
    const convHotWarm = "live-ttl-hot-warm";
    const logDir1 = path.join(fakeHome, ".gemini", "antigravity", "brain", convHotCold, ".system_generated", "logs");
    const logDir2 = path.join(fakeHome, ".gemini", "antigravity", "brain", convHotWarm, ".system_generated", "logs");
    fs.mkdirSync(logDir1, { recursive: true });
    fs.mkdirSync(logDir2, { recursive: true });

    const port = 37920 + Math.floor(Math.random() * 400);
    const serverProc = spawn(process.execPath, [path.join(ROOT, "sidecars", "dashboard", "server.mjs")], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        USERPROFILE: fakeHome,
        HOME: fakeHome,
        AGY_DART_DB_PATH: tmpDb,
        AGY_DART_DISABLE_COMPILE_CACHE: "1",
        SIDECAR_FORCE_HTTP: "1",
        PORT: String(port)
      }
    });

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Sidecar startup timed out")), 5000);
        serverProc.stdout.on("data", (d) => {
          if (d.toString("utf8").includes("listening")) {
            clearTimeout(timer);
            resolve();
          }
        });
        serverProc.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`Sidecar exited prematurely: ${code}`));
        });
      });

      const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      const token = html.match(/<meta name="agy-dart-token" content="([a-f0-9]+)">/i)?.[1];
      assert.ok(token, "Sidecar HTML must inject agy-dart-token meta");
      const authHeaders = { headers: { "X-Agy-Dart-Token": token } };

      // Write transcripts AFTER Sidecar is ready so startup latency cannot distort short TTL windows
      const nowLive = Date.now();
      fs.writeFileSync(
        path.join(logDir1, "transcript.jsonl"),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          step_index: 1,
          created_at: new Date(nowLive).toISOString(),
          model: "unknown-custom-model",
          input_tokens: 10000,
          cache_read_tokens: 130000,
          output_tokens: 200
        }) + "\n",
        "utf8"
      );
      fs.writeFileSync(
        path.join(logDir2, "transcript.jsonl"),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          step_index: 1,
          created_at: new Date(nowLive - 58500).toISOString(),
          model: "unknown-custom-model",
          input_tokens: 10000,
          cache_read_tokens: 130000,
          output_tokens: 200
        }) + "\n",
        "utf8"
      );

      // Negative TTL must sanitize consistently on BOTH cache miss and cache hit
      const neg1 = await (await fetch(`http://127.0.0.1:${port}/api/cache-diag?scope=conversation&conversationId=${convHotCold}&ttl=-5`, authHeaders)).json();
      const neg2 = await (await fetch(`http://127.0.0.1:${port}/api/cache-diag?scope=conversation&conversationId=${convHotCold}&ttl=-5`, authHeaders)).json();
      assert.equal(neg1.transcriptFound, true);
      assert.equal(neg1.cacheTtlSec, 300);
      assert.equal(neg1.cacheTemperature, "hot");
      assert.equal(neg2.cacheTtlSec, 300);
      assert.equal(neg2.cacheTemperature, "hot", "Cached hit with negative ttl must not flip to cold/expired");
      assert.equal(neg2.compactAdvice, "delay_hot_cache");

      // Initial cached reads: both transcripts start HOT
      const short1 = await (await fetch(`http://127.0.0.1:${port}/api/cache-diag?scope=conversation&conversationId=${convHotCold}&ttl=2`, authHeaders)).json();
      assert.equal(short1.cacheTemperature, "hot");
      assert.equal(short1.compactAdvice, "delay_hot_cache");

      const warm1 = await (await fetch(`http://127.0.0.1:${port}/api/cache-diag?scope=conversation&conversationId=${convHotWarm}&ttl=300`, authHeaders)).json();
      assert.equal(warm1.cacheTemperature, "hot");
      assert.equal(warm1.compactAdvice, "delay_hot_cache");

      await new Promise((r) => setTimeout(r, 2300));

      // After 2.3s on unchanged files (pure refreshWallClockTtl cache hits):
      // - convHotCold (ttl=2) transitions hot -> cold & opportunistic_cold_compact
      // - convHotWarm (58.5s + 2.3s > 60s, ttl=300) transitions hot -> warm & keeps delay_hot_cache
      const short2 = await (await fetch(`http://127.0.0.1:${port}/api/cache-diag?scope=conversation&conversationId=${convHotCold}&ttl=2`, authHeaders)).json();
      assert.equal(short2.ttlStatus, "expired");
      assert.equal(short2.cacheTemperature, "cold", "refreshWallClockTtl must age cached entry to cold");
      assert.equal(short2.compactAdvice, "opportunistic_cold_compact");

      const warm2 = await (await fetch(`http://127.0.0.1:${port}/api/cache-diag?scope=conversation&conversationId=${convHotWarm}&ttl=300`, authHeaders)).json();
      assert.equal(warm2.cacheTemperature, "warm", "refreshWallClockTtl must age cached entry from hot to warm");
      assert.equal(warm2.compactAdvice, "delay_hot_cache");
    } finally {
      serverProc.kill("SIGTERM");
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
