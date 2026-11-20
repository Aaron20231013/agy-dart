<div align="center">

<img src="assets/logo.svg" alt="agy-dart logo" width="80" />

# agy-dart

**All-in-One Latency Accelerator & Context-Window Guard Plugin for Google Antigravity**

Zero Runtime Dependencies · Dual-Engine Co-op · Hard `<= 8.8 KB` No-Spill Budget · Built-in Live Sidecar Dashboard · Optional Auto `rg` Setup

[简体中文](README.zh-CN.md) · English · [Third-Party Notices](THIRD_PARTY_NOTICES.md)

</div>

---

## Why `agy-dart`?

Long coding sessions in Google Antigravity (Desktop 2.0 / IDE / CLI) hit two compounding bottlenecks:
1. **Round-trip & check latency**: per-turn TTFT, split `edit_file` calls, serial shell searches, and Antigravity's ~10 KB MCP `output.txt` disk spill causing extra turns.
2. **Context bloat & agent amnesia**: multi-megabyte build logs, giant JSON/CSV payloads, and un-paged file dumps flooding the prompt.

Installing separate acceleration and context-guard plugins naively causes friction (over-eager 8 KB read blocks fighting local 7ms `read_file`, conflicting `AGENTS.md` routing rules, MCP previews spilling past 10 KB, and missing Sidecar assets from npm installs).

**`agy-dart`** fuses both capabilities into **one clean native Antigravity plugin** with unified zero-conflict routing, single-process lifecycle hooks, an isolated SQLite store (`~/.agy-dart/context.db`), and a live Aux Pane dashboard.

---

## Credits & Open-Source Inspirations

`agy-dart` stands on the shoulders of three open-source projects (full upstream licenses and boundaries are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)):

| Project | License | What Was Reused / Inspired | What `agy-dart` Improved |
| :--- | :---: | :--- | :--- |
| **[INK-Q/agy-fast](https://github.com/INK-Q/agy-fast)** | MIT | Reused its zero-dep 4-tool batching engine (`batch_search`, `apply_edits`, `read_slices`, `run_checks`), `SessionStart` workspace snapshot, `<= 8.8 KB` no-spill rule, multimodal TTFT hygiene, and offline `benchmark.mjs` | Bundled as `agy-dart_fast`, merged into a unified `SessionStart` hook (without upstream self-overwrite), and aligned under one arbitration rule file |
| **[Domush/antigravity-plugin-context-mode](https://github.com/Domush/antigravity-plugin-context-mode)** | MIT | Reused & adapted its zero-dep `node:sqlite` FTS5 (Porter BM25 + Trigram RRF) engine, 8 `ctx_*` tools, `PreToolUse` guard, and Aux Pane Sidecar dashboard | Bundled as `agy-dart_context` with `${PLUGIN_ROOT}` MCP paths, complete `sidecars/` copy, dynamic `sidecar_sdk` loading, single-connection SQLite reuse in hooks, **16 KB / 410-line** balanced default cutoff, **`<= 8.8 KB`** UTF-8 response cap, and isolated `~/.agy-dart/context.db` |
| **[mksglu/context-mode](https://github.com/mksglu/context-mode)** | Elastic-2.0 (**no code included**) | Architectural inspiration for "Thinking in Code" output sandboxing, hybrid Porter + Trigram RRF search, and v2's exemption of agent-owned skill/rule files | Conceptual inspiration only (zero source code reused); added automatic `PreToolUse` exemption for `SKILL.md` / `AGENTS.md` / `GEMINI.md` and builtin skill directories |

---

## Dual-Engine Routing Overview

| Workload | Designated Tool | Why |
| :--- | :--- | :--- |
| Multi-query code search / glob / read-only `git` | `agy-dart_fast` → `batch_search` | Up to 20 concurrent queries via `rg`/Node, `<= 8.8 KB` inline |
| Unknown large source files (>300 lines) | `agy-dart_fast` → `read_slices({ outlines })` + parallel `read_file` | Map symbols once, then read exact ranges with 7ms local allowlisted `read_file` |
| Small source files (<300 lines / <16 KB) | Built-in `read_file` (parallel) | 0 remote checks (~7ms), 46 KB/call inline, passes default 16 KB gate |
| Multi-hunk / multi-file edits + verify | `agy-dart_fast` → `apply_edits` | Atomic commits, `bestEffort`, inline `verify` saves full turns |
| Concurrent build / lint / test checks | `agy-dart_fast` → `run_checks` | True concurrency pool with noise stripping (never sequential `ctx_batch`) |
| **Large logs (>16 KB – MBs), giant JSON/CSV, API dumps** | `agy-dart_context` → `ctx_execute` | Run local Node/Python/Shell filter scripts; return only concise answers (`<= 8.8 KB`) |
| **Long docs, web URLs, or repeatedly queried logs** | `agy-dart_context` → `ctx_index` + `ctx_search` | Local SQLite FTS5 BM25 + Trigram RRF; use `ctx_resume` after `/compact` |

---

## Quick Install

Requires **Node.js >= 22** (uses built-in `node:sqlite`; **no `npm install` needed**).

### Windows (PowerShell)
```powershell
git clone https://github.com/zou172866/agy-dart.git
cd agy-dart

# Install with balanced 16 KB guard + live doctor check
.\install.ps1

# Recommended: also auto-install official ripgrep (rg.exe) to ~/.local/bin
.\install.ps1 -InstallRg
```

### macOS / Linux
```bash
git clone https://github.com/zou172866/agy-dart.git
cd agy-dart
./install.sh
```

### Cross-Platform CLI
```bash
node scripts/install.mjs install --mode balanced-16k
node scripts/install.mjs install --project /path/to/repo   # workspace-scoped
node scripts/install.mjs doctor
node scripts/install.mjs mode fast-32k                     # balanced-16k | fast-32k | strict-8k | no-read-hook
node scripts/install.mjs uninstall
```

### Let Antigravity Install It For You

Paste this prompt into Antigravity:

```text
Clone https://github.com/zou172866/agy-dart.git to a temp folder, run `node scripts/install.mjs install --mode balanced-16k` (add `--install-rg` on Windows if `rg` is missing), and confirm `doctor` passes.
```

Restart Antigravity (or reload window) and start a new conversation. If you previously installed standalone `agy-fast` or `antigravity-plugin-context-mode`, disable or remove them under **Customizations → Installed** to avoid duplicate MCP servers/hooks.

---

## Testing & Benchmarking

```bash
# Run end-to-end integration test suite
npm test

# Measure real-world round-trip & token-quota savings locally (offline)
node ~/.gemini/config/plugins/agy-dart/fast/benchmark.mjs analyze --local --recent 10
```

## License

[MIT](LICENSE). Upstream MIT notices are preserved in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
