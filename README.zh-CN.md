<div align="center">

<img src="assets/logo.svg" alt="agy-dart logo" width="80" />

# agy-dart

**面向 Google Antigravity 的一体化「极速批处理 + 上下文护栏」原生插件**

零运行期依赖 · 双引擎零冲突协作 · 死守 ≤ 8.8 KB 零溢盘 · 内置实时 Sidecar 面板 · 支持一键补装 `rg`

简体中文 · [English](README.md) · [第三方开源致谢与许可](THIRD_PARTY_NOTICES.md)

</div>

---

## 为什么做 `agy-dart`

在 Google Antigravity（Desktop 2.0 / IDE / CLI）的高强度编码会话中，慢和贵通常同时来自两类问题：
1. **轮次与审查开销**：单轮固定首字等待（TTFT）、重复拆分的 `edit_file` 与串行 Shell 搜索触发高频远端校验，以及 MCP 超 10 KB 输出落盘 `output.txt` 带来的二次读取。
2. **上下文膨胀与失忆**：动辄几十 KB 到数 MB 的构建日志、JSON/CSV 数据集或超长文档被直接整段塞进对话，拉高 TTFT 并挤爆上下文窗口。

如果把现有的加速插件与上下文护栏插件直接堆叠安装，容易出现 **8 KB 过严拦截反噬 `read_file` 7ms 本地白名单**、**两份 `AGENTS.md` 互相抢工具**、**`ctx_execute` 返回超 10 KB 触发落盘**、**`npx` 安装丢掉 Sidecar 面板** 等冲突。

**`agy-dart`** 将两者深度整合为 **1 个原生 Antigravity 插件**：一套零冲突路由规则、一套单进程合并钩子、一套可一键切换阈值的实时仪表盘，开箱即用。

---

## v1.2.0 核心新增能力

1. **Sidecar 安全加固与统一配置（`~/.agy-dart/config.json`）**：
   - Sidecar 所有写接口（`/api/purge`、`/api/toggle-active`、`/api/cutoff`、`/api/exemptions`、`/api/maintenance`、`/api/cli-filter`、`/api/read-dedup`）强制仅允许 `POST` + `Content-Type: application/json` + 进程级随机 `X-Agy-Dart-Token` CSRF 校验，全站强制 `Host`/`Origin`/`Sec-Fetch-Site` 防 DNS Rebinding 与跨站拦截、请求体上限 `64 KB`，并加固自定义扩展名 XSS 转义。
   - 将 20+ 项 `AGY_DART_*` 环境变量收敛至 `~/.agy-dart/config.json`（环境变量始终优先覆盖），`doctor` 与 `ctx_doctor` 直接输出当前生效配置及覆盖来源。
2. **SmartCrusher 结构化 JSON 粉碎、扩展 CLI 规则与跨 Shell 语法护栏**：
   - 新增零依赖可逆 JSON/JSONL 粉碎器（`context/lib/json-crusher.js`），自动提取大数组 Schema、首尾样本与异常项（`status >= 400`、`ok: false`、错误/空值异常），原文同步入库 FTS5。
   - 新增 `gh`、`kubectl`、`terraform`、`playwright` 规则、项目级 `.agy-dart/filters.json` 声明式过滤（带 ReDoS 校验）、安全 `cd [/d] <path> && <cmd> [2>&1]` 拆解，并拦截 cmd/PowerShell 易引起语义漂移的元字符（`%`、`!`、`{}`、`@`、非 git `^`）。
3. **三态增量 Diff 读缓存（默认关闭、按需开启）**：
   - 修改后仅返 Unified Diff 默认关闭（通过 `~/.agy-dart/config.json` 的 `diffRead: true` 或 `AGY_DART_ENABLE_DIFF_READ=1` 手动开启）；开启后严格按直接 `conversationId` 隔离（杜绝父子 Agent 串底稿）并受最近轮次与时间窗口新鲜度约束，头部标明基线版本并提供 2-strike 重读全文旁路。
