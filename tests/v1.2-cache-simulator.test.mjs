import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  formatSimulationMarkdown,
  simulateCachePolicies
} from "../context/lib/cache-simulator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function policyById(report, id) {
  const found = report.policies.find((p) => p.id === id);
  assert.ok(found, `Expected policy '${id}' in report.policies`);
  return found;
}

function assertAllNumbersFinite(obj, pathPrefix = "root") {
  if (typeof obj === "number") {
    assert.ok(Number.isFinite(obj), `Non-finite number at ${pathPrefix}: ${obj}`);
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, idx) => assertAllNumbersFinite(v, `${pathPrefix}[${idx}]`));
    return;
  }
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      assertAllNumbersFinite(v, `${pathPrefix}.${k}`);
    }
  }
}

test("P2-10.1: Idle-heavy Claude session (8-15 min gaps at 120k context) -> ttl-1h beats ttl-5m despite 2.0x write surcharge & inputs stay immutable", () => {
  const t0 = Date.parse("2026-11-20T10:00:00Z");
  const iso = (sec) => new Date(t0 + sec * 1000).toISOString();

  // Claude Sonnet 4.6 ($3/1M, 90% read discount, 1.25x 5m write, 2.0x 1h write)
  // Multiple 9-14 min idle gaps at ~120k context, observed running on 5m TTL (3 idle busts)
  const idleHeavySession = [
    {
      type: "PLANNER_RESPONSE",
      step_index: 1,
      created_at: iso(0),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 2000, cache_creation_input_tokens: 118000, cache_read_input_tokens: 0, output_tokens: 300 }
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 2,
      created_at: iso(540), // 9 min gap -> 5m TTL bust
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 2000, cache_creation_input_tokens: 122000, cache_read_input_tokens: 0, output_tokens: 250 }
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 3,
      created_at: iso(1260), // 12 min gap -> 5m TTL bust
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 2000, cache_creation_input_tokens: 126000, cache_read_input_tokens: 0, output_tokens: 250 }
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 4,
      created_at: iso(2100), // 14 min gap -> 5m TTL bust
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 2000, cache_creation_input_tokens: 130000, cache_read_input_tokens: 0, output_tokens: 250 }
    }
  ];

  const snapshotBefore = JSON.stringify(idleHeavySession);
  const report = simulateCachePolicies([idleHeavySession]);
  assert.equal(JSON.stringify(idleHeavySession), snapshotBefore, "simulateCachePolicies MUST NOT mutate input sessions");
  assertAllNumbersFinite(report);

  assert.equal(report.sessions, 1);
  assert.equal(report.turnsWithUsage, 4);
  assert.equal(report.policies.length, 9);

  const obs = policyById(report, "observed");
  const ttl5m = policyById(report, "ttl-5m");
  const ttl1h = policyById(report, "ttl-1h");

  // Observed & ttl-5m both suffer 3 idle busts: (496k * 1.25 + 8k) * $3/1M = $1.8840
  assert.equal(obs.projectedBusts, 3);
  assert.equal(obs.projectedInputCostUsd, 1.884);
  assert.equal(ttl5m.projectedBusts, 3);
  assert.equal(ttl5m.projectedInputCostUsd, 1.884);

  // ttl-1h eliminates all 3 idle busts:
  // T1: 118k*2.0 + 2k = 238k; T2: 120k*0.1 + 2k*2.0 + 2k = 18k;
  // T3: 124k*0.1 + 2k*2.0 + 2k = 18.4k; T4: 128k*0.1 + 2k*2.0 + 2k = 18.8k -> 293.2k * $3/1M = $0.8796
  assert.equal(ttl1h.projectedBusts, 0);
  assert.equal(ttl1h.projectedWastedTokens, 0);
  assert.ok(ttl1h.projectedHitRate > 0.70, `Expected high hit rate under ttl-1h, got ${ttl1h.projectedHitRate}`);
  assert.equal(ttl1h.projectedInputCostUsd, 0.8796);
  assert.ok(
    ttl1h.projectedInputCostUsd < ttl5m.projectedInputCostUsd,
    `Expected ttl-1h ($${ttl1h.projectedInputCostUsd}) < ttl-5m ($${ttl5m.projectedInputCostUsd})`
  );
  assert.ok(ttl1h.deltaUsdVsObserved < -1.0, `Expected >$1 savings, got ${ttl1h.deltaUsdVsObserved}`);
  assert.ok(ttl1h.deltaPctVsObserved < -50, `Expected >50% savings, got ${ttl1h.deltaPctVsObserved}%`);
  assert.ok(report.rationale.includes("1h TTL beats 5m TTL"), `Unexpected rationale: ${report.rationale}`);

  // Also verify simplified Antigravity schema (no cache_creation_input_tokens) still shows ttl-1h beating ttl-5m!
  const simpleClaudeIdle = [
    { type: "PLANNER_RESPONSE", step_index: 1, created_at: iso(0), model: "claude-sonnet-4-6", input_tokens: 120000, cache_read_tokens: 0 },
    { type: "PLANNER_RESPONSE", step_index: 2, created_at: iso(600), model: "claude-sonnet-4-6", input_tokens: 124000, cache_read_tokens: 0 },
    { type: "PLANNER_RESPONSE", step_index: 3, created_at: iso(1200), model: "claude-sonnet-4-6", input_tokens: 128000, cache_read_tokens: 0 }
  ];
  const simpleRep = simulateCachePolicies([simpleClaudeIdle]);
  assertAllNumbersFinite(simpleRep);
  assert.ok(
    policyById(simpleRep, "ttl-1h").projectedInputCostUsd < policyById(simpleRep, "ttl-5m").projectedInputCostUsd,
    "Simplified schema idle-heavy Claude session must also show ttl-1h < ttl-5m"
  );
});

