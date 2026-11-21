# agy-dart Tool Routing, KV-Cache & Context Hygiene

`agy-dart` pairs **`agy-dart_fast`** (batched search/outlines/edits/checks) + **`agy-dart_context`** (sandboxed filtering & SQLite FTS5) with built-in **`read_file`** (~7ms local allowlist, 46 KB inline).

| Task | Tool | Why |
| :--- | :--- | :--- |
| Outline unknown large source (>300 lines; 10–20/batch) | `agy-dart_fast` → `read_slices({ outlines })` | Maps symbols in 1 call; then read <=200-line ranges in parallel `read_file` |
| Read small source (<16 KB) or known ranges | Built-in `read_file` (parallel, <=410 lines) | ~7ms local allowlist; unchanged duplicate reads auto-guarded (retry once to bypass) |
| >=2 text/regex/glob/read-only `git` queries | `agy-dart_fast` → `batch_search` (1 call) | Concurrent `rg`/Node execution, <=8.8 KB |
| >=2 hunks/files edit, or edit + verify | `agy-dart_fast` → `apply_edits` (`bestEffort` >=3 files) | Atomic commits + inline `verify` |
| >=2 concurrent build/lint/test/diag commands | `agy-dart_fast` → `run_checks` | True concurrent pool (never `ctx_batch` for builds/tests) |
| >16 KB logs, giant JSON/CSV, or raw API dumps | `agy-dart_context` → `ctx_execute` | Local sandbox filter; <=8.8 KB inline + full FTS5 index |
| Repeat search over long docs, Markdown, or URLs | `agy-dart_context` → `ctx_index` + `ctx_search` | Heading-aware MD chunking + BM25/Trigram RRF; `ctx_resume` after `/compact` |

## Rules
1. **Direct invocation (0 schema turns)**: Call `call_mcp_tool` directly (`ServerName: "agy-dart_fast"` or `"agy-dart_context"`) using schemas below; never read `mcp/agy-dart_*/*.json`.
2. **No blind dumps**: Never run bare `cat`/`Get-Content`/`type` or stdout `curl`/`wget`. Single `run_command` dev commands (`git`, tests, builds) are transparently compacted <=8.8 KB (raw output indexed in FTS5).
3. **KV-Cache & TTFT hygiene**: Use the `SessionStart` snapshot + Core hubs before `ls`/`git status`. Keep screenshots/images out of >150k-token sessions (delegate to a text-only subagent). Avoid re-reading unchanged files already in context. Avoid premature `/compact` while prompt cache is hot; compact at cold/phase boundaries then call `ctx_resume`.
4. **Pack into ONE MCP call/turn & brief subagents**: Combine cross-dir searches into one `batch_search`, multi-file edits + `verify` into one `apply_edits`, and tell subagents to use `agy-dart_fast` or ranged `read_file`.

## Inline Schemas (hard-capped <=8.8 KB)
**`agy-dart_fast`**:
- `batch_search`: `{ cwd?, queries: [{ type: "text"|"regex"|"glob"|"git", pattern, path?, glob?, caseSensitive?, contextLines?: 0..5, maxResults?: 1..200 }], maxChars?: 500..8800 }`
- `apply_edits`: `{ cwd?, edits: [{ path, hunks?: [{ target, replacement, startLine?, endLine?, replaceAll? }], create?: string, overwrite?: boolean }], dryRun?, bestEffort?, verify?: string, verifyTimeoutSec?, maxVerifyChars?: 300..7500 }`
- `read_slices`: `{ cwd?, outlines?: string[], slices?: [{ path, ranges: [[startLine, endLine], ...] }], maxChars?: 1000..8800 }`
- `run_checks`: `{ cwd?, commands: [{ name?, command, cwd?, timeoutSec? }], concurrency?: 1..8, timeoutSec?, outputMode?: "compact"|"full", maxChars?: 500..8800 }`

**`agy-dart_context`**:
- `ctx_execute`: `{ language?: "javascript"|"nodejs"|"python"|"shell"|"powershell"|"cmd", code?, file?, args?: string[], intent? }`
- `ctx_index`: `{ path?, url?, content?, label? }`
- `ctx_search`: `{ queries: string[], sourceId?, scope?: "session"|"worktree"|"all", limit?: int, offset?: int }`
- `ctx_resume`: `{ seq?: int, sessionId?: string }` · `ctx_stats`: `{ reset?: boolean, sessionId?: string }` · `ctx_doctor`: `{}` · `ctx_purge`: `{ scope?: "session"|"worktree"|"all"|"stale", sessionId?: string, olderThanDays?: int, vacuum?: boolean }` *(pass current Conversation ID as `sessionId` in shared MCP hosts)*
