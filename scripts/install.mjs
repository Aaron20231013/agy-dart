#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const PLUGIN_NAME = "agy-dart";

const MODES = {
  "strict-8k": { cutoffBytes: 8192, readHook: true, label: "Strict (8 KB / 200 lines)" },
  "balanced-16k": { cutoffBytes: 16384, readHook: true, label: "Balanced Scheme A (16 KB / 410 lines, recommended)" },
  "fast-32k": { cutoffBytes: 32768, readHook: true, label: "Relaxed Scheme A (32 KB / 820 lines)" },
  "no-read-hook": { cutoffBytes: 16384, readHook: false, label: "Ultra-fast Scheme B (command guard only, no read_file hook)" }
};

const FILES_TO_COPY = [
  "plugin.json",
  "mcp_config.json",
  "hooks.json",
  "package.json",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "README.md",
  "README.zh-CN.md",
  "assets/logo.svg",
  "rules/AGENTS.md",
  "skills/agy-dart/SKILL.md",
  "fast/mcp-server.mjs",
  "fast/session-start.mjs",
  "fast/benchmark.mjs",
  "context/server.js",
  "context/lib/store.js",
  "context/lib/executor.js",
  "context/lib/tools.js",
  "hooks/session-start.mjs",
  "hooks/pre-tool-use.mjs",
  "sidecars/dashboard/sidecar.json",
  "sidecars/dashboard/server.mjs",
  "sidecars/dashboard/index.html",
  "scripts/install.mjs"
];

function getHomeDir() {
  return process.platform === "win32"
    ? process.env.USERPROFILE || process.env.HOME || os.homedir()
    : process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function getGlobalPluginsRoot() {
  return path.join(getHomeDir(), ".gemini", "config", "plugins");
}

function checkNodeAndSqlite() {
  const major = Number.parseInt(process.versions.node.split(".")[0] || "0", 10);
  if (major < 22) {
    throw new Error(`Node.js >= 22 (with built-in node:sqlite) is required. Current: v${process.versions.node}`);
  }
  return process.versions.node;
}

function hasCommand(bin, args = ["--version"]) {
  const res = spawnSync(bin, args, { stdio: "ignore", timeout: 3000, windowsHide: true });
  return !res.error && res.status === 0;
}

async function pathExists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let command = "install";
  let targetDir = "";
  let projectDir = "";
  let mode = "balanced-16k";
  let installRg = false;
  let showHelp = false;
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      showHelp = true;
    } else if (a === "--install-rg") {
      installRg = true;
    } else if (a === "--mode") {
      const next = args[++i];
      if (!next || !MODES[next]) {
        throw new Error(`Invalid --mode '${next}'. Expected one of: ${Object.keys(MODES).join(", ")}`);
      }
      mode = next;
    } else if (a === "--target") {
      const next = args[++i];
      if (!next) throw new Error("Missing path after --target");
      targetDir = path.resolve(next);
    } else if (a === "--project") {
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        projectDir = path.resolve(args[++i]);
      } else {
        projectDir = process.cwd();
      }
    } else if (!a.startsWith("-")) {
      positional.push(a);
    } else {
      throw new Error(`Unknown option: ${a}`);
    }
  }

  if (positional.length >= 1) command = positional[0];
  if (command === "mode" && positional.length >= 2) {
    if (!MODES[positional[1]]) {
      throw new Error(`Unknown mode '${positional[1]}'. Expected one of: ${Object.keys(MODES).join(", ")}`);
    }
    mode = positional[1];
  }

  const isCustomTarget = Boolean(targetDir);
  if (!targetDir) {
    targetDir = projectDir
      ? path.join(projectDir, ".agents", "plugins", PLUGIN_NAME)
      : path.join(getGlobalPluginsRoot(), PLUGIN_NAME);
  }

  return { command, targetDir, isProject: Boolean(projectDir), isCustomTarget, mode, installRg, showHelp };
}

