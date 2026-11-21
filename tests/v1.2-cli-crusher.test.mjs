import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { isJsonLike, smartCrushJson } from "../context/lib/json-crusher.js";
import { ContextModeStore } from "../context/lib/store.js";
import { createTools } from "../context/lib/tools.js";
import {
  applyFilterRule,
  isSafeRegex,
  loadProjectFilterRules,
  matchFilterRule,
  unwrapSafeCompoundCommand
} from "../hooks/filter-rules.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

test("SmartCrusher: large JSON arrays extract schema + head + tail + prioritized anomalies with original indices", () => {
  const rows = [];
  for (let i = 0; i < 220; i++) {
    rows.push({
      id: i,
      userId: `usr_${String(i).padStart(4, "0")}`,
      endpoint: "/api/v2/orders",
      status: 200,
      ok: true,
      error: null,
      latencyMs: 12 + (i % 30),
      note: `normal_record_${i}_${"payload".repeat(12)}`
    });
  }
  // Inject distinct anomaly types in the middle of the array
  rows[42].status = 503;
  rows[42].note = "upstream gateway timeout";
  rows[88].ok = false;
  rows[88].error = "PAYMENT_DECLINED";
  rows[137].note = "Unhandled fatal exception in worker pool";
  rows[175].userId = null; // unexpected null in non-nullable field (219/220 non-null)
  delete rows[190].latencyMs; // test missing count in schema

  const rawJson = JSON.stringify(rows);
  const rawBytes = Buffer.byteLength(rawJson, "utf8");
  assert.ok(rawBytes > 30000, `Expected >30 KB input, got ${rawBytes}B`);
  assert.equal(isJsonLike(rawJson), true);

  const res = smartCrushJson(rawJson, {
    maxBytes: 7000,
    sourceId: "s_api_orders_1",
    headItems: 3,
    tailItems: 2,
    maxAnomalyItems: 5
  });

  assert.equal(res.crushed, true);
  assert.equal(res.format, "json");
  assert.equal(res.rawBytes, rawBytes);
  assert.equal(res.crushedBytes, Buffer.byteLength(res.text, "utf8"));
  assert.ok(res.crushedBytes <= 7000, `Expected <= 7000B, got ${res.crushedBytes}B`);

  const parsed = JSON.parse(res.text);
  assert.equal(parsed._crushed, true);
  assert.equal(parsed.totalItems, 220);
  assert.equal(parsed.head.length, 3);
  assert.equal(parsed.head[0].id, 0);
  assert.equal(parsed.tail.length, 2);
  assert.equal(parsed.tail[1].id, 219);
  assert.ok(parsed.hint.includes("s_api_orders_1"));

  // Schema summary checks (keys, inferred types, null/missing counts)
  assert.ok(parsed.schema.id.includes("number"));
  assert.ok(parsed.schema.userId.includes("null:1"));
  assert.ok(parsed.schema.latencyMs.includes("missing:1"));

  // Prioritized anomalies preserve original array indices and do NOT falsely flag normal `error: null` rows
  const anomIndices = parsed.anomalies.map((a) => a.index);
  assert.deepEqual(anomIndices, [42, 88, 137, 175]);
  assert.equal(res.stats.totalAnomalies, 4);
  assert.ok(parsed.anomalies.find((a) => a.index === 42).reason.includes("status=503"));
  assert.ok(parsed.anomalies.find((a) => a.index === 88).reason.includes("ok=false"));
  assert.ok(parsed.anomalies.find((a) => a.index === 175).reason.includes("unexpected_null(userId)"));
});

