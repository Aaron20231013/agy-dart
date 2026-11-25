import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runApplyEdits, runBatchSearch, runChecks } from "../fast/mcp-server.mjs";
import { extractSymbolsFromLines } from "../context/lib/code-outline.js";

function temporaryWorkspace(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-fast-merge-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

test("batch_search keeps counts, filtered filenames and multiline results consistent across backends", async t => {
  const cwd = temporaryWorkspace(t);
  fs.writeFileSync(path.join(cwd, "alpha.ts"), "hit hit\r\nstart\r\nend\r\nhit\r\n");
  fs.writeFileSync(path.join(cwd, "beta.tsx"), "hit\n");
  fs.writeFileSync(path.join(cwd, "skip.txt"), "hit\n");
  fs.utimesSync(path.join(cwd, "alpha.ts"), 100, 100);
  const common = { type: "text", pattern: "hit", fileType: "typescript" };
  const cases = [
    [{ ...common, outputMode: "count" }, "alpha.ts: 2 matching lines\nbeta.tsx: 1 matching lines"],
    [{ ...common, outputMode: "files_with_matches" }, "alpha.ts\nbeta.tsx"],
    [{ type: "regex", pattern: "start.*end", multiline: true }, "alpha.ts\n  2: start\n  3: end"],
    [{ type: "regex", pattern: "hit", multiline: true, outputMode: "count", path: "alpha.ts" }, "alpha.ts: 3 matches"],
    [{ type: "fuzzy", pattern: "bt", fileType: "tsx" }, "beta.tsx"],
    [{ type: "glob", pattern: "*.ts*", sortBy: "mtime" }, "beta.tsx\nalpha.ts"]
  ];
  for (const forceNodeFallback of [false, true]) {
    for (const [query, expected] of cases) {
      const { text } = await runBatchSearch({ cwd, queries: [query] }, { forceNodeFallback });
      assert.equal(text.slice(text.indexOf("\n") + 1), expected);
    }
  }
});

test("markup outlines keep multiline opening tags, real closing lines and embedded script symbols", () => {
  const lines = ["<main>", "<section", ' id="checkout">', "<!-- </section> -->",
    "<script>", "function pay() { return '</section>'; }", "</script>", "</section>", "</main>"];
  for (const ext of ["html", "vue", "svelte"]) {
    const symbols = extractSymbolsFromLines("checkout." + ext, lines);
    const range = name => {
      const symbol = symbols.find(item => item.name === name);
      assert.ok(symbol, name);
      return [symbol.startLine, symbol.endLine];
    };
    assert.deepEqual(range("<main>"), [1, 9]);
    assert.deepEqual(range("<section #checkout>"), [2, 8]);
    assert.deepEqual(range("pay"), [6, 6]);
  }
});

test("Windows checks and edit verification recognize PowerShell and retain Chinese output", {
  skip: process.platform !== "win32"
}, async t => {
  const cwd = temporaryWorkspace(t);
  const checks = await runChecks({ cwd, outputMode: "full", commands: [
    { command: "Get-Location | Select-Object -ExpandProperty Path" },
    { command: "Write-Output ([char]0x4E2D)" }, { command: "node --version" }
  ] });
  assert.equal(checks.isError, false, checks.text);
  assert.ok(checks.text.includes(path.basename(cwd)), checks.text);
  assert.match(checks.text, /^中\r?$/m);
  const edit = await runApplyEdits({
    cwd, edits: [{ path: "fixture.txt", create: "verified" }], verify: "Get-Content fixture.txt"
  });
  assert.equal(edit.isError, false, edit.text);
  assert.match(edit.text, /verified/);
});

test("apply_edits validates verify before writing or previewing the batch", async t => {
  const cwd = temporaryWorkspace(t);
  const existing = path.join(cwd, "existing.txt");
  const created = path.join(cwd, "new.txt");
  fs.writeFileSync(existing, "before");
  const edits = [
    { path: "existing.txt", hunks: [{ target: "before", replacement: "after" }] },
    { path: "new.txt", create: "new" }
  ];

  for (const verify of [{}, { command: "  " }, { command: 1 }, { command: "node --version", cwd: false }, [], null, true]) {
    for (const mode of [{}, { bestEffort: true }, { dryRun: true }]) {
      const result = await runApplyEdits({ cwd, edits, verify, ...mode });
      assert.equal(result.isError, true, result.text);
      assert.match(result.text, /0 files modified.*verify/s);
      assert.equal(fs.readFileSync(existing, "utf8"), "before");
      assert.equal(fs.existsSync(created), false);
    }
  }

  // The verifier can run inside a directory created by this same batch.
  const valid = await runApplyEdits({
    cwd, edits: [{ path: "checks/files.txt", create: "ok" }],
    verify: { command: "node --version", cwd: "checks", timeoutSec: "5" }
  });
  assert.equal(valid.isError, false, valid.text);
  assert.match(valid.text, /Verify \[PASS/);

  const noVerify = await runApplyEdits({ cwd, edits, verify: "  " });
  assert.equal(noVerify.isError, false, noVerify.text);
  assert.doesNotMatch(noVerify.text, /Verify/);
  assert.equal(fs.readFileSync(existing, "utf8"), "after");
});