function printHelp() {
  console.log(`agy-dart installer & doctor

Usage:
  node scripts/install.mjs install [options]     Install agy-dart globally (default) or to a project
  node scripts/install.mjs doctor [options]      Verify both MCP servers, hooks, SQLite, Sidecar & rg
  node scripts/install.mjs mode <mode> [opts]    Switch protection mode (${Object.keys(MODES).join(" | ")})
  node scripts/install.mjs uninstall [options]   Remove installed agy-dart plugin

Options:
  --project [dir]        Install into <dir>/.agents/plugins/agy-dart
  --target <dir>         Install into a custom directory
  --mode <mode>          balanced-16k (default) | fast-32k | strict-8k | no-read-hook
  --install-rg           On Windows x64, download official ripgrep (rg.exe) to ~/.local/bin and add to PATH
  -h, --help             Show this help
`);
}

async function applyMode(targetDir, modeKey, skipDb = false) {
  const cfg = MODES[modeKey];
  const hooksPath = path.join(targetDir, "hooks.json");
  const hooksJson = {
    "agy-dart-lifecycle": {
      SessionStart: [
        {
          type: "command",
          command: "node ./hooks/session-start.mjs",
          timeout: 8
        }
      ],
      PreToolUse: [
        {
          matcher: cfg.readHook ? "run_command|read_file|view_file" : "run_command",
          hooks: [
            {
              type: "command",
              command: "node ./hooks/pre-tool-use.mjs",
              timeout: 10
            }
          ]
        }
      ]
    }
  };
  await fs.writeFile(hooksPath, JSON.stringify(hooksJson, null, 2) + "\n", "utf8");

  if (!skipDb) {
    const storeUrl = pathToFileURL(path.join(targetDir, "context", "lib", "store.js")).href;
    const { ContextModeStore } = await import(storeUrl);
    const store = new ContextModeStore();
    store.setCutoff(cfg.cutoffBytes, "lifetime");
    store.close();
  }
  return cfg;
}

function installRipgrepWindows() {
  if (hasCommand("rg", ["--version"])) {
    console.log("  - ripgrep (rg): already installed on PATH");
    return true;
  }
  if (process.platform !== "win32" || process.arch !== "x64") {
    console.log("  - ripgrep (rg): please install via your package manager (brew install ripgrep / apt install ripgrep)");
    return false;
  }
  console.log("  - Installing official ripgrep (rg.exe) to ~/.local/bin ...");
  const psScript = `
$ErrorActionPreference = "Stop"
$tags = git ls-remote --tags --refs https://github.com/BurntSushi/ripgrep.git | ForEach-Object { ($_ -split "\`t")[1] -replace '^refs/tags/', '' } | Where-Object { $_ -match '^\\d+\\.\\d+\\.\\d+$' }
$ver = ($tags | Sort-Object { [version]$_ } | Select-Object -Last 1)
if (-not $ver) { $ver = "15.2.0" }
$url = "https://github.com/BurntSushi/ripgrep/releases/download/$ver/ripgrep-$ver-x86_64-pc-windows-msvc.zip"
$tmp = Join-Path $env:TEMP ("agy-dart-rg-" + [guid]::NewGuid().ToString("N"))
$bin = Join-Path $env:USERPROFILE ".local\\bin"
New-Item -ItemType Directory -Force -Path $tmp, $bin | Out-Null
try {
  curl.exe -fsSL -o (Join-Path $tmp "rg.zip") $url
  Expand-Archive -Path (Join-Path $tmp "rg.zip") -DestinationPath (Join-Path $tmp "out") -Force
  $exe = Get-ChildItem (Join-Path $tmp "out") -Filter "rg.exe" -Recurse | Select-Object -First 1
  Copy-Item $exe.FullName (Join-Path $bin "rg.exe") -Force
  $up = [Environment]::GetEnvironmentVariable("Path", "User")
  $parts = @($up -split ";" | Where-Object { $_ -and $_.Trim() -ne "" })
  if (-not ($parts | Where-Object { $_.TrimEnd("\\") -ieq $bin.TrimEnd("\\") })) {
    [Environment]::SetEnvironmentVariable("Path", (($parts + $bin) -join ";"), "User")
  }
  Write-Output "Installed rg $ver to $bin\\rg.exe"
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
`;
  const res = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psScript], {
    encoding: "utf8",
    timeout: 60000,
    windowsHide: true
  });
  if (res.error || res.status !== 0) {
    console.log(`  - Warning: automatic ripgrep install failed (${res.stderr?.trim() || res.error?.message || "unknown"}). Node.js fallback remains active.`);
    return false;
  }
  console.log(`  - ${res.stdout.trim()}`);
  return true;
}