test("SmartCrusher: large nested objects, JSONL/NDJSON, CJK UTF-8 safety, and never inflating small JSON", () => {
  // 1. Small JSON MUST NOT be inflated
  const smallJson = JSON.stringify({ ok: true, count: 3, items: [1, 2, 3] });
  const smallRes = smartCrushJson(smallJson, { maxBytes: 7400 });
  assert.equal(smallRes.crushed, false);
  assert.equal(smallRes.format, "json");
  assert.equal(smallRes.text, smallJson);
  assert.equal(smallRes.crushedBytes, smallRes.rawBytes);

  // Non-JSON plain text returns false
  assert.equal(isJsonLike("plain text log line\nanother line"), false);
  assert.equal(isJsonLike('{"a":1}\n{"a":2}\n{"a":3}\n{"a":4}'), false, "< 5 JSONL lines must not trigger JSONL");

  // 2. Large nested object preserves top-level keys while crushing nested array & huge string
  const nestedObj = {
    requestId: "req-998877",
    region: "ap-northeast-1",
    meta: { page: 1, total: 150 },
    hugeTrace: "堆栈跟踪中文日志行_".repeat(2500),
    events: Array.from({ length: 150 }, (_, i) => ({
      seq: i,
      service: "checkout",
      status: i === 77 ? 500 : 200,
      msg: i === 77 ? "DB connection failed" : `事件处理完成_${i}_` + "中文内容".repeat(10)
    }))
  };
  const nestedRaw = JSON.stringify(nestedObj);
  const nestedRes = smartCrushJson(nestedRaw, { maxBytes: 5500, sourceId: "s_nested_1" });
  assert.equal(nestedRes.crushed, true);
  assert.ok(nestedRes.crushedBytes <= 5500);
  assert.ok(!nestedRes.text.includes("\uFFFD"), "Zero UTF-8 corruption on CJK text");

  const parsedNested = JSON.parse(nestedRes.text);
  assert.equal(parsedNested.requestId, "req-998877");
  assert.equal(parsedNested.region, "ap-northeast-1");
  assert.deepEqual(parsedNested.meta, { page: 1, total: 150 });
  assert.ok(parsedNested.hugeTrace.includes("[truncated,"));
  assert.equal(parsedNested.events._crushedArray, true);
  assert.equal(parsedNested.events.totalItems, 150);
  assert.ok(parsedNested.events.anomalies.some((a) => a.index === 77));
  assert.ok(parsedNested._crushed.hint.includes("s_nested_1"));

  // 3. JSONL / NDJSON (>= 5 valid JSON object lines)
  const jsonlLines = Array.from({ length: 180 }, (_, i) =>
    JSON.stringify({
      ts: `2026-11-20T10:00:${String(i % 60).padStart(2, "0")}Z`,
      level: i === 111 ? "fatal" : "info",
      pod: `api-${i % 4}`,
      msg: i === 111 ? "OOM fatal crash in worker" : `处理请求中文日志_${i}_${"数据".repeat(20)}`
    })
  ).join("\n");
  assert.equal(isJsonLike(jsonlLines), true);
  const jsonlRes = smartCrushJson(jsonlLines, { maxBytes: 4000, sourceId: "s_jsonl_1" });
  assert.equal(jsonlRes.crushed, true);
  assert.equal(jsonlRes.format, "jsonl");
  assert.ok(jsonlRes.crushedBytes <= 4000);
  assert.ok(!jsonlRes.text.includes("\uFFFD"));
  const parsedJsonl = JSON.parse(jsonlRes.text);
  assert.equal(parsedJsonl.format, "jsonl");
  assert.equal(parsedJsonl.totalItems, 180);
  assert.ok(parsedJsonl.anomalies.some((a) => a.index === 111));

  // 4. Extreme tight budget with pure CJK keys/values still obeys <= maxBytes without broken chars
  const cjkHeavy = JSON.stringify(
    Array.from({ length: 60 }, (_, i) => ({
      中文长字段名甲乙丙丁: `中文内容_${i}_` + "超长多字节字符测试".repeat(30)
    }))
  );
  const tightRes = smartCrushJson(cjkHeavy, { maxBytes: 420 });
  assert.equal(tightRes.crushed, true);
  assert.ok(Buffer.byteLength(tightRes.text, "utf8") <= 420);
  assert.ok(!tightRes.text.includes("\uFFFD"));
});