4. **KV-Cache 审计/策略回放、Handoff 交接卡与持久化 L2 缓存**：
   - 新增 `npm run cache:audit` 全域缓存体检、`npm run cache:simulate` 7 套缓存策略离线回放、Sidecar 一键 **Handoff Brief** 与 1s 本地 TTL 倒计时、7 桶 `contextComposition` 与 `subagentBreakdown`、子 Agent 自动共享稳定 Turn-0 前缀、SQLite L2 `outline_cache` 持久化、按功能维度量化的 `featureRoi` 遥测，以及跨 Node 22/24 的 SQLite 零 `stderr` 告警拦截。
5. **存储模块化与运行时/开发工具分离安装**：
   - 将 `context/lib/store.js` 拆分为 `context/lib/store/` 5 个职责子模块与 `context/lib/cache/profiles.js`；默认 `install` 仅拷贝运行时文件（加 `--with-devtools` 同步安装离线审计与压测 CLI），并由 `npm run verify:pkg` 静态校验完整 Import 图。

## v1.1.0 核心新增能力

1. **透明 CLI 输出过滤（`PreToolUse.overwrite`）**：对常见高噪单条开发命令（`git status/diff/log`、`npm/pnpm/yarn/node/pytest/cargo/go/dotnet` 测试、`tsc/eslint/ruff/mypy/vite/cargo` 构建、`npm/pip install`、`docker build`）通过零依赖 `hooks/cli-filter.mjs` 在 **1 轮内透明降噪**（免去拦截重试多一轮），严格保留原始退出码、剥离 ANSI 与进度条、强制输出 `<= 8.8 KB`，并将原始大输出自动落库 FTS5 可查。
2. **服务端 KV-Cache / Prompt Cache 保护与诊断**：
   - 确定性前缀稳定 `SessionStart` 排布（静态路由头 → 半静态项目/目录结构 + `git HEAD` 缓存的核心导入枢纽 → 易变 `git status` 置尾）+ 瘦身冻结 Turn-0 MCP Schema（`npm run prefix:budget` 常驻约 ~2,912 tok）。
   - **模型感知动态水位 / TTL / 缓存折扣**（自动匹配 Claude / Gemini / GPT / DeepSeek / Qwen 档位并保留环境变量覆写）+ **收敛与死循环监控**（追踪近期工具指纹重复率与 `edit↔fail` 震荡计数）。
   - 零前缀污染 `PreInvocation` 钩子：利用 Antigravity 原生纯 UI 提示 `metadata.user_markdown`（`systemMessage: ""` 零 token 注入），在动态水位、热缓存延迟压缩、空闲 TTL 过期、高上下文多模态风险及死循环震荡时仅向用户预警。
   - `fast/benchmark.mjs cache` 与 Sidecar 实时面板支持失效归因、最近 15 轮 ASCII 命中率趋势条 / 微型柱状图与单步上下文增量 Top-3 工具归因。
3. **会话级读去重、有界切片缓存与结构化 `ctx_resume` 恢复卡**：
   - SQLite 追踪 `(session, file, range, mtime, size)` 拦截重复未变更读取并在编辑/压缩时自动失效；`PostToolUse` 与 `cli-filter` 轻量记录已改文件与最近一次测试/构建状态，`ctx_resume` 零新增工具返回紧凑 `sessionCheckpoint` 恢复卡。
   - `agy-dart_fast` 的 `read_slices` 同时支持符号大纲 LRU（128 条）与文本行跨调用缓存（总计 ≤ 4 MB、单文件 ≤ 256 KB，`apply_edits` 写入后主动失效）。
4. **安全补强与数据库 TTL/Vacuum 维护**：
   - `ctx_index(url)` 补齐 SSRF 防护（仅 `http:`/`https:`、最多 5 跳相对重定向、逐跳 DNS 私网/回环/链路本地 IP 拦截与 DNS pinning），落库/回传前默认执行轻量密钥正则脱敏（可用 `AGY_DART_DISABLE_SECRET_REDACTION=1` 关闭），并支持可选敏感文件读取提醒（`AGY_DART_SENSITIVE_FILE_GUARD=warn|deny`）。
   - Markdown 标题感知分块、SHA-256 内容去重、每日轻量 TTL 清理、`ctx_purge({ scope: "stale", vacuum: true })` 与 Sidecar 一键 **Prune & Vacuum**。

