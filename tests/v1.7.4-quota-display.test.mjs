import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  buildStatusLineSetupInfo,
  collectLocalRollingUsage,
  formatStatusLineOutput,
  MAX_QUOTA_BUCKETS,
  normalizeStatusLineQuotaPayload,
  projectQuotaSnapshot,
  QUOTA_STATUSLINE_META_KEY,
  readStatusLineQuotaSnapshot,
  saveStatusLineQuotaSnapshot
} from "../context/lib/quota.js";
import { ContextModeStore } from "../context/lib/store.js";
import { resetConfigCache } from "../context/lib/config.js";
import {
  closeRuntimeStore,
  createStandaloneServer,
  registerSidecarRoutes
} from "../sidecars/dashboard/server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function httpRawRequest(port, urlPath, { method = "POST", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const reqHeaders = { Host: `127.0.0.1:${port}`, ...headers };
    if (body !== null && body !== undefined && reqHeaders["Content-Length"] === undefined) {
      reqHeaders["Content-Length"] = Buffer.byteLength(body, "utf8");
    }
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: reqHeaders
      },
      (res) => {
        let raw = "";
        res.on("data", (d) => (raw += d.toString("utf8")));
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
    if (body !== null && body !== undefined) req.write(body);
    req.end();
  });
}

function writeTranscriptFile(rootDir, convId, relParts, lines, mtimeMs) {
  const fullPath = path.join(rootDir, convId, ...relParts);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  const sec = mtimeMs / 1000;
  fs.utimesSync(fullPath, sec, sec);
  return fullPath;
}

test("v1.7.4-1: normalizeStatusLineQuotaPayload, projectQuotaSnapshot, and formatStatusLineOutput handle valid, edge, and malformed payloads", () => {
  const baseNow = Date.parse("2026-11-25T10:00:00.000Z");

  // Malformed / empty inputs return null safely
  for (const bad of [null, undefined, "", "   ", "{bad json", "[]", 42, {}]) {
    assert.equal(normalizeStatusLineQuotaPayload(bad, { nowMs: baseNow }), null);
  }

  // Official Antigravity CLI statusLine schema
  const sample = {
    product: "antigravity",
    version: "1.4.5",
    agent_state: "idle",
    model: {
      id: "Gemini 4 Neon (High)",
      display_name: "Gemini 4 Neon (High)",
      effort: "high"
    },
    context_window: {
      used_percentage: 14.24,
      remaining_percentage: 85.76
    },
    quota: {
      "3p-weekly": { remaining_fraction: 0.42, reset_in_seconds: 86400 },
      "gemini-weekly": { remaining_fraction: 0.9378, reset_time: "2026-12-01T10:00:00.000Z" },
      "3p-5h": { remaining_fraction: 0.15, reset_in_seconds: 3600 },
      "gemini-5h": { remaining_fraction: 0.979, reset_in_seconds: 15120 }
    }
  };

  const norm = normalizeStatusLineQuotaPayload(sample, { nowMs: baseNow });
  assert.ok(norm);
  assert.equal(norm.buckets.length, 4);
  // Deterministic priority order: gemini-5h, gemini-weekly, 3p-5h, 3p-weekly
  assert.deepEqual(
    norm.buckets.map((b) => b.id),
    ["gemini-5h", "gemini-weekly", "3p-5h", "3p-weekly"]
  );
  assert.equal(norm.buckets[0].label, "Gemini 5h");
  assert.equal(norm.buckets[2].label, "3P 5h");
  assert.equal(norm.contextWindow.usedPercentage, 14.24);

  // Live projection at capture time
  const liveProj = projectQuotaSnapshot(norm, { nowMs: baseNow });
  assert.equal(liveProj.available, true);
  assert.equal(liveProj.freshness, "live");
  assert.equal(liveProj.overallSeverity, "critical"); // 3p-5h is 15% < 20%
  assert.equal(liveProj.lowestBucket.id, "3p-5h");
  assert.equal(liveProj.buckets[0].remainingPercent, 97.9);
  assert.equal(liveProj.buckets[0].severity, "ok");
  assert.equal(liveProj.buckets[2].severity, "critical");
  assert.equal(liveProj.buckets[3].severity, "warn");

  // Aging (30 min later) & stale (3 hours later)
  const agingProj = projectQuotaSnapshot(norm, { nowMs: baseNow + 30 * 60 * 1000 });
  assert.equal(agingProj.freshness, "aging");
  const staleProj = projectQuotaSnapshot(norm, { nowMs: baseNow + 3 * 3600 * 1000 });
  assert.equal(staleProj.freshness, "stale");
  assert.equal(staleProj.buckets[2].isResetElapsed, true);

  // CLI single-line formatting selects active model family (Gemini -> gemini-5h & gemini-weekly)
  const line = formatStatusLineOutput(norm, { nowMs: baseNow });
  assert.ok(!line.includes("\n") && !line.includes("\r"));
  assert.ok(line.includes("agy-dart"));
  assert.ok(line.includes("Gemini 4 Neon (High)"));
  assert.ok(line.includes("Ctx 14%"));
  assert.ok(line.includes("5h 98%"));
  assert.ok(line.includes("7d 94%"));

  // Oversized bucket DoS cap & fraction clamping
  const hugeQuota = {};
  for (let i = 0; i < 40; i++) {
    hugeQuota[`bucket-${i}`] = { remaining_fraction: i === 0 ? 1.8 : i === 1 ? -0.4 : 0.5 };
  }
  const capped = normalizeStatusLineQuotaPayload({ product: "antigravity", quota: hugeQuota }, { nowMs: baseNow });
  assert.equal(capped.buckets.length, MAX_QUOTA_BUCKETS);
  assert.equal(capped.buckets.find((b) => b.id === "bucket-0").remainingFraction, 1);
  assert.equal(capped.buckets.find((b) => b.id === "bucket-1").remainingFraction, 0);
});

