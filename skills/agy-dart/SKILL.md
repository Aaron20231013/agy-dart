---
name: agy-dart
description: >-
  Workflow playbook for agy-dart dual-engine acceleration and context protection.
  Use when diagnosing large logs (>16 KB), processing bulk JSON/CSV/API outputs,
  indexing long documentation or URLs for FTS5 retrieval, tuning PreToolUse cutoffs,
  or benchmarking session latency savings with benchmark.mjs.
---

# agy-dart Playbook

`agy-dart` unites two complementary engines inside one Antigravity plugin:
1. **`agy-dart_fast`** — minimizes round-trips, remote checks, and TTFT during source-code exploration, editing, and testing.
2. **`agy-dart_context`** — keeps massive logs, datasets, and reference documents out of the prompt via local sandbox execution and SQLite FTS5 indexing (`~/.agy-dart/context.db`).

## 1. Thinking in Code (`ctx_execute`)

When facing build logs, test output dumps, CSV/JSON files, or API responses larger than 16 KB, write a short extraction script so only the computed answer enters the conversation:

```json
{
  "language": "javascript",
  "code": "const fs = require('fs'); const lines = fs.readFileSync('build.log', 'utf8').split(/\\r?\\n/); const errs = lines.filter(l => /error|exception/i.test(l)); console.log(JSON.stringify({ totalLines: lines.length, errorCount: errs.length, sample: errs.slice(0, 20) }, null, 2));",
  "intent": "Count and sample errors from build.log"
}
```

- All stdout/stderr is automatically indexed in SQLite FTS5.
- Inline responses are hard-capped (`<= 8.8 KB` total) so Antigravity never spills MCP output to `output.txt`.

## 2. Repeat Search Over Long Docs / URLs (`ctx_index` + `ctx_search`)

1. Index once: `ctx_index({ path: "docs/spec.md", label: "Spec" })` or `ctx_index({ url: "https://..." })`.
2. Query repeatedly with Porter BM25 + Trigram RRF: `ctx_search({ queries: ["rate limit", "OAuthError"], limit: 5 })`.
3. After `/compact`, call `ctx_resume({})` to recover recent indexed `sourceId` handles.

## 3. Source Code Workflows (`agy-dart_fast` + Built-in `read_file`)

- Do **not** index normal source files before trying `read_slices({ outlines: [...] })`.
- Outline 10–20 large files in 1 call, then read exact target blocks in parallel with built-in `read_file(StartLine, EndLine)`.
- Use `batch_search` for multi-query text/regex/glob/read-only `git`, `apply_edits` (`bestEffort: true` + `verify`) for multi-hunk/multi-file edits, and `run_checks` for concurrent build/lint/test commands.

## 4. Verification & Tuning

- Call `ctx_stats({})` / `ctx_doctor({})` or open the **agy-dart Context** Aux Pane dashboard to monitor savings, adjust the cutoff (`16 KB` default, `32 KB` for large repos, or `Paused`), and inspect FTS5 chunks.
- Measure end-to-end round-trip & token-quota savings locally:
  ```bash
  node ~/.gemini/config/plugins/agy-dart/fast/benchmark.mjs analyze --local --recent 10
  ```
