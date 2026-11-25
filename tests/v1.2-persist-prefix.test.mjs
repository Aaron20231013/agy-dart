import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  ContextModeStore,
  MAX_OUTLINE_CACHE_DB_ENTRIES,
  MAX_OUTLINE_JSON_BYTES
} from "../context/lib/store.js";
import {
  STATIC_COOP_NOTE,
  assemblePrefixStableStartup,
  isSubagentPayload
} from "../hooks/session-start.mjs";
import { auditPrefixBudget } from "../scripts/prefix-budget.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function writeFileDeep(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function runSessionStart(payload, dbPath, extraEnv = {}) {
  const cleanEnv = { ...process.env };
  delete cleanEnv.AGY_DART_STABLE_PREFIX_ONLY;
  delete cleanEnv.AGY_DART_SUBAGENT_INCLUDE_GIT;
  delete cleanEnv.ANTIGRAVITY_PARENT_CONVERSATION_ID;
  delete cleanEnv.ANTIGRAVITY_SUBAGENT;
  const res = spawnSync(process.execPath, [path.join(ROOT, "hooks", "session-start.mjs")], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...cleanEnv,
      AGY_DART_DB_PATH: dbPath,
      AGY_DART_CONFIG_PATH: path.join(path.dirname(dbPath), "nonexistent-config.json"),
      AGY_DART_DISABLE_COMPILE_CACHE: "1",
      ...extraEnv
    }
  });
  assert.equal(res.status, 0, `session-start failed: ${res.stderr}`);
  const parsed = JSON.parse(res.stdout.trim() || "{}");
  return parsed?.injectSteps?.[0]?.systemMessage?.systemMessage || "";
}