test("P2-10.2: Short/bursty Claude session (no idle gaps >5m) -> ttl-5m beats ttl-1h due to 2.0x write penalty", () => {
  const t0 = Date.parse("2026-11-20T11:00:00Z");
  const iso = (sec) => new Date(t0 + sec * 1000).toISOString();

  // Case A: Observed running on 5m TTL with fast 20-35s cadence (0 idle gaps >= 300s)
  const bursty5mSession = [
    {
      type: "PLANNER_RESPONSE",
      step_index: 1,
      created_at: iso(0),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 2000, cache_creation_input_tokens: 98000, cache_read_input_tokens: 0, output_tokens: 200 }
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 2,
      created_at: iso(25),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 1000, cache_creation_input_tokens: 3000, cache_read_input_tokens: 100000, output_tokens: 200 }
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 3,
      created_at: iso(55),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 1000, cache_creation_input_tokens: 3000, cache_read_input_tokens: 104000, output_tokens: 200 }
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 4,
      created_at: iso(90),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 1000, cache_creation_input_tokens: 3000, cache_read_input_tokens: 108000, output_tokens: 200 }
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 5,
      created_at: iso(120),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 1000, cache_creation_input_tokens: 3000, cache_read_input_tokens: 112000, output_tokens: 200 }
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 6,
      created_at: iso(150),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 1000, cache_creation_input_tokens: 3000, cache_read_input_tokens: 116000, output_tokens: 200 }
    }
  ];

  const repA = simulateCachePolicies([bursty5mSession]);
  assertAllNumbersFinite(repA);

  const obsA = policyById(repA, "observed");
  const ttl5mA = policyById(repA, "ttl-5m");
  const ttl1hA = policyById(repA, "ttl-1h");

  assert.equal(obsA.projectedBusts, 0);
  assert.equal(ttl5mA.projectedBusts, 0);
  assert.equal(ttl1hA.projectedBusts, 0);
  assert.equal(ttl5mA.projectedInputCostUsd, obsA.projectedInputCostUsd);
  assert.ok(
    ttl5mA.projectedInputCostUsd < ttl1hA.projectedInputCostUsd,
    `Expected ttl-5m ($${ttl5mA.projectedInputCostUsd}) < ttl-1h ($${ttl1hA.projectedInputCostUsd})`
  );
  assert.ok(ttl1hA.deltaUsdVsObserved > 0.20, `Expected ttl-1h to cost >$0.20 more, got ${ttl1hA.deltaUsdVsObserved}`);
  assert.ok(ttl1hA.deltaPctVsObserved > 35, `Expected ttl-1h penalty >35%, got ${ttl1hA.deltaPctVsObserved}%`);
  assert.equal(repA.recommendedPolicy, "observed", "Already-optimal 5m bursty session should keep 'observed'");
  assert.ok(repA.rationale.includes("5m TTL beats 1h TTL"), `Unexpected rationale: ${repA.rationale}`);

  // Case B: Same bursty session mistakenly paying 2.0x 1h TTL -> simulator recommends switching to ttl-5m!
  const burstyOverpaying1h = bursty5mSession.map((step, i) => ({
    ...step,
    usage: {
      ...step.usage,
      ...(i === 0 ? { cache_creation: { ephemeral_1h_input_tokens: 98000, ephemeral_5m_input_tokens: 0 } } : {})
    }
  }));
  const repB = simulateCachePolicies([burstyOverpaying1h]);
  assertAllNumbersFinite(repB);
  assert.equal(repB.recommendedPolicy, "ttl-5m", "Overpaying 1h TTL on a bursty workload should recommend ttl-5m");
  assert.ok(policyById(repB, "ttl-5m").deltaPctVsObserved < -20);
});

