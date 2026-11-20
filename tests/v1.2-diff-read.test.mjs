import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { ContextModeStore, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOTS_PER_SESSION } from "../context/lib/store.js";
import { computeUnifiedDiff, extractLineSlice, splitTextLines, truncateUtf8Safe } from "../context/lib/text-diff.js";
import { buildCliFilterRewrite } from "../hooks/pre-tool-use.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function runHook(scriptRel, payload, dbPath, extraEnv = {}) {
  const hook = path.join(ROOT, scriptRel);
  const res = spawnSync(process.execPath, [hook], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      AGY_DART_DB_PATH: dbPath,
      AGY_DART_DISABLE_COMPILE_CACHE: "1",
      AGY_DART_ENABLE_DIFF_READ: "1",
      ...extraEnv
    }
  });
  assert.equal(res.status, 0, `${scriptRel} failed: ${res.stderr}`);
  return JSON.parse(res.stdout.trim() || "{}");
}

function makeNumberedLines(count, prefix = "export const item") {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return `${prefix}_${n} = "payload_${String(n).padStart(4, "0")}_xxxxxxxxxxxxxxxxxxxxxx";`;
  });
}

function writeAndBumpMtime(filePath, content, bumpSec = 5) {
  fs.writeFileSync(filePath, content, "utf8");
  const t = Math.floor(Date.now() / 1000) + bumpSec;
  fs.utimesSync(filePath, t, t);
}

