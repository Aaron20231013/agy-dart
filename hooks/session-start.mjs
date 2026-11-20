#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ContextModeStore } from "../context/lib/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAST_SNAPSHOT_SCRIPT = path.resolve(__dirname, "..", "fast", "session-start.mjs");

function readStdin(timeoutMs = 1500) {
  return new Promise((resolve) => {
    let data = "";
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(done, timeoutMs);
    timer.unref();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

async function main() {
  const rawInput = (await readStdin()).trim();

  // 1. Reset transient context-mode session overrides so new sessions inherit Lifetime defaults
  try {
    const store = new ContextModeStore();
    store.clearSessionOverrides();
    store.close();
  } catch {
    // Non-blocking: never block session start on DB error
  }

  // 2. Capture compact workspace snapshot from fast/session-start.mjs (with upstream updater disabled)
  let snapshotText = "";
  if (rawInput) {
    try {
      const res = spawnSync(process.execPath, [FAST_SNAPSHOT_SCRIPT], {
        input: rawInput,
        encoding: "utf8",
        timeout: 4000,
        windowsHide: true,
        env: { ...process.env, AGY_FAST_AUTO_UPDATE: "off" }
      });
      if (!res.error && res.status === 0 && res.stdout) {
        const parsed = JSON.parse(res.stdout.trim());
        snapshotText = parsed?.injectSteps?.[0]?.systemMessage?.systemMessage || "";
      }
    } catch {
      // Fail open: fall back to status line only
    }
  }

  const coOpNote =
    "agy-dart active: use agy-dart_fast + parallel ranged read_file for source code search/outline/edits/checks; use agy-dart_context (ctx_execute / ctx_index / ctx_search) for >16 KB logs, large JSON/CSV/API payloads, or long docs/URLs.";

  const mergedText = snapshotText ? `${snapshotText}\n${coOpNote}` : coOpNote;

  process.stdout.write(
    JSON.stringify({
      injectSteps: [
        {
          systemMessage: {
            systemMessage: mergedText
          }
        }
      ]
    }) + "\n"
  );
}

main().catch(() => {
  process.stdout.write(JSON.stringify({}) + "\n");
});
