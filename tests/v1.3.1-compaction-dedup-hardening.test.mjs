import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { ContextModeStore } from "../context/lib/store.js";
import { createTools } from "../context/lib/tools.js";
import { formatEffectiveConfigLines, getConfigSnapshot, resetConfigCache } from "../context/lib/config.js";
import {
  analyzeTranscriptCache,
  extractLatestCompactionEvent,
  inspectTranscriptCompaction
} from "../context/lib/cache-analyzer.js";
import {
  MAX_FILTERED_OUTPUT_BYTES,
  applyFilterRule,
  compactFailureWithErrorAnchors
} from "../hooks/filter-rules.mjs";

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
      ...extraEnv
    }
  });
  assert.equal(res.status, 0, `${scriptRel} failed: ${res.stderr}`);
  assert.equal(res.stderr, "", `${scriptRel} emitted unexpected stderr: ${res.stderr}`);
  return JSON.parse(res.stdout.trim() || "{}");
}

function makeCodeLines(count, prefix = "export const entry") {
  return (
    Array.from({ length: count }, (_, i) => {
      const n = i + 1;
      return `${prefix}_${n} = "payload_${String(n).padStart(4, "0")}_xxxxxxxxxxxxxxxxxxxxxxxx";`;
    }).join("\n") + "\n"
  );
}