test("filter-rules: safe compound cd/2>&1 wrappers match while ALL forbidden/unsafe compounds still return null", () => {
  // Safe single leading cd + optional trailing 2>&1
  const m1 = matchFilterRule("cd subdir && npm test");
  assert.equal(m1?.rule.id, "test-runner");
  assert.equal(m1.effectiveCommand, "cd subdir && npm test");

  const m2 = matchFilterRule("pytest -v 2>&1");
  assert.equal(m2?.rule.id, "test-runner");
  assert.equal(m2.effectiveCommand, "pytest -v 2>&1");

  const m3 = matchFilterRule('cd /d "C:\\my repo\\packages\\api" && node --test a.test.mjs 2>&1');
  assert.equal(m3?.rule.id, "test-runner");
  assert.equal(m3.effectiveCommand, 'cd /d "C:\\my repo\\packages\\api" && node --test a.test.mjs 2>&1');

  // Unbounded git log wrapped in safe cd + 2>&1 preserves wrapper AND bounds inner git log
  const m4 = matchFilterRule("cd packages/web && git log 2>&1");
  assert.equal(m4?.rule.id, "git-log");
  assert.equal(m4.effectiveCommand, "cd packages/web && git log -n 30 2>&1");
  assert.ok(m4.note);

  // unwrapSafeCompoundCommand parses cleanly
  const uw = unwrapSafeCompoundCommand('cd /d "sub dir" && pytest -v 2>&1');
  assert.equal(uw?.cdPath, "sub dir");
  assert.equal(uw?.innerCommand, "pytest -v");
  assert.equal(uw?.hasStderrRedirect, true);

  // ALL v1.1 forbidden compounds and structured flags MUST STILL return null
  const mustReject = [
    "git status && git diff",
    "npm test | head -n 20",
    "pytest > out.txt",
    "git log; echo hi",
    "git status --porcelain",
    "git diff --stat",
    "vitest --watch",
    "npm test -- --json",
    "git log --format=%h",
    'node "hooks/cli-filter.mjs" --rule git-status --b64 abc',
    // Additional unsafe compound / injection attempts
    "cd subdir && npm test && echo done",
    "cd a && cd b && npm test",
    "cd subdir && npm test | head -n 10",
    "cd subdir && pytest > out.txt",
    "cd subdir; npm test",
    "cd subdir || npm test",
    "cd $(whoami) && npm test",
    "cd %TEMP% && npm test",
    "cd `pwd` && npm test",
    "cd - && npm test",
    "cd && npm test",
    "(cd subdir && npm test)",
    "pytest -v 2>&1 > out.txt",
    "pytest -v 2>&1 2>&1",
    "cd subdir && git status --porcelain",
    "cd subdir && npm test -- --json"
  ];
  for (const cmd of mustReject) {
    assert.equal(matchFilterRule(cmd), null, `Expected unsafe/skip command to return null: ${cmd}`);
  }
});

test("filter-rules: new built-in rules (gh, kubectl, terraform, playwright) + automatic SmartCrusher on large JSON/JSONL", () => {
  // 1. gh-cli
  assert.equal(matchFilterRule("gh pr view 123")?.rule.id, "gh-cli");
  assert.equal(matchFilterRule("gh pr diff 123")?.rule.id, "gh-cli");
  assert.equal(matchFilterRule("gh pr checks 123")?.rule.id, "gh-cli");
  assert.equal(matchFilterRule("gh run view 999")?.rule.id, "gh-cli");
  assert.equal(matchFilterRule("gh issue view 42")?.rule.id, "gh-cli");
  assert.equal(matchFilterRule("gh pr view 123 --json title"), null);
  assert.equal(matchFilterRule("gh pr checks 123 --watch"), null);
  assert.equal(matchFilterRule("gh pr view 123 --web"), null);

  // 2. kubectl (respecting SKIP_FLAGS_RE for -o json / -o yaml and -f/--follow)
  assert.equal(matchFilterRule("kubectl logs pod/api-1 --tail=500")?.rule.id, "kubectl");
  assert.equal(matchFilterRule("kubectl describe pod api-1")?.rule.id, "kubectl");
  assert.equal(matchFilterRule("kubectl get pods -n prod")?.rule.id, "kubectl");
  assert.equal(matchFilterRule("kubectl get pods -o json"), null);
  assert.equal(matchFilterRule("kubectl get pods -o yaml"), null);
  assert.equal(matchFilterRule("kubectl get pods -o=json"), null);
  assert.equal(matchFilterRule("kubectl get pods --output=yaml"), null);
  assert.equal(matchFilterRule("kubectl get pods -ojson"), null);
  assert.equal(matchFilterRule("kubectl get pods -oyaml"), null);
  assert.equal(matchFilterRule("kubectl logs -f pod/api-1"), null);
  assert.equal(matchFilterRule("kubectl logs --follow pod/api-1"), null);
  assert.equal(matchFilterRule("kubectl get pods -w"), null);

  // 3. terraform
  assert.equal(matchFilterRule("terraform plan")?.rule.id, "terraform");
  assert.equal(matchFilterRule("terraform apply -auto-approve")?.rule.id, "terraform");
  assert.equal(matchFilterRule("terraform validate")?.rule.id, "terraform");
  assert.equal(matchFilterRule("terraform validate -json"), null);

  const tfRaw = [
    ...Array.from({ length: 120 }, (_, i) => `aws_iam_role.role_${i}: Refreshing state... [id=role-${i}]`),
    "# aws_s3_bucket.logs will be updated in-place",
    "  ~ resource \"aws_s3_bucket\" \"logs\" {",
    "Plan: 0 to add, 1 to change, 0 to destroy."
  ].join("\n");
  const tfRes = applyFilterRule("terraform", tfRaw, "", 0);
  assert.equal(tfRes.wasFiltered, true);
  assert.ok(!tfRes.filteredText.includes("Refreshing state"));
  assert.ok(tfRes.filteredText.includes("Plan: 0 to add, 1 to change, 0 to destroy."));

  // 4. playwright
  assert.equal(matchFilterRule("playwright test")?.rule.id, "playwright");
  assert.equal(matchFilterRule("npx playwright test tests/login.spec.ts")?.rule.id, "playwright");
  assert.equal(matchFilterRule("cd e2e && npx playwright test 2>&1")?.rule.id, "playwright");
  assert.equal(matchFilterRule("npx playwright test --ui"), null);
  assert.equal(matchFilterRule("npx playwright test --reporter=json"), null);

  const pwPassRaw = [
    "Running 80 tests using 4 workers",
    ...Array.from({ length: 80 }, (_, i) => `  ✓  ${i + 1} [chromium] › auth.spec.ts:10:5 › case #${i} (120ms)`),
    "  80 passed (9.2s)"
  ].join("\n");
  const pwPassRes = applyFilterRule("playwright", pwPassRaw, "", 0);
  assert.equal(pwPassRes.wasFiltered, true);
  assert.ok(pwPassRes.filteredText.includes("80 passed"));
  assert.ok(!pwPassRes.filteredText.includes("case #40"));

  // 5. applyFilterRule automatically runs SmartCrusher on large JSON/JSONL output instead of mid-JSON truncation
  const bigKubeJsonl = Array.from({ length: 150 }, (_, i) =>
    JSON.stringify({
      ts: `2026-11-20T12:00:${String(i % 60).padStart(2, "0")}Z`,
      pod: "billing-0",
      status: i === 66 ? 502 : 200,
      msg: i === 66 ? "upstream error 502 bad gateway" : `heartbeat ok #${i} ${"x".repeat(60)}`
    })
  ).join("\n");
  const kubeCrushed = applyFilterRule("kubectl", bigKubeJsonl, "", 0, { sourceId: "s_kube_1" });
  assert.equal(kubeCrushed.crushedJson, true);
  assert.equal(kubeCrushed.wasFiltered, true);
  assert.ok(kubeCrushed.filteredBytes <= 7900);
  assert.ok(kubeCrushed.filteredText.includes("json-crushed"));
  assert.ok(kubeCrushed.filteredText.includes("s_kube_1"));
  assert.ok(kubeCrushed.filteredText.includes("502"));
});