async function verifyMcpServer(scriptPath, extraEnv = {}) {
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
      reject(new Error(`MCP smoke test timed out: ${scriptPath}`));
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
      const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length < 2) {
        return reject(new Error(`Incomplete MCP response (exit ${code}): ${stderr || stdout}`));
      }
      try {
        const initResp = JSON.parse(lines[0]);
        const listResp = JSON.parse(lines[1]);
        const tools = listResp?.result?.tools;
        if (!initResp?.result?.serverInfo || !Array.isArray(tools)) {
          return reject(new Error("Invalid MCP JSON-RPC responses"));
        }
        resolve({
          serverName: initResp.result.serverInfo.name,
          tools: tools.map((t) => t.name)
        });
      } catch (err) {
        reject(err);
      }
    });

    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "agy-dart-doctor", version: "1.0" } }
    }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    child.stdin.end();
  });
}

async function verifySessionStart(hookScript, sampleDir, dbPath) {
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [hookScript], {
    input: JSON.stringify({ cwd: sampleDir, workspacePaths: [sampleDir], hookEventName: "SessionStart" }),
    encoding: "utf8",
    timeout: 6000,
    windowsHide: true,
    env: { ...process.env, AGY_DART_DB_PATH: dbPath }
  });
  if (res.error || res.status !== 0) {
    throw new Error(`SessionStart failed: ${res.stderr || res.error?.message}`);
  }
  const parsed = JSON.parse(res.stdout.trim());
  const msg = parsed?.injectSteps?.[0]?.systemMessage?.systemMessage || "";
  return { durationMs: Date.now() - t0, bytes: Buffer.byteLength(msg, "utf8") };
}