test("v1.7.4-2: saveStatusLineQuotaSnapshot preserves prior buckets on transient empty quota ticks and survives single-session purge", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-quota-store-"));
  const dbPath = path.join(tmpDir, "context.db");
  const store = new ContextModeStore({ dbPath });
  t.after(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  store.open();

  const t0 = Date.parse("2026-11-25T10:00:00.000Z");
  const saved1 = saveStatusLineQuotaSnapshot(
    store,
    {
      product: "antigravity",
      model: { display_name: "Gemini 4 Neon" },
      quota: { "gemini-5h": { remaining_fraction: 0.85, reset_in_seconds: 7200 } }
    },
    { nowMs: t0 }
  );
  assert.equal(saved1.saved, true);
  assert.ok(store.getMeta(QUOTA_STATUSLINE_META_KEY, null));

  // Transient CLI tick without quota buckets keeps prior buckets
  const saved2 = saveStatusLineQuotaSnapshot(
    store,
    {
      product: "antigravity",
      model: { display_name: "Claude Sonnet 4.5" },
      quota: {}
    },
    { nowMs: t0 + 60_000 }
  );
  assert.equal(saved2.saved, true);
  const readBack = readStatusLineQuotaSnapshot(store, { nowMs: t0 + 60_000 });
  assert.equal(readBack.buckets.length, 1);
  assert.equal(readBack.buckets[0].id, "gemini-5h");
  assert.equal(readBack.model.displayName, "Claude Sonnet 4.5");

  // Single-session purge must NOT wipe account-level quota snapshot
  store.purge({ scope: "session", sessionId: "some-conv-123" });
  const afterPurge = readStatusLineQuotaSnapshot(store, { nowMs: t0 + 60_000 });
  assert.equal(afterPurge.buckets.length, 1);
});

