# agy-dart Tool Routing, KV-Cache & Context Hygiene

`agy-dart` pairs **`agy-dart_fast`** (batched search/outlines/edits/checks) + **`agy-dart_context`** (sandbox filter & SQLite FTS5) with built-in **`read_file`** (~7ms local, 46 KB inline).

| Task | Tool | Why |
| :--- | :--- | :--- |
| Outline unknown large source (>300 lines; 10–20/batch) | `agy-dart_fast` → `read_slices({ outlines })` | Maps symbols in 1 call; then read <=200-line ranges in parallel `read_file` |
| Read small source (<16 KB) or known ranges | Built-in `read_file` (parallel, <=410 lines) | ~7ms local; unchanged duplicate reads auto-guarded (retry once to bypass) |
| >=2 text/regex/glob/read-only `git` queries | `agy-dart_fast` → `batch_search` (1 call) | Concurrent `rg`/Node execution, <=8.8 KB |
| >=2 hunks/files edit, or edit + verify | `agy-dart_fast` → `apply_edits` (`bestEffort` >=3 files) | Atomic commits + inline `verify` |
| >=2 concurrent checks (<=60s) | `agy-dart_fast` → `run_checks` | True pool; use `run_command` for >60s builds/tests or async (`WaitMsBeforeAsync <= 2000`) |
| >16 KB logs, giant JSON/CSV, or API dumps | `agy-dart_context` → `ctx_execute` | Sandbox filter; <=8.8 KB inline + FTS5 index |
| Repeat search over long docs, MD, or URLs | `agy-dart_context` → `ctx_index` + `ctx_search` | Heading MD chunks + BM25/Trigram RRF; `ctx_resume` after `/compact` |

## Rules
1. **Direct invocation (0 schema turns)**: Call `call_mcp_tool` (`ServerName: "agy-dart_fast"` or `"agy-dart_context"`) using schemas below; never read `mcp/agy-dart_*/*.json`.
2. **No blind dumps & long commands**: Never run bare `cat`/`Get-Content`/`type` or stdout `curl`/`wget`. Short `run_command` dev calls (`git`, tests, builds) are compacted <=8.8 KB (indexed in FTS5); >60s or async (`WaitMsBeforeAsync <= 2000`, `IsDaemon: true`) run natively via `run_command`.
3. **KV-Cache & TTFT hygiene**: Use `SessionStart` snapshot + Core hubs before `ls`/`git status`. Delegate screenshots/images in >150k-token sessions to a text-only subagent. Avoid re-reading unchanged files. Never pause mid-task to ask for `/compact`; keep long tasks continuous and call `ctx_resume` only after user compaction.
4. **One MCP call/turn & brief subagents**: Pack searches into one `batch_search`, edits + `verify` into one `apply_edits`, and tell subagents to use `agy-dart_fast` or ranged `read_file`.

## Inline Schemas (<=8.8 KB)
**`agy-dart_fast`**:
- `batch_search`: `{ cwd?, queries: [{ type: "text"|"regex"|"glob"|"git", pattern, path?, glob?, caseSensitive?, contextLines?: 0..5, maxResults?: 1..200 }], maxChars?: 500..8800 }`
- `apply_edits`: `{ cwd?, edits: [{ path, hunks?: [{ target, replacement, startLine?, endLine?, replaceAll? }], create?: string, overwrite?: boolean }], dryRun?, bestEffort?, verify?: string, verifyTimeoutSec?, maxVerifyChars?: 300..7500 }`
- `read_slices`: `{ cwd?, outlines?: string[], slices?: [{ path, ranges: [[startLine, endLine], ...] }], maxChars?: 1000..8800 }`
- `run_checks`: `{ cwd?, commands: [{ name?, command, cwd?, timeoutSec? }], concurrency?: 1..8, timeoutSec?, outputMode?: "compact"|"full", maxChars?: 500..8800 }`

**`agy-dart_context`**:
- `ctx_execute`: `{ cwd?, language?: "javascript"|"nodejs"|"python"|"shell"|"powershell"|"cmd", code?, file?, args?: string[], intent?, timeoutSec?: 1..300 }`
- `ctx_index`: `{ cwd?, path?, url?, content?, label? }` · `ctx_batch`: `{ cwd?, commands: string[], queries?: string[] }`
- `ctx_search`: `{ cwd?, queries: string[], sourceId?, scope?: "session"|"worktree"|"all", limit?: int, offset?: int }`
- `ctx_resume`: `{ seq?: int, sessionId?: string }` · `ctx_stats`: `{ reset?: boolean, sessionId?: string }` · `ctx_doctor`: `{ cwd? }` · `ctx_purge`: `{ cwd?, scope?: "session"|"worktree"|"all"|"stale", sessionId?: string, olderThanDays?: int, vacuum?: boolean }` *(pass Conversation ID as `sessionId` in shared hosts)*
