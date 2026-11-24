# agy-dart Error & Troubleshooting Playbook

Read this file on demand when hitting a guard block, edit rollback, rejected project filter rule, KV-cache hit drop, or platform/timeout error.

## Quick Triage Matrix

| Symptom / Error | Likely Cause | First Recovery Action |
| --- | --- | --- |
| `read_file` / `view_file` blocked by Read Guard | Un-ranged read exceeded tier cap (`45 KiB` / `800 lines` source, `128 KiB` patch, `16 KB` noisy/minified) or matched `readDedup` | Use the returned inline outline line numbers with `read_file(StartLine, EndLine)` or `agy-dart_fast` `read_slices`; for logs/data use `ctx_index` or `ctx_execute` |
| `ctx_doctor` / `doctor` shows rejected `.agy-dart/filters.json` rules | Invalid schema/ID, file `> 64 KB` / `> 20` rules, or regex rejected by `isSafeRegex` (ReDoS guard) | Inspect exact rejection reason via `ctx_doctor`; simplify regex to linear-time pattern using `examples/filters.json` |
| `apply_edits` aborted (`0 files modified`) or rolled back | Stale/mismatched `target`, ambiguous multi-line match, or write error | Re-read exact target slice (`read_slices`), pass `startLine`/`endLine` or wider anchor lines, preview with `dryRun: true` |
| KV-cache hit rate drops or Turn-0 prefix grows | Bloated rules/skill frontmatter, non-deterministic MCP `tools/list`, conflicting legacy plugin, or dynamic `systemMessage` hook | Run `npm run cache:audit -- --workspace . --no-live` and `node bin/agy-dart.mjs audit skills --workspace .` |
| Slow search, Windows encoding garble, or `run_checks` timeout | Missing `rg`, complex shell quoting, or `> 60s` job run inside `run_checks` | Install `rg` (`--install-rg`), use `ctx_execute` script file for heavy parsing, route `> 60s`/daemon jobs to native `run_command` (`WaitMsBeforeAsync <= 2000`) |

---

## 1. Read Guard Blocks & Duplicate-Read Protection

### How tiered read limits work
- **Source code**: up to `45 KiB` / `800` lines direct read by default (`host-45k`).
- **Patches / diffs (`.patch`, `.diff`)**: up to `128 KiB` direct read (`reviewMaxReadBytes`); paginated continuation via `ByteOffset` passes through in soft mode.
- **Noisy / minified files** (logs, large JSON, lockfiles, minified bundles): capped at `16 KB` (`noiseMaxReadBytes`).

### Recovery steps
1. **Use the inline outline first**: On the first blocked un-ranged read (for files `<= 512 KiB`, `inlineOutlineMaxBytes`), `agy-dart` returns a compact outline with line numbers. Follow up immediately with ranged `read_file({ Path, StartLine, EndLine })` or `agy-dart_fast` `read_slices({ slices: [{ path, ranges: [[start, end]] }] })`.
2. **Batch outlines for unfamiliar files**: Call `read_slices({ outlines: ["path/a.js", "path/b.js"] })` before opening targeted ranges.
3. **Soft mode 2-strike retry**: Default `readGuardMode` is `"soft"`. Repeating the exact same read once passes through intentionally when a full read is genuinely required. In `"strict"` mode, hard denials stay enforced.
4. **Logs, CSVs, and large JSON**: Do not retry full reads on `> 16 KB` data/log files. Use `agy-dart_context` `ctx_execute` (filter locally to `<= 8.8 KB`) or `ctx_index` + `ctx_search`.
5. **Adjust preset mode or exemptions**:
   - Preset CLI modes: `node scripts/install.mjs mode <host-45k|fast-32k|balanced-16k|strict-8k|no-read-hook>`.
   - Fine-grained overrides in `~/.agy-dart/config.json`: `readGuardMode` (`"soft" | "strict" | "off"`), `maxReadBytes`, `exemptExtensions`, `exemptPaths`, `readDedup`. Note: `exemptPaths` and `readGuardMode: "off"` bypass size guards only; unchanged-file `readDedup` resets automatically after edits or `/compact`.

---

## 2. `.agy-dart/filters.json` Rejected Rules & `ctx_doctor` Warnings

Project-specific CLI output filters live in `<workspace>/.agy-dart/filters.json` and fail open on errors so commands never break. Check status with `ctx_doctor` or `node scripts/install.mjs doctor`.

### File-level errors
- `not_a_file` / `empty_file`: Path is not a regular non-empty file.
- `file_too_large`: File exceeds `64 KB` (`MAX_PROJECT_RULES_FILE_BYTES`). Keep only active build/test rules.
- `invalid_json` / `invalid_schema`: Fix JSON syntax and ensure a top-level `{ "rules": [ ... ] }` array.
- `too_many_rules`: Exceeds `20` rules (`MAX_PROJECT_RULES_COUNT`). Merge related command matchers.

### Rule-level rejection reasons
- `invalid_id` / `duplicate_id`: Every `id` must be unique and match `/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/`.
- `missing_match` / `invalid_keep` / `invalid_drop`: `match` is required and must be a string; optional `keep` / `drop` must be strings.
- `unsafe_or_invalid_regex` / `invalid_regex`: `hooks/filter-rules.mjs` validates every regex with `isSafeRegex()` to prevent catastrophic backtracking (ReDoS). It rejects nested quantifiers (e.g., `(a+)+`), overlapping quantified alternations (e.g., `(a|aa)+`), backreferences (`\1`), oversized `{min,max}` bounds (`min > 100` or `max > 200`), or invalid syntax.
  - **Fix**: Replace nested or wildcard quantifiers with anchored literal prefixes, character classes (e.g., `[a-z0-9._-]+`), or simple non-overlapping alternations.
  - **Reference**: Copy and adapt a validated starter template from `examples/filters.json`.