test("P2-10.3: High-context cold-idle session -> cold-boundary-compact slashes subsequent input tokens & USD cost", () => {
  const t0 = Date.parse("2026-11-20T12:00:00Z");
  const iso = (sec) => new Date(t0 + sec * 1000).toISOString();

  // High context (140k on 200k window -> well above 30% = 60k coldCompactTokens),
  // 10-min TTL expiry on Turn 3 followed by 4 active warm turns carrying the full context forward!
  const highCtxColdSession = [
    {
      type: "PLANNER_RESPONSE",
      step_index: 1,
      created_at: iso(0),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 2000, cache_creation_input_tokens: 138000, cache_read_input_tokens: 0 }
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 2,
      created_at: iso(30),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 2000, cache_creation_input_tokens: 3000, cache_read_input_tokens: 140000 }
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 3,
      created_at: iso(630), // 600s >= 300s TTL expiry at 145k prevCtx -> cold boundary compaction!
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 2000, cache_creation_input_tokens: 148000, cache_read_input_tokens: 0 }
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 4,
      created_at: iso(660),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 2000, cache_creation_input_tokens: 3000, cache_read_input_tokens: 150000 }
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 5,
      created_at: iso(690),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 2000, cache_creation_input_tokens: 3000, cache_read_input_tokens: 155000 }
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 6,
      created_at: iso(720),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 2000, cache_creation_input_tokens: 3000, cache_read_input_tokens: 160000 }
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 7,
      created_at: iso(750),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 2000, cache_creation_input_tokens: 3000, cache_read_input_tokens: 165000 }
    }
  ];

  const report = simulateCachePolicies([highCtxColdSession]);
  assertAllNumbersFinite(report);

  const obs = policyById(report, "observed");
  const coldCompact = policyById(report, "cold-boundary-compact");

  // Turn 3 compacts 145k -> min(145k*0.25, 25k) = 25k (sheds 120k!), saving massive cold re-prefill + 4 warm reads
  assert.equal(coldCompact.projectedBusts, obs.projectedBusts, "Cold-boundary compaction adds zero extra cache busts");
  assert.ok(
    coldCompact.projectedWastedTokens < obs.projectedWastedTokens * 0.30,
    `Expected wasted tokens slashed (<30% of ${obs.projectedWastedTokens}), got ${coldCompact.projectedWastedTokens}`
  );
  assert.ok(
    coldCompact.projectedInputCostUsd < obs.projectedInputCostUsd * 0.65,
    `Expected >35% input USD reduction, obs=$${obs.projectedInputCostUsd} vs compact=$${coldCompact.projectedInputCostUsd}`
  );
  assert.ok(coldCompact.deltaPctVsObserved <= -35);
  assert.ok(coldCompact.notes.includes("1 cold-boundary compaction"), `Unexpected notes: ${coldCompact.notes}`);
  assert.equal(report.recommendedPolicy, "cold-boundary-compact");
});