test("v1.7.4-3: hooks/statusline.mjs and bin/agy-dart.mjs statusline/quota work end-to-end with 0-byte stderr", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-statusline-cli-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const dbPath = path.join(tmpDir, "context.db");
  const brainRoot = path.join(tmpDir, "brain");
  fs.mkdirSync(brainRoot, { recursive: true });

  const nowMs = Date.now();
  writeTranscriptFile(
    brainRoot,
    "conv-cli-e2e",
    [".system_generated", "logs", "transcript.jsonl"],
    [
      {
        type: "PLANNER_RESPONSE",
        created_at: new Date(nowMs - 30 * 60 * 1000).toISOString(),
        model: "gemini-4-neon",
        usage: { input_tokens: 1200, cache_read_input_tokens: 4800, output_tokens: 600 }
      }
    ],
    nowMs - 30 * 60 * 1000
  );

  const env = {
    ...process.env,
    AGY_DART_DB_PATH: dbPath,
    AGY_DART_QUOTA_BRAIN_ROOTS: brainRoot
  };

  // 1. Setup snippet output is valid JSON pointing to hooks/statusline.mjs
  const snipRun = spawnSync(process.execPath, [path.join(ROOT, "hooks", "statusline.mjs"), "--setup-snippet"], {
    encoding: "utf8",
    env,
    windowsHide: true
  });
  assert.equal(snipRun.status, 0);
  assert.equal(snipRun.stderr, "");
  const snipParsed = JSON.parse(snipRun.stdout);
  assert.equal(snipParsed.statusLine.type, "command");
  assert.ok(snipParsed.statusLine.command.includes("hooks/statusline.mjs"));

  // 2. Pipe official statusLine payload via stdin to `bin/agy-dart.mjs statusline`
  const stdinPayload = JSON.stringify({
    product: "antigravity",
    model: { id: "gemini-4-neon", display_name: "Gemini 4 Neon" },
    context_window: { used_percentage: 22.5, remaining_percentage: 77.5 },
    quota: {
      "gemini-5h": { remaining_fraction: 0.76, reset_in_seconds: 5400 },
      "gemini-weekly": { remaining_fraction: 0.91, reset_in_seconds: 345600 }
    }
  });
  const slRun = spawnSync(process.execPath, [path.join(ROOT, "bin", "agy-dart.mjs"), "statusline"], {
    input: stdinPayload,
    encoding: "utf8",
    env,
    windowsHide: true
  });
  assert.equal(slRun.status, 0);
  assert.equal(slRun.stderr, "");
  assert.ok(slRun.stdout.trim().startsWith("agy-dart | Gemini 4 Neon | Ctx 23% | 5h 76%"));

  // 3. Fail-open on corrupt stdin
  const badRun = spawnSync(process.execPath, [path.join(ROOT, "hooks", "statusline.mjs")], {
    input: "{not valid json",
    encoding: "utf8",
    env,
    windowsHide: true
  });
  assert.equal(badRun.status, 0);
  assert.equal(badRun.stderr, "");
  assert.equal(badRun.stdout.trim(), "agy-dart");

  // 4. `bin/agy-dart.mjs quota --json` returns persisted official snapshot + local 5h/7d spend
  const qRun = spawnSync(process.execPath, [path.join(ROOT, "bin", "agy-dart.mjs"), "quota", "--json"], {
    encoding: "utf8",
    env,
    windowsHide: true
  });
  assert.equal(qRun.status, 0);
  assert.equal(qRun.stderr, "");
  const qJson = JSON.parse(qRun.stdout);
  assert.equal(qJson.ok, true);
  assert.equal(qJson.official.available, true);
  assert.equal(qJson.official.buckets.length, 2);
  assert.equal(qJson.official.buckets[0].remainingPercent, 76);
  assert.equal(qJson.local.window5h.turns, 1);
  assert.equal(qJson.local.window5h.totalTokens, 6600);
  assert.equal(qJson.local.window5h.nonCachedTokens, 1800);
  assert.equal(qJson.local.window5h.byFamily.gemini.turns, 1);

  // 5. `--chain-script` persists to agy-dart AND forwards identical stdin to downstream Node script, with self-recursion guard
  const downstreamMarker = path.join(tmpDir, "downstream-received.json");
  const downstreamScript = path.join(tmpDir, "downstream-statusline.mjs");
  fs.writeFileSync(
    downstreamScript,
    `import fs from "node:fs";
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(downstreamMarker)}, raw, "utf8");
  process.stdout.write("downstream-bar | OK\\n");
});
`,
    "utf8"
  );
  const chainPayload = JSON.stringify({
    product: "antigravity",
    model: { display_name: "Gemini 4 Neon" },
    quota: { "gemini-5h": { remaining_fraction: 0.52, reset_in_seconds: 1800 } }
  });
  const chainRun = spawnSync(
    process.execPath,
    [path.join(ROOT, "hooks", "statusline.mjs"), "--chain-script", downstreamScript],
    { input: chainPayload, encoding: "utf8", env, windowsHide: true }
  );
  assert.equal(chainRun.status, 0);
  assert.equal(chainRun.stderr, "");
  assert.equal(chainRun.stdout.trim(), "downstream-bar | OK");
  assert.equal(fs.readFileSync(downstreamMarker, "utf8"), chainPayload);

  // Verify agy-dart ALSO persisted the updated 52% quota from the chained run
  const qAfterChain = spawnSync(process.execPath, [path.join(ROOT, "hooks", "statusline.mjs"), "--report", "--json"], {
    encoding: "utf8",
    env,
    windowsHide: true
  });
  assert.equal(qAfterChain.status, 0);
  assert.equal(JSON.parse(qAfterChain.stdout).official.buckets[0].remainingPercent, 52);

  // Self-chaining must be safely blocked (no recursion, falls back cleanly to agy-dart line)
  const selfChainRun = spawnSync(
    process.execPath,
    [path.join(ROOT, "hooks", "statusline.mjs"), "--chain-script", path.join(ROOT, "hooks", "statusline.mjs")],
    { input: chainPayload, encoding: "utf8", env, windowsHide: true }
  );
  assert.equal(selfChainRun.status, 0);
  assert.equal(selfChainRun.stderr, "");
  assert.ok(selfChainRun.stdout.trim().startsWith("agy-dart | Gemini 4 Neon | 5h 52%"));
});

