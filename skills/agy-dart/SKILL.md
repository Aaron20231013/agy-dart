---
name: agy-dart
description: Batch code work, filter logs, search indexed docs and diagnose context or cache usage.
---

# agy-dart

## Search, read, edit and verify

Call exposed tools directly. In Antigravity's `call_mcp_tool`, set `ServerName` to `agy-dart_fast` for these operations.

| Tool | Arguments for common tasks |
| --- | --- |
| `batch_search` | Pass `queries` with `type` (`text`, `regex`, `glob`, `fuzzy` path or read-only `git`) and `pattern`. For text/regex, use `outputMode` (`content`, `files_with_matches` or `count`) and optional `multiline`. Counts are matching lines or, in multiline mode, occurrences. Use `fileType` on text/regex/fuzzy, and `sortBy: "mtime"` for newest-first globs. Limit scope with `path`, `glob`, `contextLines` or `maxResults`. |
| `read_slices` | Pass `outlines` for symbols or patch hunks, preferably 10–20 files per batch. For 1-based inclusive ranges use `slices: [{path, ranges: [[start, end]]}]` or `lineRanges: ["file:start-end"]`. |
| `apply_edits` | Pass `edits: [{path, hunks: [{target, replacement}]}]` or use `create` for a new file. Use `dryRun` to preview and `verify` to check after writing. Use `bestEffort` only when committing valid files independently is acceptable. |
| `run_checks` | Pass `commands: [{name, command}]`, with optional per-command `cwd` and `timeoutSec`. For long builds or async jobs (`WaitMsBeforeAsync <= 2000`, `IsDaemon: true`), use native `run_command` and monitor with `manage_task`. |

Use `cwd` to select the workspace. The default read guard allows 45 KiB for source, 128 KiB for patches and 16 KB for noisy or minified files. Soft mode offers a one-time retry. Prefer ranged reads for larger files.

## Filter large output

On `agy-dart_context`, call `ctx_execute` with a short `intent` first. For inline scripts up to five lines (~400 characters), pass `code` and `language` (JavaScript/Node.js, Python, shell, PowerShell or cmd). JavaScript accepts CommonJS and top-level ESM imports. Set `cwd` and `timeoutSec` as needed (1–300 seconds, default 120).

For longer scripts, use `write_file` with `<Artifact Directory Path>/scratch/agy_ctx_trace.py` (`<appDataDir>/brain/<conversation-id>/scratch/agy_ctx_trace.py` in Antigravity). On other hosts use a resolved absolute OS temp path outside the repo, such as `"file": "/tmp/agy_ctx_trace.py"` or the user's Windows temp directory. Pass the saved file to `ctx_execute`.

```json
{
  "intent": "Analyze slow queries in trace.json",
  "language": "python",
  "file": "/home/<user>/.gemini/antigravity/brain/<conversation-id>/scratch/agy_ctx_trace.py",
  "args": ["trace.json"]
}
```

Return only the computed counts, examples or error lines needed. Supported foreground shell commands are filtered to 8.8 KB inline with original exit codes and searchable redacted output. Project filters live in `.agy-dart/filters.json`.

## Indexed retrieval and recovery

Index Markdown or URLs once with `ctx_index({path, label})` or `ctx_index({url, label})`. For repeated questions use `ctx_search({queries, sourceId, limit, offset})`. Use `ctx_batch({commands, queries})` to search a group of command results. After user compaction, `ctx_resume({})` restores recent source IDs and the last checkpoint. On shared hosts pass the conversation ID as `sessionId` to resume, statistics or purge operations.

## Diagnostics

Open the **agy-dart Context** panel for prompt cache hits, context usage and handoff. Use `ctx_stats` for savings and `ctx_doctor` for effective settings. Configure read guards and optional diff reads in `~/.agy-dart/config.json`. Environment variables override the file. To prune old records use `ctx_purge({scope: "stale", olderThanDays: 14, vacuum: true})`.

From the source checkout run `npm run prefix:budget`, `npm run cache:audit -- --workspace . --no-live` or `npm run cache:simulate`. Offline tools are also available when installed with `--with-devtools`.
