import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { inspectProjectFilterRules, loadProjectFilterRules, matchFilterRule } from "../hooks/filter-rules.mjs";
import { auditPrefixBudget } from "../scripts/prefix-budget.mjs";
import {
  auditEnvironmentCache,
  auditSkillsOnly,
  formatSkillsAuditMarkdown
} from "../scripts/cache-audit.mjs";
import { RUNTIME_FILES } from "../scripts/install.mjs";
import { verifyPackageManifest } from "../scripts/verify-package-graph.mjs";
import { runTargets } from "../scripts/targets/index.mjs";
import { manageFiles, skillSpec, skillSpecs } from "../scripts/targets/shared.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CLI_BIN = path.join(ROOT, "bin", "agy-dart.mjs");
const CACHE_AUDIT_SCRIPT = path.join(ROOT, "scripts", "cache-audit.mjs");
const PREFIX_BUDGET_SCRIPT = path.join(ROOT, "scripts", "prefix-budget.mjs");

function makeTempDir(prefix = "agy-v172-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 });
    }
  };
}

function findPythonBin() {
  for (const bin of process.platform === "win32" ? ["python", "python3", "py"] : ["python3", "python"]) {
    const args = bin === "py" ? ["-3", "--version"] : ["--version"];
    const res = spawnSync(bin, args, { encoding: "utf8", timeout: 3000, windowsHide: true });
    if (!res.error && res.status === 0 && /Python 3\./i.test(`${res.stdout}${res.stderr}`)) {
      return bin === "py" ? { bin, prefixArgs: ["-3"] } : { bin, prefixArgs: [] };
    }
  }
  return null;
}

test("1. skills/agy-dart/examples/filters.json passes inspectProjectFilterRules cleanly and filters realistic build logs", () => {
  const tmp = makeTempDir("agy-filters-example-");
  try {
    const examplePath = path.join(ROOT, "skills", "agy-dart", "examples", "filters.json");
    assert.ok(fs.existsSync(examplePath), "examples/filters.json must exist");

    const projectFilterDir = path.join(tmp.dir, ".agy-dart");
    fs.mkdirSync(projectFilterDir, { recursive: true });
    fs.copyFileSync(examplePath, path.join(projectFilterDir, "filters.json"));

    const diag = inspectProjectFilterRules(tmp.dir);
    assert.equal(diag.exists, true);
    assert.equal(diag.error, null, `Unexpected filter parse error: ${diag.error}`);
    assert.ok(diag.loadedCount >= 2, `Expected >= 2 loaded rules, got ${diag.loadedCount}`);
    assert.equal(diag.rejectedCount, 0, `Expected 0 rejected rules, got: ${JSON.stringify(diag.rejected)}`);
    assert.deepEqual(diag.rejected, []);

    const compiled = loadProjectFilterRules(tmp.dir);
    assert.equal(compiled.length, diag.loadedCount);

    // Every starter rule MUST be dispatched by matchFilterRule() as custom:* (never shadowed by built-in FILTER_RULES)
    const gradleHit = matchFilterRule("./gradlew assembleRelease", { cwd: tmp.dir });
    assert.equal(gradleHit?.rule?.id, "custom:jvm-gradle-maven-build");
    const winGradleHit = matchFilterRule(".\\gradlew.bat test", { cwd: tmp.dir });
    assert.equal(winGradleHit?.rule?.id, "custom:jvm-gradle-maven-build");
    const cmakeHit = matchFilterRule("cmake --build build", { cwd: tmp.dir });
    assert.equal(cmakeHit?.rule?.id, "custom:cmake-ninja-bazel-build");
    const dockerTransferHit = matchFilterRule("docker compose pull", { cwd: tmp.dir });
    assert.equal(dockerTransferHit?.rule?.id, "custom:docker-registry-transfer");

    // Exercise cmake/ninja/bazel rule on realistic build output
    const sampleBuildOut = [
      "[1/400] Building CXX object src/core.o",
      "[2/400] Compiling src/util.o",
      "Entering directory '/repo/build'",
      "warning: unused variable 'x'",
      "Build completed successfully"
    ].join("\n");
    const filteredOk = cmakeHit.rule.filter(sampleBuildOut, 0, {});
    assert.ok(filteredOk.includes("warning: unused variable 'x'"));
    assert.ok(filteredOk.includes("Build completed successfully"));
    assert.ok(!filteredOk.includes("[1/400] Building CXX object"));

    // Verify failure error preservation
    const sampleFailOut = [
      "[1/400] Building CXX object src/core.o",
      "src/core.cpp:42:10: fatal error: missing.h: No such file or directory",
      "ninja: build stopped: subcommand failed."
    ].join("\n");
    const filteredFail = cmakeHit.rule.filter(sampleFailOut, 1, {
      cleanedStderr: "src/core.cpp:42:10: fatal error: missing.h: No such file or directory"
    });
    assert.ok(filteredFail.includes("fatal error: missing.h"));
  } finally {
    tmp.cleanup();
  }
});

