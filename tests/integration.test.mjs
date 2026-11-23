import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ContextModeStore } from "../context/lib/store.js";
import { createTools } from "../context/lib/tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function mcpHandshake(scriptPath, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ...extraEnv }
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timeout: ${scriptPath}`));
    }, 6000);
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("close", () => {
      clearTimeout(timer);
      const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
      resolve({ lines, stderr });
    });
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } }
    }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    child.stdin.end();
  });
}

function runPreHook(payload, dbPath, extraEnv = {}) {
  const hook = path.join(ROOT, "hooks", "pre-tool-use.mjs");
  const res = spawnSync(process.execPath, [hook], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, AGY_DART_DB_PATH: dbPath, ...extraEnv }
  });
  assert.equal(res.status, 0, `Hook failed: ${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

test("MCP servers: fast (4 tools) and context (8 tools) both pass live JSON-RPC handshake", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-mcp-"));
  const tmpDb = path.join(tmpDir, "context.db");
  try {
    const fast = await mcpHandshake(path.join(ROOT, "fast", "mcp-server.mjs"));
    const fastTools = fast.lines.find((l) => l.id === 2)?.result?.tools?.map((t) => t.name) || [];
    assert.deepEqual(fastTools.sort(), ["apply_edits", "batch_search", "read_slices", "run_checks"]);

    const ctx = await mcpHandshake(path.join(ROOT, "context", "server.js"), { AGY_DART_DB_PATH: tmpDb });
    const ctxInit = ctx.lines.find((l) => l.id === 1)?.result?.serverInfo;
    const ctxTools = ctx.lines.find((l) => l.id === 2)?.result?.tools?.map((t) => t.name) || [];
    assert.equal(ctxInit.name, "agy-dart-context");
    assert.equal(ctxTools.length, 8);
    assert.ok(ctxTools.includes("ctx_execute"));
    assert.ok(ctxTools.includes("ctx_search"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("PreToolUse: 45 KiB default cutoff, 16 KB log guard, ranged allow, SKILL.md exemption, and unbounded command deny", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-hook-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const small12k = path.join(tmpDir, "small.ts");
  const large26k = path.join(tmpDir, "big.log");
  const bigSkill = path.join(tmpDir, "SKILL.md");

  fs.writeFileSync(small12k, "x".repeat(12 * 1024));
  fs.writeFileSync(large26k, Array.from({ length: 650 }, (_, i) => `line ${i} ${"y".repeat(36)}`).join("\n"));
  fs.writeFileSync(bigSkill, "# Skill Manual\n" + "instruction text ".repeat(1500)); // ~25 KB

  try {
    // 1. Default cutoff in fresh DB is 45 KiB (46,080 B, aligned with Antigravity host read_file cap)
    const store = new ContextModeStore({ dbPath: tmpDb });
    try {
      assert.equal(store.getCutoff(null), 46080);
    } finally {
      store.close();
    }

    // 2. 12 KB source file allowed whole
    const rSmall = runPreHook({ toolCall: { name: "read_file", args: { Path: small12k } } }, tmpDb);
    assert.equal(rSmall.decision, "allow");

    // 3. 26 KB log denied whole with agy-dart_fast & agy-dart_context guidance
    const rLarge = runPreHook({ toolCall: { name: "read_file", args: { Path: large26k } } }, tmpDb);
    assert.equal(rLarge.decision, "deny");
    assert.ok(rLarge.reason.includes("agy-dart_context"));
    assert.ok(rLarge.reason.includes("agy-dart_fast"));

    // 4. 26 KB log allowed when paged <= 410 lines
    const rPaged = runPreHook({ toolCall: { name: "read_file", args: { Path: large26k, StartLine: 1, EndLine: 200 } } }, tmpDb);
    assert.equal(rPaged.decision, "allow");

    // 5. 25 KB SKILL.md auto-exempted (agent instruction file)
    const rSkill = runPreHook({ toolCall: { name: "read_file", args: { Path: bigSkill } } }, tmpDb);
    assert.equal(rSkill.decision, "allow");

    // 6. Unbounded Get-Content denied
    const rCmd = runPreHook({ toolCall: { name: "run_command", args: { CommandLine: "Get-Content server.log" } } }, tmpDb);
    assert.equal(rCmd.decision, "deny");
    assert.ok(rCmd.reason.includes("agy-dart protection"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ctx_execute enforces <= 8800 UTF-8 bytes inline cap even on 84 KB CJK output", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-cap-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const store = new ContextModeStore({ dbPath: tmpDb });
  const tools = createTools({ store, getCwd: () => tmpDir, getSessionId: () => "cap-session" });

  try {
    const res = await tools.ctx_execute({
      language: "javascript",
      code: 'console.log("测试日志中文字符输出\\n".repeat(2800));',
      intent: "Verify <=8.8 KB UTF-8 hard cap"
    });
    const totalJsonBytes = Buffer.byteLength(JSON.stringify(res, null, 2), "utf8");
    assert.ok(res.rawBytes > 70000);
    assert.ok(totalJsonBytes <= 8800, `Expected <= 8800 B, got ${totalJsonBytes} B`);

    const search = await tools.ctx_search({ queries: ["测试日志"], sourceId: res.sourceId });
    assert.ok(search.hits.length >= 1);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("SessionStart unified hook merges workspace snapshot and agy-dart status in one step", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-ss-"));
  const tmpDb = path.join(tmpDir, "context.db");
  try {
    const res = spawnSync(process.execPath, [path.join(ROOT, "hooks", "session-start.mjs")], {
      input: JSON.stringify({ cwd: ROOT, workspacePaths: [ROOT], hookEventName: "SessionStart" }),
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, AGY_DART_DB_PATH: tmpDb }
    });
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout.trim());
    const msg = parsed?.injectSteps?.[0]?.systemMessage?.systemMessage || "";
    assert.ok(msg.includes("agy-dart active:"));
    assert.ok(msg.includes("package.json") || msg.includes("Project") || msg.length > 150);
    assert.doesNotMatch(msg.split("\n")[0], /agy-dart_fast|apply_edits/, "the startup header should not select the coding workflow");

    const empty = spawnSync(process.execPath, [path.join(ROOT, "hooks", "session-start.mjs")], {
      input: JSON.stringify({ hookEventName: "SessionStart", workspacePaths: [] }),
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, AGY_DART_DB_PATH: tmpDb }
    });
    assert.equal(empty.status, 0, empty.stderr);
    assert.deepEqual(JSON.parse(empty.stdout), {}, "no standalone tool recommendation without workspace context");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Installer dry-run to custom target copies sidecars and passes doctor", () => {
  const tmpTarget = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-install-"));
  const installDir = path.join(tmpTarget, "agy-dart");
  try {
    const res = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "install.mjs"), "install", "--target", installDir, "--mode", "balanced-16k"],
      { encoding: "utf8", windowsHide: true }
    );
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    assert.ok(fs.existsSync(path.join(installDir, "sidecars", "dashboard", "sidecar.json")));
    assert.ok(res.stdout.includes("MCP [fast]    : OK (4 tools"));
    assert.ok(res.stdout.includes("MCP [context] : OK (8 tools"));
    assert.ok(res.stdout.includes("Sidecar UI    : OK"));
  } finally {
    fs.rmSync(tmpTarget, { recursive: true, force: true });
  }
});
