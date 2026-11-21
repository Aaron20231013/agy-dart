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

## v1.3.0 核心升级（四层读守卫 + 评审一等公民 + Diff 三阶段保真）

1. **宿主对齐四层读拦截架构（默认 `45 KiB` / `800 行` + 2-strike 软护栏）**：
   - 将常规源码默认阈值对齐 Antigravity 原生 `read_file` 封顶（**`45 KiB` = `46,080 B` / `<= 800 行`**，`host-45k` 模式）并启用 **2-strike 软护栏**（5 分支会话/子代理/匿名 TTL 隔离），彻底解决无 MCP 子代理死锁与大源码硬拒；同时保持高噪日志/锁文件/压缩单行文件 **`16 KB`**（`noiseMaxReadBytes`）与 `.patch`/`.diff` 评审文件 **`128 KB`**（`reviewMaxReadBytes`），原生放行 `ByteOffset` 与开放尾行 `StartLine` 分页续读。
   - 彻底解耦 `read_file` 体积豁免（`exemptExtensions`、零 ReDoS 线性 `exemptPaths`、`readGuardMode: "soft"|"strict"|"off"`）与 **`readDedup`/`diffRead`** 以及 **`run_command`**（独立 `shellDumpMaxBytes = 16 KB`，封堵 `cat huge.png` / `curl .../archive.zip` 绕过且 `cutoff=0` 不再放穿 `cat`）。
   - 修复读缓存优先防三连拒、`measureLineRangeBytes` `>2 MB && sLine > 1` 盲区、宽行多行文本误报压缩文件、`sensitive_read_confirm` TTL/隔离、`getExemptExtensions` 分裂 Bug、Sidecar `/api/purge` `"conversation"` 报错、自定义阈值下拉回显与平滑升级迁移（`cutoff:source` 自动迁旧默认 `16384 -> 46080` 且不覆盖自定义值）。
2. **原生 `.patch`/`.diff` 符号大纲 & `git diff` / `gh pr diff` 三阶段上下文保真**：
   - `agy-dart_fast` `read_slices({ outlines })` 新增零依赖 `.patch`/`.diff` 解析器（`extractDiffSymbols`），1 次大纲即列出全部变更文件（`+add/-del`）与 `@@` hunk 行号范围。
   - `filterGitDiff` 升级为预算内 100% 保留上下文 → 显式 `-U`/`--unified`/`-W`/`--word-diff` 保上下文截断 → 超预算普通 diff 先缩至 1 行上下文再压缩 `+/-`（并支持 `From <sha>`/`---` 邮件箱补丁头）；修复 `filterGhCli` 不再误伤正文中含 ```` ```diff ```` 代码块的 `gh pr view`。

## v1.2.2 核心新增与深度加固

1. **长任务连续执行与防过早交接（Anti-Premature-Handoff）优化**：
   - 移除 `rules/AGENTS.md` 中诱导任务中段暂停执行 `/compact` 的指令；将 `>60s` 构建/测试与后台流式任务（`WaitMsBeforeAsync <= 2000`，`cliFilterAsyncBypassMs`）直通原生 `run_command`，并为同步 `overwrite` 附加插件目录只读 `permissionOverrides` 以免触发沙盒外审批中断。
   - `ctx_execute` 默认超时提升至 `120s`（`execTimeoutMs`，支持单次 `timeoutSec: 1..300`）且超时返回 `timedOut: true` 与后台切换指引；为 `agy-dart_context` 全系工具补齐 `cwd` 与 MCP `initialize` `workspaceFolders`/`rootUri` 对齐；`PreInvocation` 在工具循环中段（`invocationNum >= 1`）静默空闲 TTL 与冷压缩交接横幅并将 1M 窗口 `ttlMinContext` 提升至 `300k`；读去重新增步数衰减自动放行（`readDedupMaxSteps: 40`）。
2. **第二轮对抗性审计、跨平台 CI 与协议深度加固（42 项核实修复）**：
   - **访问控制、SSRF、ReDoS 与 Windows 跨 Shell 保真**：全链路贯通 `sensitiveFileGuard=deny`（含软链指向敏感文件、`.envrc`/`*.env` 及 `\\?\` ADS 流）（`P1-03`）；`git remote show` 强制 `-n` 阻断网络 SSRF（`P1-04`）；`install.mjs` 拦截内部软链/NTFS 目录联接逃逸、UNC 路径与含 `.git` 副克隆并恢复安装副本自 `uninstall`（`P1-05`/`P1-06`）；`cli-filter` 严格遵守 `PATH` 逐目录 `PATHEXT` 顺序并规避 PowerShell `,`/`--`/`"` 参数损坏（`P1-07`）；`fast` 序列化响应二分死守 `<= 8.8 KB`、修复混合帧头丢包与悬空软链回滚，并收敛 Glob/正则/Markdown 线性复杂度（`P1-09`–`P1-13`）。
   - **会话隔离、进程组回收与多厂商计费精度**：加固 Sidecar `/api/search` 与 MCP `ctx_search`/`ctx_resume` 跨会话隔离（`P1-01`）；补齐 POSIX `detached` 进程组与 Windows `taskkill /T /F` 树级回收、线性 JS ESM `--input-type=module` 词法检测、递归子 Shell 转储拦截及 Windows `413` 优雅关连接；`pruneByTtl` 纳入写事务，按轮次模型计算跨 `model_switch` 美元成本、修复 OpenAI 兼容网关缓存双计与 1h 隐式写回放基线（Linux & Windows × Node 22/24 全矩阵 126/126 全绿）。

## v1.2.1 核心加固与修复