test("2. skills/agy-dart/examples/ctx_trace_summary.py uses stdlib only and summarizes JSONL/logs within inline byte budget", () => {
  const scriptPath = path.join(ROOT, "skills", "agy-dart", "examples", "ctx_trace_summary.py");
  assert.ok(fs.existsSync(scriptPath), "examples/ctx_trace_summary.py must exist");

  const src = fs.readFileSync(scriptPath, "utf8");
  const sizeBytes = Buffer.byteLength(src, "utf8");
  assert.ok(sizeBytes > 500 && sizeBytes < 12000, `Unexpected script size: ${sizeBytes} bytes`);

  // Verify zero third-party imports
  const allowedStdlib = new Set(["collections", "json", "re", "sys"]);
  for (const line of src.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:from\s+([A-Za-z0-9_]+)\s+import|import\s+([A-Za-z0-9_]+))/);
    if (m) {
      const mod = m[1] || m[2];
      assert.ok(allowedStdlib.has(mod), `Disallowed non-stdlib import in example script: ${mod}`);
    }
  }

  const py = findPythonBin();
  if (!py) {
    return;
  }

  const tmp = makeTempDir("agy-py-example-");
  try {
    // 2a. Mixed JSONL (with UTF-8 BOM + CJK) + malformed JSON + plain log lines with varying UUIDs & timestamps
    const traceFile = path.join(tmp.dir, "trace.jsonl");
    const rows = [
      JSON.stringify({ level: "info", endpoint: "/api/health", message: "健康检查 ok", status: 200 }),
      JSON.stringify({ level: "error", code: "E_TIMEOUT", endpoint: "/api/orders", message: "Upstream timed out req 550e8400-e29b-41d4-a716-446655440001 after 5001ms", status: 504 }),
      JSON.stringify({ level: "error", code: "E_TIMEOUT", endpoint: "/api/orders", message: "Upstream timed out req 550e8400-e29b-41d4-a716-446655440002 after 5012ms", status: 504 }),
      JSON.stringify({ level: "error", code: "E_TIMEOUT", endpoint: "/api/orders", message: "Upstream timed out req 550e8400-e29b-41d4-a716-446655440003 after 5025ms", status: 504 }),
      JSON.stringify({ level: "error", code: "E_DB", endpoint: "/api/users", message: "Deadlock detected on shard 4", status: 500 }),
      JSON.stringify({ level: "warn", endpoint: "/api/cache", message: "Cache miss rate high" }),
      "{broken json line with ERROR token",
      "2026-11-24T10:15:01Z ERROR Worker 99 crashed on job 12345"
    ];
    fs.writeFileSync(traceFile, "\uFEFF" + rows.join("\n") + "\n", "utf8");

    const runRes = spawnSync(py.bin, [...py.prefixArgs, scriptPath, traceFile, "--top", "5"], {
      encoding: "utf8",
      timeout: 6000,
      windowsHide: true
    });
    assert.equal(runRes.status, 0, `Python script failed: ${runRes.stderr}`);
    assert.ok(Buffer.byteLength(runRes.stdout, "utf8") <= 8800, "Output must stay within 8.8 KB cap");
    assert.ok(runRes.stdout.includes("Lines: 8 total (6 JSON objects, 2 plain, 1 malformed JSON)"), runRes.stdout);
    assert.ok(
      runRes.stdout.includes("[3x] [E_TIMEOUT] /api/orders Upstream timed out req <uuid> after <n>ms status=<n>"),
      runRes.stdout
    );
    assert.ok(runRes.stdout.includes("[1x] [E_DB] /api/users"), runRes.stdout);

    // 2b. Byte-budget truncation guard on many distinct error lines
    const bigTrace = path.join(tmp.dir, "big.jsonl");
    const manyErrors = [];
    for (let i = 0; i < 60; i++) {
      manyErrors.push(
        JSON.stringify({
          level: "error",
          code: `E_CODE_${String.fromCharCode(65 + (i % 26))}_${i}`,
          endpoint: `/api/service_${String.fromCharCode(97 + (i % 26))}`,
          message: `Unique failure variant alpha_${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(97 + ((i * 7) % 26))} detailed payload text here`
        })
      );
    }
    fs.writeFileSync(bigTrace, manyErrors.join("\n") + "\n", "utf8");
    const capRes = spawnSync(py.bin, [...py.prefixArgs, scriptPath, bigTrace, "--top", "50", "--max-bytes", "900"], {
      encoding: "utf8",
      timeout: 6000,
      windowsHide: true
    });
    assert.equal(capRes.status, 0, capRes.stderr);
    assert.ok(Buffer.byteLength(capRes.stdout, "utf8") <= 900, "Output exceeded --max-bytes budget");
    assert.ok(capRes.stdout.includes("truncated"), "Expected truncation marker when capped");

    // 2c. Empty file edge case
    const emptyFile = path.join(tmp.dir, "empty.jsonl");
    fs.writeFileSync(emptyFile, "", "utf8");
    const emptyRes = spawnSync(py.bin, [...py.prefixArgs, scriptPath, emptyFile], {
      encoding: "utf8",
      timeout: 6000,
      windowsHide: true
    });
    assert.equal(emptyRes.status, 0, emptyRes.stderr);
    assert.ok(emptyRes.stdout.includes("Lines: 0 total"), emptyRes.stdout);

    // 2d. Missing file fails cleanly with non-zero status and concise stderr (no traceback)
    const missingRes = spawnSync(py.bin, [...py.prefixArgs, scriptPath, path.join(tmp.dir, "nope.jsonl")], {
      encoding: "utf8",
      timeout: 6000,
      windowsHide: true
    });
    assert.notEqual(missingRes.status, 0);
    assert.ok(missingRes.stderr.includes("ctx_trace_summary error:"));
    assert.ok(!missingRes.stderr.includes("Traceback"));
  } finally {
    tmp.cleanup();
  }
});