test("P2-10.4: Oversized tool-dump session -> cutoff-strict-8k <= cutoff-balanced-16k <= cutoff-relaxed-32k < observed", () => {
  const t0 = Date.parse("2026-11-20T13:00:00Z");
  const iso = (sec) => new Date(t0 + sec * 1000).toISOString();

  // Build 3 realistic oversized tool results across tiers:
  // - 12 KB dump (only caught by strict-8k)
  // - 24 KB dump (caught by strict-8k & balanced-16k, missed by relaxed-32k)
  // - 48 KB dump (caught by all three, with stricter summary caps saving more)
  const dump12k = "log_entry_alpha_0123456789abcdef\n".repeat(375); // ~12.4 KB
  const dump24k = "中文日志输出记录_error_stack_trace_line\n".repeat(480); // ~24+ KB UTF-8 CJK
  const dump48k = "test_output_verbose_row_0123456789abcdef01234567\n".repeat(1000); // ~49 KB

  const toolDumpSession = [
    {
      type: "PLANNER_RESPONSE",
      step_index: 1,
      created_at: iso(0),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 1000, cache_creation_input_tokens: 29000, cache_read_input_tokens: 0 }
    },
    { type: "GENERIC", step_index: 2, content: dump12k },
    {
      type: "PLANNER_RESPONSE",
      step_index: 3,
      created_at: iso(20),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 500, cache_creation_input_tokens: 4500, cache_read_input_tokens: 30000 }
    },
    { type: "TOOL_RESULT", step_index: 4, content: dump24k },
    {
      type: "PLANNER_RESPONSE",
      step_index: 5,
      created_at: iso(40),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 500, cache_creation_input_tokens: 9500, cache_read_input_tokens: 35000 }
    },
    { type: "GENERIC", step_index: 6, content: dump48k },
    {
      type: "PLANNER_RESPONSE",
      step_index: 7,
      created_at: iso(60),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 500, cache_creation_input_tokens: 14500, cache_read_input_tokens: 45000 }
    },
    // Propagate avoided context delta across 5 subsequent warm turns!
    {
      type: "PLANNER_RESPONSE",
      step_index: 8,
      created_at: iso(80),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 500, cache_creation_input_tokens: 1500, cache_read_input_tokens: 60000 }
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 9,
      created_at: iso(100),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 500, cache_creation_input_tokens: 1500, cache_read_input_tokens: 62000 }
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 10,
      created_at: iso(120),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 500, cache_creation_input_tokens: 1500, cache_read_input_tokens: 64000 }
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 11,
      created_at: iso(140),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 500, cache_creation_input_tokens: 1500, cache_read_input_tokens: 66000 }
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 12,
      created_at: iso(160),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 500, cache_creation_input_tokens: 1500, cache_read_input_tokens: 68000 }
    }
  ];

  const report = simulateCachePolicies([toolDumpSession]);
  assertAllNumbersFinite(report);

  const obs = policyById(report, "observed");
  const strict8k = policyById(report, "cutoff-strict-8k");
  const balanced16k = policyById(report, "cutoff-balanced-16k");
  const relaxed32k = policyById(report, "cutoff-relaxed-32k");

  assert.ok(strict8k.notes.includes("Capped 3 payload(s)"), `strict-8k should cap all 3 dumps: ${strict8k.notes}`);
  assert.ok(balanced16k.notes.includes("Capped 2 payload(s)"), `balanced-16k should cap 2 dumps: ${balanced16k.notes}`);
  assert.ok(relaxed32k.notes.includes("Capped 1 payload(s)"), `relaxed-32k should cap 1 dump: ${relaxed32k.notes}`);

  assert.ok(
    strict8k.projectedInputCostUsd < balanced16k.projectedInputCostUsd,
    `Expected strict-8k ($${strict8k.projectedInputCostUsd}) < balanced-16k ($${balanced16k.projectedInputCostUsd})`
  );
  assert.ok(
    balanced16k.projectedInputCostUsd < relaxed32k.projectedInputCostUsd,
    `Expected balanced-16k ($${balanced16k.projectedInputCostUsd}) < relaxed-32k ($${relaxed32k.projectedInputCostUsd})`
  );
  assert.ok(
    relaxed32k.projectedInputCostUsd < obs.projectedInputCostUsd,
    `Expected relaxed-32k ($${relaxed32k.projectedInputCostUsd}) < observed ($${obs.projectedInputCostUsd})`
  );
  assert.ok(strict8k.deltaPctVsObserved < -15, `Expected >15% total savings under strict-8k, got ${strict8k.deltaPctVsObserved}%`);
  assert.equal(report.recommendedPolicy, "cutoff-strict-8k");
});

