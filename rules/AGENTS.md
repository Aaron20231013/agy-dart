# agy-dart tool routing

Follow workspace and workflow routing first. After read-only discovery, if the workspace or `agy-cmd` calls for `/plan`, submit the plan and wait for approval before editing project files.

Use the startup snapshot for discovery. Call exposed tools or use `call_mcp_tool` with the server name below.

- `agy-dart_fast`: batch queries with `batch_search`. In `apply_edits` + `verify`, group independent hunks by path. Use `run_checks` for short checks, native `run_command` for >60s or async (`WaitMsBeforeAsync <= 2000`).
- For large source/patches, outline with `read_slices({ outlines })`, then read targeted `read_file` ranges (45 KiB/800 lines); for huge full-file reviews, prefer a read-only subagent covering contiguous ranges with evidence. Reuse unchanged reads. Give subagents the same routing.
- `agy-dart_context`: filter >16 KB logs, JSON, CSV or API output with `ctx_execute`; avoid whole-file shell/URL dumps. Use `ctx_index({path|url})` and `ctx_search({queries})` to locate passages in long docs/URLs.
- `ctx_execute`: `{ intent?, language?, code?, file?, args?, cwd?, timeoutSec?: 1..300 }`. Lead with a short intent. Keep code <=5 lines (~400 chars). For longer scripts pass `file` + `args` from `<Artifact Directory Path>/scratch/...` (`<appDataDir>/brain/<conversation-id>/scratch/...`) or an absolute OS temp path outside the repo.

Never pause mid-task for `/compact`. After user compaction call `ctx_resume`. On shared hosts pass the conversation ID as `sessionId`. Above 150k tokens, have a subagent inspect images and return text.