test("3. prefix-budget reports progressive-disclosure aux files as excluded with zero Turn-0 frontmatter growth and clean package manifest", async () => {
  // Verify YAML frontmatter is untouched
  const skillText = fs.readFileSync(path.join(ROOT, "skills", "agy-dart", "SKILL.md"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(
    skillText.startsWith(
      "---\nname: agy-dart\ndescription: Batch code work, filter logs, search indexed docs and diagnose context or cache usage.\n---\n"
    ),
    "skills/agy-dart/SKILL.md YAML frontmatter must remain byte-for-byte unchanged"
  );

  const report = await auditPrefixBudget(ROOT);
  const { brake, reference, tools, startup } = report.blocks;

  assert.equal(reference.auxFileCount, 3);
  assert.ok(reference.auxBytes > 0);
  assert.ok(reference.auxTokens > 0);
  assert.deepEqual(reference.auxFiles, [
    "examples/ctx_trace_summary.py",
    "examples/filters.json",
    "references/error-playbook.md"
  ]);

  // Aux assets MUST NOT be counted into Turn-0 totals
  assert.equal(report.totalTokens, brake.tokens + reference.frontmatterTokens + tools.tokens + startup.tokens);
  assert.equal(report.totalBytes, brake.bytes + reference.frontmatterBytes + tools.bytes + startup.bytes);
  assert.ok(reference.frontmatterTokens <= 40, `Expected compact frontmatter tokens <= 40, got ${reference.frontmatterTokens}`);
  assert.equal(report.exceedsBudget, false);
  assert.equal(report.exceedsUpperBound, false);
  assert.equal(tools.canonical, true);

  // Human report explicitly shows excluded aux count
  const cli = spawnSync(process.execPath, [PREFIX_BUDGET_SCRIPT], { encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(cli.status, 0, cli.stderr);
  assert.ok(cli.stdout.includes("on-demand aux (3 files):"));
  assert.ok(cli.stdout.includes("excluded"));

  // Runtime manifest & package graph verification
  for (const rel of [
    "skills/agy-dart/references/error-playbook.md",
    "skills/agy-dart/examples/filters.json",
    "skills/agy-dart/examples/ctx_trace_summary.py"
  ]) {
    assert.ok(RUNTIME_FILES.includes(rel), `Missing from RUNTIME_FILES: ${rel}`);
  }
  const pkgReport = verifyPackageManifest(ROOT);
  assert.equal(pkgReport.ok, true, JSON.stringify(pkgReport, null, 2));
  assert.deepEqual(pkgReport.devtoolsLeakedIntoRuntime, []);
  assert.deepEqual(pkgReport.missingFromRuntimeManifest, []);
});

test("4. cache-audit detects all 5 new Skill rules, progressive-disclosure metadata, thresholds, and legacy-path isolation", async () => {
  const tmp = makeTempDir("agy-skills-rules-");
  try {
    const configDir = path.join(tmp.dir, "config");
    const workspaceDir = path.join(tmp.dir, "workspace");
    fs.mkdirSync(path.join(configDir, "skills"), { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    // (a) Missing frontmatter + blank frontmatter
    const noFmDir = path.join(configDir, "skills", "no-frontmatter");
    fs.mkdirSync(noFmDir, { recursive: true });
    fs.writeFileSync(path.join(noFmDir, "SKILL.md"), "# Skill Without Header\nJust markdown body.\n", "utf8");

    const blankFmDir = path.join(configDir, "skills", "blank-frontmatter");
    fs.mkdirSync(blankFmDir, { recursive: true });
    fs.writeFileSync(path.join(blankFmDir, "SKILL.md"), "---\n   \n---\n# Blank Header\n", "utf8");

    // (b) Oversized single skill frontmatter (> 250 est. tokens using CJK + English)
    const bigFmDir = path.join(configDir, "skills", "big-frontmatter");
    fs.mkdirSync(bigFmDir, { recursive: true });
    fs.writeFileSync(
      path.join(bigFmDir, "SKILL.md"),
      `---\nname: big-frontmatter\ndescription: ${"非常冗长的技能触发描述信息用于测试超限检测".repeat(15)}\n---\n\n# Short Body\n`,
      "utf8"
    );

    // (c) Oversized skill body (> 3000 est. tokens) with progressive disclosure subdirs
    const bigBodyDir = path.join(workspaceDir, ".agents", "skills", "big-body-progressive");
    fs.mkdirSync(path.join(bigBodyDir, "references"), { recursive: true });
    fs.mkdirSync(path.join(bigBodyDir, "examples"), { recursive: true });
    fs.mkdirSync(path.join(bigBodyDir, "scripts"), { recursive: true });
    fs.writeFileSync(
      path.join(bigBodyDir, "SKILL.md"),
      "---\nname: big-body-progressive\ndescription: Concise frontmatter.\n---\n\n" +
        "Detailed inline reference step with long instructions. ".repeat(260),
      "utf8"
    );
    fs.writeFileSync(path.join(bigBodyDir, "references", "guide.md"), "# Guide\nOn-demand reference.\n", "utf8");
    fs.writeFileSync(path.join(bigBodyDir, "examples", "sample.json"), '{"ok":true}\n', "utf8");
    fs.writeFileSync(path.join(bigBodyDir, "scripts", "check.sh"), "echo ok\n", "utf8");

    // (d) Non-progressive skill with stray sibling file (auxDirs should be empty, auxFileCount = 1)
    const strayDir = path.join(workspaceDir, ".agents", "skills", "stray-sibling");
    fs.mkdirSync(strayDir, { recursive: true });
    fs.writeFileSync(
      path.join(strayDir, "SKILL.md"),
      "---\nname: stray-sibling\ndescription: Clean short skill.\n---\n\n# Body\n",
      "utf8"
    );
    fs.writeFileSync(path.join(strayDir, "README.md"), "Extra notes not in standard aux dir.\n", "utf8");

    // (e) Legacy workspace & legacy global skill paths
    const legacyWsDir = path.join(workspaceDir, ".agent", "skills", "old-ws-skill");
    fs.mkdirSync(legacyWsDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyWsDir, "SKILL.md"),
      "---\nname: old-ws-skill\ndescription: Legacy workspace skill.\n---\n\n# Legacy WS\n",
      "utf8"
    );
    const legacyGlobalDir = path.join(tmp.dir, "antigravity", "skills", "old-global-skill");
    fs.mkdirSync(legacyGlobalDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyGlobalDir, "SKILL.md"),
      "---\nname: old-global-skill\ndescription: Legacy global skill.\n---\n\n# Legacy Global\n",
      "utf8"
    );

    const report = await auditEnvironmentCache({ workspace: workspaceDir, configDir, live: false });

    // Thresholds exposed on report.prefix.thresholds
    assert.equal(report.prefix.thresholds.singleSkillFrontmatterWarnTokens, 250);
    assert.equal(report.prefix.thresholds.singleSkillBodyWarnTokens, 3000);
    assert.equal(report.prefix.thresholds.totalSkillsFrontmatterWarnTokens, 2000);

    // 1. missing_skill_frontmatter (2 skills)
    const missingFindings = report.findings.filter((f) => f.code === "missing_skill_frontmatter");
    assert.equal(missingFindings.length, 2);
    assert.ok(missingFindings.every((f) => f.severity === "warn"));

    // 2. oversized_skill_frontmatter (1 skill)
    const bigFmFindings = report.findings.filter((f) => f.code === "oversized_skill_frontmatter");
    assert.equal(bigFmFindings.length, 1);
    assert.equal(bigFmFindings[0].severity, "warn");
    assert.ok(bigFmFindings[0].target.includes("big-frontmatter"));

    // 3. oversized_skill_body (1 skill)
    const bigBodyFindings = report.findings.filter((f) => f.code === "oversized_skill_body");
    assert.equal(bigBodyFindings.length, 1);
    assert.equal(bigBodyFindings[0].severity, "info");
    assert.ok(bigBodyFindings[0].target.includes("big-body-progressive"));

    // 4. legacy_skill_path (both workspace .agent/skills and global antigravity/skills)
    const legacyFindings = report.findings.filter((f) => f.code === "legacy_skill_path");
    assert.equal(legacyFindings.length, 2);
    assert.ok(legacyFindings.every((f) => f.severity === "info"));
    assert.ok(legacyFindings.some((f) => f.target === "workspace:.agent/skills" && f.recommendation.includes(".agents/skills/")));
    assert.ok(legacyFindings.some((f) => f.target === "global:antigravity/skills" && f.recommendation.includes("~/.gemini/config/skills/")));

    // Progressive-disclosure metadata check
    const progItem = report.prefix.items.find((i) => i.skillName === "big-body-progressive");
    assert.ok(progItem);
    assert.equal(progItem.hasFrontmatter, true);
    assert.deepEqual(progItem.auxDirs, ["examples", "references", "scripts"]);
    assert.equal(progItem.auxFileCount, 3);
    assert.ok(progItem.auxBytes > 0 && progItem.auxTokens > 0);
    assert.ok(progItem.tokens < 40, "Aux files must not inflate Turn-0 frontmatter tokens");

    const strayItem = report.prefix.items.find((i) => i.skillName === "stray-sibling");
    assert.ok(strayItem);
    assert.deepEqual(strayItem.auxDirs, []);
    assert.equal(strayItem.auxFileCount, 1);
    assert.equal(report.prefix.progressiveSkillCount, 1, "Only skills with recognized aux dirs count as progressive");

    // Test isolation: when basename(configDir) !== "config", sibling antigravity/skills MUST NOT be scanned,
    // and an empty .agent/skills/ directory MUST NOT emit a false-positive legacy_skill_path finding
    const customCfgDir = path.join(tmp.dir, "isolated-custom-cfg");
    const emptyWsDir = path.join(tmp.dir, "empty-ws");
    fs.mkdirSync(customCfgDir, { recursive: true });
    fs.mkdirSync(path.join(emptyWsDir, ".agent", "skills"), { recursive: true });
    const isolatedReport = auditSkillsOnly({ workspace: emptyWsDir, configDir: customCfgDir });
    assert.equal(isolatedReport.summary.skillCount, 0);
    assert.equal(isolatedReport.findings.length, 0);

    // 5. excessive_skills_frontmatter (> 2000 total across many individually valid <= 250-token skills)
    const manyCfg = path.join(tmp.dir, "many-cfg");
    const manyWs = path.join(tmp.dir, "many-ws");
    fs.mkdirSync(path.join(manyCfg, "skills"), { recursive: true });
    fs.mkdirSync(manyWs, { recursive: true });
    for (let i = 0; i < 11; i++) {
      const sDir = path.join(manyCfg, "skills", `pack-skill-${String(i).padStart(2, "0")}`);
      fs.mkdirSync(sDir, { recursive: true });
      const desc = `Skill ${i} concise routing summary `.repeat(24); // ~205 est. tokens each (<= 250)
      fs.writeFileSync(
        path.join(sDir, "SKILL.md"),
        `---\nname: pack-skill-${String(i).padStart(2, "0")}\ndescription: ${desc}\n---\n\n# Body\n`,
        "utf8"
      );
    }
    const manyReport = auditSkillsOnly({ workspace: manyWs, configDir: manyCfg });
    assert.equal(manyReport.findings.filter((f) => f.code === "oversized_skill_frontmatter").length, 0);
    const totalWarn = manyReport.findings.find((f) => f.code === "excessive_skills_frontmatter");
    assert.ok(totalWarn, `Expected excessive_skills_frontmatter, got: ${JSON.stringify(manyReport.findings)}`);
    assert.equal(totalWarn.severity, "warn");
    assert.ok(totalWarn.message.includes("Top contributors:"));
    assert.ok(manyReport.summary.totalFrontmatterTokens > 2000);
  } finally {
    tmp.cleanup();
  }
});

test("5. --skills-only and `agy-dart audit skills` skip MCP/rules/hooks and render Skills report in JSON & Markdown", () => {
  const tmp = makeTempDir("agy-skills-only-cli-");
  try {
    const configDir = path.join(tmp.dir, "custom-cfg");
    const workspaceDir = path.join(tmp.dir, "ws");
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    // Place a huge rule & a non-existent/broken MCP config that would fail or warn in full audit
    fs.writeFileSync(path.join(workspaceDir, "AGENTS.md"), "Very large rule content line.\n".repeat(400), "utf8");
    fs.writeFileSync(
      path.join(configDir, "mcp_config.json"),
      JSON.stringify({ mcpServers: { broken: { command: "nonexistent-mcp-binary-xyz", args: [] } } }),
      "utf8"
    );
    // Add one clean progressive skill + one skill missing frontmatter
    const goodDir = path.join(workspaceDir, ".agents", "skills", "good-skill");
    fs.mkdirSync(path.join(goodDir, "references"), { recursive: true });
    fs.writeFileSync(
      path.join(goodDir, "SKILL.md"),
      "---\nname: good-skill\ndescription: Clean progressive skill.\n---\n\n# Good\n",
      "utf8"
    );
    fs.writeFileSync(path.join(goodDir, "references", "ref.md"), "# Ref\nDetails.\n", "utf8");

    const badDir = path.join(workspaceDir, ".agents", "skills", "missing-fm");
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, "SKILL.md"), "# Missing Frontmatter\n", "utf8");

    // 5a. Direct script --skills-only --json
    const t0 = Date.now();
    const directJson = spawnSync(
      process.execPath,
      [CACHE_AUDIT_SCRIPT, "--skills-only", "--workspace", workspaceDir, "--config-dir", configDir, "--json"],
      { encoding: "utf8", timeout: 6000, windowsHide: true }
    );
    assert.equal(directJson.status, 0, directJson.stderr);
    assert.ok(Date.now() - t0 < 4000, "Offline --skills-only must finish rapidly without MCP probing");
    const parsed = JSON.parse(directJson.stdout);
    assert.equal(parsed.mode, "skills-only");
    assert.equal(parsed.summary.skillCount, 2);
    assert.equal(parsed.summary.progressiveSkillCount, 1);
    assert.equal(parsed.summary.missingFrontmatterCount, 1);
    assert.equal(parsed.findings.length, 1);
    assert.equal(parsed.findings[0].code, "missing_skill_frontmatter");

    // 5b. CLI `bin/agy-dart.mjs audit skills --json`
    const cliJson = spawnSync(
      process.execPath,
      [CLI_BIN, "audit", "skills", "--workspace", workspaceDir, "--config-dir", configDir, "--json"],
      { encoding: "utf8", timeout: 6000, windowsHide: true }
    );
    assert.equal(cliJson.status, 0, cliJson.stderr);
    assert.deepEqual(JSON.parse(cliJson.stdout), parsed);

    // 5c. CLI `bin/agy-dart.mjs audit skills` Markdown view matches formatter
    const cliMd = spawnSync(
      process.execPath,
      [CLI_BIN, "audit", "skills", "--workspace", workspaceDir, "--config-dir", configDir],
      { encoding: "utf8", timeout: 6000, windowsHide: true }
    );
    assert.equal(cliMd.status, 0, cliMd.stderr);
    assert.ok(cliMd.stdout.includes("# Skills Turn-0 Tax & Progressive Disclosure Report"));
    assert.ok(cliMd.stdout.includes("## 1. Installed Skills Inventory"));
    assert.ok(cliMd.stdout.includes("`references`"));
    assert.ok(cliMd.stdout.includes("missing_skill_frontmatter"));
    assert.equal(cliMd.stdout.trim(), formatSkillsAuditMarkdown(parsed).trim());
  } finally {
    tmp.cleanup();
  }
});

test("6. Multi-host Claude Code & Codex install/doctor/uninstall cover progressive skill files, clean empty dirs, and preserve skillSpec() compat", async () => {
  const tmp = makeTempDir("agy-multihost-skills-");
  try {
    const home = tmp.dir;
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });

    const expectedRelFiles = [
      "SKILL.md",
      path.join("references", "error-playbook.md"),
      path.join("examples", "filters.json"),
      path.join("examples", "ctx_trace_summary.py")
    ];

    // Verify skillSpecs enumerates all 4 files
    assert.equal(skillSpecs(home, ".claude", ROOT).length, 4);
    assert.equal(skillSpecs(home, ".codex", ROOT).length, 4);

    // Install both hosts
    await runTargets(ROOT, ["install", "--target", "claude,codex"], home);
    for (const hostDir of [".claude", ".codex"]) {
      for (const rel of expectedRelFiles) {
        const dest = path.join(home, hostDir, "skills", "agy-dart", rel);
        assert.ok(fs.existsSync(dest), `Expected installed skill asset: ${dest}`);
        assert.equal(
          fs.readFileSync(dest, "utf8"),
          fs.readFileSync(path.join(ROOT, "skills", "agy-dart", rel), "utf8")
        );
      }
    }

    // Doctor passes on both hosts
    await runTargets(ROOT, ["doctor", "--target", "claude,codex"], home);

    // Tampering an auxiliary file is caught by doctor AND protected from silent overwrite on uninstall
    const codexPlaybook = path.join(home, ".codex", "skills", "agy-dart", "references", "error-playbook.md");
    const origPlaybook = fs.readFileSync(codexPlaybook, "utf8");
    fs.writeFileSync(codexPlaybook, origPlaybook + "\n# local edit\n", "utf8");
    await assert.rejects(runTargets(ROOT, ["doctor", "--target", "codex"], home), /Invalid installation/);
    await assert.rejects(runTargets(ROOT, ["uninstall", "--target", "codex"], home), /Locally modified skill/);
    fs.writeFileSync(codexPlaybook, origPlaybook, "utf8");

    // Place a user-created file inside .claude/skills/agy-dart/references to verify non-empty dir preservation
    const userNote = path.join(home, ".claude", "skills", "agy-dart", "references", "user-note.md");
    fs.writeFileSync(userNote, "keep me\n", "utf8");

    // Uninstall Codex -> ALL files AND empty directories (references/, examples/, skills/agy-dart/) removed cleanly
    await runTargets(ROOT, ["uninstall", "--target", "codex"], home);
    assert.equal(fs.existsSync(path.join(home, ".codex", "skills", "agy-dart")), false, "Empty agy-dart skill dir must be removed");
    assert.equal(fs.existsSync(path.join(home, ".codex", "skills")), true, "Parent .codex/skills directory must remain");

    // Uninstall Claude -> managed files & empty examples/ removed, while user-note.md & its parent references/ stay intact
    await runTargets(ROOT, ["uninstall", "--target", "claude"], home);
    assert.equal(fs.existsSync(path.join(home, ".claude", "skills", "agy-dart", "SKILL.md")), false);
    assert.equal(fs.existsSync(path.join(home, ".claude", "skills", "agy-dart", "examples")), false);
    assert.equal(fs.existsSync(path.join(home, ".claude", "skills", "agy-dart", "references", "error-playbook.md")), false);
    assert.equal(fs.existsSync(userNote), true, "Unrelated user file inside skill dir must not be deleted");
    assert.equal(fs.existsSync(path.join(home, ".agy-dart", "runtime")), false, "Shared runtime must clean up after last host uninstall");

    // Backward-compatibility check for legacy skillSpec() export
    const compatHome = path.join(home, "compat-home");
    fs.mkdirSync(compatHome, { recursive: true });
    const singleSpec = skillSpec(compatHome, ".codex", ROOT);
    manageFiles(compatHome, "codex", [singleSpec], "install");
    assert.ok(fs.existsSync(path.join(compatHome, ".codex", "skills", "agy-dart", "SKILL.md")));
    assert.equal(fs.existsSync(path.join(compatHome, ".codex", "skills", "agy-dart", "references")), false);
    manageFiles(compatHome, "codex", [singleSpec], "uninstall");
    assert.equal(fs.existsSync(path.join(compatHome, ".codex", "skills", "agy-dart")), false);
  } finally {
    tmp.cleanup();
  }
});