async function runDoctor(targetDir) {
  const nodeVer = checkNodeAndSqlite();
  await import("node:sqlite");
  const exists = await pathExists(targetDir);
  if (!exists) {
    console.log(`agy-dart is not installed at: ${targetDir}`);
    return false;
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-dart-doctor-"));
  const tmpDb = path.join(tmpDir, "doctor.db");

  try {
    const fastCheck = await verifyMcpServer(path.join(targetDir, "fast", "mcp-server.mjs"));
    const ctxCheck = await verifyMcpServer(path.join(targetDir, "context", "server.js"), { AGY_DART_DB_PATH: tmpDb });
    const hookCheck = await verifySessionStart(path.join(targetDir, "hooks", "session-start.mjs"), targetDir, tmpDb);
    const hasSidecar = await pathExists(path.join(targetDir, "sidecars", "dashboard", "sidecar.json"));
    const hasRg = hasCommand("rg", ["--version"]);

    const hooksRaw = JSON.parse(await fs.readFile(path.join(targetDir, "hooks.json"), "utf8"));
    const matcher = hooksRaw?.["agy-dart-lifecycle"]?.PreToolUse?.[0]?.matcher || "";

    console.log("agy-dart health check:");
    console.log(`  - Plugin path   : ${targetDir}`);
    console.log(`  - Node / SQLite : v${nodeVer} (OK)`);
    console.log(`  - ripgrep (rg)  : ${hasRg ? "available (fast search active)" : "not found (Node.js fallback active; rerun with --install-rg on Windows)"}`);
    console.log(`  - MCP [fast]    : OK (${fastCheck.tools.length} tools: ${fastCheck.tools.join(", ")})`);
    console.log(`  - MCP [context] : OK (${ctxCheck.tools.length} tools: ${ctxCheck.tools.join(", ")})`);
    console.log(`  - SessionStart  : OK (${hookCheck.durationMs}ms, ${hookCheck.bytes} bytes)`);
    console.log(`  - PreToolUse    : OK (matcher: ${matcher})`);
    console.log(`  - Sidecar UI    : ${hasSidecar ? "OK (sidecars/dashboard present)" : "MISSING"}`);

    // Friendly warning if standalone legacy plugins coexist globally
    const globalRoot = getGlobalPluginsRoot();
    if (path.resolve(targetDir) === path.resolve(globalRoot, PLUGIN_NAME)) {
      const legacy = [];
      if (await pathExists(path.join(globalRoot, "agy-fast"))) legacy.push("agy-fast");
      if (await pathExists(path.join(globalRoot, "antigravity-plugin-context-mode"))) legacy.push("antigravity-plugin-context-mode");
      if (legacy.length > 0) {
        console.log(`  - Notice        : Found standalone plugin(s): ${legacy.join(", ")}. Disable or remove them in Customizations -> Installed to avoid duplicate MCP/hooks.`);
      }
    }

    return fastCheck.tools.length === 4 && ctxCheck.tools.length === 8 && hookCheck.bytes > 0 && hasSidecar;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runInstall(opts) {
  checkNodeAndSqlite();
  await import("node:sqlite");

  const srcRoot = path.resolve(REPO_ROOT);
  const dstRoot = path.resolve(opts.targetDir);

  if (srcRoot !== dstRoot) {
    if (await pathExists(dstRoot)) {
      await fs.rm(dstRoot, { recursive: true, force: true });
    }
    await fs.mkdir(dstRoot, { recursive: true });
    for (const rel of FILES_TO_COPY) {
      const src = path.join(srcRoot, rel);
      const dst = path.join(dstRoot, rel);
      if (!(await pathExists(src))) {
        throw new Error(`Missing required source file: ${rel}`);
      }
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.copyFile(src, dst);
    }
    console.log(`Installed agy-dart to ${dstRoot}`);
  }

  const modeCfg = await applyMode(dstRoot, opts.mode, opts.isCustomTarget);
  console.log(`Configured mode: ${opts.mode} — ${modeCfg.label}`);

  if (opts.installRg) {
    installRipgrepWindows();
  }

  const ok = await runDoctor(dstRoot);
  if (!ok) throw new Error("Post-install health check failed.");

  console.log("\nDone! Restart Antigravity (or reload window) and open a new conversation to activate agy-dart.");
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.showHelp) {
    printHelp();
    return;
  }
  switch (opts.command) {
    case "install":
      await runInstall(opts);
      break;
    case "mode": {
      if (!(await pathExists(opts.targetDir))) {
        throw new Error(`agy-dart is not installed at ${opts.targetDir}. Run 'install' first.`);
      }
      const cfg = await applyMode(opts.targetDir, opts.mode, opts.isCustomTarget);
      console.log(`Switched agy-dart mode at ${opts.targetDir} -> ${opts.mode} (${cfg.label})`);
      break;
    }
    case "doctor":
    case "status": {
      const ok = await runDoctor(opts.targetDir);
      if (!ok) process.exitCode = 1;
      break;
    }
    case "uninstall": {
      if (path.resolve(opts.targetDir) === path.resolve(REPO_ROOT)) {
        throw new Error("Refusing to delete source repository directory.");
      }
      if (await pathExists(opts.targetDir)) {
        await fs.rm(opts.targetDir, { recursive: true, force: true });
        console.log(`Removed agy-dart from ${opts.targetDir}`);
      } else {
        console.log(`Not installed at ${opts.targetDir}`);
      }
      break;
    }
    default:
      throw new Error(`Unknown command: ${opts.command}`);
  }
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