- **Failure safety**: On non-zero exit codes, stderr and error-anchor lines are preserved automatically (`preserveTailOnFail: true` by default) so custom `drop` rules do not hide crash diagnostics.
- **Precedence**: Built-in rules (`git`, `npm`/`vitest`/`pytest`/`go`/`cargo`/`dotnet`, `tsc`/`eslint`/`vite build`/`webpack`, `docker build`, `gh`, `kubectl`, `terraform`, `playwright`) run **before** `.agy-dart/filters.json`. Use `.agy-dart/filters.json` for project-specific CLIs not already covered by built-in rules.

---

## 3. `apply_edits` Rollback, Abort & Target Mismatch

`agy-dart_fast` `apply_edits` validates all hunks before writing and rolls back written files automatically if a write error occurs.

### Common errors & fixes
1. **`target text not found`**:
   - Re-read the target region with `read_slices({ lineRanges: ["path:start-end"] })` or ranged `read_file`.
   - Check indentation (tabs vs spaces), trailing whitespace, or prior edits that already changed the block.
   - Verify `cwd` points to the intended workspace (calls landing inside the installed plugin directory are blocked).
2. **`target matched N times (lines: ...)`**:
   - Add `startLine` and `endLine` to the hunk, expand surrounding unique context lines in `target`, or set `replaceAll: true` if every occurrence should be replaced.
3. **Safe multi-file workflow**:
   - Group multiple hunks for the same file under a single entry in `edits`.
   - Use `dryRun: true` to verify all hunks across files with zero writes.
   - Pass `verify` to run a post-write check in the same step.
   - Set `bestEffort: true` only when partial per-file commits are explicitly acceptable.

---

## 4. KV-Cache Hit Drops & Turn-0 Prefix Bloat

### Diagnostic commands
- Full offline environment audit: `npm run cache:audit -- --workspace . --no-live` (omit `--no-live` to also probe configured stdio MCP servers twice for deterministic `tools/list` ordering).
- Fast Skills-only audit: `node bin/agy-dart.mjs audit skills --workspace .` (flags `missing_skill_frontmatter`, `oversized_skill_frontmatter > 250 tok`, `oversized_skill_body > 3000 tok`, `excessive_skills_frontmatter > 2000 tok`, and `legacy_skill_path`).
- Plugin budget & MCP schema fingerprint gate: `npm run prefix:budget`.
- Session replay & keepalive cost check: `npm run cache:simulate`.

### Common root causes & fixes
- **Bloated Turn-0 prefix**: Move bulky docs out of always-loaded `rules/` into on-demand `SKILL.md` bodies, compress verbose skill YAML `description` fields, and split long `SKILL.md` files into `references/` and `examples/`.
- **Conflicting legacy plugins**: Disable standalone `agy-fast` or `antigravity-plugin-context-mode` when `agy-dart` is installed.
- **After `/compact`**: Call `ctx_resume({})` (passing `sessionId` on shared hosts) to restore recent FTS5 source IDs and session checkpoints without re-reading large files.
- **`stablePrefixOnly` vs keepalive**:
  - Enable `stablePrefixOnly: true` in `~/.agy-dart/config.json` to strip volatile Git status lines from `SessionStart` for higher cross-session prefix stability.
  - Automatic cache keepalive (`ttlKeepalive`) is **off by default** and opt-in per window in the **agy-dart Context** panel (each keepalive consumes model input; use only when intentionally preserving a warm large prompt across short idle gaps).

---

## 5. Windows / PowerShell Encoding, Missing `rg` & Long-Task Timeouts

- **Missing `rg` (ripgrep)**: `batch_search` works via a Node.js fallback, but installing `rg` significantly speeds up large repositories.
  - Windows x64: `node scripts/install.mjs install --install-rg` (or `.\install.ps1 -InstallRg`) installs official `rg.exe` into `~/.local/bin`.
  - macOS / Linux: `brew install ripgrep` or `apt install ripgrep`.
- **Windows / PowerShell quoting & UTF-8**:
  - Inline `ctx_execute` code should stay `<= 5` lines (`~400` chars). For multi-line log/JSONL processing or tricky shell escaping, write a script to `<Artifact Directory Path>/scratch/` (or an OS temp directory outside the repo on non-Antigravity hosts) and call `ctx_execute({ language: "python", file, args })`. See `examples/ctx_trace_summary.py`.
  - Commands with unsafe shell metacharacters (`%`, `!`, etc.) fail open past `cli-filter` automatically.
- **Long tasks & daemons (`run_checks` vs `run_command`)**:
  - Use `agy-dart_fast` `run_checks` for short foreground checks (`<= 60s`).
  - For builds, full integration suites (`> 60s`), watchers, or dev servers, use native `run_command` with `WaitMsBeforeAsync <= 2000` (plus `IsDaemon: true` for servers) and monitor with `manage_task`. Commands with `WaitMsBeforeAsync <= 2000` bypass foreground CLI filtering (`cliFilterAsyncBypassMs: 2000`).