test("7. Hardening regressions: symlinked skills/legacy dedup, YAML fence edges, stale aux pruning, anchored skill root, and Python non-string JSON errors", () => {
  const tmp = makeTempDir("agy-v172-hardening-");
  try {
    // 7a. cache-audit: trailing spaces on `---`, YAML `...` closing fence, symlinked skills, and symlinked .agent/skills -> .agents/skills
    const ws = path.join(tmp.dir, "ws");
    const cfg = path.join(tmp.dir, "cfg");
    fs.mkdirSync(path.join(ws, ".agents", "skills", "trail-space"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".agents", "skills", "trail-space", "SKILL.md"),
      "---   \nname: trail-space\ndescription: Valid frontmatter with trailing spaces.\n---  \n\n# Body\n",
      "utf8"
    );
    fs.mkdirSync(path.join(ws, ".agents", "skills", "dot-close"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".agents", "skills", "dot-close", "SKILL.md"),
      "---\nname: dot-close\ndescription: Valid frontmatter closed with YAML dots.\n...\n\n# Body\n",
      "utf8"
    );
    // Symlinked skill directory inside .agents/skills/ must be discovered
    const extSkill = path.join(tmp.dir, "external-linked-skill");
    fs.mkdirSync(extSkill, { recursive: true });
    fs.writeFileSync(
      path.join(extSkill, "SKILL.md"),
      "---\nname: external-linked-skill\ndescription: Linked skill.\n---\n\n# Linked\n",
      "utf8"
    );
    const linkType = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(extSkill, path.join(ws, ".agents", "skills", "linked-skill"), linkType);
    // Symlinked .agent/skills -> .agents/skills must NOT double-count or emit false legacy_skill_path
    fs.mkdirSync(path.join(ws, ".agent"), { recursive: true });
    fs.symlinkSync(path.join(ws, ".agents", "skills"), path.join(ws, ".agent", "skills"), linkType);

    const skillReport = auditSkillsOnly({ workspace: ws, configDir: cfg });
    assert.equal(skillReport.summary.skillCount, 3, `Expected 3 unique skills, got ${JSON.stringify(skillReport.skills.map((s) => s.skillName))}`);
    assert.equal(skillReport.findings.length, 0, `Unexpected findings: ${JSON.stringify(skillReport.findings)}`);
    assert.ok(skillReport.skills.some((s) => s.skillName === "linked-skill"));

    // Legacy markdown scope label must not stutter as "workspace-legacy [legacy]"
    const legacyWs = path.join(tmp.dir, "legacy-ws");
    fs.mkdirSync(path.join(legacyWs, ".agent", "skills", "old-one"), { recursive: true });
    fs.writeFileSync(
      path.join(legacyWs, ".agent", "skills", "old-one", "SKILL.md"),
      "---\nname: old-one\ndescription: Legacy skill.\n---\n# Legacy\n",
      "utf8"
    );
    const legacyMd = formatSkillsAuditMarkdown(auditSkillsOnly({ workspace: legacyWs, configDir: cfg }));
    assert.ok(legacyMd.includes("`workspace-legacy`"), legacyMd);
    assert.ok(!legacyMd.includes("workspace-legacy [legacy]"), legacyMd);

    // 7b. shared.mjs: home path containing "skills/agy-dart" must NOT cause non-skill uninstall to remove .claude/
    const weirdHome = path.join(tmp.dir, "skills", "agy-dart", "fake-home");
    fs.mkdirSync(path.join(weirdHome, ".claude"), { recursive: true });
    const dummySettingsSpec = {
      file: path.join(weirdHome, ".claude", "settings.json"),
      install: () => ({ text: "{}\n", undo: { offset: 0, length: 3 } }),
      verify: (c) => c === "{}\n",
      remove: () => null
    };
    manageFiles(weirdHome, "claude", [dummySettingsSpec], "install");
    manageFiles(weirdHome, "claude", [dummySettingsSpec], "uninstall");
    assert.equal(fs.existsSync(path.join(weirdHome, ".claude")), true, "Non-skill uninstall must never delete .claude dir");

    // 7c. shared.mjs: upgrading or uninstalling after a release removes an aux file cleans up unmodified orphans & guards local edits
    const upHome = path.join(tmp.dir, "upgrade-home");
    const upSrc = path.join(tmp.dir, "upgrade-src");
    fs.mkdirSync(path.join(upSrc, "skills", "agy-dart", "examples"), { recursive: true });
    fs.writeFileSync(path.join(upSrc, "skills", "agy-dart", "SKILL.md"), "skill v1", "utf8");
    fs.writeFileSync(path.join(upSrc, "skills", "agy-dart", "examples", "obsolete.json"), '{"v":1}\n', "utf8");
    manageFiles(upHome, "codex", skillSpecs(upHome, ".codex", upSrc), "install");
    const installedObsolete = path.join(upHome, ".codex", "skills", "agy-dart", "examples", "obsolete.json");
    assert.equal(fs.existsSync(installedObsolete), true);

    // Remove obsolete.json from source and simulate local modification first -> must throw Locally modified skill
    fs.unlinkSync(path.join(upSrc, "skills", "agy-dart", "examples", "obsolete.json"));
    fs.writeFileSync(path.join(upSrc, "skills", "agy-dart", "SKILL.md"), "skill v2", "utf8");
    fs.writeFileSync(installedObsolete, '{"v":1,"user":true}\n', "utf8");
    assert.throws(() => manageFiles(upHome, "codex", skillSpecs(upHome, ".codex", upSrc), "install"), /Locally modified skill/);

    // Restore unmodified content -> upgrade removes obsolete.json and empty examples/ cleanly
    fs.writeFileSync(installedObsolete, '{"v":1}\n', "utf8");
    manageFiles(upHome, "codex", skillSpecs(upHome, ".codex", upSrc), "install");
    assert.equal(fs.existsSync(installedObsolete), false, "Unmodified obsolete aux file must be removed on upgrade");
    assert.equal(fs.existsSync(path.join(upHome, ".codex", "skills", "agy-dart", "examples")), false, "Empty obsolete aux dir must be removed");
    manageFiles(upHome, "codex", skillSpecs(upHome, ".codex", upSrc), "uninstall");
    assert.equal(fs.existsSync(path.join(upHome, ".codex", "skills", "agy-dart")), false);

    // 7d. ctx_trace_summary.py: non-string error.message, Pino numeric levels, string HTTP statuses, and exact small --max-bytes
    const py = findPythonBin();
    if (py) {
      const trickyPath = path.join(tmp.dir, "tricky.jsonl");
      fs.writeFileSync(
        trickyPath,
        [
          JSON.stringify({ level: "error", error: { message: ["nested", "list"] }, status: 500 }),
          JSON.stringify({ level: 50, msg: "pino numeric error level" }),
          JSON.stringify({ endpoint: "/api/pay", status: "504", msg: "gateway timeout string status" })
        ].join("\n") + "\n",
        "utf8"
      );
      const scriptPath = path.join(ROOT, "skills", "agy-dart", "examples", "ctx_trace_summary.py");
      const trickyRes = spawnSync(py.bin, [...py.prefixArgs, scriptPath, trickyPath], {
        encoding: "utf8",
        timeout: 6000,
        windowsHide: true
      });
      assert.equal(trickyRes.status, 0, trickyRes.stderr);
      assert.ok(trickyRes.stdout.includes("Levels: ERROR=3"), trickyRes.stdout);
      assert.ok(trickyRes.stdout.includes("Errors: 3 (3 unique)"), trickyRes.stdout);

      const cap200 = spawnSync(py.bin, [...py.prefixArgs, scriptPath, trickyPath, "--max-bytes", "200"], {
        encoding: "utf8",
        timeout: 6000,
        windowsHide: true
      });
      assert.equal(cap200.status, 0, cap200.stderr);
      assert.ok(Buffer.byteLength(cap200.stdout, "utf8") <= 200, `Expected <= 200 bytes, got ${Buffer.byteLength(cap200.stdout, "utf8")}`);
    }
  } finally {
    tmp.cleanup();
  }
});