1. **全仓库首轮安全与稳定性审计修复（76 项修复）**：
   - 拆分 `apply_edits` 临时写入与 `rename` 回退保证原子回滚（`C-1`），补齐 `executor.js` 子进程流异常监听与 `close` 排空（`C-2`/`H-10`）、PowerShell 环境变量参数隔离（`M-21`）、只读 `git branch`/`tag` 参数封堵（`H-1`）、Windows `\\?\`/`\\.\`/8.3 路径规范化（`H-2`/`H-3`）及 CSS/SFC 线性大纲提取（`H-7`）。

## v1.2.0 核心新增能力

1. **Sidecar 安全加固与统一配置（`~/.agy-dart/config.json`）**：
   - Sidecar 独立 HTTP 模式全量 `/api/*` 强制进程级随机 `X-Agy-Dart-Token` 校验（`SidecarApp` 模式全量 `/api/*` 强制 `POST` + `X-Sidecar-Token`）；`/api/search` 及所有写接口（`/api/purge`、`/api/toggle-active`、`/api/cutoff`、`/api/exemptions`、`/api/maintenance`、`/api/cli-filter`、`/api/read-dedup`）强制仅允许 `POST` + `Content-Type: application/json`，全站强制 `Host`/`Origin`/`Sec-Fetch-Site` 防 DNS Rebinding 与跨站拦截、请求体上限 `64 KB`，并加固自定义扩展名 XSS 转义。
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
   - 确定性前缀稳定 `SessionStart` 排布（静态路由头 → 半静态项目/目录结构 + `git HEAD` 缓存的核心导入枢纽 → 易变 `git status` 置尾）+ 瘦身冻结 Turn-0 MCP Schema（`npm run prefix:budget` 常驻约 ~2,832–2,950 tok）。
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
| **MIT 模式参考**（`mpecan/tokf`、`uuie/agent-cache-optimizer`、`rkolesnichenko/ccdrift`、`ooples/token-optimizer-mcp`、`tobi/qmd`、`DeusData/codebase-memory-mcp`、`tirth8205/code-review-graph`、`lennartschoch/opencode-cache-compact`） | MIT | 借鉴声明式 CLI 过滤、前缀稳定性、缓存归因、读去重、Markdown 标题分块、`git HEAD` 缓存依赖枢纽与压缩交接摘要模式 | 纯零依赖 Node.js ESM 净室实现，原生融合 Antigravity 四大钩子与 Sidecar |
| **仅架构思想借鉴**（`mksglu/context-mode`、`rtk-ai/rtk`、`opencode-dynamic-context-pruning`、`the-cybersapien/claude-cache`、`huiliyi37/Tianshu-harness`） | 非 MIT / Apache-2.0（**零源码引入**） | 仅参考高层次架构范式（沙盒过滤、透明钩子改写、会话去重、KV-Cache TTL 延续性、版本化 V8 编译缓存、SHA-256 内容去重、前缀预算审计、Ghost 拦截效率反馈、热缓存延迟压缩） | **严守红线，未引入任何一行源码**，全部自主 MIT 净室实现 |

---

## 双引擎分工架构（零冲突）

| 任务类型 | 唯一指定工具 | 优势 |
| :--- | :--- | :--- |
| 代码文本 / 正则 / Glob / 只读 Git 查询 | `agy-dart_fast` → `batch_search` | 1 次调用并发最多 20 条查询，走 `rg` 毫秒级，≤ 8.8 KB 零溢盘 |
| 未知大源码 / `.patch` 补丁（>300 行） | `agy-dart_fast` → `read_slices({ outlines })` + 并行内置 `read_file` | 先 1 次拿全文件符号或 diff 文件/hunk 行号，再用本地 7ms `read_file` 精确读分段 |
| 常规源码（<45 KiB）与 `.patch`（<128 KB） | 内置 `read_file`（同轮并行，≤800 行） | 0 远端审查（~7ms）、45 KiB 宿主封顶，超限走 2-strike 软护栏不死锁 |
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

# 默认安装（host-45k：45 KiB / 800 行宿主对齐软护栏 + 自动健康自检，升级自动保留自定义阈值）
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
# 全局安装到 ~/.gemini/config/plugins/agy-dart（默认 host-45k 仅安装运行时）
node scripts/install.mjs install

# 同时安装离线审计 / 压测 / 策略回放等开发工具 CLI
node scripts/install.mjs install --with-devtools

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
请将 https://github.com/zou172866/agy-dart.git 克隆到临时目录，运行其中的 scripts/install.mjs install 完成全局安装并跑 doctor 自检（Windows 如未安装 rg 请同时传 --install-rg）。
```

> **生效提示**：安装完成后，重启 Antigravity（或重载窗口）并开启新对话即可生效。如果你之前单独安装过 `agy-fast` 或 `antigravity-plugin-context-mode`，请在 **Customizations → Installed** 中关闭或移除旧单独插件，避免重复挂载。

---

## 保护模式一键切换（方案 A / 方案 B）

除了在右侧 Aux Pane 的 **agy-dart Context** 实时面板中随时点选阈值或暂停（`Active / Paused`），也可以用命令行一键切换预设模式：

```bash
# 默认推荐（宿主对齐 45 KiB / 800 行软护栏 + 16 KB 高噪/压缩 + 128 KB diff/patch）
node scripts/install.mjs mode host-45k

# 经典方案 A：16 KB / 410 行
node scripts/install.mjs mode balanced-16k

# 宽松模式：32 KB / 800 行
node scripts/install.mjs mode fast-32k

# 严格模式：8 KB / 205 行
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
