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

## What's New in v1.2.0

1. **Sidecar Security Hardening & Unified Config (`~/.agy-dart/config.json`)**:
   - All mutating Sidecar endpoints (`/api/purge`, `/api/toggle-active`, `/api/cutoff`, `/api/exemptions`, `/api/maintenance`, `/api/cli-filter`, `/api/read-dedup`) are strictly `POST`-only with `Content-Type: application/json`, per-process `X-Agy-Dart-Token` CSRF validation, `Host`/`Origin`/`Sec-Fetch-Site` anti-DNS-rebinding guards, a `64 KB` request body cap, and XSS-safe DOM rendering.
   - Consolidated 20+ `AGY_DART_*` toggles into `~/.agy-dart/config.json` (with `AGY_DART_*` env vars always overriding); `doctor` and `ctx_doctor` print effective flags and override provenance.
2. **SmartCrusher, Expanded CLI Rules & Hardened Shell Guard**:
   - Reversible zero-dep JSON/JSONL structural compactor (`context/lib/json-crusher.js`) extracts schema, head/tail samples, and prioritized anomalies (`status >= 400`, `ok: false`, fatal/error rows) while indexing raw output into FTS5.
   - Added built-in CLI rules for `gh`, `kubectl`, `terraform`, and `playwright`, project-level declarative `.agy-dart/filters.json` (with ReDoS validator), safe `cd [/d] <path> && <cmd> [2>&1]` unwrapping, and stricter cmd/PowerShell metacharacter rejection (`%`, `!`, `{}`, `@`, non-git `^`).
3. **Opt-In Three-State Diff-Read Cache (Safe by Default)**:
   - Compact unified-diff re-reads on modified files are **OFF by default** (`diffRead: true` in `~/.agy-dart/config.json` or `AGY_DART_ENABLE_DIFF_READ=1` to opt in), scoped strictly to direct `conversationId` (zero parent↔subagent baseline leaks), bounded by recency (`diffReadMaxTurns` / `diffReadMaxAgeMs`), and carry baseline SHA/timestamp + 2-strike full-file bypass hints.
4. **KV-Cache Diagnostics, Policy Replay, Handoff Brief & Persistent L2 Caches**:
   - Added `npm run cache:audit` (global Prompt Cache audit), `npm run cache:simulate` (7-policy offline replay comparing 5m vs 1h TTL, cold-boundary compact, and cutoffs), Sidecar **Handoff Brief** + live 1s TTL countdown, 7-bucket `contextComposition` & `subagentBreakdown`, subagent Turn-0 stable-prefix sharing, persistent SQLite L2 `outline_cache`, per-feature ROI telemetry (`featureRoi`), and cross-Node 22/24 zero-`stderr` SQLite warning suppression.
5. **Modular Store & Lean Runtime Install**:
   - Split `context/lib/store.js` into focused `context/lib/store/` submodules and `context/lib/cache/profiles.js`; default `scripts/install.mjs install` copies **runtime files only** (pass `--with-devtools` to also copy offline benchmark/audit CLIs), verified automatically by `npm run verify:pkg`.

## What's New in v1.1.0

1. **Transparent CLI Output Filtering (`PreToolUse.overwrite`)**: Automatically wraps safe noisy dev commands (`git status/diff/log`, `npm/pnpm/yarn/node/pytest/cargo/go/dotnet` tests, `tsc/eslint/ruff/mypy/vite/cargo` builds, package installs, `docker build`) through zero-dependency `hooks/cli-filter.mjs` in **1 turn** (zero deny/retry overhead!), preserving exact exit codes, stripping ANSI/spinners, capping inline output `<= 8.8 KB`, and indexing raw output in SQLite FTS5.
2. **Server-Side KV-Cache Protection & Diagnostics**:
   - Deterministic prefix-stable `SessionStart` ordering (static routing line → semi-static Project/Layout + `git HEAD`-cached import hubs → volatile `git status` last) and slimmed canonical Turn-0 MCP tool schemas (`npm run prefix:budget` ~2,912 est. tokens).
   - Model-aware dynamic watermarks, idle TTL, and cost-discount estimation (`resolveModelProfile` across Claude / Gemini / GPT / DeepSeek / Qwen tiers, with env overrides) + **Doom-Loop / Oscillation Watch** (`edit↔fail` cycles & normalized tool-call repeat rate).
   - Zero-prefix-pollution `PreInvocation` hook using Antigravity's UI-only `metadata.user_markdown` (`systemMessage: ""`) for dynamic context watermark, hot-cache compact-delay, idle TTL expiry, multimodal TTFT cliff, and convergence alerts.
   - Deep `transcript.jsonl` cache-bust attribution, last-15-turns ASCII hit-rate trend, and Top-3 context-growth tool attribution in both `fast/benchmark.mjs cache` and the live Sidecar Dashboard (with mini hit-rate bar chart).