function createPersistentMcpClient(scriptPath, extraEnv = {}) {
  const child = spawn(process.execPath, [scriptPath], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, AGY_DART_DISABLE_COMPILE_CACHE: "1", ...extraEnv }
  });
  let buf = "";
  let stderr = "";
  let nextId = 1;
  const pending = new Map();
  let exitCode = null;
  let closed = false;

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
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

  child.on("close", (code) => {
    closed = true;
    exitCode = code;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error(`MCP server exited unexpectedly with code ${code}; stderr=${stderr}`));
    }
    pending.clear();
  });

  return {
    getStderr() {
      return stderr;
    },
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP request timed out: ${method} (id=${id}); stderr=${stderr}`));
        }, 10000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    close() {
      if (closed) return Promise.resolve({ code: exitCode, stderr });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
          reject(new Error("MCP server hung on stdin EOF (did not close cleanly)"));
        }, 4000);
        child.once("close", (code) => {
          clearTimeout(timer);
          resolve({ code, stderr });
        });
        child.stdin.end();
      });
    }
  };
}

test("P1-5A: isSubagentPayload and assemblePrefixStableStartup(omitVolatileGit) unit behavior", () => {
  // Normal primary session payloads
  assert.equal(isSubagentPayload({ cwd: "/repo", conversationId: "c1" }, {}), false);
  assert.equal(isSubagentPayload({ cwd: "/repo", rootConversationId: "c1", conversationId: "c1" }, {}), false);
  assert.equal(isSubagentPayload({ role: "coordinator" }, {}), false);
  assert.equal(isSubagentPayload({ agentType: "primary" }, {}), false);
  assert.equal(isSubagentPayload({ role: "networker" }, {}), false);
  assert.equal(isSubagentPayload(null, {}), false);

  // Subagent / swarm worker detection paths
  assert.equal(isSubagentPayload({ subagent: true }, {}), true);
  assert.equal(isSubagentPayload({ isSubagent: true }, {}), true);
  assert.equal(isSubagentPayload({ is_subagent: true }, {}), true);
  assert.equal(isSubagentPayload({ parentConversationId: "parent-1" }, {}), true);
  assert.equal(isSubagentPayload({ parent_conversation_id: "parent-2" }, {}), true);
  assert.equal(isSubagentPayload({ rootConversationId: "root-1", conversationId: "child-2" }, {}), true);
  assert.equal(isSubagentPayload({ root_conversation_id: "root-1", conversation_id: "child-2" }, {}), true);
  assert.equal(isSubagentPayload({}, { ANTIGRAVITY_PARENT_CONVERSATION_ID: "parent-env-1" }), true);
  assert.equal(isSubagentPayload({}, { ANTIGRAVITY_SUBAGENT: "1" }), true);
  assert.equal(isSubagentPayload({ role: "subagent" }, {}), true);
  assert.equal(isSubagentPayload({ agentType: "swarm-worker" }, {}), true);
  assert.equal(isSubagentPayload({ agent_type: "research" }, {}), true);
  assert.equal(isSubagentPayload({ role: "verifier-3" }, {}), true);

  // assemblePrefixStableStartup backward-compatible 2-arg call vs omitVolatileGit: true
  const sampleSnapshot = [
    "[agy-dart startup snapshot] Workspace: /demo",
    "Git: branch `main`",
    "Working tree: clean",
    "Modified (2): M src/a.js, M src/b.js",
    "Recent commits:",
    "  - abc1234 feat: initial commit",
    "  - def5678 fix: bug fix",
    "Project:",
    "  - package.json (demo) scripts: test",
    "Layout (2 levels):",
    "  src/ (a.js, b.js)",
    "  package.json"
  ].join("\n");
  const hubs = "Core hubs (2 src files): src/a.js (1)";

  const fullDefault = assemblePrefixStableStartup(sampleSnapshot, hubs);
  assert.ok(fullDefault.startsWith(STATIC_COOP_NOTE));
  assert.ok(fullDefault.includes("Git: branch `main`"));
  assert.ok(fullDefault.includes("Recent commits:"));
  assert.ok(fullDefault.includes("abc1234"));

  const stableOnly = assemblePrefixStableStartup(sampleSnapshot, hubs, { omitVolatileGit: true });
  assert.ok(stableOnly.startsWith(STATIC_COOP_NOTE));
  assert.ok(stableOnly.includes("[agy-dart startup snapshot] Workspace: /demo"));
  assert.ok(stableOnly.includes("Project:\n  - package.json (demo) scripts: test"));
  assert.ok(stableOnly.includes("Layout (2 levels):\n  src/ (a.js, b.js)\n  package.json"));
  assert.ok(stableOnly.includes(hubs));
  assert.ok(!stableOnly.includes("Git:"));
  assert.ok(!stableOnly.includes("Working tree:"));
  assert.ok(!stableOnly.includes("Modified ("));
  assert.ok(!stableOnly.includes("Recent commits:"));
  assert.ok(!stableOnly.includes("abc1234"));
  assert.ok(fullDefault.startsWith(stableOnly + "\n"), "Stable-only output must be an exact prefix of default startup");
});

test("P1-5B: SessionStart stable-prefix-only & subagent payloads stay byte-identical across edits and new commits", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-stable-prefix-"));
  const repoDir = path.join(tmpDir, "repo");
  const tmpDb = path.join(tmpDir, "context.db");
  fs.mkdirSync(repoDir, { recursive: true });

  const git = (args) => {
    const r = spawnSync("git", args, {
      cwd: repoDir,
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test Author",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test Author",
        GIT_COMMITTER_EMAIL: "test@example.com"
      }
    });
    assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout;
  };

  try {
    git(["init"]);
    writeFileDeep(path.join(repoDir, "package.json"), JSON.stringify({ name: "prefix-demo", scripts: { test: "node --test" } }, null, 2));
    writeFileDeep(path.join(repoDir, "src", "core.js"), "export function compute(x) { return x + 1; }\n");
    writeFileDeep(path.join(repoDir, "src", "app.js"), 'import { compute } from "./core.js";\nexport const v = compute(1);\n');
    writeFileDeep(path.join(repoDir, "src", "cli.js"), 'import { compute } from "./core.js";\nexport const run = () => compute(2);\n');
    git(["add", "."]);
    git(["commit", "-m", "initial commit"]);

    const basePayload = { cwd: repoDir, workspacePaths: [repoDir], hookEventName: "SessionStart" };

    // 1. Clean repo baseline
    const normalClean = runSessionStart(basePayload, tmpDb);
    assert.ok(normalClean.includes("Git: branch"));
    assert.ok(normalClean.includes("Working tree: clean"));
    assert.ok(normalClean.includes("Recent commits:"));

    const stableEnvClean = runSessionStart(basePayload, tmpDb, { AGY_DART_STABLE_PREFIX_ONLY: "1" });
    assert.ok(!stableEnvClean.includes("Git:"));
    assert.ok(!stableEnvClean.includes("Working tree:"));
    assert.ok(!stableEnvClean.includes("Recent commits:"));
    assert.ok(stableEnvClean.includes("Core hubs (3 src files): src/core.js (2)"));
    assert.ok(normalClean.startsWith(stableEnvClean + "\n"), "Normal startup must share exact stable prefix");

    // Multiple subagent payloads match AGY_DART_STABLE_PREFIX_ONLY=1 byte-for-byte
    const subPayloads = [
      { ...basePayload, subagent: true },
      { ...basePayload, parentConversationId: "parent-001", conversationId: "child-001" },
      { ...basePayload, rootConversationId: "root-001", conversationId: "child-002" },
      { ...basePayload, agentType: "verifier" }
    ];
    for (const sp of subPayloads) {
      assert.equal(runSessionStart(sp, tmpDb), stableEnvClean);
    }
    const subByEnv = runSessionStart(basePayload, tmpDb, { ANTIGRAVITY_PARENT_CONVERSATION_ID: "parent-env-99" });
    assert.equal(subByEnv, stableEnvClean);

    // 2. Edit tracked file (dirty working tree)
    writeFileDeep(
      path.join(repoDir, "src", "app.js"),
      'import { compute } from "./core.js";\nexport const v = compute(42);\n// dirty edit\n'
    );
    const normalDirty = runSessionStart(basePayload, tmpDb);
    assert.notEqual(normalDirty, normalClean, "Normal startup should reflect dirty git status");
    assert.ok(normalDirty.includes("Modified (1):"));

    const stableEnvDirty = runSessionStart(basePayload, tmpDb, { AGY_DART_STABLE_PREFIX_ONLY: "1" });
    const subDirty = runSessionStart({ ...basePayload, parentConversationId: "parent-001" }, tmpDb);
    assert.equal(stableEnvDirty, stableEnvClean, "AGY_DART_STABLE_PREFIX_ONLY=1 must stay byte-identical after file edit");
    assert.equal(subDirty, stableEnvClean, "Subagent SessionStart must stay byte-identical after file edit");

    // 3. Make a new commit (changes HEAD SHA & Recent commits)
    git(["add", "."]);
    git(["commit", "-m", "second commit changing git log"]);
    const normalCommit2 = runSessionStart(basePayload, tmpDb);
    assert.notEqual(normalCommit2, normalClean, "Normal startup should reflect new commit");
    assert.ok(normalCommit2.includes("second commit changing git log"));

    const stableEnvCommit2 = runSessionStart(basePayload, tmpDb, { AGY_DART_STABLE_PREFIX_ONLY: "1" });
    const subCommit2 = runSessionStart({ ...basePayload, subagent: true }, tmpDb);
    assert.equal(stableEnvCommit2, stableEnvClean, "AGY_DART_STABLE_PREFIX_ONLY=1 must stay byte-identical after new commit");
    assert.equal(subCommit2, stableEnvClean, "Subagent SessionStart must stay byte-identical after new commit");

    // 4. Opt-in escape hatch AGY_DART_SUBAGENT_INCLUDE_GIT=1 restores git tail for subagents
    const subWithGit = runSessionStart(
      { ...basePayload, subagent: true, parentConversationId: "parent-001" },
      tmpDb,
      { AGY_DART_SUBAGENT_INCLUDE_GIT: "1" }
    );
    assert.equal(subWithGit, normalCommit2, "AGY_DART_SUBAGENT_INCLUDE_GIT=1 must restore git tail for subagents");

    // 5. Large repo (>1500-char snapshot): volatile gitSummary must NOT steal Layout budget in stable-prefix-only mode!
    const largeRepoDir = path.join(tmpDir, "large-repo");
    fs.mkdirSync(largeRepoDir, { recursive: true });
    const gitLarge = (args) => {
      const r = spawnSync("git", args, {
        cwd: largeRepoDir,
        encoding: "utf8",
        windowsHide: true,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Test Author",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "Test Author",
          GIT_COMMITTER_EMAIL: "test@example.com"
        }
      });
      assert.equal(r.status, 0, `gitLarge ${args.join(" ")} failed: ${r.stderr}`);
      return r.stdout;
    };
    gitLarge(["init"]);
    writeFileDeep(
      path.join(largeRepoDir, "package.json"),
      JSON.stringify({ name: "large-prefix-demo", scripts: { test: "node --test", build: "node build.js" } }, null, 2)
    );
    for (let d = 0; d < 14; d++) {
      const dirName = `module_${String(d).padStart(2, "0")}_feature`;
      for (let f = 0; f < 5; f++) {
        writeFileDeep(
          path.join(largeRepoDir, dirName, `component_${f}_impl.js`),
          `export const v_${d}_${f} = ${d * 10 + f};\n`
        );
      }
    }
    gitLarge(["add", "."]);
    gitLarge(["commit", "-m", "initial large repo snapshot"]);

    const largePayload = { cwd: largeRepoDir, workspacePaths: [largeRepoDir], hookEventName: "SessionStart" };
    const largeCleanStable = runSessionStart(largePayload, tmpDb, { AGY_DART_STABLE_PREFIX_ONLY: "1" });
    const largeCleanSub = runSessionStart({ ...largePayload, subagent: true }, tmpDb);
    assert.equal(largeCleanSub, largeCleanStable);
    assert.ok(!largeCleanStable.includes("Git:"));
    assert.ok(largeCleanStable.includes("Layout (top level):"));
    assert.ok(!largeCleanStable.includes("component_0_impl.js"), "Start with a directory map; discover child files on demand");

    // Modify 6 tracked files across subdirectories so gitSummary would normally grow by >250 chars
    for (let d = 0; d < 6; d++) {
      const dirName = `module_${String(d).padStart(2, "0")}_feature`;
      writeFileDeep(
        path.join(largeRepoDir, dirName, "component_0_impl.js"),
        `export const v_${d}_0 = ${d * 100 + 999};\n// modified tracked file ${d}\n`
      );
    }
    const largeDirtyStable = runSessionStart(largePayload, tmpDb, { AGY_DART_STABLE_PREFIX_ONLY: "1" });
    const largeDirtySub = runSessionStart({ ...largePayload, parentConversationId: "p-large" }, tmpDb);
    assert.equal(
      largeDirtyStable,
      largeCleanStable,
      "Large repo (>1500 chars) AGY_DART_STABLE_PREFIX_ONLY=1 must stay byte-identical after editing 6 tracked files"
    );
    assert.equal(
      largeDirtySub,
      largeCleanStable,
      "Large repo (>1500 chars) subagent SessionStart must stay byte-identical after editing 6 tracked files"
    );

    gitLarge(["add", "."]);
    gitLarge(["commit", "-m", "second large repo commit with a longer subject line"]);
    const largeCommit2Stable = runSessionStart(largePayload, tmpDb, { AGY_DART_STABLE_PREFIX_ONLY: "1" });
    assert.equal(
      largeCommit2Stable,
      largeCleanStable,
      "Large repo (>1500 chars) AGY_DART_STABLE_PREFIX_ONLY=1 must stay byte-identical after new commit"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("P1-5C: prefix-budget.mjs --stable-only --json reports volatileBytes===0 & stablePct===100 with intact schema", async () => {
  const cleanEnv = {
    ...process.env,
    AGY_DART_CONFIG_PATH: path.join(os.tmpdir(), `agy-dart-nonexistent-config-${process.pid}.json`),
    AGY_DART_DISABLE_COMPILE_CACHE: "1"
  };
  delete cleanEnv.AGY_DART_STABLE_PREFIX_ONLY;

  const defCli = spawnSync(process.execPath, [path.join(ROOT, "scripts", "prefix-budget.mjs"), "--json"], {
    encoding: "utf8",
    windowsHide: true,
    env: cleanEnv
  });
  assert.equal(defCli.status, 0, defCli.stderr);
  assert.equal(defCli.stderr, "");
  const defReport = JSON.parse(defCli.stdout);

  const stableCli = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "prefix-budget.mjs"), "--stable-only", "--json"],
    { encoding: "utf8", windowsHide: true, env: cleanEnv }
  );
  assert.equal(stableCli.status, 0, stableCli.stderr);
  assert.equal(stableCli.stderr, "");
  const stableReport = JSON.parse(stableCli.stdout);

  // Existing top-level & block fields preserved
  assert.equal(defReport.budgetLimitTokens, 4000);
  assert.equal(stableReport.budgetLimitTokens, 4000);
  assert.equal(defReport.stablePrefixOnly, false);
  assert.equal(stableReport.stablePrefixOnly, true);
  assert.equal(stableReport.toolsFingerprint, defReport.toolsFingerprint);
  assert.equal(stableReport.blocks.tools.canonical, true);

  // Stable-only invariants
  assert.equal(stableReport.blocks.startup.volatileBytes, 0);
  assert.equal(stableReport.blocks.startup.volatilePct, 0);
  assert.equal(stableReport.blocks.startup.stablePct, 100);
  assert.equal(stableReport.blocks.startup.stableSha256, stableReport.blocks.startup.fullSha256);
  assert.equal(stableReport.totalTokens, stableReport.stableOnlyTokens);
  assert.equal(defReport.stableOnlyTokens, stableReport.stableOnlyTokens);
  assert.equal(defReport.blocks.startup.stableSha256, stableReport.blocks.startup.fullSha256);

  // Programmatic auditPrefixBudget + human-readable CLI mode
  const apiStable = await auditPrefixBudget(ROOT, { stableOnly: true });
  assert.equal(apiStable.stablePrefixOnly, true);
  assert.equal(apiStable.blocks.startup.volatileBytes, 0);
  assert.equal(apiStable.blocks.startup.stablePct, 100);

  const humanCli = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "prefix-budget.mjs"), "--stable-only"],
    { encoding: "utf8", windowsHide: true, env: cleanEnv }
  );
  assert.equal(humanCli.status, 0, humanCli.stderr);
  assert.ok(humanCli.stdout.includes("[stable-only]"));
  assert.ok(humanCli.stdout.includes(`stable-only: ${stableReport.stableOnlyTokens} tok`));
});