test("P2-10.5: Empty, zero-usage, and malformed sessions produce zero NaN/Infinity in JSON & Markdown", () => {
  const cases = [
    [],
    [[]],
    [null, undefined, "not-an-array", [{ type: "USER_INPUT", content: "hello" }]],
    [
      [
        {
          type: "PLANNER_RESPONSE",
          step_index: 1,
          input_tokens: 0,
          cache_read_tokens: 0,
          usage: { promptTokenCount: 0 }
        }
      ]
    ]
  ];

  for (const input of cases) {
    const rep = simulateCachePolicies(input);
    assertAllNumbersFinite(rep);
    assert.equal(rep.sessions, 0);
    assert.equal(rep.turnsWithUsage, 0);
    assert.equal(rep.recommendedPolicy, "observed");
    assert.equal(rep.policies.length, 9);
    for (const p of rep.policies) {
      assert.equal(p.projectedHitRate, 0);
      assert.equal(p.projectedBusts, 0);
      assert.equal(p.projectedWastedTokens, 0);
      assert.equal(p.projectedInputCostUsd, 0);
      assert.equal(p.deltaUsdVsObserved, 0);
      assert.equal(p.deltaPctVsObserved, 0);
    }

    const md = formatSimulationMarkdown(rep);
    assert.ok(md.includes("# agy-dart Offline KV-Cache Policy Replay Simulation"));
    assert.ok(!md.includes("NaN"), `Markdown must never contain NaN:\n${md}`);
    assert.ok(!md.includes("Infinity"), `Markdown must never contain Infinity:\n${md}`);
  }
});