test("v1.3.1-1: Zero-latency silent compaction first-turn fallback in PreToolUse (0 wasted turns, same-turn new-read preservation & diff-read guard)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v131-silent-"));
  const dbPath = path.join(tmpDir, "context.db");
  const cfgPath = path.join(tmpDir, "config.json");
  const oldFile = path.join(tmpDir, "old_module.js");
  const newFile = path.join(tmpDir, "new_module.js");
  const txPath = path.join(tmpDir, "transcript.jsonl");

  const baseEnv = { AGY_DART_CONFIG_PATH: cfgPath };

  try {
    fs.writeFileSync(oldFile, makeCodeLines(100, "export const oldItem"), "utf8"); // ~6.6 KB
    fs.writeFileSync(newFile, makeCodeLines(100, "export const newItem"), "utf8"); // ~6.6 KB

    const t0 = Date.now() - 60_000;
    const preCompactSteps = [
      {
        type: "PLANNER_RESPONSE",
        step_index: 9,
        created_at: new Date(t0).toISOString(),
        model: "claude-sonnet-4-6",
        input_tokens: 100000,
        cache_read_tokens: 0,
        output_tokens: 200
      }
    ];
    fs.writeFileSync(txPath, preCompactSteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");

    // 1. Pre-compaction read of oldFile at step 10 -> allow
    assert.equal(
      runHook(
        "hooks/pre-tool-use.mjs",
        { conversationId: "s-silent", stepIdx: 10, transcriptPath: txPath, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: oldFile } } },
        dbPath,
        baseEnv
      ).decision,
      "allow"
    );

    // 2. Pre-compaction re-read at step 12 -> normal Strike 1 read-dedup deny; Strike 2 allow (re-anchors at step 13)
    const preDup = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-silent", stepIdx: 12, transcriptPath: txPath, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: oldFile } } },
      dbPath,
      baseEnv
    );
    assert.equal(preDup.decision, "deny");
    assert.match(preDup.reason, /read-dedup/);
    assert.equal(
      runHook(
        "hooks/pre-tool-use.mjs",
        { conversationId: "s-silent", stepIdx: 13, transcriptPath: txPath, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: oldFile } } },
        dbPath,
        baseEnv
      ).decision,
      "allow"
    );

    // 3. PreInvocation runs BEFORE the silent compaction PLANNER_RESPONSE is written (so it sees only 100k, no compaction yet)
    runHook("hooks/pre-invocation.mjs", { conversationId: "s-silent", transcriptPath: txPath }, dbPath, baseEnv);

    // 4. Silent auto-compaction occurs (NO /compact, NO ctx_resume): host writes compacted PLANNER_RESPONSE (100k -> 18k) at step 50
    const postCompactLine = JSON.stringify({
      type: "PLANNER_RESPONSE",
      step_index: 50,
      created_at: new Date(t0 + 30_000).toISOString(),
      model: "claude-sonnet-4-6",
      input_tokens: 18000,
      cache_read_tokens: 0,
      output_tokens: 150
    });
    fs.appendFileSync(txPath, postCompactLine + "\n", "utf8");

    // 5. Same post-compaction turn reads a brand-new file at step 51 BEFORE re-reading oldFile
    assert.equal(
      runHook(
        "hooks/pre-tool-use.mjs",
        { conversationId: "s-silent", stepIdx: 51, transcriptPath: txPath, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: newFile } } },
        dbPath,
        baseEnv
      ).decision,
      "allow"
    );

    // 6. Re-reading oldFile (read_step=13 <= 50) at step 52 MUST allow on FIRST try via PreToolUse lazy check (0 wasted turns!)
    const postCompactOld = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-silent", stepIdx: 52, transcriptPath: txPath, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: oldFile } } },
      dbPath,
      baseEnv
    );
    assert.equal(
      postCompactOld.decision,
      "allow",
      "First-turn post-compaction re-read must allow on Strike 1 with 0 wasted turns"
    );

    // 7. Same-turn newFile (read_step=51 > 50) MUST be preserved so duplicate re-read at step 53 still dedups
    const postCompactNewDup = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-silent", stepIdx: 53, transcriptPath: txPath, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: newFile } } },
      dbPath,
      baseEnv
    );
    assert.equal(postCompactNewDup.decision, "deny", "Files read after compaction boundary must be preserved");
    assert.match(postCompactNewDup.reason, /read-dedup/);

    // 8. Re-reading oldFile AGAIN at step 54 (now stamped & recorded at step 52) dedups normally (no repeated clearing)
    const postCompactOldSecond = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-silent", stepIdx: 54, transcriptPath: txPath, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: oldFile } } },
      dbPath,
      baseEnv
    );
    assert.equal(postCompactOldSecond.decision, "deny");
    assert.match(postCompactOldSecond.reason, /read-dedup/);

    // 9. State-3 diff-read also honors lazy compaction check on first turn after silent compaction
    const diffTx = path.join(tmpDir, "diff_transcript.jsonl");
    const diffFile = path.join(tmpDir, "diff_target.js");
    const diffV1 = makeCodeLines(100, "export const dItem");
    fs.writeFileSync(diffFile, diffV1, "utf8");
    fs.writeFileSync(
      diffTx,
      JSON.stringify({
        type: "PLANNER_RESPONSE",
        step_index: 5,
        created_at: new Date(t0).toISOString(),
        model: "claude-sonnet-4-6",
        input_tokens: 90000,
        cache_read_tokens: 0,
        output_tokens: 100
      }) + "\n",
      "utf8"
    );
    const diffEnv = { ...baseEnv, AGY_DART_ENABLE_DIFF_READ: "1" };
    assert.equal(
      runHook(
        "hooks/pre-tool-use.mjs",
        { conversationId: "s-silent-diff", stepIdx: 6, transcriptPath: diffTx, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: diffFile } } },
        dbPath,
        diffEnv
      ).decision,
      "allow"
    );
    // Modify file + append silent compaction (90k -> 16k) WITHOUT calling PreInvocation first
    fs.writeFileSync(diffFile, diffV1.replace("dItem_10", "dItem_10_modified"), "utf8");
    const futureSec = Math.floor(Date.now() / 1000) + 10;
    fs.utimesSync(diffFile, futureSec, futureSec);
    fs.appendFileSync(
      diffTx,
      JSON.stringify({
        type: "PLANNER_RESPONSE",
        step_index: 15,
        created_at: new Date(t0 + 20_000).toISOString(),
        model: "claude-sonnet-4-6",
        input_tokens: 16000,
        cache_read_tokens: 0,
        output_tokens: 100
      }) + "\n",
      "utf8"
    );
    const diffAfterSilent = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-silent-diff", stepIdx: 16, transcriptPath: diffTx, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: diffFile } } },
      dbPath,
      diffEnv
    );
    assert.equal(
      diffAfterSilent.decision,
      "allow",
      "Modified re-read on first turn after silent compaction must allow full file instead of emitting a stale diff"
    );

    // 10. >128 KB tool dump between pre-compaction (100k) and post-compaction (18k) turns MUST still detect shrink via tail widening
    const bigGapTx = path.join(tmpDir, "big_gap_transcript.jsonl");
    fs.writeFileSync(
      bigGapTx,
      [
        JSON.stringify({ type: "PLANNER_RESPONSE", step_index: 10, created_at: new Date(t0).toISOString(), model: "claude-sonnet-4-6", input_tokens: 100000, cache_read_tokens: 0 }),
        JSON.stringify({ type: "TOOL_RESULT", step_index: 11, content: "X".repeat(150000) }),
        JSON.stringify({ type: "PLANNER_RESPONSE", step_index: 12, created_at: new Date(t0 + 25_000).toISOString(), model: "claude-sonnet-4-6", input_tokens: 18000, cache_read_tokens: 0 })
      ].join("\n") + "\n",
      "utf8"
    );
    const bigGapEv = inspectTranscriptCompaction(bigGapTx);
    assert.ok(bigGapEv, "inspectTranscriptCompaction must widen past >128KB tool result to find prior usage step");
    assert.equal(bigGapEv.prevCtxTokens, 100000);
    assert.equal(bigGapEv.currCtxTokens, 18000);

    // 11. diff-read per-range snapshot precision: post-compaction read of lines 101-200 on same file MUST NOT preserve pre-compaction (1-100) snapshot
    const multiRangeFile = path.join(tmpDir, "multi_range_diff.js");
    const multiV1 = makeCodeLines(200, "export const mrItem");
    const multiTx = path.join(tmpDir, "multi_range_tx.jsonl");
    fs.writeFileSync(multiRangeFile, multiV1, "utf8");
    fs.writeFileSync(
      multiTx,
      JSON.stringify({ type: "PLANNER_RESPONSE", step_index: 5, created_at: new Date(t0).toISOString(), model: "claude-sonnet-4-6", input_tokens: 90000, cache_read_tokens: 0 }) + "\n",
      "utf8"
    );
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "s-multi-snap", stepIdx: 6, transcriptPath: multiTx, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: multiRangeFile, StartLine: 1, EndLine: 100 } } }, dbPath, diffEnv).decision,
      "allow"
    );
    fs.appendFileSync(
      multiTx,
      JSON.stringify({ type: "PLANNER_RESPONSE", step_index: 20, created_at: new Date(t0 + 30_000).toISOString(), model: "claude-sonnet-4-6", input_tokens: 15000, cache_read_tokens: 0 }) + "\n",
      "utf8"
    );
    // Post-compaction read of DIFFERENT range (101-200) on the same file
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "s-multi-snap", stepIdx: 21, transcriptPath: multiTx, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: multiRangeFile, StartLine: 101, EndLine: 200 } } }, dbPath, diffEnv).decision,
      "allow"
    );
    // Modify line 10 and line 150 -> lines 1-100 MUST allow full range (pre-compact snapshot cleared), while lines 101-200 still diff-reads (post-compact snapshot preserved!)
    fs.writeFileSync(
      multiRangeFile,
      multiV1.replace("mrItem_10 =", "mrItem_10_mod =").replace("mrItem_150 =", "mrItem_150_mod ="),
      "utf8"
    );
    fs.utimesSync(multiRangeFile, futureSec + 5, futureSec + 5);
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "s-multi-snap", stepIdx: 22, transcriptPath: multiTx, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: multiRangeFile, StartLine: 1, EndLine: 100 } } }, dbPath, diffEnv).decision,
      "allow",
      "Pre-compaction range snapshot (1-100) must be invalidated even when another range (101-200) of the same file was read post-compaction"
    );
    const preservedRangeDiff = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-multi-snap", stepIdx: 23, transcriptPath: multiTx, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: multiRangeFile, StartLine: 101, EndLine: 200 } } },
      dbPath,
      diffEnv
    );
    assert.equal(preservedRangeDiff.decision, "deny", "Post-compaction range snapshot (101-200) must remain active");
    assert.match(preservedRangeDiff.reason, /diff-read/);

    // 12. Zero-overhead on allow path: unchanged 2.5 KB file with diffRead=true must NOT scan transcript.jsonl
    const smallDiffFile = path.join(tmpDir, "small_allow_2500.js");
    const allowTx = path.join(tmpDir, "allow_path_tx.jsonl");
    fs.writeFileSync(smallDiffFile, makeCodeLines(40, "export const smAllow"), "utf8"); // ~2.5 KB
    fs.writeFileSync(allowTx, JSON.stringify({ type: "PLANNER_RESPONSE", step_index: 1, input_tokens: 50000 }) + "\n", "utf8");
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "s-zero-ovh", stepIdx: 2, transcriptPath: allowTx, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: smallDiffFile } } }, dbPath, diffEnv).decision,
      "allow"
    );
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "s-zero-ovh", stepIdx: 3, transcriptPath: allowTx, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: smallDiffFile } } }, dbPath, diffEnv).decision,
      "allow"
    );
    const ovhStore = new ContextModeStore({ dbPath });
    assert.equal(
      ovhStore.getTimedMeta("compact_invalidated:tx_stat:s-zero-ovh", ""),
      "",
      "Normal allow path on unchanged diff-read candidate must never scan transcript.jsonl"
    );
    ovhStore.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.3.1-2: All 4 compaction signals (model_switch+shrink, mild prune 100k->80k, explicit steps, /compact idempotency) & initialNumSteps rollback", () => {
  const t0 = Date.now() - 120_000;
  const iso = (sec) => new Date(t0 + sec * 1000).toISOString();

  // 1. Simultaneous compaction + model_switch: preserves bustsByCause.model_switch AND emits latestCompactionEvent + clears seenReadSignatures
  const switchSteps = [
    {
      type: "PLANNER_RESPONSE",
      step_index: 1,
      created_at: iso(0),
      model: "claude-sonnet-4-6",
      input_tokens: 100000,
      cache_read_tokens: 0,
      tool_calls: [{ name: "read_file", args: { Path: "src/app.js" } }]
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 2,
      created_at: iso(15),
      model: "gemini-2.5-pro",
      input_tokens: 20000,
      cache_read_tokens: 0,
      tool_calls: [{ name: "read_file", args: { Path: "src/app.js" } }]
    }
  ];
  const switchDiag = analyzeTranscriptCache(switchSteps);
  assert.equal(switchDiag.bustsByCause.model_switch, 1);
  assert.equal(switchDiag.bustsByCause.compaction_or_truncation, 0);
  assert.ok(switchDiag.latestCompactionEvent, "Compaction coupled with model_switch must emit latestCompactionEvent");
  assert.equal(switchDiag.latestCompactionEvent.kind, "context_shrink");
  assert.equal(switchDiag.latestCompactionEvent.prevCtxTokens, 100000);
  assert.equal(switchDiag.latestCompactionEvent.currCtxTokens, 20000);
  assert.equal(switchDiag.duplicateReadCount, 0, "seenReadSignatures must clear on decoupled context shrink");
  assert.equal(extractLatestCompactionEvent(switchSteps)?.stamp, switchDiag.latestCompactionEvent.stamp);

  // 2. Mild / selective pruning (100k -> 80k, -20%, drop 20k >= 8k, still warm cache hit -> NOT a bust, YET triggers latestCompactionEvent)
  const mildSteps = [
    { type: "PLANNER_RESPONSE", step_index: 10, created_at: iso(0), model: "claude-sonnet-4-6", input_tokens: 10000, cache_read_tokens: 90000 },
    { type: "PLANNER_RESPONSE", step_index: 11, created_at: iso(10), model: "claude-sonnet-4-6", input_tokens: 5000, cache_read_tokens: 75000 }
  ];
  const mildDiag = analyzeTranscriptCache(mildSteps);
  assert.equal(mildDiag.bustCount, 0);
  assert.ok(mildDiag.latestCompactionEvent, "Mild pruning (100k -> 80k, -20%) must emit latestCompactionEvent");
  assert.equal(mildDiag.latestCompactionEvent.kind, "context_shrink");
  assert.equal(mildDiag.latestCompactionEvent.prevCtxTokens, 100000);
  assert.equal(mildDiag.latestCompactionEvent.currCtxTokens, 80000);
  assert.equal(extractLatestCompactionEvent(mildSteps)?.stamp, mildDiag.latestCompactionEvent.stamp);

  // 2b. Non-compaction noise: small fluctuation (50k->47k), tiny drop (15k->12k), and interleaved subagent step (100k -> subagent 12k) MUST NOT trigger
  const noCompactSteps = [
    { type: "SYSTEM_MESSAGE", content: "agy-dart active: use agy-dart_fast + parallel ranged read_file" },
    { type: "PLANNER_RESPONSE", step_index: 1, created_at: iso(0), model: "claude-sonnet-4-6", input_tokens: 50000, cache_read_tokens: 0 },
    { type: "PLANNER_RESPONSE", step_index: 2, created_at: iso(5), model: "claude-sonnet-4-6", input_tokens: 2000, cache_read_tokens: 45000 },
    { type: "PLANNER_RESPONSE", step_index: 3, created_at: iso(10), model: "claude-sonnet-4-6", subagent: true, input_tokens: 2000, cache_read_tokens: 10000 }
  ];
  assert.equal(analyzeTranscriptCache(noCompactSteps).latestCompactionEvent, null);
  assert.equal(extractLatestCompactionEvent(noCompactSteps), null);

  // 3. Explicit compaction steps: step.type, compacted flag, SYSTEM_MESSAGE summary marker, and USER_INPUT `/compact`
  assert.equal(
    analyzeTranscriptCache([{ type: "CONTEXT_COMPACTION", step_index: 4, created_at: iso(20) }]).latestCompactionEvent?.kind,
    "explicit_compaction_step"
  );
  assert.equal(
    analyzeTranscriptCache([{ type: "PLANNER_RESPONSE", step_index: 5, compacted: true, input_tokens: 12000 }]).latestCompactionEvent?.kind,
    "explicit_compaction_step"
  );
  assert.equal(
    analyzeTranscriptCache([
      { type: "SYSTEM_MESSAGE", step_index: 6, content: "This session is being continued from a previous conversation that ran out of context." }
    ]).latestCompactionEvent?.kind,
    "explicit_compaction_step"
  );
  assert.equal(
    analyzeTranscriptCache([
      { type: "SYSTEM_MESSAGE", step_index: 6, content: "System note:\n<conversation_summary>\nPrior summary here\n</conversation_summary>" }
    ]).latestCompactionEvent?.kind,
    "explicit_compaction_step"
  );
  assert.equal(
    analyzeTranscriptCache([{ type: "USER_INPUT", step_index: 7, content: "/compact focus on auth module" }]).latestCompactionEvent?.kind,
    "slash_compact"
  );

  // 3b. Interleaved subagent turn between primary turns preserves exact parity between analyzeTranscriptCache & extractLatestCompactionEvent
  const interleavedSubSteps = [
    { type: "PLANNER_RESPONSE", step_index: 1, created_at: iso(0), model: "claude-sonnet-4-6", input_tokens: 100000, cache_read_tokens: 0 },
    { type: "PLANNER_RESPONSE", step_index: 2, created_at: iso(10), model: "gemini-2.5-flash", subagent: true, input_tokens: 12000, cache_read_tokens: 0 },
    { type: "PLANNER_RESPONSE", step_index: 3, created_at: iso(20), model: "claude-sonnet-4-6", input_tokens: 18000, cache_read_tokens: 0 }
  ];
  assert.deepEqual(
    analyzeTranscriptCache(interleavedSubSteps).latestCompactionEvent,
    extractLatestCompactionEvent(interleavedSubSteps)
  );
  assert.equal(extractLatestCompactionEvent(interleavedSubSteps)?.kind, "compaction_bust");

  // 4. End-to-end PreInvocation `/compact` lastUserInput (idempotent during invocationNum >= 1) + initialNumSteps rollback + PreToolUse unstamped `/compact`
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v131-cmd-"));
  const dbPath = path.join(tmpDir, "context.db");
  const cfgPath = path.join(tmpDir, "config.json");
  const fileA = path.join(tmpDir, "alpha.js");
  const fileB = path.join(tmpDir, "beta.js");
  const env = { AGY_DART_CONFIG_PATH: cfgPath };

  try {
    fs.writeFileSync(fileA, makeCodeLines(100, "export const alpha"), "utf8");
    fs.writeFileSync(fileB, makeCodeLines(100, "export const beta"), "utf8");

    // Read alpha.js before /compact
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "s-cmd", stepIdx: 15, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: fileA } } }, dbPath, env).decision,
      "allow"
    );

    // PreInvocation sees lastUserInput="/compact" at turn entry (invocationNum=0, initialNumSteps=20) -> wipes file_reads
    runHook(
      "hooks/pre-invocation.mjs",
      { conversationId: "s-cmd", lastUserInput: "/compact", initialNumSteps: 20, invocationNum: 0 },
      dbPath,
      env
    );

    // Post-compact first read of alpha.js & beta.js -> both allowed!
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "s-cmd", stepIdx: 21, lastUserInput: "/compact", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: fileA } } }, dbPath, env).decision,
      "allow"
    );
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "s-cmd", stepIdx: 22, lastUserInput: "/compact", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: fileB } } }, dbPath, env).decision,
      "allow"
    );

    // Mid-turn continuation (invocationNum=1, still lastUserInput="/compact") MUST NOT wipe alpha.js/beta.js!
    runHook(
      "hooks/pre-invocation.mjs",
      { conversationId: "s-cmd", lastUserInput: "/compact", initialNumSteps: 22, invocationNum: 1 },
      dbPath,
      env
    );
    const reReadB = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-cmd", stepIdx: 23, lastUserInput: "/compact", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: fileB } } },
      dbPath,
      env
    );
    assert.equal(reReadB.decision, "deny", "Mid-turn invocationNum>=1 with /compact must NOT clear files newly read after compaction");
    assert.match(reReadB.reason, /read-dedup/);

    // Direct PreToolUse with unstamped /compact (no prior PreInvocation) clears stale reads immediately on Strike 1
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "s-cmd-direct", stepIdx: 10, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: fileA } } }, dbPath, env).decision,
      "allow"
    );
    const directCompactAllow = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-cmd-direct", stepIdx: 12, lastUserInput: "/compact", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: fileA } } },
      dbPath,
      env
    );
    assert.equal(directCompactAllow.decision, "allow", "Unstamped /compact in PreToolUse must invalidate and allow immediately");
    const directCompactSecond = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-cmd-direct", stepIdx: 13, lastUserInput: "/compact", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: fileA } } },
      dbPath,
      env
    );
    assert.equal(directCompactSecond.decision, "deny", "Second read under already-stamped /compact must resume dedup");

    // Normal non-compact lastUserInput in PreToolUse resets stale cmd stamp even without PreInvocation so a later /compact works
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "s-cmd-direct", stepIdx: 20, lastUserInput: "inspect beta", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: fileB } } }, dbPath, env).decision,
      "allow"
    );
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "s-cmd-direct", stepIdx: 30, lastUserInput: "/compact", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: fileB } } }, dbPath, env).decision,
      "allow",
      "Subsequent /compact after a non-compact prompt must invalidate cleanly even without PreInvocation"
    );

    // Consecutive /compact with invocationNum=0 and NO initialNumSteps must still invalidate on the 2nd /compact
    runHook("hooks/pre-invocation.mjs", { conversationId: "s-cmd-2x", lastUserInput: "/compact", invocationNum: 0 }, dbPath, env);
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "s-cmd-2x", lastUserInput: "/compact", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: fileA } } }, dbPath, env).decision,
      "allow"
    );
    runHook("hooks/pre-invocation.mjs", { conversationId: "s-cmd-2x", lastUserInput: "/compact", invocationNum: 0 }, dbPath, env);
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "s-cmd-2x", lastUserInput: "/compact", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: fileA } } }, dbPath, env).decision,
      "allow",
      "Consecutive /compact with explicit invocationNum=0 must invalidate even when initialNumSteps is omitted"
    );

    // initialNumSteps rollback in PreInvocation clears file_reads immediately
    runHook("hooks/pre-invocation.mjs", { conversationId: "s-rewind", initialNumSteps: 40, lastUserInput: "work" }, dbPath, env);
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "s-rewind", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: fileA } } }, dbPath, env).decision,
      "allow"
    );
    runHook("hooks/pre-invocation.mjs", { conversationId: "s-rewind", initialNumSteps: 12, lastUserInput: "rewound" }, dbPath, env);
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "s-rewind", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: fileA } } }, dbPath, env).decision,
      "allow",
      "initialNumSteps rollback in PreInvocation must invalidate stale file_reads"
    );

    // inspectTranscriptCompaction works on file directly
    const txFile = path.join(tmpDir, "mild.jsonl");
    fs.writeFileSync(txFile, mildSteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
    const inspected = inspectTranscriptCompaction(txFile);
    assert.equal(inspected?.stamp, mildDiag.latestCompactionEvent.stamp);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.3.1-3: Full-scope turn decay (readDedupMaxTurns=12 without stepIdx), stepIdx rollback & legacy read_turn_seq migration", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v131-turns-"));
  const dbPath = path.join(tmpDir, "context.db");
  const cfgPath = path.join(tmpDir, "config.json");
  const srcFile = path.join(tmpDir, "long_horizon.js");

  try {
    // 1. Legacy v3 DB without file_reads.read_turn_seq upgrades idempotently
    const legacy = new DatabaseSync(dbPath);
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
        read_step INTEGER,
        PRIMARY KEY (session_id, file_path, start_line, end_line)
      );
      CREATE TABLE file_snapshots (
        session_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        mtime_ms REAL NOT NULL,
        file_size INTEGER NOT NULL,
        raw_bytes INTEGER NOT NULL DEFAULT 0,
        content_gz BLOB NOT NULL,
        updated_ts INTEGER NOT NULL,
        bypass_armed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, file_path, start_line, end_line)
      );
    `);
    legacy.close();

    const checkStore = new ContextModeStore({ dbPath });
    checkStore.open();
    const cols = checkStore.db.prepare("PRAGMA table_info(file_reads)").all().map((c) => c.name);
    assert.ok(cols.includes("read_turn_seq"), "Legacy file_reads table must gain read_turn_seq column");
    const snapCols = checkStore.db.prepare("PRAGMA table_info(file_snapshots)").all().map((c) => c.name);
    assert.ok(snapCols.includes("read_step"), "Legacy file_snapshots table must gain read_step column");
    checkStore.close();

    fs.writeFileSync(srcFile, makeCodeLines(100, "export const turnItem"), "utf8"); // ~6.6 KB

    // Explicitly disable cacheWatch & diffRead so we prove readDedup alone drives PreInvocation turn clock
    const env = {
      AGY_DART_CONFIG_PATH: cfgPath,
      AGY_DART_DISABLE_CACHE_WATCH: "1",
      AGY_DART_DISABLE_DIFF_READ: "1"
    };

    // Initial read WITHOUT stepIdx (records read_turn_seq = 0; read_file must NOT bump conv_turn_seq)
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "s-turns", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: srcFile } } }, dbPath, env).decision,
      "allow"
    );

    const sCheck = new ContextModeStore({ dbPath });
    assert.equal(sCheck.getConversationTurnSeq("s-turns"), 0, "read_file must NEVER increment conv_turn_seq");
    sCheck.close();

    // Advance 12 PreInvocation turns (conv_turn_seq = 12; gap 12 <= 12 -> still deduplicates!)
    for (let t = 0; t < 12; t++) {
      runHook("hooks/pre-invocation.mjs", { conversationId: "s-turns" }, dbPath, env);
    }
    const atTurn12 = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-turns", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: srcFile } } },
      dbPath,
      env
    );
    assert.equal(atTurn12.decision, "deny", "At gap=12 (<= readDedupMaxTurns=12), read-dedup is still active");
    // Reset bypass_armed by completing Strike 2? Wait: test fresh read on another conv so bypass_armed doesn't interfere!

    // Fresh conversation: read at turn 1, advance 13 turns -> turn 14 (gap 13 > 12) auto-allows on FIRST try!
    runHook("hooks/pre-invocation.mjs", { conversationId: "s-turns-decay" }, dbPath, env); // turn 1
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "s-turns-decay", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: srcFile } } }, dbPath, env).decision,
      "allow"
    );
    for (let t = 0; t < 13; t++) {
      runHook("hooks/pre-invocation.mjs", { conversationId: "s-turns-decay" }, dbPath, env);
    }
    // Now conv_turn_seq = 14, gap = 14 - 1 = 13 > 12 -> auto-allows WITHOUT 2-strike deny!
    const afterDecay = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-turns-decay", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: srcFile } } },
      dbPath,
      env
    );
    assert.equal(afterDecay.decision, "allow", "After >12 PreInvocation turns without stepIdx, readDedup must auto-allow on first try");

    // Re-read immediately at turn 14 -> refreshed read_turn_seq=14, so dedups again!
    const refreshedDup = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-turns-decay", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: srcFile } } },
      dbPath,
      env
    );
    assert.equal(refreshedDup.decision, "deny");
    assert.match(refreshedDup.reason, /read-dedup/);

    // AGY_DART_READ_DEDUP_MAX_TURNS=0 disables turn decay
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "s-turns-off", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: srcFile } } }, dbPath, { ...env, AGY_DART_READ_DEDUP_MAX_TURNS: "0" }).decision,
      "allow"
    );
    for (let t = 0; t < 15; t++) {
      runHook("hooks/pre-invocation.mjs", { conversationId: "s-turns-off" }, dbPath, env);
    }
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "s-turns-off", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: srcFile } } }, dbPath, { ...env, AGY_DART_READ_DEDUP_MAX_TURNS: "0" }).decision,
      "deny",
      "readDedupMaxTurns=0 must disable turn-based decay"
    );

    // stepIdx rollback in PreToolUse auto-allows even when readDedupMaxSteps=0!
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "s-step-back", stepIdx: 50, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: srcFile } } }, dbPath, { ...env, AGY_DART_READ_DEDUP_MAX_STEPS: "0" }).decision,
      "allow"
    );
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "s-step-back", stepIdx: 20, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: srcFile } } }, dbPath, { ...env, AGY_DART_READ_DEDUP_MAX_STEPS: "0" }).decision,
      "allow",
      "stepIdx rollback (20 < 50) must auto-allow immediately even when readDedupMaxSteps=0"
    );

    // stepIdx rollback also invalidates diff-read snapshots on modified files without PreInvocation initialNumSteps
    const rbDiffFile = path.join(tmpDir, "rb_diff.js");
    const rbV1 = makeCodeLines(100, "export const rbItem");
    fs.writeFileSync(rbDiffFile, rbV1, "utf8");
    const rbDiffEnv = { ...env, AGY_DART_ENABLE_DIFF_READ: "1" };
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "s-diff-rb", stepIdx: 50, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: rbDiffFile } } }, dbPath, rbDiffEnv).decision,
      "allow"
    );
    fs.writeFileSync(rbDiffFile, rbV1.replace("rbItem_10 =", "rbItem_10_mod ="), "utf8");
    const futSec = Math.floor(Date.now() / 1000) + 10;
    fs.utimesSync(rbDiffFile, futSec, futSec);
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "s-diff-rb", stepIdx: 20, cwd: tmpDir, toolCall: { name: "read_file", args: { Path: rbDiffFile } } }, dbPath, rbDiffEnv).decision,
      "allow",
      "stepIdx rollback (20 < 50) with diffRead=true must allow full file instead of emitting a stale diff"
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.3.1-4: readDedupMinBytes (4 KB default, narrow 15-line slice pass-through, env override, doctor output) & dedup_bypass telemetry isolation", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-v131-minbytes-"));
  const dbPath = path.join(tmpDir, "context.db");
  const cfgPath = path.join(tmpDir, "config.json");
  const smallFile = path.join(tmpDir, "small_cfg.js");
  const bigFile = path.join(tmpDir, "big_module.js");

  try {
    resetConfigCache();
    const defSnap = getConfigSnapshot({ configPath: cfgPath, env: {} });
    assert.equal(defSnap.values.readDedupMinBytes, 4096);
    assert.equal(defSnap.values.readDedupMaxTurns, 12);
    const cfgLines = formatEffectiveConfigLines(defSnap);
    assert.ok(
      cfgLines.some((l) => l.includes("Read dedup") && l.includes("minBytes=4 KB") && l.includes("maxTurns=12")),
      `Expected Read dedup summary in formatEffectiveConfigLines:\n${cfgLines.join("\n")}`
    );

    // 1. Small file (~1.5 KB < 4 KB default) -> never triggers 2-strike read-dedup
    fs.writeFileSync(smallFile, makeCodeLines(24, "export const cfg"), "utf8"); // ~1.5 KB
    assert.ok(fs.statSync(smallFile).size >= 1400 && fs.statSync(smallFile).size < 2500);
    const env = { AGY_DART_CONFIG_PATH: cfgPath };
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "s-min", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: smallFile } } }, dbPath, env).decision,
      "allow"
    );
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "s-min", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: smallFile } } }, dbPath, env).decision,
      "allow",
      "1.5 KB file (< 4 KB default) must pass through directly without 2-strike dedup"
    );

    // 2. Large file (~13 KB, 200 lines): narrow 15-line slice (~1 KB < 4 KB) passes through directly; wide slice (>= 4 KB) dedups!
    fs.writeFileSync(bigFile, makeCodeLines(200, "export const bigVal"), "utf8");
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "s-min", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: bigFile } } }, dbPath, env).decision,
      "allow"
    );
    const narrowSlice = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-min", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: bigFile, StartLine: 10, EndLine: 24 } } },
      dbPath,
      env
    );
    assert.equal(narrowSlice.decision, "allow", "15-line narrow slice (~1 KB < 4 KB) must allow directly without 2-strike backfire");

    const wideSlice1 = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-min", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: bigFile, StartLine: 1, EndLine: 120 } } },
      dbPath,
      env
    );
    assert.equal(wideSlice1.decision, "deny", "Wide slice (~7.8 KB >= 4 KB) must still trigger read-dedup");
    assert.match(wideSlice1.reason, /read-dedup/);

    // 3. Strike 2 bypass records dedup_bypass telemetry WITHOUT inflating getStats().breakdown.dedups or read_dedup.calls
    const wideSlice2 = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-min", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: bigFile, StartLine: 1, EndLine: 120 } } },
      dbPath,
      env
    );
    assert.equal(wideSlice2.decision, "allow");

    const store = new ContextModeStore({ dbPath });
    store.open();
    const bypassRow = store.db
      .prepare("SELECT kind, key, sandbox_bytes, returned_bytes FROM events WHERE session_id = ? AND key = 'dedup_bypass'")
      .get("s-min");
    assert.ok(bypassRow, "Strike 2 bypass must record a dedup_bypass telemetry event");
    assert.equal(bypassRow.kind, "dedup");
    assert.equal(bypassRow.sandbox_bytes, bypassRow.returned_bytes);

    const stats = store.getStats("s-min");
    assert.equal(stats.breakdown.dedups, 1, "dedup_bypass must NOT inflate breakdown.dedups");
    const roi = store.getFeatureRoi("s-min");
    assert.equal(roi.features.read_dedup.calls, 1, "dedup_bypass must NOT inflate read_dedup.calls");
    assert.equal(roi.features.read_dedup.bypasses, 1);
    assert.equal(roi.features.read_dedup.bypassRate, 1);

    // ctx_doctor exposes readDedup config (minBytes, maxSteps, maxTurns) alongside readGuard
    const prevCfgEnv = process.env.AGY_DART_CONFIG_PATH;
    process.env.AGY_DART_CONFIG_PATH = cfgPath;
    resetConfigCache();
    try {
      const ctxTools = createTools({ store, getSessionId: () => "s-min", getCwd: () => tmpDir });
      const doctorOut = await ctxTools.ctx_doctor({ cwd: tmpDir });
      assert.deepEqual(doctorOut.readDedup, {
        enabled: true,
        minBytes: 4096,
        maxSteps: 40,
        maxTurns: 12
      });
    } finally {
      if (prevCfgEnv === undefined) delete process.env.AGY_DART_CONFIG_PATH;
      else process.env.AGY_DART_CONFIG_PATH = prevCfgEnv;
      resetConfigCache();
    }
    store.close();

    // 4. Env override AGY_DART_READ_DEDUP_MIN_BYTES=1024 restores dedup on 1.5 KB smallFile
    const lowMinEnv = { ...env, AGY_DART_READ_DEDUP_MIN_BYTES: "1024" };
    assert.equal(
      runHook("hooks/pre-tool-use.mjs", { conversationId: "s-min-env", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: smallFile } } }, dbPath, lowMinEnv).decision,
      "allow"
    );
    const smallDedup = runHook(
      "hooks/pre-tool-use.mjs",
      { conversationId: "s-min-env", cwd: tmpDir, toolCall: { name: "read_file", args: { Path: smallFile } } },
      dbPath,
      lowMinEnv
    );
    assert.equal(smallDedup.decision, "deny");
    assert.match(smallDedup.reason, /read-dedup/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("v1.3.1-5: cli-filter compactFailureWithErrorAnchors preserves middle AssertionError/stack & tail summary within <=7900B UTF-8", () => {
  // 1. Build a ~32 KB failing test log with root-cause AssertionError buried in the middle
  const lines = [
    "> project@1.0.0 test",
    "> node --test tests/*.test.mjs",
    "TAP version 13",
    "# Starting integration test run..."
  ];
  for (let i = 0; i < 200; i++) {
    lines.push(`[debug ${String(i).padStart(3, "0")}] worker setup verbose trace payload=${"a".repeat(52)}`);
  }
  lines.push("# Subtest: auth middleware validates rotated JWT");
  lines.push("not ok 42 - auth middleware validates rotated JWT");
  lines.push("  AssertionError [ERR_ASSERTION]: Expected HTTP status 200 but received 401");
  lines.push("    401 !== 200");
  lines.push("      at verifyRotatedJwt (e:/repo/src/auth/jwt.js:88:12)");
  lines.push("      at TestContext.<anonymous> (e:/repo/tests/auth.test.mjs:41:5)");
  for (let i = 0; i < 220; i++) {
    lines.push(`[trace ${String(i).padStart(3, "0")}] post-failure cleanup verbose log payload=${"b".repeat(52)}`);
  }
  lines.push("  ✖ rejects expired session cookie");
  lines.push("    TypeError: Cannot read properties of undefined (reading 'expiresAt')");
  lines.push("      at parseCookie (e:/repo/src/auth/cookie.js:19:7)");
  lines.push("ℹ tests 120");
  lines.push("ℹ suites 12");
  lines.push("ℹ pass 118");
  lines.push("ℹ fail 2");
  lines.push("ℹ duration_ms 4120.5");

  const raw32k = lines.join("\n");
  assert.ok(Buffer.byteLength(raw32k, "utf8") > 30000, "Fixture must exceed 30 KB");

  const res = applyFilterRule("test-runner", raw32k, "", 1, { sourceId: "src_fail_1" });
  assert.equal(res.wasFiltered, true);
  assert.equal(res.truncated, true);
  assert.ok(
    res.filteredBytes <= MAX_FILTERED_OUTPUT_BYTES,
    `Expected <= ${MAX_FILTERED_OUTPUT_BYTES} B, got ${res.filteredBytes} B`
  );
  assert.equal(Buffer.byteLength(res.filteredText, "utf8"), res.filteredBytes);
  assert.ok(res.filteredText.includes("AssertionError [ERR_ASSERTION]: Expected HTTP status 200 but received 401"), "Must preserve middle root-cause AssertionError");
  assert.ok(res.filteredText.includes("at verifyRotatedJwt (e:/repo/src/auth/jwt.js:88:12)"), "Must preserve middle stack trace");
  assert.ok(res.filteredText.includes("✖ rejects expired session cookie"), "Must preserve late indented ✖ failure anchor");
  assert.ok(res.filteredText.includes("ℹ fail 2"), "Must preserve tail summary");
  assert.ok(res.filteredText.includes("error-anchors"), "Footer must note error-anchors compaction");
  assert.ok(!res.filteredText.includes("\uFFFD"), "Output must remain valid UTF-8");

  // 2. CJK + Emoji 30 KB failure log: strictly <= budget with zero broken multi-byte characters
  const cjkLines = ["开始执行构建校验..."];
  for (let i = 0; i < 180; i++) {
    cjkLines.push(`普通构建日志第 ${i} 行：正在编译常规业务模块数据内容_${"日志".repeat(18)}`);
  }
  cjkLines.push("ERROR: 数据库迁移脚本校验失败 🚨 缺少字段 read_turn_seq");
  cjkLines.push("    at migrateSchema (src/store/schema.js:265:9)");
  for (let i = 0; i < 180; i++) {
    cjkLines.push(`后续清理日志第 ${i} 行：释放临时资源句柄信息_${"清理".repeat(18)}`);
  }
  cjkLines.push("构建退出码: 1");
  const cjkRes = compactFailureWithErrorAnchors(cjkLines.join("\n"), 4000);
  assert.ok(cjkRes !== null);
  assert.ok(Buffer.byteLength(cjkRes, "utf8") <= 4000);
  assert.ok(cjkRes.includes("数据库迁移脚本校验失败 🚨 缺少字段 read_turn_seq"));
  assert.ok(cjkRes.includes("构建退出码: 1"));
  assert.ok(!cjkRes.includes("\uFFFD"));

  // 3. Many scattered error lines (60 blocks) still strictly stay within budget and preserve first + last + tail
  const floodLines = ["header line 0"];
  for (let i = 0; i < 60; i++) {
    floodLines.push(`ERROR: block_${i} failure message ${"x".repeat(40)}`);
    for (let j = 0; j < 6; j++) floodLines.push(`  filler_${i}_${j} ${"y".repeat(30)}`);
  }
  floodLines.push("FINAL SUMMARY: 60 failures");
  const floodRes = compactFailureWithErrorAnchors(floodLines.join("\n"), 3200);
  assert.ok(floodRes !== null);
  assert.ok(Buffer.byteLength(floodRes, "utf8") <= 3200);
  assert.ok(floodRes.includes("ERROR: block_0 failure message"), "Must preserve first error block");
  assert.ok(floodRes.includes("ERROR: block_59 failure message"), "Must preserve last error block");
  assert.ok(floodRes.includes("FINAL SUMMARY: 60 failures"), "Must preserve final summary");

  // 4. Zero-error summary lines ("0 errors", "ℹ fail 0", "Tests: 0 failed, 50 passed") without real errors return null -> clean fallback
  const noRealErrLines = [
    "runner start",
    "ℹ fail 0",
    "0 errors",
    "pkg-a: Tests: 0 failed, 50 passed, 50 total",
    "test result: ok. 12 passed; 0 failed; 0 ignored",
    ...Array.from({ length: 300 }, (_, i) => `normal output line ${i} ${"z".repeat(80)}`)
  ];
  assert.equal(compactFailureWithErrorAnchors(noRealErrLines.join("\n"), 3000), null);

  // 5. Huge single error line (4.5 KB) inside ±3 block is clipped rather than skipped, AND preserves following stack frame
  const hugeErrLineLog = [
    "> npm test",
    ...Array.from({ length: 120 }, (_, i) => `[debug ${i}] verbose trace ${"x".repeat(60)}`),
    "[ctx] before 1",
    "[ctx] before 2",
    "[ctx] before 3",
    "AssertionError: ROOT_CAUSE_NEEDLE expected " + "A".repeat(4500) + " === B",
    "    at verifyToken (src/auth.js:42:9)",
    ...Array.from({ length: 120 }, (_, i) => `[after ${i}] cleanup trace ${"y".repeat(60)}`),
    "ℹ fail 1"
  ];
  const hugeRes = compactFailureWithErrorAnchors(hugeErrLineLog.join("\n"), 4000);
  assert.ok(hugeRes !== null && Buffer.byteLength(hugeRes, "utf8") <= 4000);
  assert.ok(hugeRes.includes("AssertionError: ROOT_CAUSE_NEEDLE"), "Huge error anchor line must be clipped, never dropped");
  assert.ok(hugeRes.includes("at verifyToken (src/auth.js:42:9)"), "Stack trace frame after huge error line must be preserved");
  assert.ok(!hugeRes.includes("\uFFFD"));

  // 6. PascalCase exception classes (ValueError, NullPointerException) & ERR_* codes in middle of 32 KB log are detected
  const pyLines = [
    "> pytest",
    ...Array.from({ length: 200 }, (_, i) => `collecting item ${i} ${"x".repeat(70)}`),
    "    raise ValueError('JWT_EXPIRED_NEEDLE')",
    "ValueError: JWT_EXPIRED_NEEDLE",
    ...Array.from({ length: 200 }, (_, i) => `teardown item ${i} ${"y".repeat(70)}`),
    "exit status 1"
  ];
  const pyRes = compactFailureWithErrorAnchors(pyLines.join("\n"), 4000);
  assert.ok(pyRes !== null && Buffer.byteLength(pyRes, "utf8") <= 4000);
  assert.ok(pyRes.includes("ValueError: JWT_EXPIRED_NEEDLE"), "PascalCase *Error: in middle of log must be preserved");

  // 7. Tight minimum budget (450 B) with multi-block CJK/emoji flood stays strictly <= 450 B, valid UTF-8, keeping root-cause anchor
  const tightFlood = [
    "启动测试套件...",
    ...Array.from({ length: 80 }, (_, i) => `普通日志行 ${i} ${"内容".repeat(20)}`),
    "ERROR: 根因断言失败 🚨 FIRST_ROOT_CAUSE",
    ...Array.from({ length: 80 }, (_, i) => `中间日志行 ${i} ${"数据".repeat(20)}`),
    "ERROR: 末尾连带失败 LAST_ERROR",
    "退出码: 1"
  ];
  const tightRes = compactFailureWithErrorAnchors(tightFlood.join("\n"), 450);
  assert.ok(tightRes !== null);
  assert.ok(Buffer.byteLength(tightRes, "utf8") <= 450, `Expected <= 450 B, got ${Buffer.byteLength(tightRes, "utf8")} B`);
  assert.ok(tightRes.includes("FIRST_ROOT_CAUSE"), "Tight budget must still retain first root-cause anchor");
  assert.ok(!tightRes.includes("\uFFFD"), "Tight CJK/emoji trim must stay valid UTF-8");

  // 8. Passing run (exitCode=0) never adds error-anchors even when output is huge
  const passRes = applyFilterRule("build-lint", raw32k, "", 0);
  assert.ok(!passRes.filteredText.includes("error-anchors"));
});
