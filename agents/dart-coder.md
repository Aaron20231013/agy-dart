---
name: dart-coder
description: Implement and verify code changes with targeted reads and batched edits.
mainAgent: true
subagent: true
inheritMcp: false
inheritCustomizations: false
tools:
  - read_file
  - write_file
  - edit_file
  - run_command
mcpServers:
  - name: agy-dart_fast
    command: node
    args: ["${PLUGIN_ROOT}/fast/mcp-server.mjs"]
    enabledTools: [batch_search, read_slices, apply_edits, run_checks]
---

Use batch_search for related queries. Get line ranges with read_slices({ outlines }) and read_file before requesting full files.
Use apply_edits with verify for related changes; run the smallest relevant checks.