test("v1.7.4-4: collectLocalRollingUsage enforces 5h/7d windows, avoids transcript_full double-count, detects real 429s only, caches by mtime, and blocks escaping symlinks", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-local-rolling-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const brainRoot = path.join(tmpDir, "brain");
  const outsideDir = path.join(tmpDir, "outside");
  fs.mkdirSync(brainRoot, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });

  const nowMs = Date.parse("2026-11-25T12:00:00.000Z");
  const ts2h = nowMs - 2 * 3600 * 1000;
  const ts1h = nowMs - 1 * 3600 * 1000;
  const ts10h = nowMs - 10 * 3600 * 1000;
  const ts10d = nowMs - 10 * 24 * 3600 * 1000;

  // Conv A (2h ago, Gemini): both transcript.jsonl and transcript_full.jsonl exist -> MUST NOT double count
  const convASteps = [
    {
      type: "PLANNER_RESPONSE",
      created_at: new Date(ts2h).toISOString(),
      model: "gemini-4-neon",
      usage: { input_tokens: 1000, cache_read_input_tokens: 9000, output_tokens: 500, thinking_tokens: 200 }
    }
  ];
  writeTranscriptFile(brainRoot, "conv-a", [".system_generated", "logs", "transcript.jsonl"], convASteps, ts2h);
  writeTranscriptFile(brainRoot, "conv-a", [".system_generated", "logs", "transcript_full.jsonl"], convASteps, ts2h);

  // Conv B (10h ago, Claude): in 7d only; contains 1 real ERROR 429 + 1 normal prose mention of "429"
  writeTranscriptFile(
    brainRoot,
    "conv-b",
    [".system_generated", "logs", "transcript.jsonl"],
    [
      {
        type: "PLANNER_RESPONSE",
        created_at: new Date(ts10h).toISOString(),
        model: "claude-sonnet-4-5",
        content: "Let us handle HTTP 429 RESOURCE_EXHAUSTED errors cleanly in retry logic.",
        usage: { input_tokens: 2000, cache_read_input_tokens: 3000, output_tokens: 1000 }
      },
      {
        type: "ERROR_MESSAGE",
        status: "ERROR",
        created_at: new Date(ts10h + 1000).toISOString(),
        error: "HTTP 429 RESOURCE_EXHAUSTED: quota exceeded"
      }
    ],
    ts10h + 1000
  );

  // Conv C (10 days ago, GPT): outside 7d window -> excluded
  writeTranscriptFile(
    brainRoot,
    "conv-c",
    [".system_generated", "logs", "transcript.jsonl"],
    [
      {
        type: "PLANNER_RESPONSE",
        created_at: new Date(ts10d).toISOString(),
        model: "gpt-5",
        usage: { input_tokens: 99999, output_tokens: 99999 }
      }
    ],
    ts10d
  );

  // Conv D (1h ago): real 429 inside 5h window
  writeTranscriptFile(
    brainRoot,
    "conv-d",
    [".system_generated", "logs", "transcript.jsonl"],
    [
      {
        type: "PLANNER_RESPONSE",
        status: "ERROR",
        created_at: new Date(ts1h).toISOString(),
        model: "gpt-5",
        error: "rate limit reached (429)",
        usage: { input_tokens: 500, output_tokens: 100 }
      }
    ],
    ts1h
  );

  // Escaping symlink test (best-effort on platforms allowing symlinks without elevated privileges)
  const outsideFile = path.join(outsideDir, "secret-transcript.jsonl");
  fs.writeFileSync(
    outsideFile,
    JSON.stringify({
      type: "PLANNER_RESPONSE",
      created_at: new Date(ts1h).toISOString(),
      model: "gemini-4-neon",
      usage: { input_tokens: 777777, output_tokens: 111111 }
    }) + "\n",
    "utf8"
  );
  const escapeLogsDir = path.join(brainRoot, "conv-escape", ".system_generated", "logs");
  fs.mkdirSync(escapeLogsDir, { recursive: true });
  try {
    fs.symlinkSync(outsideFile, path.join(escapeLogsDir, "transcript.jsonl"), "file");
  } catch {
    // Windows without Developer Mode may disallow file symlinks; skip link creation cleanly
  }

  const cache = new Map();
  const res1 = collectLocalRollingUsage({
    roots: [brainRoot],
    includeDefaultRoots: false,
    nowMs,
    cache
  });

  // 5h window: Conv A (10700 tok, 1700 non-cached) + Conv D (600 tok, 600 non-cached)
  assert.equal(res1.window5h.turns, 2);
  assert.equal(res1.window5h.sessions, 2);
  assert.equal(res1.window5h.totalTokens, 11300);
  assert.equal(res1.window5h.nonCachedTokens, 2300);
  assert.equal(res1.window5h.byFamily.gemini.totalTokens, 10700);
  assert.equal(res1.window5h.byFamily.gpt.totalTokens, 600);
  assert.equal(res1.window5h.byFamily.claude.totalTokens, 0);
  assert.equal(res1.rateLimitHits5h, 1);

  // 7d window: adds Conv B (6000 tok, 3000 non-cached, 1 real rate limit); excludes Conv C (10d) & symlink
  assert.equal(res1.window7d.turns, 3);
  assert.equal(res1.window7d.sessions, 3);
  assert.equal(res1.window7d.totalTokens, 17300);
  assert.equal(res1.window7d.nonCachedTokens, 5300);
  assert.equal(res1.window7d.byFamily.claude.totalTokens, 6000);
  assert.equal(res1.rateLimitHits7d, 2);
  assert.equal(res1.hourlyBuckets.length, 5);
  assert.equal(res1.dailyBuckets.length, 7);
  assert.equal(res1.parsedFiles, 3);
  assert.equal(res1.cacheHits, 0);

  // Second call hits incremental mtime/size cache with 0 reparses
  const res2 = collectLocalRollingUsage({
    roots: [brainRoot],
    includeDefaultRoots: false,
    nowMs,
    cache
  });
  assert.equal(res2.cacheHits, 3);
  assert.equal(res2.parsedFiles, 0);
  assert.equal(res2.window7d.totalTokens, 17300);
});

