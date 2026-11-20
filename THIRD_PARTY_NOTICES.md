# Third-Party Notices & Open-Source Attributions

`agy-dart` is built upon and inspired by the following open-source projects. All upstream copyright notices and license terms are preserved below.

---

## 1. INK-Q/agy-fast (MIT License)

- **Repository**: https://github.com/INK-Q/agy-fast
- **License**: MIT License
- **What is reused / adapted**:
  - Zero-dependency bundled ESM artifacts (`fast/mcp-server.mjs`, `fast/session-start.mjs`, `fast/benchmark.mjs`) implementing the 4 batched latency-acceleration tools (`batch_search`, `apply_edits`, `read_slices`, `run_checks`), workspace `SessionStart` snapshot generator, and offline transcript benchmark CLI.
  - Tool-routing latency hygiene principles (inline schemas, `<= 8.8 KB` UTF-8 MCP inline budget, parallel ranged `read_file` after outlining, multimodal >180k context TTFT isolation).

```text
MIT License

Copyright (c) 2026 agy-fast contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. Domush/antigravity-plugin-context-mode (MIT License)

- **Repository**: https://github.com/Domush/antigravity-plugin-context-mode
- **License**: MIT License
- **What is reused / adapted**:
  - Local-first `node:sqlite` WAL + FTS5 (Porter BM25 + Trigram RRF) storage engine (`context/lib/store.js`), sandboxed code executor (`context/lib/executor.js`), MCP tools (`context/lib/tools.js`, `context/server.js`), lifecycle `PreToolUse` protection logic (`hooks/pre-tool-use.mjs`), and Aux Pane Sidecar dashboard (`sidecars/dashboard/`).
  - Adapted in `agy-dart` with: `${PLUGIN_ROOT}` MCP paths, isolated `~/.agy-dart/context.db`, 16 KB / 410-line default balanced cutoff, `<= 8.8 KB` UTF-8 hard output cap, single-connection SQLite reuse inside `PreToolUse`, automatic exemption for agent instruction files (`SKILL.md`/`AGENTS.md`/`GEMINI.md`), and dynamic `sidecar_sdk` resolution.

```text
MIT License

Copyright (c) 2026 Phillip Webber

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 3. mksglu/context-mode (Architectural Inspiration Only — No Source Code Included)

- **Repository**: https://github.com/mksglu/context-mode
- **License**: Elastic License 2.0 (ELv2)
- **Relationship**: **`agy-dart` contains zero code from `mksglu/context-mode`.** We acknowledge and credit `mksglu/context-mode` for pioneering the "Thinking in Code" output-sandboxing paradigm, hybrid Porter BM25 + Trigram RRF indexing model, and the engineering insight of exempting agent-owned skill/rule files (`SKILL.md`, `AGENTS.md`, etc.) from `PreToolUse` file-size gates.
