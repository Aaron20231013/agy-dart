import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describeToolCall } from "../context/lib/cache-analyzer.js";
import { inferLanguageFromFile } from "../context/lib/executor.js";
import { ContextModeStore } from "../context/lib/store.js";
import { createTools } from "../context/lib/tools.js";
import { classifyToolExecutionKind } from "../context/lib/watchdog-lease.js";
import { auditPrefixBudget } from "../scripts/prefix-budget.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function createMcpClient(scriptPath, { env = {} } = {}) {
  const child = spawn(process.execPath, [scriptPath], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, ...env }
  });
  let buf = "";
  let stderr = "";
  let nextId = 1;
  const pending = new Map();

  child.stderr.on("data", (d) => {
    stderr += d.toString("utf8");
  });
  child.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed && parsed.id !== undefined && pending.has(parsed.id)) {
        const resolve = pending.get(parsed.id);
        pending.delete(parsed.id);
        resolve(parsed);
      }
    }
  });

  return {
    getStderr: () => stderr,
    request(method, params = {}, timeoutMs = 10000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP ${method} timed out (${stderr})`));
        }, timeoutMs);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.stdin.end();
      } catch {}
      await new Promise((r) => {
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {}
          r();
        }, 1000);
        child.once("close", () => {
          clearTimeout(timer);
          r();
        });
      });
    }
  };
}

test("ctx_execute resolves silent summary/description aliases, whitespace fallbacks, and FTS5 labels cleanly", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ctx-compact-unit-"));
  const store = new ContextModeStore({ dbPath: path.join(tmpDir, "ctx.db") });
  try {
    const tools = createTools({
      store,
      getCwd: () => tmpDir,
      getSessionId: () => "compact-session"
    });

    // 1. summary alias fallback + FTS5 source label
    const resSummary = await tools.ctx_execute({
      language: "javascript",
      code: "console.log('summary-payload-alpha');",
      summary: "  Short summary alias  "
    });
    assert.equal(resSummary.ok, true);
    assert.equal(resSummary.intent, "Short summary alias");
    const searchSummary = store.search({
      queries: ["summary-payload-alpha"],
      sourceId: resSummary.sourceId,
      sessionId: "compact-session",
      limit: 1
    });
    assert.equal(searchSummary.hits[0]?.title, "Short summary alias");

    // 2. description alias fallback
    const resDesc = await tools.ctx_execute({
      language: "javascript",
      code: "console.log('desc-ok');",
      description: "Short description alias"
    });
    assert.equal(resDesc.ok, true);
    assert.equal(resDesc.intent, "Short description alias");

    // 3. Canonical intent takes precedence over summary & description
    const resPrecedence = await tools.ctx_execute({
      language: "javascript",
      code: "console.log('prec-ok');",
      intent: "Canonical intent",
      summary: "Ignored summary",
      description: "Ignored description"
    });
    assert.equal(resPrecedence.ok, true);
    assert.equal(resPrecedence.intent, "Canonical intent");

    // 4. Whitespace-only intent falls through to summary, and non-string garbage is ignored safely
    const resBlankIntent = await tools.ctx_execute({
      language: "javascript",
      code: "console.log('blank-intent-ok');",
      intent: "   \t  ",
      summary: { bad: true },
      description: "Fallback after blank intent"
    });
    assert.equal(resBlankIntent.ok, true);
    assert.equal(resBlankIntent.intent, "Fallback after blank intent");

    // 5. All blank / non-string -> intent: null
    const resNullIntent = await tools.ctx_execute({
      language: "javascript",
      code: "console.log('no-intent');",
      intent: "  ",
      summary: 42,
      description: false
    });
    assert.equal(resNullIntent.ok, true);
    assert.equal(resNullIntent.intent, null);

    // 6. Oversized multi-KB description alias is capped to <= 240 UTF-8 bytes so MCP JSON stays <= 8.8 KB without starving output
    const resHugeDesc = await tools.ctx_execute({
      language: "javascript",
      code: "console.log('preserved-output-body');",
      description: "测".repeat(4000)
    });
    assert.equal(resHugeDesc.ok, true);
    assert.ok(Buffer.byteLength(resHugeDesc.intent, "utf8") <= 240);
    assert.equal(resHugeDesc.intent.includes("\uFFFD"), false);
    assert.match(resHugeDesc.output, /preserved-output-body/);
    assert.ok(Buffer.byteLength(JSON.stringify(resHugeDesc, null, 2), "utf8") <= 8800);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("ctx_execute executes OS temp-dir scripts via file + args ($TMPDIR/%TEMP%/file://), infers omitted language, and enforces sensitiveFileGuard", async () => {
  assert.equal(inferLanguageFromFile("/tmp/filter.py"), "python");
  assert.equal(inferLanguageFromFile("C:\\Temp\\parse.mjs"), "javascript");
  assert.equal(inferLanguageFromFile("/tmp/check.ps1"), "powershell");
  assert.equal(inferLanguageFromFile("/tmp/run.sh"), "shell");
  assert.equal(inferLanguageFromFile(""), "");

  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ctx-ws-"));
  const scratchSubdir = `agy-ctx-scratch-${process.pid}-${Date.now()}`;
  const scratchAbsDir = path.join(os.tmpdir(), scratchSubdir);
  fs.mkdirSync(scratchAbsDir, { recursive: true });
  const store = new ContextModeStore({ dbPath: path.join(wsDir, "ctx.db") });

  try {
    const tools = createTools({
      store,
      getCwd: () => wsDir,
      getSessionId: () => "temp-file-session"
    });

    // ESM .mjs script placed in OS temp dir (outside workspace, no package.json needed)
    const mjsPath = path.join(scratchAbsDir, "analyze_trace.mjs");
    fs.writeFileSync(
      mjsPath,
      [
        'import path from "node:path";',
        "const args = process.argv.slice(2);",
        "console.log(JSON.stringify({ cwdBase: path.basename(process.cwd()), args }));"
      ].join("\n"),
      "utf8"
    );

    // 1. Omitted language auto-infers javascript from .mjs + $TMPDIR expansion
    const resTmpEnv = await tools.ctx_execute({
      intent: "Analyze trace via $TMPDIR",
      file: `$TMPDIR/${scratchSubdir}/analyze_trace.mjs`,
      args: ["alpha beta", "gamma&delta"]
    });
    assert.equal(resTmpEnv.ok, true, resTmpEnv.output);
    assert.equal(resTmpEnv.language, "javascript");
    assert.equal(resTmpEnv.intent, "Analyze trace via $TMPDIR");
    assert.deepEqual(JSON.parse(resTmpEnv.output.trim()), {
      cwdBase: path.basename(wsDir),
      args: ["alpha beta", "gamma&delta"]
    });

    // 2. Windows %TEMP% and $env:TEMP expansion + file:// URI script support
    for (const fileRef of [
      `%TEMP%\\${scratchSubdir}\\analyze_trace.mjs`,
      `$env:TEMP/${scratchSubdir}/analyze_trace.mjs`,
      pathToFileURL(mjsPath).href
    ]) {
      const resRef = await tools.ctx_execute({
        intent: "Analyze via temp ref",
        language: "javascript",
        file: fileRef,
        args: ["ok"]
      });
      assert.equal(resRef.ok, true, `Failed for ${fileRef}: ${resRef.output}`);
      assert.deepEqual(JSON.parse(resRef.output.trim()).args, ["ok"]);
    }

    // 3. sensitiveFileGuard=deny still blocks expanded temp/file:// paths pointing to .env
    const fakeEnvFile = path.join(scratchAbsDir, ".env");
    fs.writeFileSync(fakeEnvFile, "API_KEY=secret\n", "utf8");
    const prevGuard = process.env.AGY_DART_SENSITIVE_FILE_GUARD;
    process.env.AGY_DART_SENSITIVE_FILE_GUARD = "deny";
    try {
      await assert.rejects(
        () =>
          tools.ctx_execute({
            intent: "Attempt blocked env execution",
            language: "shell",
            file: `$TMPDIR/${scratchSubdir}/.env`
          }),
        /Blocked executing sensitive file/
      );
      await assert.rejects(
        () =>
          tools.ctx_execute({
            intent: "Attempt blocked file URI env execution",
            language: "shell",
            file: pathToFileURL(fakeEnvFile).href
          }),
        /Blocked executing sensitive file/
      );
    } finally {
      if (prevGuard === undefined) delete process.env.AGY_DART_SENSITIVE_FILE_GUARD;
      else process.env.AGY_DART_SENSITIVE_FILE_GUARD = prevGuard;
    }
  } finally {
    store.close();
    fs.rmSync(scratchAbsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(wsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("MCP stdio tools/call forwards silent aliases while tools/list, Watchdog, CacheAnalyzer, AGENTS.md, SKILL.md & prefix:budget stay aligned", async () => {
  // Watchdog & CacheAnalyzer pick up silent summary/description aliases on ctx_execute
  const wdSummary = classifyToolExecutionKind("call_mcp_tool", {
    ServerName: "agy-dart_context",
    ToolName: "ctx_execute",
    Arguments: { summary: "Scan slow SQL", language: "python", file: "/tmp/scan.py" }
  });
  assert.equal(wdSummary.activeTool, "ctx_execute");
  assert.equal(wdSummary.summary, "Scan slow SQL");

  const caDesc = describeToolCall({
    name: "call_mcp_tool",
    args: {
      ServerName: "agy-dart_context",
      ToolName: "ctx_execute",
      Arguments: { description: "Parse huge CSV", file: "/tmp/csv.py" }
    }
  });
  assert.match(caDesc.label, /Parse huge CSV/);

  // Live MCP server handshake & tools/call verification
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ctx-mcp-compact-"));
  const scriptFile = path.join(tmpDir, "sum_args.mjs");
  fs.writeFileSync(
    scriptFile,
    'console.log(JSON.stringify({ sum: process.argv.slice(2).map(Number).reduce((a, b) => a + b, 0) }));\n',
    "utf8"
  );

  const client = createMcpClient(path.join(ROOT, "context", "server.js"), {
    env: { AGY_DART_DB_PATH: path.join(tmpDir, "ctx.db") }
  });
  try {
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      rootUri: pathToFileURL(tmpDir).href
    });

    const listResp = await client.request("tools/list", {});
    const ctxExecDef = listResp.result.tools.find((t) => t.name === "ctx_execute");
    assert.ok(ctxExecDef, "ctx_execute must exist in tools/list");
    assert.equal(ctxExecDef.inputSchema.properties.intent.type, "string");
    // Silent aliases must NOT bloat advertised inputSchema
    assert.equal(ctxExecDef.inputSchema.properties.summary, undefined);
    assert.equal(ctxExecDef.inputSchema.properties.description, undefined);
    assert.match(ctxExecDef.description, /intent first/i);
    assert.match(ctxExecDef.description, /file \+ args/i);

    const callResp = await client.request("tools/call", {
      name: "ctx_execute",
      arguments: {
        summary: "Sum numeric args via MCP stdio",
        file: scriptFile,
        args: ["10", "25", "7"]
      }
    });
    assert.equal(callResp.result.isError, false, callResp.result.content?.[0]?.text);
    const payload = JSON.parse(callResp.result.content[0].text);
    assert.equal(payload.ok, true);
    assert.equal(payload.language, "javascript");
    assert.equal(payload.intent, "Sum numeric args via MCP stdio");
    assert.deepEqual(JSON.parse(payload.output.trim()), { sum: 42 });
    assert.equal(client.getStderr(), "");
  } finally {
    await client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  // Rule & Skill alignment + Turn-0 prefix budget gate
  const agentsMd = fs.readFileSync(path.join(ROOT, "rules", "AGENTS.md"), "utf8");
  const skillMd = fs.readFileSync(path.join(ROOT, "skills", "agy-dart", "SKILL.md"), "utf8");

  assert.match(agentsMd, /- `ctx_execute`: `\{\s*intent\?,/);
  assert.match(agentsMd, /<=5 lines/i);
  assert.match(agentsMd, /`file` \+ `args`/);
  assert.equal(/`summary`|`description`/i.test(skillMd), false);
  assert.match(skillMd, /"intent": "Analyze slow queries in trace\.json"/);
  assert.match(skillMd, /"file": "\/tmp\/agy_ctx_trace\.py"/);

  const budget = await auditPrefixBudget(ROOT);
  assert.equal(budget.exceedsBudget, false);
  assert.equal(budget.exceedsUpperBound, false);
  assert.equal(budget.blocks.tools.canonical, true);
  assert.ok(budget.totalTokens < 3150, `Expected Turn-0 tokens < 3150, got ${budget.totalTokens}`);
});