test("v1.7.4-5: Sidecar /api/quota enforces CSRF + POST-only SidecarApp parity and index.html quota card compiles cleanly", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-quota-sidecar-"));
  const dbPath = path.join(tmpDir, "context.db");
  const brainRoot = path.join(tmpDir, "brain");
  fs.mkdirSync(brainRoot, { recursive: true });

  const prevDb = process.env.AGY_DART_DB_PATH;
  const prevRoots = process.env.AGY_DART_QUOTA_BRAIN_ROOTS;
  process.env.AGY_DART_DB_PATH = dbPath;
  process.env.AGY_DART_QUOTA_BRAIN_ROOTS = brainRoot;
  resetConfigCache();
  closeRuntimeStore();

  const nowMs = Date.now();
  writeTranscriptFile(
    brainRoot,
    "conv-sidecar-q",
    [".system_generated", "logs", "transcript.jsonl"],
    [
      {
        type: "PLANNER_RESPONSE",
        created_at: new Date(nowMs - 15 * 60 * 1000).toISOString(),
        model: "gemini-4-neon",
        usage: { input_tokens: 4000, cache_read_input_tokens: 16000, output_tokens: 1000 }
      }
    ],
    nowMs - 15 * 60 * 1000
  );

  // Seed an official statusLine snapshot into the isolated DB
  const seedStore = new ContextModeStore({ dbPath });
  seedStore.open();
  saveStatusLineQuotaSnapshot(
    seedStore,
    {
      product: "antigravity",
      model: { display_name: "Gemini 4 Neon" },
      quota: {
        "gemini-5h": { remaining_fraction: 0.64, reset_in_seconds: 9000 },
        "gemini-weekly": { remaining_fraction: 0.88, reset_in_seconds: 400000 }
      }
    },
    { nowMs }
  );
  seedStore.close();

  const csrfToken = "test-quota-csrf-token-123456";
  const server = createStandaloneServer({ csrfToken });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeRuntimeStore();
    if (prevDb === undefined) delete process.env.AGY_DART_DB_PATH;
    else process.env.AGY_DART_DB_PATH = prevDb;
    if (prevRoots === undefined) delete process.env.AGY_DART_QUOTA_BRAIN_ROOTS;
    else process.env.AGY_DART_QUOTA_BRAIN_ROOTS = prevRoots;
    resetConfigCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 1. Missing CSRF token -> 403
  const noTok = await httpRawRequest(port, "/api/quota", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  assert.equal(noTok.status, 403);

  // 2. Invalid forceRefresh type -> 400
  const badField = await httpRawRequest(port, "/api/quota", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Agy-Dart-Token": csrfToken
    },
    body: JSON.stringify({ forceRefresh: "yes" })
  });
  assert.equal(badField.status, 400);

  // 3. Authenticated POST /api/quota -> 200 with official + local + setup
  const okPost = await httpRawRequest(port, "/api/quota", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Agy-Dart-Token": csrfToken
    },
    body: JSON.stringify({ forceRefresh: true })
  });
  assert.equal(okPost.status, 200);
  assert.equal(okPost.json.ok, true);
  assert.equal(okPost.json.official.available, true);
  assert.equal(okPost.json.official.buckets[0].remainingPercent, 64);
  assert.equal(okPost.json.local.window5h.totalTokens, 21000);
  assert.ok(okPost.json.setup.snippetJson.includes("hooks/statusline.mjs"));

  // 4. Authenticated GET /api/quota -> 200
  const okGet = await httpRawRequest(port, "/api/quota?forceRefresh=false", {
    method: "GET",
    headers: { "X-Agy-Dart-Token": csrfToken }
  });
  assert.equal(okGet.status, 200);
  assert.equal(okGet.json.official.buckets.length, 2);

  // 5. SidecarApp mode registers /api/quota strictly as POST-only
  const registered = [];
  registerSidecarRoutes({
    config: { conversationId: "default" },
    api(routePath, handler, method) {
      registered.push({ routePath, handler, method });
    }
  });
  const quotaRoute = registered.find((r) => r.routePath === "/api/quota");
  assert.ok(quotaRoute, "registerSidecarRoutes must register /api/quota");
  assert.equal(quotaRoute.method, "POST", "/api/quota must be POST-only in SidecarApp mode");
  const sidecarRes = quotaRoute.handler({ forceRefresh: true });
  assert.equal(sidecarRes.ok, true);
  assert.equal(sidecarRes.official.buckets[0].id, "gemini-5h");

  // 6. index.html contains #quota-card, /api/quota, EN & ZH labels, and parses with valid JS syntax
  const html = fs.readFileSync(path.join(ROOT, "sidecars", "dashboard", "index.html"), "utf8");
  assert.ok(html.includes('id="quota-card"'));
  assert.ok(html.includes("/api/quota"));
  assert.ok(html.includes("Remaining Quota & Rolling Spend"));
  assert.ok(html.includes("剩余额度与滚动消耗"));
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1])
    .filter((s) => s.trim().length > 0);
  assert.ok(scripts.length >= 1);
  for (const src of scripts) {
    assert.doesNotThrow(() => new vm.Script(src));
  }
  assert.ok(buildStatusLineSetupInfo(ROOT).scriptPath.endsWith(path.join("hooks", "statusline.mjs")));
});