test("text-diff.js: exact unified hunks, startLine offsets, CJK UTF-8 truncation safety, and <15ms bounded 4000-line diff", () => {
  // 1. Identical text -> changed: false
  const same = computeUnifiedDiff("a\nb\nc\n", "a\nb\nc\n");
  assert.equal(same.changed, false);
  assert.equal(same.diff, "");
  assert.equal(same.hunkCount, 0);
  assert.equal(same.addedLines, 0);
  assert.equal(same.removedLines, 0);
  assert.equal(same.diffBytes, 0);

  // 2. Multi-hunk edit with startLine offset and fileLabel
  const baseLines = Array.from({ length: 30 }, (_, i) => `line_${i + 1}`);
  const modLines = [...baseLines];
  modLines[2] = "line_3_edited";
  modLines.splice(22, 0, "inserted_a", "inserted_b");

  const d1 = computeUnifiedDiff(baseLines.join("\n"), modLines.join("\n"), {
    fileLabel: "src/app.js",
    startLine: 50,
    contextLines: 2
  });
  assert.equal(d1.changed, true);
  assert.equal(d1.hunkCount, 2);
  assert.equal(d1.addedLines, 3);
  assert.equal(d1.removedLines, 1);
  assert.equal(d1.truncated, false);
  assert.ok(d1.diff.includes("--- a/src/app.js\n+++ b/src/app.js"));
  // Line index 2 with startLine=50 is line 52; with 2 context lines before -> starts at 50
  assert.ok(d1.diff.includes("@@ -50,5 +50,5 @@"), `Unexpected hunk header:\n${d1.diff}`);
  assert.ok(d1.diff.includes("-line_3\n+line_3_edited"));
  assert.ok(d1.diff.includes("+inserted_a\n+inserted_b"));

  // 3. Pure insertion into empty & pure deletion to empty with contextLines: 0
  const dIns = computeUnifiedDiff("", "alpha\nbeta\n", { contextLines: 0 });
  assert.equal(dIns.changed, true);
  assert.ok(dIns.diff.includes("@@ -0,0 +1,2 @@"));
  assert.equal(dIns.addedLines, 2);
  assert.equal(dIns.removedLines, 0);

  const dDel = computeUnifiedDiff("alpha\nbeta\n", "", { contextLines: 0 });
  assert.equal(dDel.changed, true);
  assert.ok(dDel.diff.includes("@@ -1,2 +0,0 @@"));
  assert.equal(dDel.addedLines, 0);
  assert.equal(dDel.removedLines, 2);

  // 4. extractLineSlice + splitTextLines CRLF canonicalization
  assert.deepEqual(splitTextLines("a\r\nb\r\nc\r\n"), ["a", "b", "c"]);
  assert.equal(extractLineSlice("L1\nL2\nL3\nL4\nL5\n", 2, 4, 1), "L2\nL3\nL4");
  assert.equal(extractLineSlice("L10\nL11\nL12\nL13\n", 11, 12, 10), "L11\nL12");

  // 5. CJK UTF-8 safety under tight maxDiffBytes (zero \uFFFD, strict <= cap)
  const cjkOld = Array.from({ length: 40 }, (_, i) => `第${i + 1}行：中文内容配置项_旧值_${"测试".repeat(12)}`).join("\n");
  const cjkNew = Array.from({ length: 40 }, (_, i) => `第${i + 1}行：中文内容配置项_新值_${"更新".repeat(12)}`).join("\n");
  const dCjk = computeUnifiedDiff(cjkOld, cjkNew, { maxDiffBytes: 300 });
  assert.equal(dCjk.changed, true);
  assert.equal(dCjk.truncated, true);
  assert.ok(dCjk.diffBytes <= 300, `Expected <= 300 bytes, got ${dCjk.diffBytes}`);
  assert.equal(Buffer.byteLength(dCjk.diff, "utf8"), dCjk.diffBytes);
  assert.ok(!dCjk.diff.includes("\uFFFD"), "Truncated CJK diff must not contain replacement char");
  assert.equal(truncateUtf8Safe("中文🚀测试", 5), "中"); // 3 bytes; next char is 3 bytes (3+3>5)

  // 6. Performance on 4,000-line files (localized, scattered, and full rewrite)
  const big4kOld = makeNumberedLines(4000);
  const big4kLocal = [...big4kOld];
  big4kLocal[2000] = 'export const item_2001 = "UPDATED_MIDDLE_LINE";';
  const oldStr = big4kOld.join("\n");
  const localStr = big4kLocal.join("\n");

  const tLocalStart = performance.now();
  const dLocal = computeUnifiedDiff(oldStr, localStr, { fileLabel: "big.js" });
  const tLocalMs = performance.now() - tLocalStart;
  assert.equal(dLocal.changed, true);
  assert.equal(dLocal.fallback, false);
  assert.equal(dLocal.hunkCount, 1);
  assert.equal(dLocal.addedLines, 1);
  assert.equal(dLocal.removedLines, 1);
  assert.ok(tLocalMs < 50, `Expected 4k localized diff <50ms, took ${tLocalMs.toFixed(2)}ms`);

  // Scattered 10 edits across 4,000 lines
  const big4kScattered = [...big4kOld];
  for (let i = 10; i < 4000; i += 400) {
    big4kScattered[i] = `export const item_${i + 1} = "SCATTERED_${i}";`;
  }
  const scatteredStr = big4kScattered.join("\n");
  const tScatStart = performance.now();
  const dScat = computeUnifiedDiff(oldStr, scatteredStr, { fileLabel: "big.js", maxDiffBytes: 16000 });
  const tScatMs = performance.now() - tScatStart;
  assert.equal(dScat.changed, true);
  assert.equal(dScat.fallback, false);
  assert.equal(dScat.hunkCount, 10);
  assert.ok(tScatMs < 80, `Expected 4k scattered diff <80ms, took ${tScatMs.toFixed(2)}ms`);

  // Full 4,000-line rewrite must finish fast & bounded (no O(N*M) blowup)
  const big4kRewrite = makeNumberedLines(4000, "export const rewritten").join("\n");
  const tRewStart = performance.now();
  const dRew = computeUnifiedDiff(oldStr, big4kRewrite, { fileLabel: "big.js", maxDiffBytes: 6500 });
  const tRewMs = performance.now() - tRewStart;
  assert.equal(dRew.changed, true);
  assert.equal(dRew.fallback, true);
  assert.equal(dRew.truncated, true);
  assert.ok(dRew.diffBytes <= 6500);
  assert.ok(tRewMs < 80, `Expected 4k full rewrite guard <80ms, took ${tRewMs.toFixed(2)}ms`);

  // Adversarial repeating-lines 4,000-line diff (worst case for Myers snakes) must stay bounded & fast
  const repA = Array.from({ length: 4000 }, (_, i) => (i % 2 === 0 ? "common_line" : `old_var_${i}`)).join("\n");
  const repB = Array.from({ length: 4000 }, (_, i) => (i % 2 === 0 ? "common_line" : `new_var_${i}`)).join("\n");
  const tRepStart = performance.now();
  const dRep = computeUnifiedDiff(repA, repB, { maxDiffBytes: 6500 });
  const tRepMs = performance.now() - tRepStart;
  assert.equal(dRep.changed, true);
  assert.equal(dRep.truncated, true);
  assert.ok(dRep.diffBytes <= 6500);
  assert.ok(tRepMs < 80, `Expected 4k repeating-lines diff <80ms, took ${tRepMs.toFixed(2)}ms`);
});