test("8. Aux walkers ignore __pycache__, node_modules, and *.pyc/*.pyo (case-insensitive) across skillSpecs, auditPrefixBudget, and auditSkillsOnly", async () => {
  const tmp = makeTempDir("agy-v172-pycache-");
  try {
    const fakePycBytes = Buffer.from([0x61, 0x0d, 0x0d, 0x0a, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfe, 0x80]);

    // 8a. skillSpecs() + manageFiles() must ignore __pycache__, node_modules, and *.pyc/*.pyo (case-insensitive)
    const specHome = path.join(tmp.dir, "spec-home");
    const specSrc = path.join(tmp.dir, "spec-src");
    const specSkillRoot = path.join(specSrc, "skills", "agy-dart");
    fs.mkdirSync(path.join(specSkillRoot, "examples", "__pycache__"), { recursive: true });
    fs.mkdirSync(path.join(specSkillRoot, "examples", "nested", "__pycache__"), { recursive: true });
    fs.mkdirSync(path.join(specSkillRoot, "examples", "node_modules", "dep"), { recursive: true });
    fs.mkdirSync(path.join(specSkillRoot, "scripts", "__PYCACHE__"), { recursive: true });
    fs.mkdirSync(path.join(specSkillRoot, "scripts", "NODE_MODULES", "pkg"), { recursive: true });
    fs.mkdirSync(path.join(specSkillRoot, "examples", "d2", "d3", "d4", "d5", "d6", "d7"), { recursive: true });

    fs.writeFileSync(
      path.join(specSkillRoot, "SKILL.md"),
      "---\nname: agy-dart\ndescription: Concise test skill.\n---\n\n# Body\n",
      "utf8"
    );
    fs.writeFileSync(path.join(specSkillRoot, "examples", "ctx_trace_summary.py"), "print('ok')\n", "utf8");
    fs.writeFileSync(path.join(specSkillRoot, "examples", "nested", "keep.py"), "print('nested')\n", "utf8");
    fs.writeFileSync(path.join(specSkillRoot, "examples", "nested", "__pycache__", "keep.cpython-311.pyc"), fakePycBytes);
    fs.writeFileSync(path.join(specSkillRoot, "examples", "d2", "d3", "d4", "d5", "d6", "d7", "too-deep.txt"), "skip\n", "utf8");
    fs.writeFileSync(path.join(specSkillRoot, "scripts", "helper.py"), "print('helper')\n", "utf8");
    fs.writeFileSync(path.join(specSkillRoot, "examples", "__pycache__", "ctx_trace_summary.cpython-311.pyc"), fakePycBytes);
    fs.writeFileSync(path.join(specSkillRoot, "examples", "loose.pyc"), fakePycBytes);
    fs.writeFileSync(path.join(specSkillRoot, "examples", "UPPER.PYO"), fakePycBytes);
    fs.writeFileSync(path.join(specSkillRoot, "examples", "node_modules", "dep", "index.js"), "module.exports = 1;\n", "utf8");
    fs.writeFileSync(path.join(specSkillRoot, "scripts", "__PYCACHE__", "helper.cpython-311.PYC"), fakePycBytes);
    fs.writeFileSync(path.join(specSkillRoot, "scripts", "loose.pyo"), fakePycBytes);
    fs.writeFileSync(path.join(specSkillRoot, "scripts", "UPPER.PYC"), fakePycBytes);
    fs.writeFileSync(path.join(specSkillRoot, "scripts", "NODE_MODULES", "pkg", "index.js"), "module.exports = 2;\n", "utf8");

    const claudeSpecs = skillSpecs(specHome, ".claude", specSrc);
    const claudeRel = claudeSpecs
      .map((s) => path.relative(path.join(specHome, ".claude", "skills", "agy-dart"), s.file).replaceAll("\\", "/"))
      .sort();
    assert.deepEqual(claudeRel, ["SKILL.md", "examples/ctx_trace_summary.py", "examples/nested/keep.py", "scripts/helper.py"]);

    manageFiles(specHome, "claude", claudeSpecs, "install");
    const installedRoot = path.join(specHome, ".claude", "skills", "agy-dart");
    assert.equal(fs.existsSync(path.join(installedRoot, "examples", "ctx_trace_summary.py")), true);
    assert.equal(fs.existsSync(path.join(installedRoot, "examples", "nested", "keep.py")), true);
    assert.equal(fs.existsSync(path.join(installedRoot, "examples", "nested", "__pycache__")), false);
    assert.equal(fs.existsSync(path.join(installedRoot, "examples", "d2")), false);
    assert.equal(fs.existsSync(path.join(installedRoot, "scripts", "helper.py")), true);
    assert.equal(fs.existsSync(path.join(installedRoot, "examples", "__pycache__")), false);
    assert.equal(fs.existsSync(path.join(installedRoot, "examples", "node_modules")), false);
    assert.equal(fs.existsSync(path.join(installedRoot, "examples", "loose.pyc")), false);
    assert.equal(fs.existsSync(path.join(installedRoot, "examples", "UPPER.PYO")), false);
    assert.equal(fs.existsSync(path.join(installedRoot, "scripts", "__PYCACHE__")), false);
    assert.equal(fs.existsSync(path.join(installedRoot, "scripts", "NODE_MODULES")), false);
    assert.equal(fs.existsSync(path.join(installedRoot, "scripts", "loose.pyo")), false);
    assert.equal(fs.existsSync(path.join(installedRoot, "scripts", "UPPER.PYC")), false);
    manageFiles(specHome, "claude", claudeSpecs, "uninstall");
    assert.equal(fs.existsSync(installedRoot), false);

    // 8b. auditPrefixBudget() ignores __pycache__, node_modules, and *.pyc/*.pyo (including real py_compile output)
    const cleanBudget = await auditPrefixBudget(ROOT);
    const pbRoot = path.join(tmp.dir, "pb-root");
    for (const rel of RUNTIME_FILES) {
      const dest = path.join(pbRoot, ...rel.split("/"));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(ROOT, ...rel.split("/")), dest);
    }
    const pbSkillDir = path.join(pbRoot, "skills", "agy-dart");
    const py = findPythonBin();
    if (py) {
      const compRes = spawnSync(
        py.bin,
        [...py.prefixArgs, "-m", "py_compile", path.join(pbSkillDir, "examples", "ctx_trace_summary.py")],
        { encoding: "utf8", timeout: 6000, windowsHide: true }
      );
      assert.equal(compRes.status, 0, compRes.stderr);
      assert.equal(fs.existsSync(path.join(pbSkillDir, "examples", "__pycache__")), true);
    } else {
      fs.mkdirSync(path.join(pbSkillDir, "examples", "__pycache__"), { recursive: true });
      fs.writeFileSync(
        path.join(pbSkillDir, "examples", "__pycache__", "ctx_trace_summary.cpython-311.pyc"),
        fakePycBytes
      );
    }
    fs.mkdirSync(path.join(pbSkillDir, "examples", "node_modules", "dep"), { recursive: true });
    fs.mkdirSync(path.join(pbSkillDir, "scripts", "__PYCACHE__"), { recursive: true });
    fs.mkdirSync(path.join(pbSkillDir, "scripts", "NODE_MODULES", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(pbSkillDir, "examples", "stray.PYC"), fakePycBytes);
    fs.writeFileSync(path.join(pbSkillDir, "examples", "node_modules", "dep", "index.js"), "export default 1;\n", "utf8");
    fs.writeFileSync(path.join(pbSkillDir, "scripts", "__PYCACHE__", "mod.cpython-311.pyc"), fakePycBytes);
    fs.writeFileSync(path.join(pbSkillDir, "scripts", "stray.pyo"), fakePycBytes);
    fs.writeFileSync(path.join(pbSkillDir, "scripts", "NODE_MODULES", "pkg", "index.js"), "export default 2;\n", "utf8");

    const dirtyBudget = await auditPrefixBudget(pbRoot);
    assert.equal(dirtyBudget.blocks.reference.auxFileCount, 3);
    assert.deepEqual(dirtyBudget.blocks.reference.auxFiles, [
      "examples/ctx_trace_summary.py",
      "examples/filters.json",
      "references/error-playbook.md"
    ]);
    assert.equal(dirtyBudget.blocks.reference.auxBytes, cleanBudget.blocks.reference.auxBytes);
    assert.equal(dirtyBudget.blocks.reference.auxTokens, cleanBudget.blocks.reference.auxTokens);

    // 8c. auditSkillsOnly() ignores __pycache__, node_modules, and *.pyc/*.pyo and avoids false progressive detection
    const ws = path.join(tmp.dir, "ws");
    const cfg = path.join(tmp.dir, "cfg");
    fs.mkdirSync(cfg, { recursive: true });

    const pySkillDir = path.join(ws, ".agents", "skills", "py-skill");
    fs.mkdirSync(path.join(pySkillDir, "examples", "__pycache__"), { recursive: true });
    fs.mkdirSync(path.join(pySkillDir, "examples", "NODE_MODULES", "dep"), { recursive: true });
    fs.mkdirSync(path.join(pySkillDir, "scripts", "__PYCACHE__"), { recursive: true });
    fs.mkdirSync(path.join(pySkillDir, "scripts", "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(
      path.join(pySkillDir, "SKILL.md"),
      "---\nname: py-skill\ndescription: Skill with Python helpers.\n---\n\n# Py Skill\n",
      "utf8"
    );
    const exPyBody = "print('example')\n";
    const scPyBody = "print('script')\n";
    fs.writeFileSync(path.join(pySkillDir, "examples", "tool.py"), exPyBody, "utf8");
    fs.writeFileSync(path.join(pySkillDir, "scripts", "run.py"), scPyBody, "utf8");
    fs.writeFileSync(path.join(pySkillDir, "examples", "__pycache__", "tool.cpython-311.pyc"), fakePycBytes);
    fs.writeFileSync(path.join(pySkillDir, "examples", "tool.PYC"), fakePycBytes);
    fs.writeFileSync(path.join(pySkillDir, "examples", "NODE_MODULES", "dep", "index.js"), "module.exports = 1;\n", "utf8");
    fs.writeFileSync(path.join(pySkillDir, "scripts", "__PYCACHE__", "run.cpython-311.PYO"), fakePycBytes);
    fs.writeFileSync(path.join(pySkillDir, "scripts", "run.pyo"), fakePycBytes);
    fs.writeFileSync(path.join(pySkillDir, "scripts", "node_modules", "pkg", "index.js"), "module.exports = 2;\n", "utf8");

    const cacheOnlyDir = path.join(ws, ".agents", "skills", "cache-only-skill");
    fs.mkdirSync(path.join(cacheOnlyDir, "examples", "__pycache__"), { recursive: true });
    fs.mkdirSync(path.join(cacheOnlyDir, "scripts", "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(
      path.join(cacheOnlyDir, "SKILL.md"),
      "---\nname: cache-only-skill\ndescription: Skill containing only ignored cache artifacts.\n---\n\n# Cache Only\n",
      "utf8"
    );
    fs.writeFileSync(path.join(cacheOnlyDir, "examples", "__pycache__", "ghost.cpython-311.pyc"), fakePycBytes);
    fs.writeFileSync(path.join(cacheOnlyDir, "scripts", "ghost.pyo"), fakePycBytes);
    fs.writeFileSync(path.join(cacheOnlyDir, "scripts", "node_modules", "dep", "index.js"), "module.exports = 3;\n", "utf8");

    const auditRes = auditSkillsOnly({ workspace: ws, configDir: cfg });
    assert.equal(auditRes.summary.skillCount, 2);
    assert.equal(auditRes.summary.progressiveSkillCount, 1);
    assert.equal(auditRes.summary.totalAuxFileCount, 2);

    const pyItem = auditRes.skills.find((s) => s.skillName === "py-skill");
    assert.ok(pyItem);
    assert.equal(pyItem.auxFileCount, 2);
    assert.deepEqual(pyItem.auxDirs, ["examples", "scripts"]);
    assert.equal(pyItem.auxBytes, Buffer.byteLength(exPyBody, "utf8") + Buffer.byteLength(scPyBody, "utf8"));

    const cacheOnlyItem = auditRes.skills.find((s) => s.skillName === "cache-only-skill");
    assert.ok(cacheOnlyItem);
    assert.equal(cacheOnlyItem.auxFileCount, 0);
    assert.deepEqual(cacheOnlyItem.auxDirs, []);
    assert.equal(cacheOnlyItem.auxBytes, 0);
    assert.equal(cacheOnlyItem.auxTokens, 0);

    // 8c-extra. listMarkdownFiles & listSkillFiles ignore NODE_MODULES/__pycache__ case-insensitively
    fs.mkdirSync(path.join(ws, ".agents", "rules", "NODE_MODULES", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".agents", "rules", "NODE_MODULES", "pkg", "README.md"), "# Ignored\n", "utf8");
    fs.mkdirSync(path.join(ws, ".agents", "skills", "NODE_MODULES"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".agents", "skills", "NODE_MODULES", "SKILL.md"), "---\nname: bad\ndescription: x\n---\n", "utf8");
    const fullOffline = await auditEnvironmentCache({ workspace: ws, configDir: cfg, live: false });
    assert.equal(fullOffline.prefix.ruleCount, 0);
    assert.equal(fullOffline.prefix.skillCount, 2);

    // 8d. package.json `files` negations keep npm pack tarballs free of __pycache__, nested node_modules, and *.py[cod]
    const packTmp = path.join(tmp.dir, "pack-check");
    fs.mkdirSync(packTmp, { recursive: true });
    fs.copyFileSync(path.join(ROOT, "package.json"), path.join(packTmp, "package.json"));
    fs.copyFileSync(path.join(ROOT, ".gitignore"), path.join(packTmp, ".gitignore"));
    fs.cpSync(path.join(ROOT, "skills"), path.join(packTmp, "skills"), { recursive: true });
    const packExamples = path.join(packTmp, "skills", "agy-dart", "examples");
    if (py) {
      const compPack = spawnSync(
        py.bin,
        [...py.prefixArgs, "-m", "py_compile", path.join(packExamples, "ctx_trace_summary.py")],
        { encoding: "utf8", timeout: 6000, windowsHide: true }
      );
      assert.equal(compPack.status, 0, compPack.stderr);
    } else {
      fs.mkdirSync(path.join(packExamples, "__pycache__"), { recursive: true });
      fs.writeFileSync(path.join(packExamples, "__pycache__", "ctx_trace_summary.cpython-311.pyc"), fakePycBytes);
    }
    fs.mkdirSync(path.join(packExamples, "nested", "__pycache__"), { recursive: true });
    fs.writeFileSync(path.join(packExamples, "nested", "__pycache__", "mod.pyc"), fakePycBytes);
    fs.mkdirSync(path.join(packExamples, "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(packExamples, "node_modules", "dep", "index.js"), "module.exports = 1;\n", "utf8");
    fs.writeFileSync(path.join(packExamples, "node_modules", "dep", "package.json"), '{"name":"dep"}\n', "utf8");
    fs.writeFileSync(path.join(packExamples, "loose.pyc"), fakePycBytes);
    fs.writeFileSync(path.join(packExamples, "loose.pyo"), fakePycBytes);
    fs.writeFileSync(path.join(packExamples, "loose.pyd"), fakePycBytes);
    fs.writeFileSync(path.join(packExamples, "UPPER.PYC"), fakePycBytes);

    const npmCliCandidates = [
      process.env.npm_execpath,
      path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
      path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")
    ].filter((p) => p && fs.existsSync(p));
    const npmCli = npmCliCandidates[0];
    if (npmCli) {
      const packRes = spawnSync(
        process.execPath,
        [npmCli, "pack", "--dry-run", "--json"],
        {
          cwd: packTmp,
          encoding: "utf8",
          timeout: 15000,
          windowsHide: true,
          env: { ...process.env, npm_config_cache: path.join(tmp.dir, "npm-cache") }
        }
      );
      assert.equal(packRes.status, 0, packRes.stderr);
      const [packed] = JSON.parse(packRes.stdout);
      const packedPaths = packed.files.map((f) => f.path).sort();
      assert.ok(packedPaths.includes("skills/agy-dart/SKILL.md"), JSON.stringify(packedPaths));
      assert.ok(packedPaths.includes("skills/agy-dart/references/error-playbook.md"), JSON.stringify(packedPaths));
      assert.ok(packedPaths.includes("skills/agy-dart/examples/filters.json"), JSON.stringify(packedPaths));
      assert.ok(packedPaths.includes("skills/agy-dart/examples/ctx_trace_summary.py"), JSON.stringify(packedPaths));
      assert.equal(
        packedPaths.some((p) => /(?:^|\/)(?:__pycache__|node_modules)(?:\/|$)/i.test(p) || /\.py[cod]$/i.test(p)),
        false,
        `npm pack leaked ignored artifacts: ${JSON.stringify(packedPaths)}`
      );
    }
  } finally {
    tmp.cleanup();
  }
});