---

## 设计来源与开源致谢（Credits & Inspirations）

本项目严格遵循 **MIT 协议** 与 **零运行期 npm 依赖**，所有复用声明与合规红线详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)：

| 项目 | 协议 | 借鉴 / 复用内容 | `agy-dart` 的融合与净室实现 |
| :--- | :---: | :--- | :--- |
| **[INK-Q/agy-fast](https://github.com/INK-Q/agy-fast)** | MIT | 复用 4 工具批处理引擎、`SessionStart` 快照、`<=8.8 KB` 规范与 `benchmark.mjs` | 封装为 `agy-dart_fast`，升级前缀稳定启动钩子，并为 `benchmark.mjs` 扩展 KV-Cache 失效归因与 `cache` 子命令 |
| **[Domush/antigravity-plugin-context-mode](https://github.com/Domush/antigravity-plugin-context-mode)** | MIT | 复用并改造 `node:sqlite` FTS5 引擎、8 个 `ctx_*` 工具、`PreToolUse` 护栏与 Sidecar 面板 | 修复 `${PLUGIN_ROOT}`、16 KB/410 行阈值、`<=8.8 KB` 封顶、`SKILL.md` 白名单、Markdown 标题感知分块、DB TTL/Vacuum 与 KV-Cache 实时面板 |
| **MIT 模式参考**（`mpecan/tokf`、`uuie/agent-cache-optimizer`、`rkolesnichenko/ccdrift`、`ooples/token-optimizer-mcp`、`tobi/qmd`、`DeusData/codebase-memory-mcp`、`tirth8205/code-review-graph`） | MIT | 借鉴声明式 CLI 过滤、前缀稳定性、缓存归因、读去重、Markdown 标题分块与 `git HEAD` 缓存依赖枢纽模式 | 纯零依赖 Node.js ESM 净室实现，原生融合 Antigravity 四大钩子与 Sidecar |
| **仅架构思想借鉴**（`mksglu/context-mode`、`rtk-ai/rtk`、`opencode-dynamic-context-pruning`、`huiliyi37/Tianshu-harness`） | 非 MIT / Apache-2.0（**零源码引入**） | 仅参考高层次架构范式（沙盒过滤、透明钩子改写、会话去重、版本化 V8 编译缓存、SHA-256 内容去重、前缀预算审计、Ghost 拦截效率反馈、热缓存延迟压缩） | **严守红线，未引入任何一行源码**，全部自主 MIT 净室实现 |

---

## 双引擎分工架构（零冲突）

| 任务类型 | 唯一指定工具 | 优势 |
| :--- | :--- | :--- |
| 代码文本 / 正则 / Glob / 只读 Git 查询 | `agy-dart_fast` → `batch_search` | 1 次调用并发最多 20 条查询，走 `rg` 毫秒级，≤ 8.8 KB 零溢盘 |
| 未知大源码文件（>300 行） | `agy-dart_fast` → `read_slices({ outlines })` + 并行内置 `read_file` | 先 1 次拿全文件符号行号，再用本地 7ms 白名单 `read_file` 精确读分段 |
| 中小源码文件（<300 行 / <16 KB） | 内置 `read_file`（同轮并行） | 0 远端审查（~7ms）、46 KB/call 内联，16 KB 默认阈值直接放行 |
| 多处 / 跨文件代码编辑 + 验证 | `agy-dart_fast` → `apply_edits` | 原子提交、`bestEffort` 防整批回滚、内联 `verify` 省一轮 |
| 并发构建 / Lint / 单元测试 | `agy-dart_fast` → `run_checks` | 真并发池 + 自动降噪（不用串行的 `ctx_batch`） |
| **分析超大日志（>16 KB ~ 数十 MB）** | `agy-dart_context` → `ctx_execute` | 本地 Node/Python/Shell 沙盒脚本聚合过滤，仅返回精简结论（≤ 8.8 KB） |
| **处理巨型 JSON / CSV / API 响应** | `agy-dart_context` → `ctx_execute` | 在沙盒里做统计与提取，原始大载荷绝不进对话 |
| **反复检索超长文档 / 网页 / 归档日志** | `agy-dart_context` → `ctx_index` + `ctx_search` | 本地 SQLite FTS5（Porter BM25 + Trigram RRF）毫秒级召回，压缩后可用 `ctx_resume` 找回 |

---

## 快速安装

环境要求：**Node.js >= 22**（使用内置 `node:sqlite`，**无需 `npm install`**）。

### Windows（PowerShell）

```powershell
git clone https://github.com/zou172866/agy-dart.git
cd agy-dart

# 默认安装（方案 A：16 KB / 410 行均衡护栏 + 自动健康自检）
.\install.ps1

# 推荐：安装插件并自动补装官方 ripgrep (rg.exe) 到 ~/.local/bin 并加入 PATH
.\install.ps1 -InstallRg
```

### macOS / Linux

```bash
git clone https://github.com/zou172866/agy-dart.git
cd agy-dart
./install.sh

# 可选安装 ripgrep 释放极速检索
brew install ripgrep   # macOS
```

### 通用 Node.js 命令（全平台 / 支持项目级安装）

```bash
# 全局安装到 ~/.gemini/config/plugins/agy-dart（默认仅安装运行时）
node scripts/install.mjs install --mode balanced-16k

# 同时安装离线审计 / 压测 / 策略回放等开发工具 CLI
node scripts/install.mjs install --mode balanced-16k --with-devtools

# 仅安装到当前项目仓库（.agents/plugins/agy-dart）
node scripts/install.mjs install --project /path/to/your-repo

# 运行完整健康检查（双 MCP 握手 + SessionStart + PreToolUse + Sidecar + rg）
node scripts/install.mjs doctor

# 卸载
node scripts/install.mjs uninstall
```

### 直接让 Antigravity 自动安装

也可以直接把下面这句话发给 Antigravity：

```text
请将 https://github.com/zou172866/agy-dart.git 克隆到临时目录，运行其中的 scripts/install.mjs install --mode balanced-16k 完成全局安装并跑 doctor 自检（Windows 如未安装 rg 请同时传 --install-rg）。
```

> **生效提示**：安装完成后，重启 Antigravity（或重载窗口）并开启新对话即可生效。如果你之前单独安装过 `agy-fast` 或 `antigravity-plugin-context-mode`，请在 **Customizations → Installed** 中关闭或移除旧单独插件，避免重复挂载。

---

## 保护模式一键切换（方案 A / 方案 B）

除了在右侧 Aux Pane 的 **agy-dart Context** 实时面板中随时点选阈值或暂停（`Active / Paused`），也可以用命令行一键切换预设模式：

```bash
# 方案 A（默认推荐）：放行 <16 KB 文件与 <=410 行分段读，拦截无界盲读与大命令 dump
node scripts/install.mjs mode balanced-16k

# 宽松方案 A（适合超大源码文件较多的仓）：32 KB / 820 行
node scripts/install.mjs mode fast-32k

# 严格模式：8 KB / 200 行
node scripts/install.mjs mode strict-8k

# 方案 B（极致低延迟）：仅拦截无界 run_command（cat/Get-Content/git log/curl），彻底免除 read_file Hook 同步耗时
node scripts/install.mjs mode no-read-hook
```

---

## 效果量化与本地测试

```bash
# 运行本仓库全量测试套件（含集成、v1.1、v1.2、安全加固与属性/模糊测试）
npm test

# 静态校验运行时 Import 依赖图与打包清单（防漏文件）
npm run verify:pkg

# 审计 Turn-0 常驻前缀 Token 预算、双 MCP 指纹与 Token 估算误差校准
npm run prefix:budget
node scripts/prefix-budget.mjs --calibrate

# 全域 Prompt Cache 体检与 7 套缓存策略离线回放
npm run cache:audit -- --workspace . --no-live
npm run cache:simulate
```

---

## 开源协议

本项目基于 [MIT License](LICENSE) 开源；复用组件保留其原有 MIT 版权声明，合规边界详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
