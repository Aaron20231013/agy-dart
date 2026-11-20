---
name: agy-dart
description: >-
  Workflow playbook for agy-dart dual-engine acceleration, transparent CLI filtering,
  KV-cache diagnostics, read deduplication, and SQLite FTS5 context protection.
---

# agy-dart Playbook

`agy-dart` unites two zero-dependency engines plus four lifecycle hooks inside one Antigravity plugin:
1. **`agy-dart_fast`** — batched search/outlines/edits/checks (`<= 8.8 KB` inline).
2. **`agy-dart_context`** — local sandbox filtering & heading-aware SQLite FTS5 (`~/.agy-dart/context.db`).
3. **Lifecycle Guards** — prefix-stable `SessionStart` (with `git HEAD`-cached repo hubs), `PreToolUse` (transparent `overwrite` CLI filtering + 16 KB gate + 2-strike unchanged read dedup), `PostToolUse` (edit/compaction dedup invalidation), and `PreInvocation` (zero-prefix-pollution UI-only KV-cache watermark/TTL alerts).

## 1. Thinking in Code (`ctx_execute`)

For logs, test dumps, CSV/JSON files, or API responses larger than 16 KB, extract only the computed facts in the sandbox:

```json
{
  "language": "javascript",
  "code": "const fs = require('fs'); const lines = fs.readFileSync('build.log', 'utf8').split(/\\r?\\n/); const errs = lines.filter(l => /error|exception/i.test(l)); console.log(JSON.stringify({ totalLines: lines.length, errorCount: errs.length, sample: errs.slice(0, 20) }, null, 2));",
  "intent": "Count and sample errors from build.log"
}
```

## 2. Heading-Aware Docs & URLs (`ctx_index` + `ctx_search`)

1. Index once: `ctx_index({ path: "docs/spec.md", label: "Spec" })` or `ctx_index({ url: "https://..." })`. Markdown documents preserve heading breadcrumbs (`H1 > H2 > H3`) and fenced code blocks.
2. Search repeatedly via Porter BM25 + Trigram RRF: `ctx_search({ queries: ["rate limit", "OAuthError"], limit: 5 })`.
3. After `/compact`, call `ctx_resume({})` to recover recent indexed `sourceId` handles plus the structured `sessionCheckpoint` (modified files + latest test/build status) while clearing session read-dedup entries.

## 3. Transparent CLI Filtering, Security & Read Dedup

- Single noisy commands (`git status/diff/log`, `npm/pnpm/yarn/node/pytest/cargo/go` tests, builds, linters, installs, docker builds) are transparently rewritten via `PreToolUse.overwrite` through `hooks/cli-filter.mjs` to return `<= 8.8 KB` output in 1 turn while preserving exact exit codes and indexing redacted raw output into FTS5.
- `ctx_index({ url })` enforces SSRF protection (`http:`/`https:` only, max 5 redirects, per-hop DNS private/loopback/link-local blocking), and common API keys/private keys/DB passwords are redacted before indexing/returning.
- Redundant unchanged `read_file` calls in the same session are caught on strike 1; if context was compacted and you truly need a fresh copy, retry once to bypass (strike 2) or edit the file (`PostToolUse` auto-invalidates).
- Env controls: `AGY_DART_DISABLE_CLI_FILTER=1`, `AGY_DART_DISABLE_READ_DEDUP=1`, `AGY_DART_DISABLE_CACHE_WATCH=1`, `AGY_DART_DISABLE_READ_HOOK=1`, `AGY_DART_DISABLE_SECRET_REDACTION=1`, `AGY_DART_SENSITIVE_FILE_GUARD=warn|deny`, `AGY_DART_CACHE_TTL_SEC`, `AGY_DART_WARN_TOKENS`, `AGY_DART_CRITICAL_TOKENS`.

## 4. KV-Cache Diagnostics & DB Maintenance

- Check live Prompt Cache hit rate, bust attribution, idle TTL countdown, and DB size in the **agy-dart Context** Aux Pane Sidecar dashboard (or run `ctx_stats` / `ctx_doctor`).
- Prune stale entries (>14 days) and reclaim disk space: `ctx_purge({ scope: "stale", olderThanDays: 14, vacuum: true })`.
- Run offline transcript benchmarks & KV-cache bust attribution locally:
  ```bash
  node ~/.gemini/config/plugins/agy-dart/fast/benchmark.mjs analyze --local --recent 10
  node ~/.gemini/config/plugins/agy-dart/fast/benchmark.mjs cache --local --recent 10
  ```
