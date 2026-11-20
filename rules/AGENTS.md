# agy-dart Unified Tool Routing, Latency & Context Hygiene Rules

`agy-dart` pairs two zero-overlap MCP engines with Antigravity's locally allowlisted `read_file` (~7ms, 0 remote check, 46 KB/call inline):
- **`agy-dart_fast`**: Source code search, symbol outlining, atomic multi-file edits, and concurrent build/lint/test checks.
- **`agy-dart_context`**: Sandboxed script filtering ("Thinking in Code") and local SQLite FTS5 search (Porter BM25 + Trigram RRF) for large logs, datasets, and long docs/URLs.

## Task Routing Matrix

| Task | Preferred Tool | Reason |
| :--- | :--- | :--- |
| Outline unknown large source files (>300 lines; 10–20/batch, max 40) | `agy-dart_fast` → `read_slices({ outlines })` | 1 call maps exact symbol/section line ranges without blind full-file dumps |
| Read small source files (<300 lines / <16 KB) OR known ranges after outlining | Built-in `read_file` (parallel in one turn, `StartLine`/`EndLine` <=400 lines) | Local allowlist (~7ms, **0 remote check**) + **46 KB/call** inline |
| Run >=2 text/regex/glob/read-only `git` queries | `agy-dart_fast` → `batch_search` (pack ALL into **one** call) | 1 remote check + concurrent `rg`/Node execution, hard-capped <=8.8 KB |
| Edit >=2 blocks in one file, edit/create >=2 files, OR edit + verify | `agy-dart_fast` → `apply_edits` (`bestEffort: true` for >=3 files) | Replaces N serial checks + verify turn; returns closest-line hints on mismatch |
| Run >=2 independent non-interactive shell commands (build/lint/test/diag) | `agy-dart_fast` → `run_checks` (`compact` for checks, `full` for diag) | True concurrent pool; **never** use `ctx_batch` for build/test (it is sequential) |
| Analyze large logs (>16 KB–MBs), giant JSON/CSV, or raw API responses | `agy-dart_context` → `ctx_execute` | Filters/aggregates in local Node/Python/Shell sandbox; prints only concise facts |
| Query long reference docs, URLs, or huge logs repeatedly | `agy-dart_context` → `ctx_index` + `ctx_search` | Local SQLite FTS5 BM25 + Trigram RRF; call `ctx_resume` after `/compact` |

## Core Rules

1. **Direct invocation (0 schema-read turns)**: Call `call_mcp_tool` directly with `ServerName: "agy-dart_fast"` or `ServerName: "agy-dart_context"` using the schemas below. Do **not** spend a turn reading `mcp/agy-dart_*/*.json` first.
2. **Outline first, read ranges in parallel**: On unknown large source files (>300 lines), call `read_slices({ outlines })` first, then read needed <=200-line blocks with parallel built-in `read_file(StartLine, EndLine)`. Never blind-read 1–800 lines of unknown files, and never use `read_slices({ slices })` to bulk-read >150 lines across files.
3. **Never dump raw logs or unbounded outputs**: Never run bare `cat`/`Get-Content`/`type`, unbounded `git log`, or stdout `curl`/`wget`. Process large logs and API payloads inside `ctx_execute` or index them with `ctx_index` + `ctx_search`.
4. **Multimodal & long-context TTFT hygiene**: Keep screenshots/images out of long (>180k-token) coding sessions (causes 3–7x TTFT cliff); delegate visual inspection to a subagent returning text-only findings. Recommend `/compact` between major task phases, then call `ctx_resume` if you need prior indexed sources.
5. **Pack into ONE MCP call per turn & brief swarm workers**: Combine cross-dir searches into one `batch_search`, combine multi-file edits + `verify` into one `apply_edits` (`bestEffort: true` for >=3 files), use the `SessionStart` snapshot before running `ls`/`git status`, and remind swarm workers to use `agy-dart_fast` or ranged `read_file`.

## Quick Schemas

### `ServerName: "agy-dart_fast"` (hard-capped <=8.8 KB inline)
- **`batch_search`**: `{ cwd?, queries: [{ type: "text"|"regex"|"glob"|"git", pattern, path?, glob?, caseSensitive?, contextLines?: 0..5, maxResults?: 1..200 }], maxChars?: 500..8800 }` (1–20 queries; glob uses `*`/`{a,b}`, not `|`; read-only git only)
- **`apply_edits`**: `{ cwd?, edits: [{ path, hunks?: [{ target, replacement, startLine?, endLine?, replaceAll? }], create?: string, overwrite?: boolean }], dryRun?, bestEffort?, verify?: string, verifyTimeoutSec?, maxVerifyChars?: 300..7500 }` (1–50 files)
- **`read_slices`**: `{ cwd?, outlines?: string[], slices?: [{ path, ranges: [[startLine, endLine], ...] }], maxChars?: 1000..8800 }` (prefer 10–20 outlines/batch, max 40)
- **`run_checks`**: `{ cwd?, commands: [{ name?, command, cwd?, timeoutSec? }], concurrency?: 1..8, timeoutSec?, outputMode?: "compact"|"full", maxChars?: 500..8800 }` (1–12 commands)

### `ServerName: "agy-dart_context"` (hard-capped <=8.8 KB inline)
- **`ctx_execute`**: `{ language?: "javascript"|"nodejs"|"python"|"shell"|"powershell"|"cmd", code?, file?, args?: string[], intent? }`
- **`ctx_index`**: `{ path?, url?, content?, label? }`
- **`ctx_search`**: `{ queries: string[], sourceId?, scope?: "session"|"worktree"|"all", limit?: int, offset?: int }`
- **`ctx_resume`**: `{ seq?: int }` · **`ctx_stats`**: `{ reset?: boolean }` · **`ctx_doctor`**: `{}` · **`ctx_purge`**: `{ scope?: "session"|"worktree"|"all" }`