test("P1-8A: store.js outline_cache schema upgrade, CRUD, (mtimeMs, size) mismatch, 512 LRU, 128KB cap, TTL, purge & doctor", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-outline-store-"));
  const tmpDb = path.join(tmpDir, "context.db");

  try {
    // 1. Legacy v3 DB upgrades idempotently while keeping schema_version = '3'
    const legacy = new DatabaseSync(tmpDb);
    legacy.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta(key, value) VALUES ('schema_version', '3');
    `);
    legacy.close();

    const store = new ContextModeStore({ dbPath: tmpDb });
    store.open();
    assert.equal(store.getMeta("schema_version"), "3");
    const tableRow = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'outline_cache'")
      .get();
    assert.ok(tableRow, "outline_cache table must be created idempotently");
    const idxRow = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_outline_cache_updated'")
      .get();
    assert.ok(idxRow, "idx_outline_cache_updated index must exist");

    // 2. CRUD & ±1ms mtime tolerance & mismatch rejection
    const fileA = path.join(tmpDir, "src", "alpha.js");
    const sampleSymbols = [
      { kind: "function", name: "alphaInit", startLine: 1, endLine: 10, depth: 0 },
      { kind: "class", name: "AlphaRunner", startLine: 12, endLine: 40, depth: 0 }
    ];
    assert.equal(store.setOutlineCache(fileA, 1700000000100.2, 1024, 42, sampleSymbols), true);

    const exactHit = store.getOutlineCache(fileA, 1700000000100.2, 1024);
    assert.deepEqual(exactHit, { lineCount: 42, symbols: sampleSymbols });

    const subMsHit = store.getOutlineCache(fileA, 1700000000101.0, 1024);
    assert.deepEqual(subMsHit, { lineCount: 42, symbols: sampleSymbols });

    assert.equal(store.getOutlineCache(fileA, 1700000000102.5, 1024), null, "mtime diff > 1ms must miss");
    assert.equal(store.getOutlineCache(fileA, 1700000000100.2, 1025), null, "fileSize mismatch must miss");
    assert.equal(store.doctor().cachedOutlines, 1);

    // 3. > 128 KB serialized JSON must be skipped
    const hugeSymbols = Array.from({ length: 3000 }, (_, i) => ({
      kind: "function",
      name: `symbol_${i}_${"x".repeat(45)}`,
      startLine: i + 1,
      endLine: i + 2,
      depth: 0
    }));
    assert.ok(Buffer.byteLength(JSON.stringify(hugeSymbols), "utf8") > MAX_OUTLINE_JSON_BYTES);
    assert.equal(store.setOutlineCache(path.join(tmpDir, "huge.js"), 1000, 999999, 3000, hugeSymbols), false);
    assert.equal(store.doctor().cachedOutlines, 1);

    // 4. deleteOutlineCache(filePath) & deleteOutlineCache(null)
    assert.equal(store.deleteOutlineCache(fileA), 1);
    assert.equal(store.getOutlineCache(fileA, 1700000000100.2, 1024), null);
    assert.equal(store.doctor().cachedOutlines, 0);

    // 5. 512-entry LRU eviction bound (touched oldest entry survives!)
    assert.equal(MAX_OUTLINE_CACHE_DB_ENTRIES, 512);
    const baseTs = 1000000;
    for (let i = 0; i < MAX_OUTLINE_CACHE_DB_ENTRIES; i++) {
      const p = path.join(tmpDir, `lru_${i}.js`);
      store.setOutlineCache(p, 5000, 100 + i, 10, [{ kind: "function", name: `fn_${i}`, startLine: 1, endLine: 5, depth: 0 }]);
      store.db
        .prepare("UPDATE outline_cache SET updated_ts = ? WHERE file_path = ?")
        .run(baseTs + i, store._normalizeTrackPath(p));
    }
    assert.equal(store.doctor().cachedOutlines, 512);

    // Touch lru_0 so its updated_ts jumps to Date.now() (most recent)
    const touched0 = store.getOutlineCache(path.join(tmpDir, "lru_0.js"), 5000, 100);
    assert.ok(touched0 && touched0.symbols[0].name === "fn_0");

    // Insert 5 more entries -> lru_1..lru_5 must be evicted while lru_0 & lru_512..516 survive!
    for (let i = 512; i < 517; i++) {
      const p = path.join(tmpDir, `lru_${i}.js`);
      store.setOutlineCache(p, 5000, 100 + i, 10, [{ kind: "function", name: `fn_${i}`, startLine: 1, endLine: 5, depth: 0 }]);
    }
    assert.equal(store.doctor().cachedOutlines, 512, "outline_cache must stay bounded to 512 entries");
    assert.ok(store.getOutlineCache(path.join(tmpDir, "lru_0.js"), 5000, 100), "Recently read lru_0 must survive LRU eviction");
    assert.equal(store.getOutlineCache(path.join(tmpDir, "lru_1.js"), 5000, 101), null, "Oldest untouched lru_1 must be evicted");
    assert.equal(store.getOutlineCache(path.join(tmpDir, "lru_5.js"), 5000, 105), null, "Oldest untouched lru_5 must be evicted");
    assert.ok(store.getOutlineCache(path.join(tmpDir, "lru_6.js"), 5000, 106), "lru_6 should remain");
    assert.ok(store.getOutlineCache(path.join(tmpDir, "lru_516.js"), 5000, 616), "Newest lru_516 should remain");

    // 6. TTL pruning (pruneByTtl & purge stale prune >14d entries, keep fresh entries)
    store.deleteOutlineCache(null);
    const freshFile = path.join(tmpDir, "fresh.js");
    const staleFile = path.join(tmpDir, "stale.js");
    store.setOutlineCache(freshFile, 1000, 200, 10, [{ kind: "function", name: "freshFn", startLine: 1, endLine: 3, depth: 0 }]);
    store.setOutlineCache(staleFile, 1000, 200, 10, [{ kind: "function", name: "staleFn", startLine: 1, endLine: 3, depth: 0 }]);
    const fifteenDaysAgo = Date.now() - 15 * 24 * 3600 * 1000;
    store.db
      .prepare("UPDATE outline_cache SET updated_ts = ? WHERE file_path = ?")
      .run(fifteenDaysAgo, store._normalizeTrackPath(staleFile));

    const pruned = store.purge({ scope: "stale", olderThanDays: 14, vacuum: false });
    assert.equal(pruned.deletedOutlineCache, 1);
    assert.equal(store.getOutlineCache(staleFile, 1000, 200), null);
    assert.ok(store.getOutlineCache(freshFile, 1000, 200));

    // 7. purge({ scope: "all" }) clears outline_cache
    store.purge({ scope: "all" });
    assert.equal(store.doctor().cachedOutlines, 0);

    store.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("P1-8B: Cross-process L2 SQLite outline cache hits in fresh MCP process #2, invalidates on apply_edits, and stays 0-stderr & fail-open", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-l2-outline-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const disabledDb = path.join(tmpDir, "disabled.db");
  const modFile = path.join(tmpDir, "service.js");
  const serverPath = path.join(ROOT, "fast", "mcp-server.mjs");

  const srcV1 = [
    "export function alphaService() {",
    "  return 1;",
    "}",
    "export function betaService() {",
    "  return 2;",
    "}",
    ""
  ].join("\n");
  const fixedSec = Math.floor(Date.now() / 1000) - 30;
  fs.writeFileSync(modFile, srcV1, "utf8");
  fs.utimesSync(modFile, fixedSec, fixedSec);
  const origSize = fs.statSync(modFile).size;

  try {
    // 1. Process #1: cold miss parses file and populates SQLite L2 outline_cache
    const c1 = createPersistentMcpClient(serverPath, { AGY_DART_DB_PATH: tmpDb });
    let toolsList1;
    let outline1;
    try {
      await c1.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "l2-p1", version: "1.0" }
      });
      toolsList1 = JSON.stringify((await c1.request("tools/list", {})).result.tools);
      const r1 = await c1.request("tools/call", {
        name: "read_slices",
        arguments: { cwd: tmpDir, outlines: ["service.js"] }
      });
      outline1 = r1.result.content[0].text;
      assert.ok(outline1.includes("alphaService"));
      assert.ok(outline1.includes("betaService"));
    } finally {
      const closed1 = await c1.close();
      assert.equal(closed1.code, 0);
      assert.equal(closed1.stderr, "", "Process #1 must emit 0 bytes on stderr");
    }

    // Verify L2 DB now stores the outline row
    const inspectStore = new ContextModeStore({ dbPath: tmpDb });
    assert.equal(inspectStore.doctor().cachedOutlines, 1);
    inspectStore.close();

    // 2. Prove TRUE cross-process L2 SQLite hit: overwrite disk with exact same byte size & mtime!
    const srcSameLen = srcV1.replace("alphaService", "gammaService");
    assert.equal(Buffer.byteLength(srcSameLen, "utf8"), origSize);
    fs.writeFileSync(modFile, srcSameLen, "utf8");
    fs.utimesSync(modFile, fixedSec, fixedSec);

    // Spawn brand-new MCP Process #2 (empty L1 in-memory cache!)
    const c2 = createPersistentMcpClient(serverPath, { AGY_DART_DB_PATH: tmpDb });
    try {
      await c2.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "l2-p2", version: "1.0" }
      });
      const toolsList2 = JSON.stringify((await c2.request("tools/list", {})).result.tools);
      assert.equal(toolsList2, toolsList1, "tools/list must stay 100% deterministic across processes");

      const r2 = await c2.request("tools/call", {
        name: "read_slices",
        arguments: { cwd: tmpDir, outlines: ["service.js"] }
      });
      assert.equal(
        r2.result.content[0].text,
        outline1,
        "Fresh Process #2 must hit L2 SQLite outline_cache and skip reading/parsing disk"
      );

      // 3. apply_edits MUST invalidate BOTH L1 and L2 SQLite outline_cache!
      const editRes = await c2.request("tools/call", {
        name: "apply_edits",
        arguments: {
          cwd: tmpDir,
          edits: [
            {
              path: "service.js",
              hunks: [{ target: "gammaService", replacement: "deltaService" }]
            }
          ]
        }
      });
      assert.equal(editRes.result.isError, false, editRes.result.content[0].text);

      // Verify SQLite L2 row was immediately deleted on apply_edits
      const afterEditStore = new ContextModeStore({ dbPath: tmpDb });
      assert.equal(afterEditStore.doctor().cachedOutlines, 0, "apply_edits must delete affected path from L2 outline_cache");
      afterEditStore.close();

      // Subsequent outline re-parses updated deltaService and re-populates L2
      const r3 = await c2.request("tools/call", {
        name: "read_slices",
        arguments: { cwd: tmpDir, outlines: ["service.js"] }
      });
      const outline3 = r3.result.content[0].text;
      assert.ok(outline3.includes("deltaService"), `Expected deltaService after apply_edits, got:\n${outline3}`);
      assert.ok(!outline3.includes("alphaService"));
    } finally {
      const closed2 = await c2.close();
      assert.equal(closed2.code, 0);
      assert.equal(closed2.stderr, "", "Process #2 must emit 0 bytes on stderr");
    }

    // 4. Fresh Process #3 calling apply_edits BEFORE any outline must ALSO invalidate existing L2 row!
    const preEditStore = new ContextModeStore({ dbPath: tmpDb });
    assert.equal(preEditStore.doctor().cachedOutlines, 1);
    preEditStore.close();

    const c3 = createPersistentMcpClient(serverPath, { AGY_DART_DB_PATH: tmpDb });
    try {
      await c3.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "l2-p3", version: "1.0" }
      });
      const editRes3 = await c3.request("tools/call", {
        name: "apply_edits",
        arguments: {
          cwd: tmpDir,
          edits: [
            {
              path: "service.js",
              hunks: [{ target: "deltaService", replacement: "omegaService" }]
            }
          ]
        }
      });
      assert.equal(editRes3.result.isError, false);
    } finally {
      const closed3 = await c3.close();
      assert.equal(closed3.code, 0);
      assert.equal(closed3.stderr, "");
    }

    const postP3Store = new ContextModeStore({ dbPath: tmpDb });
    assert.equal(postP3Store.doctor().cachedOutlines, 0, "apply_edits in fresh process must still clear L2 outline_cache");
    postP3Store.close();

    // 5. AGY_DART_DISABLE_OUTLINE_DB=1 opt-out skips creating DB cleanly
    const cOff = createPersistentMcpClient(serverPath, {
      AGY_DART_DB_PATH: disabledDb,
      AGY_DART_DISABLE_OUTLINE_DB: "1"
    });
    try {
      await cOff.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "l2-off", version: "1.0" }
      });
      const rOff = await cOff.request("tools/call", {
        name: "read_slices",
        arguments: { cwd: tmpDir, outlines: ["service.js"] }
      });
      assert.ok(rOff.result.content[0].text.includes("omegaService"));
    } finally {
      const closedOff = await cOff.close();
      assert.equal(closedOff.code, 0);
      assert.equal(closedOff.stderr, "");
    }
    assert.equal(fs.existsSync(disabledDb), false, "AGY_DART_DISABLE_OUTLINE_DB=1 must not create SQLite DB");

    // 6. Fail-open when AGY_DART_DB_PATH points to an unwritable directory path (0 stderr, outline still works)
    const cFailOpen = createPersistentMcpClient(serverPath, { AGY_DART_DB_PATH: tmpDir });
    try {
      await cFailOpen.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "l2-failopen", version: "1.0" }
      });
      const rFo = await cFailOpen.request("tools/call", {
        name: "read_slices",
        arguments: { cwd: tmpDir, outlines: ["service.js"] }
      });
      assert.equal(rFo.result.isError, false);
      assert.ok(rFo.result.content[0].text.includes("omegaService"));
    } finally {
      const closedFo = await cFailOpen.close();
      assert.equal(closedFo.code, 0);
      assert.equal(closedFo.stderr, "");
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("P1-8C: batch_search short-TTL worktree-fingerprinted cache hits on repeat, invalidates on apply_edits / external edit / TTL, and respects TTL=0 opt-out", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-search-cache-"));
  const srcDir = path.join(tmpDir, "src");
  const svcFile = path.join(srcDir, "service.js");
  const serverPath = path.join(ROOT, "fast", "mcp-server.mjs");

  const v1Content = 'export const TOKEN = "NEEDLE_ALPHA_1111";\n';
  const v1SameLen = 'export const TOKEN = "NEEDLE_OMEGA_9999";\n';
  assert.equal(Buffer.byteLength(v1Content, "utf8"), Buffer.byteLength(v1SameLen, "utf8"));

  const fixedSec = Math.floor(Date.now() / 1000) - 20;
  writeFileDeep(svcFile, v1Content);
  fs.utimesSync(svcFile, fixedSec, fixedSec);
  fs.utimesSync(srcDir, fixedSec, fixedSec);
  fs.utimesSync(tmpDir, fixedSec, fixedSec);

  try {
    // 1. Default 15s TTL: cache hit, canonical query key order, apply_edits invalidation, external edit invalidation
    const client = createPersistentMcpClient(serverPath, { AGY_DART_DISABLE_OUTLINE_DB: "1", AGY_DART_DB_PATH: path.join(tmpDir, "search-cache.db") });
    try {
      await client.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "search-cache-test", version: "1.0" }
      });

      // Cold query
      const q1 = await client.request("tools/call", {
        name: "batch_search",
        arguments: {
          cwd: tmpDir,
          queries: [{ type: "text", pattern: "NEEDLE_ALPHA_1111" }]
        }
      });
      const text1 = q1.result.content[0].text;
      assert.ok(text1.includes("NEEDLE_ALPHA_1111"));
      assert.ok(Buffer.byteLength(text1, "utf8") <= 8800);

      // Overwrite disk with exact same byte length & restored mtimes to prove true in-memory cache hit
      fs.writeFileSync(svcFile, v1SameLen, "utf8");
      fs.utimesSync(svcFile, fixedSec, fixedSec);
      fs.utimesSync(srcDir, fixedSec, fixedSec);
      fs.utimesSync(tmpDir, fixedSec, fixedSec);

      // Identical query with reordered keys must still hit cache and return cached text1
      const q2 = await client.request("tools/call", {
        name: "batch_search",
        arguments: {
          cwd: tmpDir,
          queries: [{ pattern: "NEEDLE_ALPHA_1111", type: "text" }]
        }
      });
      assert.equal(q2.result.content[0].text, text1, "Repeated identical batch_search within TTL must hit L1 cache");

      // apply_edits MUST clear batch_search cache immediately even for same-length replacement!
      const ae = await client.request("tools/call", {
        name: "apply_edits",
        arguments: {
          cwd: tmpDir,
          edits: [
            {
              path: "src/service.js",
              hunks: [{ target: "NEEDLE_OMEGA_9999", replacement: "NEEDLE_BETA_22222" }]
            }
          ]
        }
      });
      assert.equal(ae.result.isError, false, ae.result.content[0].text);

      const qAfterApply = await client.request("tools/call", {
        name: "batch_search",
        arguments: {
          cwd: tmpDir,
          queries: [{ type: "text", pattern: "NEEDLE_ALPHA_1111" }]
        }
      });
      assert.ok(
        qAfterApply.result.content[0].text.includes("(no matches)"),
        `apply_edits must immediately invalidate batch_search cache; got:\n${qAfterApply.result.content[0].text}`
      );

      // Populate cache with NEEDLE_BETA_22222 match
      const qBeta = await client.request("tools/call", {
        name: "batch_search",
        arguments: {
          cwd: tmpDir,
          queries: [{ type: "text", pattern: "NEEDLE_BETA_22222" }]
        }
      });
      assert.ok(qBeta.result.content[0].text.includes("NEEDLE_BETA_22222"));

      // External file modification on matched file (normal write with new size & bumped mtime) -> immediate invalidation!
      const bumpedSec1 = Math.floor(Date.now() / 1000) + 5;
      fs.writeFileSync(svcFile, 'export const TOKEN = "NEEDLE_GAMMA_33333_UPDATED";\n', "utf8");
      fs.utimesSync(svcFile, bumpedSec1, bumpedSec1);

      const qAfterExtMatched = await client.request("tools/call", {
        name: "batch_search",
        arguments: {
          cwd: tmpDir,
          queries: [{ type: "text", pattern: "NEEDLE_BETA_22222" }]
        }
      });
      assert.ok(
        qAfterExtMatched.result.content[0].text.includes("(no matches)"),
        "External edit to matched file must immediately invalidate batch_search cache"
      );

      // External file modification turning a 0-match query into a match -> immediate invalidation!
      const qZero = await client.request("tools/call", {
        name: "batch_search",
        arguments: {
          cwd: tmpDir,
          queries: [{ type: "text", pattern: "NEEDLE_DELTA_4444" }]
        }
      });
      assert.ok(qZero.result.content[0].text.includes("(no matches)"));

      const bumpedSec2 = bumpedSec1 + 5;
      fs.writeFileSync(svcFile, 'export const TOKEN = "NEEDLE_DELTA_4444";\n', "utf8");
      fs.utimesSync(svcFile, bumpedSec2, bumpedSec2);

      const qAfterExtZero = await client.request("tools/call", {
        name: "batch_search",
        arguments: {
          cwd: tmpDir,
          queries: [{ type: "text", pattern: "NEEDLE_DELTA_4444" }]
        }
      });
      assert.ok(
        qAfterExtZero.result.content[0].text.includes("src/service.js"),
        `External edit adding new match must invalidate 0-match cache; got:\n${qAfterExtZero.result.content[0].text}`
      );

      // New file creation in baseCwd changes directory mtime -> immediate invalidation!
      writeFileDeep(path.join(tmpDir, "extra.js"), 'export const EXTRA = "NEEDLE_DELTA_4444";\n');
      const bumpedDirSec = bumpedSec2 + 5;
      fs.utimesSync(tmpDir, bumpedDirSec, bumpedDirSec);

      const qAfterNewFile = await client.request("tools/call", {
        name: "batch_search",
        arguments: {
          cwd: tmpDir,
          queries: [{ type: "text", pattern: "NEEDLE_DELTA_4444" }]
        }
      });
      assert.ok(qAfterNewFile.result.content[0].text.includes("extra.js"));
      assert.ok(qAfterNewFile.result.content[0].text.includes("src/service.js"));
    } finally {
      const closed = await client.close();
      assert.equal(closed.code, 0);
      assert.equal(closed.stderr, "");
    }

    // 2. Short TTL expiry (AGY_DART_SEARCH_CACHE_TTL_MS=90)
    const expFile = path.join(tmpDir, "ttl.js");
    const ttlV1 = 'export const TTL_VAL = "TTL_AAA_111";\n';
    const ttlV2 = 'export const TTL_VAL = "TTL_BBB_222";\n';
    fs.writeFileSync(expFile, ttlV1, "utf8");
    fs.utimesSync(expFile, fixedSec, fixedSec);
    fs.utimesSync(tmpDir, fixedSec, fixedSec);

    const cTtl = createPersistentMcpClient(serverPath, {
      AGY_DART_DISABLE_OUTLINE_DB: "1",
      AGY_DART_DB_PATH: path.join(tmpDir, "search-ttl.db"),
      AGY_DART_SEARCH_CACHE_TTL_MS: "90"
    });
    try {
      await cTtl.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "search-ttl-test", version: "1.0" }
      });
      const r1 = await cTtl.request("tools/call", {
        name: "batch_search",
        arguments: { cwd: tmpDir, queries: [{ type: "text", pattern: "TTL_AAA_111", path: "ttl.js" }] }
      });
      assert.ok(r1.result.content[0].text.includes("TTL_AAA_111"));

      // Overwrite with same size & restored mtime -> still cached immediately, then expires after 140ms
      fs.writeFileSync(expFile, ttlV2, "utf8");
      fs.utimesSync(expFile, fixedSec, fixedSec);
      fs.utimesSync(tmpDir, fixedSec, fixedSec);

      const rImmediate = await cTtl.request("tools/call", {
        name: "batch_search",
        arguments: { cwd: tmpDir, queries: [{ type: "text", pattern: "TTL_AAA_111", path: "ttl.js" }] }
      });
      assert.ok(rImmediate.result.content[0].text.includes("TTL_AAA_111"), "Must hit cache before TTL expires");

      await new Promise((r) => setTimeout(r, 150));

      const rExpired = await cTtl.request("tools/call", {
        name: "batch_search",
        arguments: { cwd: tmpDir, queries: [{ type: "text", pattern: "TTL_AAA_111", path: "ttl.js" }] }
      });
      assert.ok(
        rExpired.result.content[0].text.includes("(no matches)"),
        "Must miss and re-scan after TTL expires"
      );
    } finally {
      const closed = await cTtl.close();
      assert.equal(closed.code, 0);
      assert.equal(closed.stderr, "");
    }

    // 3. Opt-out via AGY_DART_SEARCH_CACHE_TTL_MS=0
    fs.writeFileSync(expFile, ttlV1, "utf8");
    fs.utimesSync(expFile, fixedSec, fixedSec);
    fs.utimesSync(tmpDir, fixedSec, fixedSec);

    const cOptOut = createPersistentMcpClient(serverPath, {
      AGY_DART_DISABLE_OUTLINE_DB: "1",
      AGY_DART_DB_PATH: path.join(tmpDir, "search-optout.db"),
      AGY_DART_SEARCH_CACHE_TTL_MS: "0"
    });
    try {
      await cOptOut.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "search-optout-test", version: "1.0" }
      });
      const r1 = await cOptOut.request("tools/call", {
        name: "batch_search",
        arguments: { cwd: tmpDir, queries: [{ type: "text", pattern: "TTL_AAA_111", path: "ttl.js" }] }
      });
      assert.ok(r1.result.content[0].text.includes("TTL_AAA_111"));

      fs.writeFileSync(expFile, ttlV2, "utf8");
      fs.utimesSync(expFile, fixedSec, fixedSec);
      fs.utimesSync(tmpDir, fixedSec, fixedSec);

      const r2 = await cOptOut.request("tools/call", {
        name: "batch_search",
        arguments: { cwd: tmpDir, queries: [{ type: "text", pattern: "TTL_AAA_111", path: "ttl.js" }] }
      });
      assert.ok(
        r2.result.content[0].text.includes("(no matches)"),
        "AGY_DART_SEARCH_CACHE_TTL_MS=0 must bypass search cache completely"
      );
    } finally {
      const closed = await cOptOut.close();
      assert.equal(closed.code, 0);
      assert.equal(closed.stderr, "");
    }

    // 4. Large (>24 files) git repo: type:"git" bypasses cache (never stale on external edit) & glob busts on sibling file add via tracked parent dirs
    const bigRepoDir = path.join(tmpDir, "big-git-repo");
    const bigSrcDir = path.join(bigRepoDir, "src");
    fs.mkdirSync(bigSrcDir, { recursive: true });
    const gitBig = (args) => {
      const r = spawnSync("git", args, {
        cwd: bigRepoDir,
        encoding: "utf8",
        windowsHide: true,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Test Author",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "Test Author",
          GIT_COMMITTER_EMAIL: "test@example.com"
        }
      });
      assert.equal(r.status, 0, `gitBig ${args.join(" ")} failed: ${r.stderr}`);
      return r.stdout;
    };
    gitBig(["init"]);
    for (let i = 0; i < 30; i++) {
      writeFileDeep(path.join(bigSrcDir, `f_${i}.js`), `export const n_${i} = ${i};\n`);
    }
    gitBig(["add", "."]);
    gitBig(["commit", "-m", "seed 30 files"]);

    const cBig = createPersistentMcpClient(serverPath, { AGY_DART_DISABLE_OUTLINE_DB: "1", AGY_DART_DB_PATH: path.join(tmpDir, "search-big.db") });
    try {
      await cBig.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "search-big-git-test", version: "1.0" }
      });

      const gitClean = await cBig.request("tools/call", {
        name: "batch_search",
        arguments: { cwd: bigRepoDir, queries: [{ type: "git", pattern: "status --short" }] }
      });
      assert.ok(gitClean.result.content[0].text.includes("(empty output)"));

      // Populate glob cache across the 30 files in src/
      const glob1 = await cBig.request("tools/call", {
        name: "batch_search",
        arguments: { cwd: bigRepoDir, queries: [{ type: "glob", pattern: "**/*.js" }] }
      });
      assert.ok(glob1.result.content[0].text.includes("src/f_0.js"));
      assert.ok(!glob1.result.content[0].text.includes("src/f_30_new.js"));

      // External edit to src/f_0.js -> git status query within 15s MUST NOT return stale (empty output)!
      fs.appendFileSync(path.join(bigSrcDir, "f_0.js"), "// external edit\n", "utf8");
      const gitDirty = await cBig.request("tools/call", {
        name: "batch_search",
        arguments: { cwd: bigRepoDir, queries: [{ type: "git", pattern: "status --short" }] }
      });
      assert.ok(
        gitDirty.result.content[0].text.includes("src/f_0.js"),
        `git status query must bypass cache and detect external edit in >24-file repo; got:\n${gitDirty.result.content[0].text}`
      );

      // External creation of new sibling file in src/ -> cached glob MUST bust immediately via tracked parent dir!
      writeFileDeep(path.join(bigSrcDir, "f_30_new.js"), "export const n_30 = 30;\n");
      const bumpedSrcSec = Math.floor(Date.now() / 1000) + 10;
      fs.utimesSync(bigSrcDir, bumpedSrcSec, bumpedSrcSec);
      const glob2 = await cBig.request("tools/call", {
        name: "batch_search",
        arguments: { cwd: bigRepoDir, queries: [{ type: "glob", pattern: "**/*.js" }] }
      });
      assert.ok(
        glob2.result.content[0].text.includes("src/f_30_new.js"),
        `glob cache must invalidate when a new sibling file is created in tracked parent dir; got:\n${glob2.result.content[0].text}`
      );
    } finally {
      const closed = await cBig.close();
      assert.equal(closed.code, 0);
      assert.equal(closed.stderr, "");
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