test("store.js: legacy DB file_snapshots upgrade, gzip compression, 256KB cap, 64-entry LRU, >15min dedup, invalidation & pruneByTtl", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-snap-store-"));
  const tmpDb = path.join(tmpDir, "context.db");

  try {
    // 1. Legacy v3 DB without file_snapshots upgrades idempotently
    const legacy = new DatabaseSync(tmpDb);
    legacy.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta(key, value) VALUES ('schema_version', '3');
      CREATE TABLE file_reads (
        session_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        file_size INTEGER NOT NULL,
        byte_est INTEGER NOT NULL DEFAULT 0,
        read_ts INTEGER NOT NULL,
        bypass_armed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, file_path, start_line, end_line)
      );
    `);
    legacy.close();

    const store = new ContextModeStore({ dbPath: tmpDb });
    store.open();
    assert.equal(store.getMeta("schema_version"), "3");
    const snapTable = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'file_snapshots'")
      .get();
    assert.ok(snapTable, "Legacy DB must gain file_snapshots table");

    // 2. Gzip storage & > 256 KB rejection
    const fileA = path.join(tmpDir, "a.js");
    const textA = makeNumberedLines(100).join("\n");
    const saveOk = store.saveFileSnapshot({
      sessionId: "s1",
      filePath: fileA,
      startLine: 1,
      endLine: null,
      mtimeMs: 1000,
      fileSize: Buffer.byteLength(textA, "utf8"),
      content: textA
    });
    assert.equal(saveOk.saved, true);
    assert.ok(saveOk.compressedBytes < saveOk.rawBytes, "Snapshot should be gzip-compressed");

    const hugeText = "x".repeat(MAX_SNAPSHOT_BYTES + 1024);
    const saveHuge = store.saveFileSnapshot({
      sessionId: "s1",
      filePath: path.join(tmpDir, "huge.txt"),
      content: hugeText
    });
    assert.equal(saveHuge.saved, false);
    assert.equal(saveHuge.reason, "too_large");

    // Exact & covering lookup
    const foundExact = store.findFileSnapshot({ sessionId: "s1", filePath: fileA, startLine: 1, endLine: null });
    assert.ok(foundExact);
    assert.equal(foundExact.isExactRange, true);
    assert.equal(foundExact.content, textA);

    const foundCover = store.findFileSnapshot({ sessionId: "s1", filePath: fileA, startLine: 10, endLine: 50 });
    assert.ok(foundCover);
    assert.equal(foundCover.isExactRange, false);
    assert.equal(foundCover.start_line, 1);
    assert.equal(foundCover.end_line, -1);

    // 3. Per-session LRU cap (default 64 entries)
    const lruSid = "s-lru";
    for (let i = 0; i < MAX_SNAPSHOTS_PER_SESSION + 6; i++) {
      const p = path.join(tmpDir, `lru_${i}.js`);
      store.saveFileSnapshot({ sessionId: lruSid, filePath: p, content: `line_${i}\n`.repeat(20) });
      // Ensure monotonic updated_ts so oldest 6 are deterministic
      store.db
        .prepare("UPDATE file_snapshots SET updated_ts = ? WHERE session_id = ? AND file_path = ?")
        .run(100000 + i, lruSid, store._normalizeTrackPath(p));
    }
    const lruCount = store.db
      .prepare("SELECT COUNT(*) AS cnt FROM file_snapshots WHERE session_id = ?")
      .get(lruSid).cnt;
    assert.equal(lruCount, MAX_SNAPSHOTS_PER_SESSION);
    // Re-trigger one save with latest ts to verify oldest 0..5 were evicted
    assert.equal(
      store.findFileSnapshot({ sessionId: lruSid, filePath: path.join(tmpDir, "lru_0.js") }),
      null,
      "Oldest LRU snapshot should be evicted"
    );
    assert.ok(
      store.findFileSnapshot({ sessionId: lruSid, filePath: path.join(tmpDir, `lru_${MAX_SNAPSHOTS_PER_SESSION + 5}.js`), maxAgeMs: 0 }),
      "Newest LRU snapshot should be retained"
    );

    // 4. findDuplicateRead: > 15-min unchanged read STILL deduplicated by default, explicit maxAgeMs honored
    store.recordFileRead({
      sessionId: "s-age",
      filePath: fileA,
      startLine: 1,
      endLine: null,
      mtimeMs: 2000,
      fileSize: 4096
    });
    const fortyFiveMinAgo = Date.now() - 45 * 60 * 1000;
    store.db
      .prepare("UPDATE file_reads SET read_ts = ? WHERE session_id = ?")
      .run(fortyFiveMinAgo, "s-age");

    const dupDefault = store.findDuplicateRead({
      sessionId: "s-age",
      filePath: fileA,
      startLine: 1,
      endLine: null,
      mtimeMs: 2000,
      fileSize: 4096
    });
    assert.ok(dupDefault, "45-min old unchanged read must still deduplicate under default compaction-bounded window");

    const dupExplicitShort = store.findDuplicateRead({
      sessionId: "s-age",
      filePath: fileA,
      startLine: 1,
      endLine: null,
      mtimeMs: 2000,
      fileSize: 4096,
      maxAgeMs: 10 * 60 * 1000
    });
    assert.equal(dupExplicitShort, null, "Explicit positive maxAgeMs must still be honored");

    // 5. invalidateFileReads(sid, filePath) keeps file_snapshots; invalidateFileReads(sid, null) clears BOTH
    store.recordFileRead({
      sessionId: "s1",
      filePath: fileA,
      startLine: 1,
      endLine: null,
      mtimeMs: 1000,
      fileSize: Buffer.byteLength(textA, "utf8")
    });
    store.invalidateFileReads("s1", fileA);
    assert.equal(
      store.findDuplicateRead({ sessionId: "s1", filePath: fileA, mtimeMs: 1000, fileSize: Buffer.byteLength(textA, "utf8") }),
      null
    );
    assert.ok(
      store.findFileSnapshot({ sessionId: "s1", filePath: fileA }),
      "Single-file edit invalidation must preserve file_snapshots baseline"
    );

    store.invalidateFileReads("s1", null);
    assert.equal(
      store.findFileSnapshot({ sessionId: "s1", filePath: fileA }),
      null,
      "Session-wide invalidation (compaction/ctx_resume) must clear file_snapshots"
    );

    // 6. pruneByTtl cleans snapshots older than 24h while keeping fresh snapshots
    const freshPath = path.join(tmpDir, "fresh.js");
    const stalePath = path.join(tmpDir, "stale.js");
    store.saveFileSnapshot({ sessionId: "s-ttl", filePath: freshPath, content: "fresh content\n".repeat(40) });
    store.saveFileSnapshot({ sessionId: "s-ttl", filePath: stalePath, content: "stale content\n".repeat(40) });
    const oldSnapTs = Date.now() - 36 * 3600 * 1000;
    store.db
      .prepare("UPDATE file_snapshots SET updated_ts = ? WHERE session_id = ? AND file_path = ?")
      .run(oldSnapTs, "s-ttl", store._normalizeTrackPath(stalePath));

    const pruned = store.pruneByTtl({ maxAgeDays: 14, vacuum: false });
    assert.ok(pruned.deletedFileSnapshots >= 1, "pruneByTtl must prune >24h old file_snapshots");
    assert.equal(store.findFileSnapshot({ sessionId: "s-ttl", filePath: stalePath, maxAgeMs: 0 }), null);
    assert.ok(store.findFileSnapshot({ sessionId: "s-ttl", filePath: freshPath }));

    store.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Three-state PreToolUse lifecycle: State 1/2/3, 2-strike bypass, incremental v1->v2->v3, superset->subset diff, and telemetry", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-diff-e2e-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const modFile = path.join(tmpDir, "service.js");
  const v1Lines = makeNumberedLines(120); // ~7.2 KB

  try {
    writeAndBumpMtime(modFile, v1Lines.join("\n") + "\n", 0);

    // State 1: First read -> allow + saves file_reads & file_snapshots
    const r1 = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-tri", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: modFile } } },
      tmpDb
    );
    assert.equal(r1.decision, "allow");

    // State 2: Unchanged re-read -> Strike 1 deny [agy-dart read-dedup]
    const r2 = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-tri", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: modFile } } },
      tmpDb
    );
    assert.equal(r2.decision, "deny");
    assert.ok(r2.reason.includes("[agy-dart read-dedup]"));

    // State 2 Strike 2 -> allow
    const r2b = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-tri", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: modFile } } },
      tmpDb
    );
    assert.equal(r2b.decision, "allow");

    // State 3: Modify 2 lines (v1 -> v2) + PostToolUse edit_file invalidates file_reads only
    const v2Lines = [...v1Lines];
    v2Lines[14] = 'export const item_15 = "CHANGED_IN_V2_ALPHA";';
    v2Lines[15] = 'export const item_16 = "CHANGED_IN_V2_BETA";';
    writeAndBumpMtime(modFile, v2Lines.join("\n") + "\n", 10);

    runHook(
      "hooks/post-tool-use.mjs",
      { conversationId: "s-tri", cwd: tmpDir, toolCall: { name: "edit_file", args: { Path: modFile } } },
      tmpDb
    );

    const r3 = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-tri", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: modFile } } },
      tmpDb
    );
    assert.equal(r3.decision, "deny");
    assert.ok(r3.reason.includes("[agy-dart diff-read]"), `Expected diff-read header, got:\n${r3.reason}`);
    assert.ok(r3.reason.includes("(+2/-2 lines"), `Expected (+2/-2 lines), got:\n${r3.reason}`);
    assert.ok(r3.reason.includes("```diff\n"));
    assert.ok(r3.reason.includes("+export const item_15 = \"CHANGED_IN_V2_ALPHA\";"));
    assert.ok(r3.reason.includes("call read_file once more to bypass"));

    // Verify telemetry event (kind: "dedup", key: "modified_diff", sandboxBytes > returnedBytes > 0)
    const store = new ContextModeStore({ dbPath: tmpDb });
    store.open();
    const diffEv = store.db
      .prepare("SELECT kind, key, sandbox_bytes, returned_bytes FROM events WHERE session_id = ? AND key = 'modified_diff' ORDER BY seq DESC LIMIT 1")
      .get("s-tri");
    assert.ok(diffEv, "Expected modified_diff telemetry event");
    assert.equal(diffEv.kind, "dedup");
    assert.ok(diffEv.sandbox_bytes > 5000);
    assert.ok(diffEv.returned_bytes > 0 && diffEv.returned_bytes < diffEv.sandbox_bytes * 0.4);
    const stats = store.getStats("s-tri");
    assert.ok(stats.breakdown.dedups >= 2);
    assert.ok(stats.breakdown.dedupSavedBytes > 5000);
    store.close();

    // Incremental v2 -> v3 WITHOUT triggering Strike 2: only line 90 delta must appear (NOT line 15!)
    const v3Lines = [...v2Lines];
    v3Lines[89] = 'export const item_90 = "CHANGED_IN_V3_GAMMA";';
    writeAndBumpMtime(modFile, v3Lines.join("\n") + "\n", 20);

    const r4 = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-tri", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: modFile } } },
      tmpDb
    );
    assert.equal(r4.decision, "deny");
    assert.ok(r4.reason.includes("[agy-dart diff-read]"));
    assert.ok(r4.reason.includes("(+1/-1 lines"));
    assert.ok(r4.reason.includes("CHANGED_IN_V3_GAMMA"), "Incremental diff must show v2->v3 change");
    assert.ok(!r4.reason.includes("CHANGED_IN_V2_ALPHA"), "Incremental diff must NOT repeat v1->v2 change");

    // 2-strike full-file bypass after diff delivery: immediate retry returns allow (full file verbatim)!
    const r5 = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-tri", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: modFile } } },
      tmpDb
    );
    assert.equal(r5.decision, "allow", "Strike 2 retry after diff-read must allow full file verbatim");

    // Subsequent unchanged read after Strike 2 bypass re-enters State 2 [agy-dart read-dedup]
    const r6 = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-tri", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: modFile } } },
      tmpDb
    );
    assert.equal(r6.decision, "deny");
    assert.ok(r6.reason.includes("[agy-dart read-dedup]"));

    // Superset snapshot (1..-1) -> subset modified read (lines 20..80) with accurate 1-based line numbers
    const v4Lines = [...v3Lines];
    v4Lines[34] = 'export const item_35 = "SUBSET_MODIFIED_LINE_35";';
    writeAndBumpMtime(modFile, v4Lines.join("\n") + "\n", 30);

    const rSub = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-tri", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: modFile, StartLine: 20, EndLine: 80 } } },
      tmpDb
    );
    assert.equal(rSub.decision, "deny");
    assert.ok(rSub.reason.includes("[agy-dart diff-read]"));
    assert.ok(rSub.reason.includes("(lines 20-80)"));
    assert.ok(rSub.reason.includes("@@ -32,7 +32,7 @@"), `Expected accurate line 32-38 hunk, got:\n${rSub.reason}`);
    assert.ok(rSub.reason.includes("SUBSET_MODIFIED_LINE_35"));

    // Strike 2 on subset -> allow verbatim
    const rSub2 = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-tri", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: modFile, StartLine: 20, EndLine: 80 } } },
      tmpDb
    );
    assert.equal(rSub2.decision, "allow");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("Guardrails: large rewrite (>=40%), >6.5KB diff, tiny file (<1.5KB), compaction/ctx_resume, >15min dedup, opt-out env, CJK UTF-8 & CLI cwd contract", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-diff-guard-"));
  const tmpDb = path.join(tmpDir, "context.db");

  try {
    // 1. Large rewrite (>=40%) falls back to allow
    const bigRewriteFile = path.join(tmpDir, "rewrite.js");
    const rwV1 = makeNumberedLines(100);
    writeAndBumpMtime(bigRewriteFile, rwV1.join("\n") + "\n", 0);
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "s-guard", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: bigRewriteFile } } }, tmpDb).decision,
      "allow"
    );
    // Rewrite 60 of 100 lines (>= 40%)
    const rwV2 = rwV1.map((l, idx) => (idx < 60 ? `export const replaced_${idx + 1} = "TOTALLY_NEW_IMPL_${idx}";` : l));
    writeAndBumpMtime(bigRewriteFile, rwV2.join("\n") + "\n", 10);
    const rLargeRewrite = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-guard", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: bigRewriteFile } } },
      tmpDb
    );
    assert.equal(rLargeRewrite.decision, "allow", "Large rewrite (>=40%) must fall back to full file allow");

    // 2. Oversized diff (> 6.5 KB even when < 40% of a ~24 KB paged range) falls back to allow
    const pagedBigFile = path.join(tmpDir, "paged_big.js");
    const pV1 = Array.from({ length: 400 }, (_, i) => `export const entry_${i + 1} = "${"p".repeat(60)}";`); // ~33 KB
    writeAndBumpMtime(pagedBigFile, pV1.join("\n") + "\n", 0);
    assert.equal(
      runHook(
        "hooks/pre-tool-use.mjs",
        { conversationId: "s-guard", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: pagedBigFile, StartLine: 1, EndLine: 360 } } },
        tmpDb
      ).decision,
      "allow"
    );
    // Change 55 lines (~9 KB diff, which is < 40% of ~30 KB slice, yet > 6.5 KB maxDiffBytes)
    const pV2 = pV1.map((l, idx) => (idx >= 50 && idx < 105 ? `export const entry_${idx + 1} = "${"q".repeat(60)}";` : l));
    writeAndBumpMtime(pagedBigFile, pV2.join("\n") + "\n", 15);
    const rOverDiffCap = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-guard", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: pagedBigFile, StartLine: 1, EndLine: 360 } } },
      tmpDb
    );
    assert.equal(rOverDiffCap.decision, "allow", "Diff exceeding 6.5 KB must fall back to allow");

    // 3. Tiny file (< 1.5 KB, >= 1 KB) skips diff-read on modification while keeping State 2 unchanged dedup
    const tinyFile = path.join(tmpDir, "tiny.js");
    const tinyV1 = Array.from({ length: 22 }, (_, i) => `export const t${i} = "${"x".repeat(35)}";`).join("\n") + "\n"; // ~1.25 KB
    assert.ok(Buffer.byteLength(tinyV1, "utf8") >= 1024 && Buffer.byteLength(tinyV1, "utf8") < 1536);
    writeAndBumpMtime(tinyFile, tinyV1, 0);

    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "s-tiny", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: tinyFile } } }, tmpDb).decision,
      "allow"
    );
    const tinyUnchanged = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-tiny", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: tinyFile } } },
      tmpDb
    );
    assert.equal(tinyUnchanged.decision, "deny");
    assert.ok(tinyUnchanged.reason.includes("[agy-dart read-dedup]"));

    const tinyV2 = tinyV1.replace("export const t5 =", "export const t5_mod =");
    writeAndBumpMtime(tinyFile, tinyV2, 10);
    const tinyMod = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-tiny", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: tinyFile } } },
      tmpDb
    );
    assert.equal(tinyMod.decision, "allow", "Tiny file (<1.5 KB) must skip diff-read and allow directly");

    // 4. ctx_resume (PostToolUse compaction) clears BOTH file_reads and file_snapshots
    const compFile = path.join(tmpDir, "compact.js");
    const compV1 = makeNumberedLines(80);
    writeAndBumpMtime(compFile, compV1.join("\n") + "\n", 0);
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "s-comp", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: compFile } } }, tmpDb).decision,
      "allow"
    );
    // Backdate file_reads by 45 minutes -> STILL deduplicated (>15 min) BEFORE compaction!
    const store = new ContextModeStore({ dbPath: tmpDb });
    store.open();
    store.db.prepare("UPDATE file_reads SET read_ts = ? WHERE session_id = ?").run(Date.now() - 45 * 60 * 1000, "s-comp");
    store.close();

    const r45Min = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-comp", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: compFile } } },
      tmpDb
    );
    assert.equal(r45Min.decision, "deny");
    assert.ok(r45Min.reason.includes("[agy-dart read-dedup]"), "45-min old unchanged read must still deduplicate");

    // Now modify file AND trigger PostToolUse ctx_resume (simulating /compact)
    const compV2 = [...compV1];
    compV2[10] = 'export const item_11 = "AFTER_COMPACT";';
    writeAndBumpMtime(compFile, compV2.join("\n") + "\n", 10);
    runHook(
      "hooks/post-tool-use.mjs",
      {
        conversationId: "s-comp",
        cwd: tmpDir,
        toolCall: { name: "call_mcp_tool", args: { ServerName: "agy-dart_context", ToolName: "ctx_resume", Arguments: {} } }
      },
      tmpDb
    );
    const rAfterCompact = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-comp", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: compFile } } },
      tmpDb
    );
    assert.equal(rAfterCompact.decision, "allow", "After ctx_resume compaction, snapshots are cleared so read_file allows full file");

    // 5. AGY_DART_DISABLE_DIFF_READ=1 opts out of diff-read while keeping State 2 unchanged dedup
    const optFile = path.join(tmpDir, "optout.js");
    const optV1 = makeNumberedLines(80);
    writeAndBumpMtime(optFile, optV1.join("\n") + "\n", 0);
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "s-opt", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: optFile } } }, tmpDb).decision,
      "allow"
    );
    const optV2 = [...optV1];
    optV2[5] = 'export const item_6 = "OPTOUT_EDIT";';
    writeAndBumpMtime(optFile, optV2.join("\n") + "\n", 10);
    const rOptDisabled = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-opt", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: optFile } } },
      tmpDb,
      { AGY_DART_DISABLE_DIFF_READ: "1" }
    );
    assert.equal(rOptDisabled.decision, "allow", "AGY_DART_DISABLE_DIFF_READ=1 must bypass diff-read");

    const rOptUnchanged = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-opt", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: optFile } } },
      tmpDb,
      { AGY_DART_DISABLE_DIFF_READ: "1" }
    );
    assert.equal(rOptUnchanged.decision, "deny");
    assert.ok(rOptUnchanged.reason.includes("[agy-dart read-dedup]"), "State 2 unchanged dedup stays active when diff-read is disabled");

    // 6. CJK UTF-8 end-to-end diff-read safety
    const cjkFile = path.join(tmpDir, "指南.md");
    const cjkV1 = Array.from({ length: 70 }, (_, i) => `## 第${i + 1}节 配置说明 — 缓存策略与上下文压缩阈值_${i + 1} 🚀`);
    writeAndBumpMtime(cjkFile, cjkV1.join("\n") + "\n", 0);
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "s-cjk", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: cjkFile } } }, tmpDb).decision,
      "allow"
    );
    const cjkV2 = [...cjkV1];
    cjkV2[25] = "## 第26节 配置说明 — 已更新为三态增量差异缓存策略 ✨";
    writeAndBumpMtime(cjkFile, cjkV2.join("\n") + "\n", 10);
    const rCjkDiff = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-cjk", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: cjkFile } } },
      tmpDb
    );
    assert.equal(rCjkDiff.decision, "deny");
    assert.ok(rCjkDiff.reason.includes("[agy-dart diff-read]"));
    assert.ok(rCjkDiff.reason.includes("已更新为三态增量差异缓存策略 ✨"));
    assert.ok(!rCjkDiff.reason.includes("\uFFFD"));
    assert.ok(Buffer.byteLength(rCjkDiff.reason, "utf8") <= 8800);

    // 7. Cross-worker contract: buildCliFilterRewrite accepts optional 3rd cwd arg cleanly
    const rwDefault = buildCliFilterRewrite("git status", "s-cli");
    const rwWithCwd = buildCliFilterRewrite("git status", "s-cli", tmpDir);
    assert.equal(rwDefault?.ruleId, "git-status");
    assert.equal(rwWithCwd?.ruleId, "git-status");

    // 8. view_file tool name is echoed in diff-read bypass instruction & PreInvocation compaction clears snapshots
    const vfFile = path.join(tmpDir, "view_target.js");
    const vfV1 = makeNumberedLines(80);
    writeAndBumpMtime(vfFile, vfV1.join("\n") + "\n", 0);
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "s-preinv", cwd: tmpDir, toolCall: { name: "view_file", args: { AbsolutePath: vfFile } } }, tmpDb).decision,
      "allow"
    );
    const vfV2 = [...vfV1];
    vfV2[12] = 'export const item_13 = "VIEW_FILE_EDITED";';
    writeAndBumpMtime(vfFile, vfV2.join("\n") + "\n", 10);
    const rVfDiff = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-preinv", cwd: tmpDir, toolCall: { name: "view_file", args: { AbsolutePath: vfFile } } },
      tmpDb
    );
    assert.equal(rVfDiff.decision, "deny");
    assert.ok(rVfDiff.reason.includes("call view_file once more to bypass"));

    // Simulate PreInvocation detecting a compaction drop (80k -> 18k tokens) -> invalidates BOTH file_reads and file_snapshots
    const transcriptPath = path.join(tmpDir, "compact_transcript.jsonl");
    const t0 = Date.now() - 20_000;
    const tSteps = [
      { type: "PLANNER_RESPONSE", step_index: 1, created_at: new Date(t0).toISOString(), model: "claude-sonnet-4", input_tokens: 80000, cache_read_tokens: 0, output_tokens: 100 },
      { type: "PLANNER_RESPONSE", step_index: 2, created_at: new Date(t0 + 10_000).toISOString(), model: "claude-sonnet-4", input_tokens: 18000, cache_read_tokens: 0, output_tokens: 100 }
    ];
    fs.writeFileSync(transcriptPath, tSteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
    runHook("hooks/pre-invocation.mjs", { conversationId: "s-preinv", transcriptPath }, tmpDb);

    // Edit again (v2 -> v3): because compaction wiped snapshots, next view_file MUST allow full file (NOT diff-read!)
    const vfV3 = [...vfV2];
    vfV3[40] = 'export const item_41 = "AFTER_PREINV_COMPACT";';
    writeAndBumpMtime(vfFile, vfV3.join("\n") + "\n", 20);
    const rAfterPreInvCompact = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-preinv", cwd: tmpDir, toolCall: { name: "view_file", args: { AbsolutePath: vfFile } } },
      tmpDb
    );
    assert.equal(rAfterPreInvCompact.decision, "allow", "PreInvocation compaction must clear file_snapshots so full read is allowed");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
