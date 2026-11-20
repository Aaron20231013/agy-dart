#!/usr/bin/env node
/**
 * Transparent CLI output filter runner for agy-dart PreToolUse.overwrite.
 * Runs the decoded command, preserves exact exit code, compacts noisy output
 * to <= 8.8 KB total inline budget, and indexes raw output into SQLite FTS5.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { enableVersionedCompileCache } from "./compile-cache.mjs";

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024; // 2 MB cap per stream to prevent OOM

function decodePayload(encoded) {
  if (!encoded) return "";
  if (encoded.startsWith("b:")) {
    return Buffer.from(encoded.slice(2), "base64url").toString("utf8");
  }
  return Buffer.from(encoded, "base64").toString("utf8");
}

function parseCliArgs(argv) {
  let ruleId = "";
  let cmdB64 = "";
  let origB64 = "";
  let sessionId = process.env.ANTIGRAVITY_CONVERSATION_ID || "default";
  let noteB64 = "";

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rule" && i + 1 < argv.length) {
      ruleId = argv[++i];
    } else if (a === "--b64" && i + 1 < argv.length) {
      cmdB64 = argv[++i];
    } else if (a === "--orig-b64" && i + 1 < argv.length) {
      origB64 = argv[++i];
    } else if (a === "--session" && i + 1 < argv.length) {
      sessionId = decodePayload(argv[++i]) || sessionId;
    } else if (a === "--note" && i + 1 < argv.length) {
      noteB64 = argv[++i];
    }
  }

  const command = decodePayload(cmdB64);
  const originalCommand = origB64 ? decodePayload(origB64) : command;
  const note = decodePayload(noteB64);
  return { ruleId, command, originalCommand, sessionId, note };
}

function expandHomePrefix(dirPath) {
  if (dirPath === "~") return os.homedir();
  if (dirPath.startsWith("~/") || dirPath.startsWith("~\\")) {
    return path.join(os.homedir(), dirPath.slice(2));
  }
  return dirPath;
}

function runCommandCaptured(command, unwrapFn = null) {
  return new Promise((resolve) => {
    const parts = typeof unwrapFn === "function" ? unwrapFn(command) : null;
    let execCwd = process.cwd();
    let execCmd = command;
    let mergeStderrToStdout = false;

    if (parts) {
      execCmd = parts.innerCommand;
      mergeStderrToStdout = Boolean(parts.hasStderrRedirect);
      if (parts.cdPath) {
        execCwd = path.resolve(process.cwd(), expandHomePrefix(parts.cdPath));
        try {
          if (!fs.statSync(execCwd).isDirectory()) {
            resolve({
              stdout: "",
              stderr: `cd: not a directory: ${parts.cdPath}\n`,
              exitCode: 1,
              truncatedCapture: false
            });
            return;
          }
        } catch {
          resolve({
            stdout: "",
            stderr: `cd: no such file or directory: ${parts.cdPath}\n`,
            exitCode: 1,
            truncatedCapture: false
          });
          return;
        }
      }
    }

    // On Windows, cmd.exe strips '^' (e.g. git diff HEAD^), expands '%...%', and misparses single quotes.
    // Route those commands through PowerShell (preserving exact $LASTEXITCODE) while keeping fast cmd.exe
    // for plain cross-shell CLIs. Since safe leading `cd ... &&` is already resolved via execCwd, PowerShell
    // never trips on Windows PowerShell 5.1's lack of `&&` support.
    const usePowerShell = process.platform === "win32" && /['^%]/.test(execCmd) && !/&&/.test(execCmd);
    const psCommand = usePowerShell
      ? `${execCmd}\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }\nif (-not $?) { exit 1 }\nexit 0`
      : null;

    const child = usePowerShell
      ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psCommand], {
          cwd: execCwd,
          env: process.env,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"]
        })
      : spawn(execCmd, {
          shell: true,
          cwd: execCwd,
          env: process.env,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"]
        });

    const outChunks = [];
    const errChunks = [];
    let outLen = 0;
    let errLen = 0;
    let truncatedCapture = false;

    const appendOut = (chunk) => {
      if (outLen < MAX_CAPTURE_BYTES) {
        const take = Math.min(chunk.length, MAX_CAPTURE_BYTES - outLen);
        outChunks.push(take === chunk.length ? chunk : chunk.subarray(0, take));
        outLen += take;
      } else {
        truncatedCapture = true;
      }
    };

    child.stdout.on("data", appendOut);

    child.stderr.on("data", (chunk) => {
      if (mergeStderrToStdout) {
        appendOut(chunk);
        return;
      }
      if (errLen < MAX_CAPTURE_BYTES) {
        const take = Math.min(chunk.length, MAX_CAPTURE_BYTES - errLen);
        errChunks.push(take === chunk.length ? chunk : chunk.subarray(0, take));
        errLen += take;
      } else {
        truncatedCapture = true;
      }
    });

    const onSignal = (sig) => {
      try {
        child.kill(sig);
      } catch {}
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    child.on("error", (err) => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolve({
        stdout: "",
        stderr: `Failed to execute command: ${err.message}`,
        exitCode: 1,
        truncatedCapture: false
      });
    });

    child.on("close", (code, signal) => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolve({
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        exitCode: code !== null && code !== undefined ? code : signal ? 1 : 0,
        truncatedCapture
      });
    });
  });
}

function extractCompactVerdict(filteredText, exitCode) {
  const lines = String(filteredText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("[agy-dart cli-filter:"));
  if (lines.length === 0) return exitCode === 0 ? "passed (exit 0)" : `failed (exit ${exitCode})`;
  const priorityRe =
    exitCode !== 0
      ? /(?:FAIL|ERROR|ERR!|AssertionError|✖|not ok|\b[1-9]\d*\s+failed\b|exit\s+[1-9])/i
      : /(?:pass|passed|tests\s+\d+|ok\b|built|compiled|0\s+errors|succeeded|done)/i;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (priorityRe.test(lines[i])) return lines[i].slice(0, 200);
  }
  return lines[lines.length - 1].slice(0, 200);
}

async function main() {
  enableVersionedCompileCache();

  const { ruleId, command, originalCommand, sessionId, note } = parseCliArgs(process.argv);
  if (!command) {
    process.stderr.write("agy-dart cli-filter: missing --b64 command\n");
    process.exit(2);
  }

  const { applyFilterRule, MAX_FILTERED_OUTPUT_BYTES, unwrapSafeCompoundCommand } = await import(
    "./filter-rules.mjs"
  );
  const [res, { ContextModeStore }, { redactSecrets }] = await Promise.all([
    runCommandCaptured(command, unwrapSafeCompoundCommand),
    import("../context/lib/store.js"),
    import("../context/lib/security.js")
  ]);

  const redOut = redactSecrets(res.stdout || "");
  const redErr = redactSecrets(res.stderr || "");
  const safeStdout = redOut.text;
  const safeStderr = redErr.text;

  const rawCombined =
    safeStdout +
    (safeStderr ? (safeStdout && !safeStdout.endsWith("\n") ? "\n" : "") + safeStderr : "");
  const rawBytes = Buffer.byteLength(rawCombined, "utf8");

  let sourceId = null;
  let store = null;

  // Index full raw output (redacted) into SQLite FTS5 when non-trivial so filtered details stay searchable
  if (rawBytes >= 2048 || (res.exitCode !== 0 && rawBytes >= 1024)) {
    try {
      store = new ContextModeStore();
      const indexed = store.indexContent({
        sessionId,
        worktree: process.cwd(),
        agent: "antigravity",
        kind: "tool_output",
        label: `cli:${ruleId || "cmd"} ${originalCommand.slice(0, 60)}`,
        content: rawCombined,
        dedup: true
      });
      sourceId = indexed.sourceId;
    } catch {
      // Fail-open: never break command output on DB error
    }
  }

  const totalRedacted = redOut.redactedCount + redErr.redactedCount;
  const effectiveNote = [
    note,
    res.truncatedCapture ? "raw stream capped at 2MB" : "",
    totalRedacted > 0 ? `redacted ${totalRedacted} secret(s)` : ""
  ]
    .filter(Boolean)
    .join("; ");

  const filtered = applyFilterRule(ruleId, safeStdout, safeStderr, res.exitCode, {
    cwd: process.cwd(),
    maxBytes: MAX_FILTERED_OUTPUT_BYTES,
    note: effectiveNote || null,
    sourceId
  });

  // Record telemetry & session verification checkpoint for Sidecar dashboard, ctx_stats & ctx_resume
  try {
    if (!store) store = new ContextModeStore();
    if (filtered.wasFiltered || rawBytes > 0) {
      store.recordEvent({
        sessionId,
        worktree: process.cwd(),
        agent: "antigravity",
        kind: "cli_filter",
        tool: "run_command",
        key: ruleId || "generic",
        path: originalCommand.slice(0, 120),
        ok: res.exitCode === 0 ? 1 : 0,
        exitCode: res.exitCode,
        bytes: filtered.rawBytes,
        body: filtered.filteredText.slice(0, 500),
        sandboxBytes: filtered.rawBytes,
        returnedBytes: filtered.filteredBytes
      });
    }
    if (ruleId === "test-runner" || ruleId === "playwright" || ruleId === "build-lint" || ruleId === "docker-build") {
      store.recordVerificationResult(sessionId, {
        kind: ruleId === "test-runner" || ruleId === "playwright" ? "test" : "build",
        command: originalCommand,
        ruleId,
        exitCode: res.exitCode,
        passed: res.exitCode === 0,
        summary: extractCompactVerdict(filtered.filteredText, res.exitCode),
        sourceId,
        worktree: process.cwd()
      });
    }
  } catch {
    // Fail-open
  } finally {
    if (store) {
      try {
        store.close();
      } catch {}
    }
  }

  if (filtered.filteredText) {
    process.stdout.write(
      filtered.filteredText.endsWith("\n") ? filtered.filteredText : `${filtered.filteredText}\n`
    );
  }
  process.exit(res.exitCode);
}

main().catch((err) => {
  process.stderr.write(`agy-dart cli-filter error: ${err?.message || err}\n`);
  process.exit(1);
});
