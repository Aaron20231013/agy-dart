# agy-dart tool routing

Use the startup snapshot before listing the workspace. Call tools directly when exposed, or use `call_mcp_tool` with the server name below. The agy-dart skill has optional arguments and examples.

- `agy-dart_fast`: batch queries with `batch_search`. In `apply_edits` + `verify`, group independent hunks by path. Use `run_checks` for short checks, native `run_command` for >60s or async (`WaitMsBeforeAsync <= 2000`).
- For unfamiliar large source or patches, outline with `read_slices({ outlines })`, then parallelize targeted `read_file` ranges (45 KiB/800 lines). Reuse unchanged reads. Give subagents the same routing.
- `agy-dart_context`: filter >16 KB logs, JSON, CSV or API output with `ctx_execute`. Avoid whole-file shell or URL dumps. Index long docs/URLs with `ctx_index({path})` or `ctx_index({url})`. Retrieve passages with `ctx_search({queries})`.
- `ctx_execute`: `{ intent?, language?, code?, file?, args?, cwd?, timeoutSec?: 1..300 }`. Lead with a short intent. Keep code <=5 lines (~400 chars). For longer scripts pass `file` + `args` from `<Artifact Directory Path>/scratch/...` (`<appDataDir>/brain/<conversation-id>/scratch/...`) or an absolute OS temp path outside the repo.

Never pause mid-task for `/compact`. After user compaction call `ctx_resume`. On shared hosts pass the conversation ID as `sessionId`. Above 150k tokens, have a subagent inspect images and return text.