test("filter-rules: project .agy-dart/filters.json declarative rules (match/keep/drop/cache + malformed & ReDoS fail-open)", () => {
  // ReDoS safety checks
  assert.equal(isSafeRegex("^mycli\\s+run\\b"), true);
  assert.equal(isSafeRegex("ERROR|WARN|PASS|FAIL"), true);
  assert.equal(isSafeRegex("^(?:npx\\s+)?playwright\\s+test(?:\\s|$)"), true);
  assert.equal(isSafeRegex("(a+)+$"), false);
  assert.equal(isSafeRegex("(a?)+"), false);
  assert.equal(isSafeRegex("([a-zA-Z]+)*"), false);
  assert.equal(isSafeRegex("(a|aa)+"), false);
  assert.equal(isSafeRegex("(.*a){15}"), false);
  assert.equal(isSafeRegex("(\\w+\\s*)+"), false);
  assert.equal(isSafeRegex("(a)\\1+"), false);
  assert.equal(isSafeRegex("[unclosed"), false);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-projrules-"));
  const cfgDir = path.join(tmpDir, ".agy-dart");
  const cfgPath = path.join(cfgDir, "filters.json");
  fs.mkdirSync(cfgDir, { recursive: true });

  try {
    // 1. Valid rule + unsafe ReDoS rule + shell-unsafe id in same file: valid loads, unsafe skipped
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        rules: [
          {
            id: "my-rule",
            match: "^mycli\\s+run\\b",
            keep: "ERROR|WARN|PASS|FAIL",
            drop: "^debug:",
            maxLines: 20,
            preserveTailOnFail: true
          },
          {
            id: "evil-redos",
            match: "(a+)+$"
          },
          {
            id: "bad;whoami",
            match: "^safecli\\b"
          },
          {
            id: "bad-syntax",
            match: "[unclosed"
          }
        ]
      }),
      "utf8"
    );

    const loaded = loadProjectFilterRules(tmpDir);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, "custom:my-rule");

    // Matches direct AND safe compound wrapper
    const mDirect = matchFilterRule("mycli run --all", { cwd: tmpDir });
    assert.equal(mDirect?.rule.id, "custom:my-rule");
    const mCompound = matchFilterRule("cd sub && mycli run --all 2>&1", { cwd: tmpDir });
    assert.equal(mCompound?.rule.id, "custom:my-rule");
    assert.equal(mCompound.effectiveCommand, "cd sub && mycli run --all 2>&1");

    // Apply custom rule keep/drop filtering
    const sampleLogs = [
      ...Array.from({ length: 60 }, (_, i) => `debug: verbose trace step ${i} ${"z".repeat(40)}`),
      "WARN: slow query detected (420ms)",
      "ERROR: database write failed on shard 3",
      "FAIL: 1 suite failed"
    ].join("\n");
    const applied = applyFilterRule("custom:my-rule", sampleLogs, "", 1, { cwd: tmpDir });
    assert.equal(applied.wasFiltered, true);
    assert.ok(!applied.filteredText.includes("verbose trace step"));
    assert.ok(applied.filteredText.includes("WARN: slow query detected"));
    assert.ok(applied.filteredText.includes("ERROR: database write failed"));
    assert.ok(applied.filteredText.includes("FAIL: 1 suite failed"));

    // 2. Malformed JSON fails open (returns [])
    fs.writeFileSync(cfgPath, "{ not valid json", "utf8");
    const bump = Math.floor(Date.now() / 1000) + 5;
    fs.utimesSync(cfgPath, bump, bump);
    assert.deepEqual(loadProjectFilterRules(tmpDir), []);

    // 3. > 20 rules rejected fail-open
    const tooMany = Array.from({ length: 21 }, (_, i) => ({
      id: `r${i}`,
      match: `^tool${i}\\b`
    }));
    fs.writeFileSync(cfgPath, JSON.stringify({ rules: tooMany }), "utf8");
    fs.utimesSync(cfgPath, bump + 5, bump + 5);
    assert.deepEqual(loadProjectFilterRules(tmpDir), []);

    // 4. > 64 KB file rejected fail-open
    fs.writeFileSync(cfgPath, JSON.stringify({ rules: [{ id: "big", match: "^big\\b" }], pad: "x".repeat(70000) }), "utf8");
    fs.utimesSync(cfgPath, bump + 10, bump + 10);
    assert.deepEqual(loadProjectFilterRules(tmpDir), []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("cli-filter.mjs live execution: cd <tmpSubdir> && node --test ... 2>&1 preserves exact pass/fail exit codes and project custom rules", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-v12-clilive-"));
  const subDir = path.join(tmpDir, "pkg sub");
  const tmpDb = path.join(tmpDir, "context.db");
  fs.mkdirSync(subDir, { recursive: true });

  fs.writeFileSync(
    path.join(subDir, "pass.test.mjs"),
    `import test from "node:test";
import assert from "node:assert/strict";
for (let i = 0; i < 50; i++) {
  test("sub pass #" + i + " " + "y".repeat(160), () => {
    if (i === 25) console.error("STDERR_MARKER_SUB_25");
    assert.equal(2 + 2, 4);
  });
}\n`
  );

  fs.writeFileSync(
    path.join(subDir, "fail.test.mjs"),
    `import test from "node:test";
import assert from "node:assert/strict";
test("ok", () => assert.equal(1, 1));
test("sub broken", () => {
  console.error("STDERR_FAIL_DIAG_TOKEN");
  assert.equal("expected_sub_ok", "actual_sub_err");
});\n`
  );

  fs.writeFileSync(
    path.join(subDir, "exit42.mjs"),
    `console.log("debug: noisy line\\n".repeat(40) + "ERROR: custom exit 42 failure"); process.exit(42);\n`
  );

  // Add project-level custom rule in workspace root tmpDir
  fs.mkdirSync(path.join(tmpDir, ".agy-dart"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, ".agy-dart", "filters.json"),
    JSON.stringify({
      rules: [
        {
          id: "exit42-rule",
          match: "^node\\s+exit42\\.mjs\\b",
          keep: "ERROR|WARN|FAIL",
          drop: "^debug:",
          maxLines: 20,
          preserveTailOnFail: true
        }
      ]
    }),
    "utf8"
  );

  const enc = (s) => `b:${Buffer.from(s, "utf8").toString("base64url")}`;
  const cleanEnv = {
    ...process.env,
    AGY_DART_DB_PATH: tmpDb,
    AGY_DART_DISABLE_COMPILE_CACHE: "1"
  };
  delete cleanEnv.NODE_TEST_CONTEXT;

  const runCliFilter = (ruleId, command, sessionId = "v12-cli-sess") =>
    spawnSync(
      process.execPath,
      [
        path.join(ROOT, "hooks", "cli-filter.mjs"),
        "--rule",
        ruleId,
        "--b64",
        enc(command),
        "--orig-b64",
        enc(command),
        "--session",
        enc(sessionId)
      ],
      {
        cwd: tmpDir,
        encoding: "utf8",
        windowsHide: true,
        env: cleanEnv
      }
    );

  try {
    // 1. Passing `cd "pkg sub" && node --test pass.test.mjs 2>&1`
    const cmdPass = 'cd "pkg sub" && node --test pass.test.mjs 2>&1';
    const matchPass = matchFilterRule(cmdPass, { cwd: tmpDir });
    assert.equal(matchPass?.rule.id, "test-runner");
    const rPass = runCliFilter(matchPass.rule.id, matchPass.effectiveCommand);
    assert.equal(rPass.status, 0, `Expected exit 0, got ${rPass.status}: ${rPass.stderr}`);
    assert.ok(Buffer.byteLength(rPass.stdout, "utf8") <= 8000);
    assert.ok(rPass.stdout.includes("PASS (exit 0)"));

    // Raw merged stderr marker is searchable in FTS5
    const store = new ContextModeStore({ dbPath: tmpDb });
    const hits = store.search({ queries: ["STDERR_MARKER_SUB_25"], sessionId: "v12-cli-sess" });
    assert.ok(hits.hits.length >= 1, "Expected merged 2>&1 stderr marker to be indexed in FTS5");
    store.close();

    // 2. Failing `cd /d "pkg sub" && node --test fail.test.mjs 2>&1` preserves non-zero exit code & failure output
    const cmdFail = 'cd /d "pkg sub" && node --test fail.test.mjs 2>&1';
    const matchFail = matchFilterRule(cmdFail, { cwd: tmpDir });
    assert.equal(matchFail?.rule.id, "test-runner");
    const rFail = runCliFilter(matchFail.rule.id, matchFail.effectiveCommand);
    assert.notEqual(rFail.status, 0, "Failing test inside cd subdir must keep non-zero exit code");
    assert.ok(
      rFail.stdout.includes("expected_sub_ok") || rFail.stdout.includes("STDERR_FAIL_DIAG_TOKEN"),
      `Expected failure diagnostics, got: ${rFail.stdout}`
    );

    // 3. Exact custom exit code 42 + project .agy-dart/filters.json applied via cli-filter.mjs (cwd forwarded!)
    const cmdCustom = 'cd "pkg sub" && node exit42.mjs 2>&1';
    const matchCustom = matchFilterRule(cmdCustom, { cwd: tmpDir });
    assert.equal(matchCustom?.rule.id, "custom:exit42-rule");
    const rCustom = runCliFilter(matchCustom.rule.id, matchCustom.effectiveCommand);
    assert.equal(rCustom.status, 42, `Expected exact exit code 42, got ${rCustom.status}`);
    assert.ok(rCustom.stdout.includes("ERROR: custom exit 42 failure"));
    assert.ok(!rCustom.stdout.includes("debug: noisy line"));

    // 4. PowerShell-routed command (single-quoted arg inside safe cd && ... 2>&1) preserves exact exit code 42 on Windows
    const rPsExact = runCliFilter("custom:exit42-rule", `cd "pkg sub" && node 'exit42.mjs' 2>&1`);
    assert.equal(rPsExact.status, 42, `Expected exact exit code 42 via PowerShell route, got ${rPsExact.status}`);
    assert.ok(rPsExact.stdout.includes("ERROR: custom exit 42 failure"));

    // 5. Nonexistent cd target fails fast with exit 1 and never runs inner command
    const rBadCd = runCliFilter("test-runner", 'cd "does_not_exist_dir" && node --test pass.test.mjs 2>&1');
    assert.equal(rBadCd.status, 1);
    assert.ok(rBadCd.stdout.includes("does_not_exist_dir") || rBadCd.stderr.includes("does_not_exist_dir"));

    // 6. P1-4: Subdirectory-only `.agy-dart/filters.json` matched via `cd <subDir> && <cmd>` AND `execCwd` propagated to applyFilterRule & SQLite worktree
    const isolatedRoot = path.join(tmpDir, "mono-root");
    const subPkgDir = path.join(isolatedRoot, "sub pkg");
    fs.mkdirSync(path.join(subPkgDir, ".agy-dart"), { recursive: true });
    fs.writeFileSync(
      path.join(subPkgDir, ".agy-dart", "filters.json"),
      JSON.stringify({
        rules: [
          {
            id: "subpkg-rule",
            match: "^node\\s+subtool\\.mjs\\b",
            keep: "SUB_ERROR|SUB_SUMMARY",
            drop: "^trace:",
            maxLines: 20,
            preserveTailOnFail: true
          }
        ]
      }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(subPkgDir, "subtool.mjs"),
      `console.log(("trace: sub noisy payload " + "z".repeat(50) + "\\n").repeat(35) + "SUB_ERROR: subpkg failure\\nSUB_SUMMARY: 1 failed"); process.exit(7);\n`
    );
    fs.writeFileSync(
      path.join(subPkgDir, "sub.test.mjs"),
      `import test from "node:test"; import assert from "node:assert/strict"; test("sub ok", () => assert.equal(1, 1));\n`
    );

    const subCmd = 'cd "sub pkg" && node subtool.mjs 2>&1';
    const subMatch = matchFilterRule(subCmd, { cwd: isolatedRoot });
    assert.equal(subMatch?.rule.id, "custom:subpkg-rule", "matchFilterRule must load .agy-dart/filters.json from unwrapped cdPath");

    const runCliFilterIn = (workDir, ruleId, command, sessionId) =>
      spawnSync(
        process.execPath,
        [
          path.join(ROOT, "hooks", "cli-filter.mjs"),
          "--rule",
          ruleId,
          "--b64",
          enc(command),
          "--orig-b64",
          enc(command),
          "--session",
          enc(sessionId)
        ],
        { cwd: workDir, encoding: "utf8", windowsHide: true, env: cleanEnv }
      );

    const subRun = runCliFilterIn(isolatedRoot, subMatch.rule.id, subMatch.effectiveCommand, "v12-subpkg-sess");
    assert.equal(subRun.status, 7);
    assert.ok(subRun.stdout.includes("SUB_ERROR: subpkg failure"), `Expected subpkg custom rule keep line, got: ${subRun.stdout}`);
    assert.ok(!subRun.stdout.includes("trace: sub noisy payload"), "Expected subpkg custom rule to drop trace lines");

    const subTestCmd = 'cd "sub pkg" && node --test sub.test.mjs 2>&1';
    const subTestRun = runCliFilterIn(isolatedRoot, "test-runner", subTestCmd, "v12-subpkg-sess");
    assert.equal(subTestRun.status, 0, subTestRun.stderr);

    const subStore = new ContextModeStore({ dbPath: tmpDb });
    try {
      subStore.open();
      const expectedExecCwd = path.resolve(subPkgDir);
      const evRow = subStore.db
        .prepare("SELECT worktree FROM events WHERE session_id = ? AND kind = 'cli_filter' ORDER BY seq DESC LIMIT 1")
        .get("v12-subpkg-sess");
      assert.equal(evRow?.worktree, expectedExecCwd, "cli-filter recordEvent must propagate unwrapped execCwd as worktree");
      const srcRow = subStore.db
        .prepare("SELECT worktree FROM sources WHERE session_id = ? ORDER BY created_ts DESC LIMIT 1")
        .get("v12-subpkg-sess");
      assert.equal(srcRow?.worktree, expectedExecCwd, "cli-filter indexContent must propagate unwrapped execCwd as worktree");
      const cpRow = subStore.db
        .prepare("SELECT worktree FROM session_checkpoints WHERE session_id = ?")
        .get("v12-subpkg-sess");
      assert.equal(cpRow?.worktree, expectedExecCwd, "cli-filter recordVerificationResult must propagate unwrapped execCwd as worktree");
    } finally {
      subStore.close();
    }

    // 7. P1-4: Rule-ID collision between parent root and cd subdir must apply the rule whose pattern matched the command
    fs.mkdirSync(path.join(isolatedRoot, ".agy-dart"), { recursive: true });
    fs.writeFileSync(
      path.join(isolatedRoot, ".agy-dart", "filters.json"),
      JSON.stringify({
        rules: [{ id: "shared-id", match: "^node\\s+parenttool\\.mjs\\b", keep: "PARENT_KEEP_LINE", maxLines: 20 }]
      }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(subPkgDir, ".agy-dart", "filters.json"),
      JSON.stringify({
        rules: [{ id: "shared-id", match: "^node\\s+othertool\\.mjs\\b", keep: "WRONG_SUB_KEEP", maxLines: 20 }]
      }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(subPkgDir, "parenttool.mjs"),
      `console.log("PARENT_KEEP_LINE: ok\\nWRONG_SUB_KEEP: should be dropped\\nnoise line");\n`
    );
    const parentFallbackCmd = 'cd "sub pkg" && node parenttool.mjs 2>&1';
    const parentFallbackMatch = matchFilterRule(parentFallbackCmd, { cwd: isolatedRoot });
    assert.equal(parentFallbackMatch?.rule.id, "custom:shared-id");
    const parentFallbackRun = runCliFilterIn(
      isolatedRoot,
      parentFallbackMatch.rule.id,
      parentFallbackMatch.effectiveCommand,
      "v12-collision-sess"
    );
    assert.equal(parentFallbackRun.status, 0, parentFallbackRun.stderr);
    assert.ok(parentFallbackRun.stdout.includes("PARENT_KEEP_LINE"), `Expected parent fallback rule output, got: ${parentFallbackRun.stdout}`);
    assert.ok(!parentFallbackRun.stdout.includes("WRONG_SUB_KEEP"), "Must not apply subdir rule with colliding ID whose pattern did not match");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("ctx_execute structurally crushes >30 KB JSON API dump to <= 8.8 KB while indexing full raw payload into FTS5", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dart-v12-ctxjson-"));
  const tmpDb = path.join(tmpDir, "context.db");
  const store = new ContextModeStore({ dbPath: tmpDb });
  const tools = createTools({ store, getCwd: () => tmpDir, getSessionId: () => "v12-json-exec" });

  try {
    // 1. >30 KB JSON API dump with CJK text, buried normal marker, and buried 503 anomaly
    const dumpScript = `
      const records = Array.from({ length: 240 }, (_, i) => ({
        id: i,
        orderNo: "ORD-" + String(i).padStart(5, "0"),
        region: "华东节点",
        status: i === 133 ? 503 : 200,
        ok: i !== 133,
        error: i === 133 ? "UPSTREAM_CIRCUIT_OPEN" : null,
        detail: i === 99 ? "BURIED_SEARCHABLE_TOKEN_99" : ("订单详情日志数据_" + i + "_" + "填充字段".repeat(8))
      }));
      console.log(JSON.stringify({ service: "orders-api", total: records.length, data: records }));
    `;
    const res = await tools.ctx_execute({
      language: "nodejs",
      code: dumpScript,
      intent: "Fetch orders API dump"
    });

    assert.equal(res.ok, true);
    assert.equal(res.crushedJson, true);
    assert.ok(res.sourceId);
    assert.ok(res.rawBytes > 30000, `Expected >30 KB raw JSON, got ${res.rawBytes}B`);

    const serializedBytes = Buffer.byteLength(JSON.stringify(res, null, 2), "utf8");
    assert.ok(serializedBytes <= 8800, `Expected total MCP JSON <= 8800B, got ${serializedBytes}B`);
    assert.ok(!res.output.includes("\uFFFD"), "Crushed JSON must have zero broken UTF-8 chars");

    // Output is valid structural JSON preserving top-level keys + nested array schema/anomalies + sourceId hint
    const crushed = JSON.parse(res.output);
    assert.equal(crushed.service, "orders-api");
    assert.equal(crushed.total, 240);
    assert.equal(crushed.data._crushedArray, true);
    assert.equal(crushed.data.totalItems, 240);
    assert.ok(crushed.data.anomalies.some((a) => a.index === 133 && a.item.error === "UPSTREAM_CIRCUIT_OPEN"));
    assert.ok(crushed._crushed.hint.includes(res.sourceId));

    // Full raw payload (including non-anomaly middle item #99) is searchable in FTS5!
    const search = await tools.ctx_search({
      queries: ["BURIED_SEARCHABLE_TOKEN_99"],
      sourceId: res.sourceId
    });
    assert.ok(search.hits.length >= 1, "Buried non-anomaly record from full raw JSON must be indexed in FTS5");

    // 2. Small JSON output MUST NOT be crushed or inflated
    const smallRes = await tools.ctx_execute({
      language: "nodejs",
      code: 'console.log(JSON.stringify({ ok: true, items: [1, 2, 3] }));',
      intent: "Small JSON check"
    });
    assert.equal(smallRes.ok, true);
    assert.equal(smallRes.crushedJson, undefined);
    assert.equal(smallRes.output.trim(), '{"ok":true,"items":[1,2,3]}');

    // 3. Adversarial heavily-escaped JSON (quotes + backslashes + newlines + CJK) stays <= 8800B
    const advRes = await tools.ctx_execute({
      language: "nodejs",
      code: 'console.log(JSON.stringify(Array.from({ length: 120 }, (_, i) => ({ k: i, v: "引\\"号\\\\换\\n行".repeat(40), status: i === 55 ? 500 : 200 }))));',
      intent: "Adversarial JSON escape cap"
    });
    assert.equal(advRes.ok, true);
    assert.equal(advRes.crushedJson, true);
    const advBytes = Buffer.byteLength(JSON.stringify(advRes, null, 2), "utf8");
    assert.ok(advBytes <= 8800, `Expected adversarial JSON MCP response <= 8800B, got ${advBytes}B`);
    assert.ok(!advRes.output.includes("\uFFFD"));
    assert.doesNotThrow(() => JSON.parse(advRes.output), "Adversarial crushed JSON output must stay valid parseable JSON");
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