test("P2-10.6: Live CLI benchmark.mjs cache simulate (JSON & Markdown) + existing cache command preserved", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-sim-cli-"));
  const t0 = Date.parse("2026-11-20T09:00:00Z");
  const iso = (sec) => new Date(t0 + sec * 1000).toISOString();

  const fixtureSteps = [
    {
      type: "PLANNER_RESPONSE",
      step_index: 1,
      created_at: iso(0),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 2000, cache_creation_input_tokens: 118000, cache_read_input_tokens: 0 }
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 2,
      created_at: iso(600),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 2000, cache_creation_input_tokens: 122000, cache_read_input_tokens: 0 }
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 3,
      created_at: iso(1200),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 2000, cache_creation_input_tokens: 126000, cache_read_input_tokens: 0 }
    }
  ];
  const fixturePath = path.join(tmpDir, "idle_claude.jsonl");
  fs.writeFileSync(fixturePath, fixtureSteps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");

  try {
    // 1. --help documents cache simulate
    const helpRes = spawnSync(process.execPath, [path.join(ROOT, "fast", "benchmark.mjs"), "--help"], {
      encoding: "utf8",
      windowsHide: true
    });
    assert.equal(helpRes.status, 0, helpRes.stderr);
    assert.ok(helpRes.stdout.includes("cache simulate"), `Missing cache simulate in help:\n${helpRes.stdout}`);

    // 2. cache simulate --json
    const jsonRes = spawnSync(
      process.execPath,
      [path.join(ROOT, "fast", "benchmark.mjs"), "cache", "simulate", fixturePath, "--json"],
      { encoding: "utf8", windowsHide: true }
    );
    assert.equal(jsonRes.status, 0, jsonRes.stderr);
    const parsed = JSON.parse(jsonRes.stdout);
    assertAllNumbersFinite(parsed);
    assert.equal(parsed.sessions, 1);
    assert.equal(parsed.turnsWithUsage, 3);
    assert.equal(parsed.policies.length, 9);
    assert.ok(
      policyById(parsed, "ttl-1h").projectedInputCostUsd < policyById(parsed, "ttl-5m").projectedInputCostUsd
    );

    // 3. cache simulate Markdown mode
    const mdRes = spawnSync(
      process.execPath,
      [path.join(ROOT, "fast", "benchmark.mjs"), "cache", "simulate", fixturePath],
      { encoding: "utf8", windowsHide: true }
    );
    assert.equal(mdRes.status, 0, mdRes.stderr);
    assert.ok(mdRes.stdout.includes("# agy-dart Offline KV-Cache Policy Replay Simulation"));
    assert.ok(mdRes.stdout.includes("| `ttl-5m`"));
    assert.ok(mdRes.stdout.includes("| `ttl-1h`"));
    assert.ok(mdRes.stdout.includes("| `cold-boundary-compact`"));
    assert.ok(mdRes.stdout.includes("| `cutoff-strict-8k`"));
    assert.ok(mdRes.stdout.includes("| `cutoff-balanced-16k`"));
    assert.ok(mdRes.stdout.includes("| `cutoff-relaxed-32k`"));
    assert.ok(!mdRes.stdout.includes("NaN"));

    // 4. Existing `cache` command still works unchanged
    const diagRes = spawnSync(
      process.execPath,
      [path.join(ROOT, "fast", "benchmark.mjs"), "cache", fixturePath, "--json"],
      { encoding: "utf8", windowsHide: true }
    );
    assert.equal(diagRes.status, 0, diagRes.stderr);
    const diagJson = JSON.parse(diagRes.stdout);
    assert.equal(diagJson.sessions, 1);
    assert.equal(diagJson.bustCount, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("P2-10.7: Isolated install.mjs install --target copies cache-simulator.js and installed benchmark.mjs cache simulate runs cleanly", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-sim-install-"));
  const installDir = path.join(tmpRoot, "installed-plugin");
  const fixturePath = path.join(tmpRoot, "sample.jsonl");
  const t0 = Date.parse("2026-11-20T08:00:00Z");
  const iso = (sec) => new Date(t0 + sec * 1000).toISOString();

  const steps = [
    {
      type: "PLANNER_RESPONSE",
      step_index: 1,
      created_at: iso(0),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 1500, cache_creation_input_tokens: 80000, cache_read_input_tokens: 0 }
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 2,
      created_at: iso(30),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 1500, cache_creation_input_tokens: 2000, cache_read_input_tokens: 81500 }
    }
  ];
  fs.writeFileSync(fixturePath, steps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");

  try {
    const instRes = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "install.mjs"), "install", "--target", installDir, "--mode", "balanced-16k", "--with-devtools"],
      {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, AGY_DART_DISABLE_COMPILE_CACHE: "1" }
      }
    );
    assert.equal(instRes.status, 0, `${instRes.stdout}\n${instRes.stderr}`);

    const copiedSim = path.join(installDir, "context", "lib", "cache-simulator.js");
    assert.ok(fs.existsSync(copiedSim), "install.mjs --with-devtools must copy context/lib/cache-simulator.js");

    // Run the INSTALLED copy of benchmark.mjs cache simulate to guarantee zero missing modules
    const simRes = spawnSync(
      process.execPath,
      [path.join(installDir, "fast", "benchmark.mjs"), "cache", "simulate", fixturePath, "--json"],
      { encoding: "utf8", windowsHide: true }
    );
    assert.equal(simRes.status, 0, `Installed benchmark.mjs cache simulate failed: ${simRes.stderr}`);
    const parsed = JSON.parse(simRes.stdout);
    assertAllNumbersFinite(parsed);
    assert.equal(parsed.sessions, 1);
    assert.equal(parsed.turnsWithUsage, 2);
    assert.equal(parsed.policies.length, 9);
    assert.ok(
      policyById(parsed, "ttl-5m").projectedInputCostUsd < policyById(parsed, "ttl-1h").projectedInputCostUsd
    );

    // Verify package.json has cache:simulate script
    const pkg = JSON.parse(fs.readFileSync(path.join(installDir, "package.json"), "utf8"));
    assert.equal(pkg.scripts["cache:simulate"], "node fast/benchmark.mjs cache simulate --local --recent 10");
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("P2-10.8: Regression hardening — multi-payload cutoff monotonicity & live warm hit in 300s-330s gap never falsely cold-compacts", () => {
  const t0 = Date.parse("2026-11-20T15:00:00Z");
  const iso = (sec) => new Date(t0 + sec * 1000).toISOString();

  // 1. Multi-payload compressed turn (obsGrowth = 3000 with 3 x 10 KB + 1 x 40 KB tool results)
  // Must strictly satisfy cutoff-strict-8k <= cutoff-balanced-16k <= cutoff-relaxed-32k <= observed
  const dump10k = "a".repeat(10 * 1024);
  const dump40k = "b".repeat(40 * 1024);
  const multiPayloadSession = [
    {
      type: "PLANNER_RESPONSE",
      step_index: 1,
      created_at: iso(0),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 1000, cache_creation_input_tokens: 39000, cache_read_input_tokens: 0 }
    },
    { type: "GENERIC", step_index: 2, content: dump10k },
    { type: "GENERIC", step_index: 3, content: dump10k },
    { type: "GENERIC", step_index: 4, content: dump10k },
    { type: "GENERIC", step_index: 5, content: dump40k },
    {
      type: "PLANNER_RESPONSE",
      step_index: 6,
      created_at: iso(25),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 500, cache_creation_input_tokens: 2500, cache_read_input_tokens: 40000 }
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 7,
      created_at: iso(50),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 500, cache_creation_input_tokens: 500, cache_read_input_tokens: 43000 }
    }
  ];

  const cutRep = simulateCachePolicies([multiPayloadSession]);
  assertAllNumbersFinite(cutRep);
  const cutObs = policyById(cutRep, "observed");
  const cut8k = policyById(cutRep, "cutoff-strict-8k");
  const cut16k = policyById(cutRep, "cutoff-balanced-16k");
  const cut32k = policyById(cutRep, "cutoff-relaxed-32k");

  assert.ok(
    cut8k.projectedInputCostUsd < cut16k.projectedInputCostUsd,
    `Expected strict-8k ($${cut8k.projectedInputCostUsd}) < balanced-16k ($${cut16k.projectedInputCostUsd})`
  );
  assert.ok(
    cut16k.projectedInputCostUsd < cut32k.projectedInputCostUsd,
    `Expected balanced-16k ($${cut16k.projectedInputCostUsd}) < relaxed-32k ($${cut32k.projectedInputCostUsd})`
  );
  assert.ok(
    cut32k.projectedInputCostUsd < cutObs.projectedInputCostUsd,
    `Expected relaxed-32k ($${cut32k.projectedInputCostUsd}) < observed ($${cutObs.projectedInputCostUsd})`
  );

  // 2. Live warm cache hit at gapSec = 310s (in [300s, 330s] calibration deadband) at 120k context
  // Must NOT falsely trigger cold-boundary-compact or invent a bust!
  const borderlineWarmSession = [
    {
      type: "PLANNER_RESPONSE",
      step_index: 1,
      created_at: iso(0),
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 2000, cache_creation_input_tokens: 118000, cache_read_input_tokens: 0 }
    },
    {
      type: "PLANNER_RESPONSE",
      step_index: 2,
      created_at: iso(310), // 310s warm hit (300 <= 310 <= 330): cache stayed warm!
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 2000, cache_creation_input_tokens: 1000, cache_read_input_tokens: 120000 }
    }
  ];

  const warmRep = simulateCachePolicies([borderlineWarmSession]);
  assertAllNumbersFinite(warmRep);
  const warmObs = policyById(warmRep, "observed");
  const warmCompact = policyById(warmRep, "cold-boundary-compact");

  assert.equal(warmObs.projectedBusts, 0);
  assert.equal(warmCompact.projectedBusts, 0, "Cold-boundary compaction must never destroy a live warm hit");
  assert.equal(warmCompact.projectedInputCostUsd, warmObs.projectedInputCostUsd);
  assert.equal(warmCompact.deltaUsdVsObserved, 0);
  assert.ok(warmCompact.notes.includes("No TTL-expired turns"), `Unexpected notes: ${warmCompact.notes}`);
});