3. **2-Strike Session Read Deduplication, Bounded Slice Cache & Structured `ctx_resume` Checkpoint**:
   - Tracks `(session, file, range, mtime, size)` in SQLite to prevent redundant unchanged re-reads while automatically invalidating on edits or compaction (`ctx_resume`), and maintains a compact `sessionCheckpoint` ledger (modified files + latest test/build status) returned by `ctx_resume` with zero extra MCP tools.
   - Cross-call `(mtimeMs, size)` LRU caches in `agy-dart_fast` for both `read_slices({ outlines })` (128 entries) and `read_slices({ slices })` (bounded <= 4 MB total / <= 256 KB per file, actively invalidated by `apply_edits`).
4. **Security Hardening & DB Maintenance**:
   - SSRF-hardened `ctx_index(url)` (`http:`/`https:` whitelist, max 5 redirects with relative `Location` resolution, per-hop DNS & IPv4/IPv6 private/loopback/link-local blocking with DNS pinning), configurable secret redaction before indexing/return (`AGY_DART_DISABLE_SECRET_REDACTION=1` to opt out), and optional sensitive-file read guard (`AGY_DART_SENSITIVE_FILE_GUARD=warn|deny`).
   - Heading-aware Markdown chunking, SHA-256 content dedup, daily TTL pruning, `ctx_purge({ scope: "stale", vacuum: true })`, and one-click **Prune & Vacuum** in the Sidecar Dashboard.

---

## Credits & Open-Source Inspirations

`agy-dart` is 100% MIT-licensed with zero runtime npm dependencies (full upstream notices and compliance boundaries are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)):

| Project | License | What Was Reused / Inspired | What `agy-dart` Built / Improved |
| :--- | :---: | :--- | :--- |
| **[INK-Q/agy-fast](https://github.com/INK-Q/agy-fast)** | MIT | Reused 4-tool batching engine (`batch_search`, `apply_edits`, `read_slices`, `run_checks`), `SessionStart` snapshot, `<= 8.8 KB` no-spill rule, and `benchmark.mjs` | Bundled as `agy-dart_fast`, prefix-stabilized startup hook, extended `benchmark.mjs` with KV-cache bust attribution & `cache` CLI |
| **[Domush/antigravity-plugin-context-mode](https://github.com/Domush/antigravity-plugin-context-mode)** | MIT | Reused & adapted `node:sqlite` FTS5 engine, 8 `ctx_*` tools, `PreToolUse` guard, and Aux Pane Sidecar dashboard | `${PLUGIN_ROOT}` paths, isolated `~/.agy-dart/context.db`, 16 KB / 410-line cutoff, `<= 8.8 KB` cap, `SKILL.md` exemptions, heading-aware MD chunking, DB TTL/Vacuum, and live KV-cache card |
| **MIT Pattern References** (`mpecan/tokf`, `uuie/agent-cache-optimizer`, `rkolesnichenko/ccdrift`, `ooples/token-optimizer-mcp`, `tobi/qmd`, `DeusData/codebase-memory-mcp`, `tirth8205/code-review-graph`) | MIT | Clean-room pattern inspiration for declarative CLI filters, prefix stability, cache-bust attribution, read dedup, MD heading chunking, and `git HEAD`-cached import hubs | Pure zero-dep Node.js ESM implementation integrated natively with Antigravity `PreToolUse.overwrite`, `PostToolUse`, `PreInvocation`, and Sidecar |
| **Architectural Inspiration Only** (`mksglu/context-mode`, `rtk-ai/rtk`, `opencode-dynamic-context-pruning`, `huiliyi37/Tianshu-harness`) | Non-MIT / Apache-2.0 (**zero code included**) | High-level conceptual inspiration only (Thinking in Code, transparent CLI hook rewriting, duplicate-read awareness, versioned V8 compile cache, SHA-256 dedup, prefix budget audit, Ghost efficiency feedback, SessionWarmth compact-delay) | Strictly zero source code reused; 100% clean-room MIT implementation |

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
node scripts/install.mjs install --with-devtools             # also install offline audit/benchmark CLIs
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
# Run full test suite (integration, v1.1, v1.2, security hardening & property/fuzz tests)
npm test

# Verify static runtime import graph & zero devtools leakage
npm run verify:pkg

# Audit Turn-0 prefix budget, MCP schema determinism & token estimator calibration
npm run prefix:budget
node scripts/prefix-budget.mjs --calibrate

# Audit global Antigravity Prompt Cache hygiene & simulate 7 cache policies locally
npm run cache:audit -- --workspace . --no-live
npm run cache:simulate
```

## License

[MIT](LICENSE). Upstream MIT notices and compliance boundaries are preserved in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
