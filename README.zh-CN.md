<div align="center">

<img src="assets/logo.svg" alt="agy-dart logo" width="80" />

# agy-dart

**面向 Google Antigravity 的一体化「极速批处理 + 上下文护栏」原生插件**

零运行期依赖 · 双引擎零冲突协作 · 死守 ≤ 8.8 KB 零溢盘 · 内置实时 Sidecar 面板 · 支持一键补装 `rg`

简体中文 · [English](README.md) · [社区反馈与改进](#社区反馈与改进community-feedback--improvements) · [第三方开源致谢与许可](THIRD_PARTY_NOTICES.md)

</div>

---

## 为什么做 `agy-dart`

在 Google Antigravity（Desktop 2.0 / IDE / CLI）的高强度编码会话中，慢和贵通常同时来自两类问题：
1. **轮次与审查开销**：单轮固定首字等待（TTFT）、重复拆分的 `edit_file` 与串行 Shell 搜索触发高频远端校验，以及 MCP 超 10 KB 输出落盘 `output.txt` 带来的二次读取。
2. **上下文膨胀与失忆**：动辄几十 KB 到数 MB 的构建日志、JSON/CSV 数据集或超长文档被直接整段塞进对话，拉高 TTFT 并挤爆上下文窗口。

如果把现有的加速插件与上下文护栏插件直接堆叠安装，容易出现 **8 KB 过严拦截反噬 `read_file` 7ms 本地白名单**、**两份 `AGENTS.md` 互相抢工具**、**`ctx_execute` 返回超 10 KB 触发落盘**、**`npx` 安装丢掉 Sidecar 面板** 等冲突。

**`agy-dart`** 将两者深度整合为 **1 个原生 Antigravity 插件**：一套零冲突路由规则、一套单进程合并钩子、一套可一键切换阈值的实时仪表盘，开箱即用。

> **提示**：谷歌 Antigravity 工具链与服务端缓存策略变化较快，建议在右上角点一下 **Star / Watch (Releases only)**，方便第一时间收到新版兼容修复与降噪策略更新。

---

## v1.5.2 核心升级（钩子与 SQLite 热路径提速、HTML/Dart 符号大纲、Windows UTF-8 管道与面板并发轮询）

1. **生命周期钩子与 SQLite 冷启动极速快跳**：
   - `hooks/pre-tool-use.mjs` 引入单次调用级文件读取上下文（`createFileReadContext`），缓存 `realpathSync`、按需单次加载的 `<= 2 MB` `Buffer` 与行区间字节统计，将单次 `read_file` 磁盘全量读取从 `4～6` 次压降至**最多 `1` 次**，并为 `isBinaryFile` 补齐 `try/finally` 句柄保护与 `.dart`/`.astro`/`.mdx`/`.proto` 等文本白名单。
   - `context/lib/store/schema.js`（`initSchema`）新增 `PRAGMA user_version` + `sqlite_master` 列签名极速快跳，短进程钩子热打开数据库时跳过全部 9 表 DDL、4 次 `PRAGMA table_info` 与 FTS5 重建（同时完整保留旧库与缺表自愈能力），并新增 `idx_events_tool_sandbox` 复合索引。
   - `hooks/session-start.mjs` 改为进程内 `Promise.all` 并发调用 `buildWorkspaceSnapshot`，消除额外子 Node 进程及子代理/`stablePrefixOnly` 模式下 **4 次无效 `git` 进程创建**，并补齐 Dart/Flutter `pubspec.yaml` 项目识别。
2. **HTML/Astro 与 Dart 3 符号大纲增强 + Windows UTF-8 管道防乱码**：
   - `agy-dart_fast` `read_slices({ outlines })` 支持提取带缩进的 `.html`/`.htm`/`.astro` `<style>`、`<body>` 语义地标与 `<script>` 内嵌 JS 函数/类（彻底解决 5,000+ 行单页 HTML 大纲为空的问题），以及 `.dart` 的 `class`/`mixin`/`extension`、可空返回类型与箭头函数。
   - `context/lib/executor.js`（`ctx_execute`）为 Python 默认注入 `PYTHONIOENCODING=utf-8` / `PYTHONUTF8=1`，为 Windows PowerShell 前置 UTF-8 输出编码（自动兼容首行 `param(...)` 脚本与原始退出码透传），杜绝 CP936 控制台管道中文乱码。
3. **Sidecar 仪表盘并发轮询与 SQLite 查询瘦身**：
   - 前端 `refreshData()` 将 5 个独立 `/api/*` `POST` 请求改为 `Promise.all` 并发拉取，新增防重入锁与后台隐藏标签页（`document.hidden`）自动休眠/切回即刷；后端消除 `/api/stats` 重复 `getGhostStats()` 扫描、对已终态 `starPrompt` 短路跳过全表聚合、按 `mtimeMs` 缓存 `index.html` 模板，并将 `"app"` 作用域 `/api/search` 的 N+1 查询合并为单条 `WHERE id IN (...)`。

## v1.5.1 体验打磨（10 分钟编辑感知 Ghost 召回窗口与全中文界面零残留）

1. **10 分钟编辑感知 Ghost 召回校准与阈值建议升级**：
   - `ghost_interceptions` 新增 `recall_closed`，仅将拦截后 `<= 10` 分钟且未发生文件编辑（`PostToolUse` 捕获 `edit_file`/`write_file`/`apply_edits` 即关窗）的窄切片计入被迫召回，并区分过紧阈值（`< 45 KiB` 建议切回 `host-45k`）与宿主上限阈值（`>= 45 KiB` 建议先用 `read_slices({ outlines })` 或豁免）。
2. **Sidecar 中文模式（`zh`）全量本地化清零**：
   - 补齐 Ghost 效率建议、阈值下拉菜单、TTL 校准来源、死循环监控与缓存失效归因提示的全部中文文案，实现中文模式下零英文残留。

## v1.5.0 核心升级（跨会话实证 TTL 校准、高上下文临期提醒与 Keep-Alive 账本回放）

1. **跨会话按模型实证 TTL 区间校准（`ttl_calibration:v1:<profileId>`）**：
   - 基于 14 天有界 Ring Buffer 跨会话累计同模型档位（如 `gemini-4-512k`、`claude-200k`）的真实热命中下界与纯空闲冷失效上界（`estimateCalibratedTtl` 支持后端 TTL 缩短时双向向下收敛、规避 `ttl_idle_expiry` 循环依赖，严格遵守 `explicit > session/history > profile` 优先级），新开会话即继承校准窗口并实时同步至 Sidecar 与 `PreInvocation`。
2. **高上下文空闲 TTL 临期桌面提醒（Opt-in 默认关闭，零 `statSync`）**：
   - 新增 `ttlDesktopNotify`（`AGY_DART_TTL_DESKTOP_NOTIFY` 与面板「临期提醒」开关，默认关闭）、`ttlNotifyLeadSec`（`60s`）与 `ttlNotifyMinTokens`（`60000`）：主对话处于 `IDLE`、`>= 60k` tokens 且距过期剩余 `(0, 60s]` 时发送一次脱敏防抖桌面通知，全程保持 **`0` 次 `statSync`**、休眠唤醒防误弹，且在 `stallWatchdog=false` 时仍可独立运行。
3. **`npm run cache:simulate` 新增 Keep-Alive 反事实策略回放**：
   - 离线回放扩充至 **9 套策略**，新增 `keepalive-1x` 与 `keepalive-unlimited`（支持 `--keepalive-tail <sec>`，标记 `hypothetical: true` 不抢占 `recommendedPolicy`），直接用真实历史轨迹核算自动保活 Ping 读成本、离座尾窗浪费以及表面刷高命中率 vs 真实用户轮命中率（`userTurnHitRate`）。

## v1.4.0 核心升级（Sidecar 卡死看门狗与免越狱救援闭环）

1. **双源融合状态机（5 大钩子 + Sidecar 巡检 + `transcript.jsonl` 尾步自愈）**：
   - 新增轻量 Fail-Open `hooks/stop.mjs`（注册至 `hooks.json` 的 `Stop` 事件），复用 `PreInvocation`、`PreToolUse`、`PostToolUse`（新增覆盖 `run_command` 完成态），通过极速模块 `context/lib/watchdog-lease.js`（<1ms 加载、完整保留 0-SQLite 快路径与 0 字节 `stderr`）向 SQLite `meta` 写入按 `directConversationId` 严格隔离的执行态租约 `watchdog_lease:<convId>`。
   - 新增 `context/lib/watchdog.js`（`WatchdogMonitor`）常驻于 Aux Pane Sidecar（`sidecars/dashboard/server.mjs`）：后台低频巡检（**全部对话空闲时零 `statSync` 开销**）、**双静默判定**（只要 `transcript.jsonl` 的 `mtimeMs`/`size` 仍在增长即自动顺延计时）与**尾步终态自愈纠偏**（防 `Stop` 钩子漏触发，同时通过时间戳与文件增长边界保护避免误把新卡死轮次当成旧轮次结束）。
2. **状态感知动态超时矩阵（黄灯/红灯两级、零误报）**：
   - 精确区分 `IDLE`、`LLM_INFLIGHT`（中低上下文 `<120k` `120s` / 高上下文 `>=120k` 或 `/compact` `240s` / 高上下文多模态 `>=150k` `360s`）、`TOOL_RUNNING`（`read_file`/常规 MCP `90s` vs 同步 `run_command`/`ctx_execute`/`run_checks` `300s`）与 `SUBAGENT_BG`（后台任务/子代理 `600s`），采用 **黄灯 `suspect`（60%）→ 红灯 `stalled`（100%）** 两级预警，全部阈值与开关收敛至 `~/.agy-dart/config.json` 与 `AGY_DART_WATCHDOG_*` 环境变量。
3. **免越狱救援闭环与工程级防护**：
   - 进入红灯 `stalled` 时自动预生成附带“卡死现场快照（阶段、静默时长、末步工具/命令、最后用户输入、疑似根因、Git Diff 摘要、检查点与 FTS5 句柄）”的脱敏**抢救版 Handoff Brief**（复用 `context/lib/handoff.js`），按 6 类根因（后台自动压缩死锁 / Windows 终端 EOF 或交互阻塞 / MCP 工具阻塞 / 文件读取或宿主工具阻塞 / 后台任务或子代理无响应 / OAuth Ghost Session 或网络断连）输出 1–2 条精准排障指引；Sidecar 面板提供 1s 本地静默计时、一键复制抢救简报、延后/标为空闲操作以及**默认关闭（Opt-in）且防抖**的 OS 桌面提醒。
   - 内置**休眠/合盖时钟跳变防护（Sleep Drift Guard）**、多会话与子代理严格隔离、Sidecar 重启清理陈旧历史租约、严格沿用 `POST`-only + CSRF Token 安全模型（新增 `/api/watchdog` 与 `/api/watchdog/action`），**绝不碰 CDP 且绝不强杀宿主进程**。

## v1.3.1 长程抗反噬与压缩零延迟补强

1. **零延迟压缩检测与首轮即时失效**：
   - 在 `context/lib/cache-analyzer.js` 中统一 4 类压缩/裁剪信号（`latestCompactionEvent` + 轻量化 `inspectTranscriptCompaction`）：原有 `compaction_or_truncation` 骤降、解耦上下文萎缩（即使同轮伴随 `model_switch` 或轻度裁剪 `>= 15%` 且降幅 `>= 8k` tokens）、显式压缩/摘要步骤、以及 `/compact` 用户指令。
   - `PreInvocation` 新增 `lastUserInput` `/compact` 即时清库（以 `initialNumSteps` 幂等落戳并保护工具循环中段 `invocationNum >= 1` 新读记录）与 `initialNumSteps` 回退检测；`PreToolUse` 在即将触发 `read-dedup`/`diff-read` 的慢路径上零常规开销兜底（`statSync` 字节数快跳过 + 尾部 128 KB 扫描），压缩后第 1 轮重读即直接放行（0 浪费轮次，且通过 `invalidateFileReadsBefore` 保全同轮已读新文件）。
2. **全域轮次衰减、小文件/窄切片防反噬与失败报错锚点保真**：
   - 新增 `readDedupMaxTurns`（默认 **`12`** 轮，`AGY_DART_READ_DEDUP_MAX_TURNS`，`file_reads.read_turn_seq`），即使宿主载荷不含 `stepIdx` 也由 `PreInvocation` 轮次时钟自动衰减放行，并在 `stepIdx` / `turnSeq` 回退时直接放行。
   - 新增可配置 `readDedupMinBytes`（默认 **`4096 B` = 4 KB**，`AGY_DART_READ_DEDUP_MIN_BYTES`），按**本次请求实际字节数**判定，避免小配置或 15 行窄切片触发 2-strike 反噬；Strike 2 绕过写入独立 `dedup_bypass` 遥测（透出至 `featureRoi.features.read_dedup.bypasses` / `bypassRate` 且不污染去重节省统计）。
   - `hooks/filter-rules.mjs` 新增 `compactFailureWithErrorAnchors`：失败命令输出超 `7.9 KB` 时自动提取藏在日志**中段**的 `AssertionError`/`Traceback`/`ERROR`/`✖`/`not ok` 等报错锚点及上下 `±3` 行上下文（优先保留首个根因块 + 末尾报错块 + 头尾摘要），死守 `<= 7.9 KB`（总输出 `<= 8.8 KB` 零溢盘），大幅降低被迫额外 `ctx_search` 的概率。

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

## 社区反馈与改进（Community Feedback & Improvements）

本区域专门记录来自社区真实工作流的吐槽、痛点原文，以及对应的工程改造方案与底层设计原理。欢迎继续通过 GitHub Issue 或评论区反馈真实踩坑场景。

### `[v1.5.0]` 15 分钟空闲缓存超时失效 vs「每轮结束自动发请求保活」

#### 1. 社区反馈原文

> 「`@billy88lsh`: 我看的记录，我的缓存是97。你的问题是你总是超时，超过15分钟就缓存没了。提升的办法就是回答完一轮，程序自动激活一下缓存」

结合 Antigravity 插件权限边界与缓存计费数学复盘后，拆解出三层事实：
1. **静态 300s 默认值低估了真实后端窗口**：连续高节奏对话确实可稳定在 95%–97%，最大失分项正是离开超过服务端 TTL 后的冷重算；而 `v1.4.x` 对新开会话一律回退 `300s`（5 分钟），既不跨会话记忆实测 ~15 分钟窗口，也无法在后端 LRU 缩短时向下收敛。
2. **插件层无法做无痕静默保活**：服务端 KV-Cache Key 绑定宿主底层完整请求前缀与签名；`Stop` Hook 为同步阻塞（`5s` 超时），Sidecar 无静默 1-token 探针 RPC，强行注入消息会直接污染上下文并违背零前缀污染红线。
3. **盈亏平衡极窄与 Goodhart 刷分幻觉**：每次保活仍需支付 `10%–25%` 缓存读费用与请求配额（90% 折扣连 Ping 10 次、75% 折扣连 Ping 4 次即贵过一次冷重算）；一旦切走开会或离座，后台自动保活 100% 白烧额度，出现“面板命中率刷高但真实账单更贵”。

#### 2. 改进方案（`v1.4.x` → `v1.5.0`）

| 维度 | 旧版 `v1.4.x` | 新版 `v1.5.0` 改造 |
| :--- | :--- | :--- |
| **TTL 识别精度** | 新会话一律重置为硬编码 `300s`，单会话仅单向上调 | **跨会话按模型实证区间校准（`ttl_calibration:v1:<profileId>`）**：14 天有界 Ring Buffer 累计热下界与纯空闲冷上界，支持后端 TTL 缩短时双向向下收敛，新会话直接继承实测窗口 |
| **切出桌面临期感知** | 仅面板内进度条倒计时，切出窗口无感知 | **高上下文空闲临期桌面提醒（Opt-in 默认关闭）**：`>= 60k` tokens 且剩余 `(0, 60s]` 时弹一次防抖通知（零 `statSync`、休眠跳变抑制、可独立于卡死看门狗运行），由用户决定续聊保热或冷后 `/compact` |
| **保活成本实证量化** | 无历史账本对比工具 | **`npm run cache:simulate` 新增 `keepalive-1x` / `keepalive-unlimited`**：支持 `--keepalive-tail <sec>`，同时输出表观命中率与 `userTurnHitRate`，用本机真实日志算清保活盈亏 |

### `[v1.4.0]` 多轮对话后持续“工作中”却零输出、直接卡死

#### 1. 社区反馈原文

> 「我在多轮对话之后很容易一直工作中却不输出任何东西，直接卡住了，难道没有自动总结压缩的功能么？」

复盘 Antigravity 多轮对话执行链路后，发现前端看起来完全一样的“一直转圈但不吐字”，背后其实集中在 **4 类真实卡死场景**：
1. **高上下文 / 后台自动压缩死锁**：上下文进入 `>= 120k`（或 `>= 150k` 伴随图片/截图）后，后台自动压缩或冷 Prefill 偶发长时间无响应，界面没有任何静默计时或逃生入口。
2. **Windows 终端 EOF 或交互阻塞**：同步 `run_command` 遇到 `[y/N]` 确认、分页器（`less`/`more`）或 Windows PowerShell/CMD 标准输入等待 EOF，导致整轮执行挂死。
3. **OAuth Ghost Session / 代理网络断连**：静默断流或 OAuth 会话失效后，连接停在 0 字节输出且不会自行报错退出。
4. **MCP 工具调用阻塞**：外部 MCP 服务卡死时，用户无法分辨当前到底卡在模型思考、终端命令还是某个 MCP 工具。

#### 2. 改进方案（`v1.3.x` → `v1.4.0`）

| 维度 | 旧版 `v1.3.x` | 新版 `v1.4.0` 改造 |
| :--- | :--- | :--- |
| **执行态可观测性** | 无执行态租约，只能盯着空白转圈干等 | **双源融合状态机**：`PreInvocation` / `PreToolUse` / `PostToolUse`（补齐 `run_command`）+ 新增轻量 `Stop` Hook 写入按 `directConversationId` 隔离的 `watchdog_lease:<convId>`，由常驻 Sidecar 融合 `transcript.jsonl` 的 `mtimeMs`/`size` 与尾步终态自愈纠偏 |
| **卡死判定与防误报** | 无（若用固定超时会在长构建或高上下文推理时疯狂误报） | **状态感知动态超时矩阵**：`IDLE`（零 `statSync`）· `LLM_INFLIGHT`（`<120k` 120s / `>=120k` 或 `/compact` 240s / `>=150k` 多模态 360s）· `TOOL_RUNNING`（`read_file`/常规 MCP 90s vs 同步 `run_command`/`ctx_execute` 300s）· `SUBAGENT_BG`（600s），黄灯 `suspect` + 红灯 `stalled` 两级，轨迹持续增长自动顺延计时 |
| **救援闭环与排障** | 强停易丢上下文与改动线索，排障靠猜 | **免越狱救援闭环**：进入红灯自动预生成附带卡死现场（阶段、末步工具/命令、最后用户输入、静默时长）的脱敏**抢救版 Handoff Brief**，按 6 类根因输出 1–2 条精准排障指引；Sidecar 1s 本地计时、一键复制/延后/标为空闲 + 默认关闭（Opt-in）防抖桌面提醒 |
| **工程防护与安全** | — | **休眠/合盖时钟跳变防护（Sleep Drift Guard）**、多会话/子代理严格隔离、Sidecar 重启清理陈旧历史租约、`hookMode: true` Fail-Open、全站沿用 `POST` + CSRF Token 安全模型，**不碰 CDP、不强杀宿主进程** |

#### 3. 底层设计原理（为什么采用独立 Sidecar 看门狗，而非 CDP 或强杀进程）

1. **免越狱常驻守护最稳**：利用 Antigravity 原生插件已有的 `restart_policy: always` Aux Pane Sidecar 与生命周期 Hooks，无需开启调试端口（CDP）、无需篡改宿主二进制、也不会因强杀 `language_server` 导致对话轨迹损坏，把“停止并带现场续接”的控制权完整交给用户。
2. **双源融合消灭单源盲区**：单靠 Hook 会遇到异常中断漏发 `Stop` 导致假告警；单靠扫 `transcript.jsonl` 无法区分正常空闲和首轮卡死。将 SQLite 租约与 `transcript.jsonl` 增长检测、时间戳受控的尾步终态自愈结合，既能杜绝活跃流式输出误报，又能自动纠正漏触发的 `Stop`。
3. **热路径零退化**：将写入租约的 `watchdog-lease.js`（<1ms 加载）与重型诊断模块 `watchdog.js` 解耦，保持 `PreToolUse` 0-SQLite 快路径与 p50/p95 延迟预算不受任何影响。
4. **空闲零磁盘 I/O 与休眠免疫**：所有会话处于 `IDLE` 时巡检零 `statSync`；笔记本合盖/休眠唤醒产生大跨度时钟跳变时，由 wall-clock vs monotonic-clock 差值自动补偿宽限期，彻底杜绝唤醒瞬间的误报红灯。

### `[v1.3.0]` 16 KB 默认读拦截误伤代码评审（`.patch`）与无 MCP 子代理

#### 1. 社区反馈原文

> 「Claude 没有这个限制。大文件它会分段读完，不会因此停下来。这个 16 KB 的限制也不是 Antigravity 自带的，而是你那台机器上 Antigravity 配置里加的一道读前检查（agy-dart protection），放宽它或者给评审目录开个例外就能解决，16kb 单文件读写居然是默认配置吗」

> 「@xcq: 我是让他做我工作流的 reviewer，会碰到这种情况，git 的 patch 文件直接拒绝读写，因为单个 patch 文件随便就超过 16kb 了碰到现在的默认设置就会失败，我走了 `AGY_DART_DISABLE_READ_HOOK=1`」

*(注：`agy-dart` 从不拦截写操作，仅在读文件前做保护；但对 code reviewer 来说，读 `.patch` 失败就足以直接中断整个评审流程。)*

顺着这两条反馈做全链路代码复核后，共定位出 `v1.2.2` 的 **5 处深层工程根因**：
1. **在宿主能力的 35% 处永久硬拒**：Antigravity 原生 `read_file` 自带 `46,080 B`（45 KiB）/ 800 行硬封顶与分页续读，但 `v1.2.2` 沿袭上游 `context-mode` 在 16 KB 就抢先硬 `deny`，且唯独大文件守卫没有 2-strike 重试旁路。
2. **合法翻页续读被自己误杀**：`ByteOffset` 原本在大文件拦截**之后**才解析，省略 `EndLine` 的 `StartLine` 续读会被 `isWideRange` 挡住；宽行多行文本（如中文长段）超 36 KB 还会被误报为“压缩单行文件”。
3. **代码评审链路断层**：`agy-dart_fast` `read_slices({ outlines })` 缺少 `.patch`/`.diff` 解析器；退回 `git diff` / `gh pr diff` 时，`filterGitDiff` 会剥光所有 `' '` 上下文行（且 `gh pr view` 正文含 diff 代码块会误抹 PR 元数据）。
4. **无 MCP 子代理死锁（上游 `context-mode#1311` 同款）**：未挂载 `agy-dart_context` 的 reviewer / research 子代理撞上硬 `deny` 后无路可走。
5. **三通道强耦合**：原逻辑中勾选 `exemptExtensions` 会短路跳过整个 `readDedup`，且 `run_command` 的 `cat`/`curl` 共用 `maxReadBytes` 与 `exemptExtensions`，设 `0` 或勾选豁免会连带放穿终端大文件/二进制直吐。

#### 2. 改进方案（`v1.2.2` → `v1.3.0`）

| 维度 | 旧版 `v1.2.2` | 新版 `v1.3.0` 改造 |
| :--- | :--- | :--- |
| **读文件阈值模型** | 一刀切 `16 KB / 410 行` 永久硬 `deny` | **四层风险分级 + 2-strike 软护栏（默认 `host-45k`）**：<br>• Tier 0（附件 / 指令文档 / 二进制）：0-SQLite 直放<br>• Tier 1（高噪日志 / 锁文件 / 压缩单行）：死守 **`16 KB`**（`noiseMaxReadBytes`）<br>• Tier 2（常规源码 / 文档）：精确对齐宿主 **`45 KiB`（`46,080 B`）/ 800 行** + 2-strike<br>• Tier 3（`.patch` / `.diff` 评审）：**`128 KB`**（`reviewMaxReadBytes`）直放，超限 2-strike |
| **分页续读与防死锁** | 拦截 `ByteOffset` / 开放尾行；无 MCP 子代理卡死 | 前置 `ByteOffset` 余量计算与合法续读放行；区分压缩单行与宽行多行文本（动态给出 `suggestedLines`）；5 分支会话/子代理/匿名 TTL 隔离 + 读缓存优先防三连拒；子代理支持 2-strike 原生降级 |
| **通道解耦与安全** | 豁免跳过 `readDedup` 且放穿 `cat`/`curl` | `read_file` 体积豁免仅跳过大小拦截，**完整保留 `readDedup`/`diffRead`**；`run_command` 拆出独立 `shellDumpMaxBytes = 16 KB` 并彻底移除 `exemptExtensions` 依赖；补齐 `realpathSync` 防软链穿透与严格整型参数校验 |
| **代码评审一等公民** | `.patch` 无大纲；`git diff` 剥上下文 | `read_slices({ outlines })` 新增原生 `.patch`/`.diff` 文件与 `@@` hunk 大纲解析；`filterGitDiff` 升级为 `<= 7.9 KB` 内**三阶段保真**（预算内 100% 留上下文 → `-U`/`-W` 保上下文截断 → 1 行上下文再压缩）+ 修复 `gh pr view` 误伤 |
| **可信配置与平滑升级** | 只能用 `AGY_DART_DISABLE_READ_HOOK=1` 一锅端 | `~/.agy-dart/config.json` 新增 `readGuardMode`（`soft`/`strict`/`off`）、分档阈值、`exemptExtensions` 与线性无 ReDoS `exemptPaths`；`cutoff:source` 升级自动将旧默认 `16384` 迁至 `46080` 且保留用户自定义值 |

#### 3. 底层设计原理（为什么这样改，而不是直接取消拦截）

1. **对齐宿主物理天花板，消灭「负 ROI 拦截区间」**：Antigravity 原生 `read_file` 已将单次读取封顶在 `46,080 B`（~11.5K tokens）/ 800 行。在 `16 KB ~ 45 KiB` 间硬拦省下的 token 很少，却会多烧 1 轮 TTFT + 整段前缀 Cache Read 费用（负收益）；对齐 `45 KiB` 后，凡放行必一轮无损读完，只在真正需要多轮分页（`> 45 KiB`）时再引导大纲切片。
2. **按「信噪比与阅读模式」分层，而非按字节一刀切**：日志/锁文件/压缩包几乎无需逐行通读，走 `ctx_execute` 沙箱聚合压缩率 >90%，继续死守 `16 KB`；源码需要上下文对齐 `45 KiB`；`.patch`/`.diff` 评审需要按变更顺序通读找未知逻辑 Bug，因此给到 `128 KB` 直放 + 超限给原生 Diff Outline。
3. **2-Strike 软护栏防死锁，配合 5 分支 TTL 隔离防抖动**：Hook 无法预知所有子代理的 MCP 权限，也不应成为流程单点死锁；重试一次放行（由宿主 45 KiB 兜底）兼顾首轮引导与零卡死，同时按独立对话 / 带 ID 子代理 / 匿名子代理 / 仅父 ID / 匿名工作区 5 分支隔离确认窗、续读刷新 TTL、读缓存优先于大文件拦截（彻底消除三连拒）。
4. **严格解耦「有宿主封顶通道」与「无封顶通道」**：`read_file` 有宿主 45 KiB 兜底，但 `cat` / `curl` / `git diff` 没有任何原生上限——放宽 `read_file` 绝不能放宽 `cat`/`curl`（独立 `shellDumpMaxBytes`），也不能靠 `skipFlags` 绕过 `cli-filter.mjs`（否则 5 MB diff 会无封顶、无脱敏直吐）；跳过大文件首次拦截也绝不等于跳过 `readDedup` 去重。
5. **安全与威胁模型守恒**：`exemptPaths` / `exemptExtensions` 仅从可信用户级 `~/.agy-dart/config.json` 与环境变量加载（不默认信任仓库内配置防上下文 DoS），严格执行于 `sensitiveFileGuard` 之后，且全部经 `fs.realpathSync` 校验与线性段匹配防 ReDoS。

### `[v1.2.2]` 启用后难以运行长任务、短时间内自动停机/交接

#### 1. 社区反馈原文

> 「使用了dart之后，就很难进行长任务了，会自动在很短的时间内交接」

结合 Antigravity 执行器循环与 `v1.2.1` 全链路复盘，“短时间内自动交接”同时对应**模型提前结束当前轮次把控制权交回用户**与**聊天流频繁弹出「交接简报（Handoff Brief）/ `/compact`」提示**两类现象，背后共有 **5 处工程根因**：
1. **高优规则措辞诱导阶段边界主动停机**：`rules/AGENTS.md` 原文包含祈使句 `compact at cold/phase boundaries then call ctx_resume`。由于 `/compact` 是纯前端斜杠指令、模型无法自行调用工具完成，严格服从 `<user_rules>` 的模型在刚跑完第 1 小阶段（几分钟内）就会主动停止工具调用，向用户输出阶段总结请求手动 `/compact` 交接。
2. **MCP 沙盒硬编码 `30s` 超时强杀长脚本**：原生 `run_command` 超过等待窗口可无缝转入后台异步长跑，但 `ctx_execute` 硬编码 `30,000 ms` 即强杀进程树（`exitCode: 124`）且未暴露超时参数，`run_checks` 默认也仅 `60s`，导致全量构建或数据批处理在半分钟到一分钟内报错中断并交接给用户。
3. **透明 CLI 改写与终端沙盒 / 后台流式任务的冲突**：`cli-filter.mjs` 全量内存缓冲导致后台运行期间 `manage_task(status)` 无实时流式输出；同时在 `Default`/`Auto` 终端沙盒下，用户主目录内的 `~/.gemini/config/plugins/agy-dart` 默认不在挂载白名单中，改写后的命令会因找不到脚本而申请沙盒外运行（Unsandboxed），触发人工审批弹窗打断无人值守长任务。
4. **工具循环中段与 1M 模型低水位误报「交接简报」**：`PreInvocation` 未区分“用户闲置”与“长耗时工具/子代理运行间隔”，当单个工具或子代理耗时满 4～5 分钟唤醒下一轮（`invocationNum >= 1`）时误弹 TTL 交接提醒；且 `ttlMinContext` 被 `Math.min(..., 60000)` 锁死在 `60k`（仅占 1M 窗口模型的 6%，两三轮即触发）。
5. **无衰减读去重挤压单轮 `MAX_INVOCATIONS` 步数预算**：跨数十步的超长任务后半程，模型在编辑前合理复核早期读过的文件仍会被 `read-dedup` 先 `deny` 一轮，累积消耗宿主单轮最大调用步数上限。

#### 2. 改进方案（`v1.2.1` → `v1.2.2`）

| 维度 | 旧版 `v1.2.1` | 新版 `v1.2.2` 改造 |
| :--- | :--- | :--- |
| **规则层阶段交接指令** | 祈使句要求在冷缓存/阶段边界执行 `/compact` | 改为**被动响应规则**：严禁任务中途停机索要 `/compact`，保持长任务连续推进，仅在用户已主动压缩后调用 `ctx_resume`；明确 `>60s` 与异步命令直走原生 `run_command` |
| **MCP 沙盒执行超时** | `ctx_execute` 硬编码 `30s` 强杀，无超时参数 | 默认超时提至 **`120s`**（`execTimeoutMs`），开放单次 `timeoutSec: 1..300`；超时显式返回 `timedOut: true` 与改用原生后台 `run_command` 指引 |
| **终端沙盒与异步后台流** | 统一改写吞流式日志；沙盒内缺插件读权限；Windows 仅杀父 Shell | `WaitMsBeforeAsync <= 2000ms`（`cliFilterAsyncBypassMs`）与 `IsDaemon` 直通原生流式后台；同步 `overwrite` 附带插件目录只读 `permissionOverrides`；补齐 Windows `taskkill /T /F` 与 POSIX `detached` 进程组树级回收 |
| **工具循环与动态水位预警** | 工具循环中段照常弹交接横幅；1M 模型 `60k` 即催交接 | 结合 `invocationNum >= 1` 与 `diag.inToolLoop` **在多步工具循环中段静默空闲 TTL 与冷压缩交接横幅**；`ttlMinContext` 对齐模型 `coldCompactTokens`（200k 模型保持 `60k`，1M 模型提至 **`300k`**） |
| **长轨迹读去重步距衰减** | 整场会话无限步距拦截未变更重读 | `file_reads` 记录轨迹步序 `read_step`，跨越 `readDedupMaxSteps`（默认 **`40` 步**）自动放行复核并刷新基线，避免深层长任务空耗 `MAX_INVOCATIONS` 步数 |

#### 3. 底层设计原理（为什么这样改，而不是一刀切关掉护栏与提醒）

1. **最高优先级 `<user_rules>` 严禁写入“模型无权自执行的祈使句”**：Antigravity 将 `AGENTS.md` 注入强制执行的系统规则层，而 `/compact` 只能由用户在输入框触发。一旦规则写成“在阶段边界压缩”，听话的模型唯一合规的行为就是在阶段末尾主动停机把接力棒交回用户；改为“绝不中途停机索要压缩、仅在用户压缩后恢复”，才能从源头消除自发阶段交接。
2. **严格区分「同步数据过滤」与「异步长任务托管」**：MCP `tools/call` 是同步请求-响应模型（受宿主调用时限与 5 分钟流空闲超时约束），适合 `<=120s` 的高噪日志/JSON 沙盒浓缩；而长构建、全量测试与持续进程依赖宿主后台 Task 的实时流式输出（`manage_task`）与完成事件回调，按 `WaitMsBeforeAsync <= 2000ms` 与 `>60s` 边界自动分流，才能兼顾短命令降噪与长任务不断流。
3. **终端沙盒最小权限原则（只读代码挂载 vs 状态库隔离）**：为解决沙盒内找不到 `~/.gemini/config/plugins/agy-dart/hooks/cli-filter.mjs` 触发沙盒外审批打断，绝不能把 `~/.agy-dart` 状态目录读写挂载进沙盒（否则不可信仓库的测试代码可篡改 `context.db`）。仅注入 `read_file(<PLUGIN_ROOT>)` 只读挂载插件不可变脚本，配合 `cli-filter` 写库 `try/catch` Fail-Open，实现了零审批中断与严格写隔离的统一。
4. **区分「用户真闲置（Turn Entry）」与「工具执行耗时（Mid-Turn Continuation）」**：当 `invocationNum >= 1` 且处于工具调用链（`inToolLoop`）时，`now - lastPlannerAt` 代表长工具或子代理的执行耗时而非用户离开，且执行中途用户无法输入 `/compact`；同时按模型窗口 `30%`（`coldCompactTokens`）动态缩放提醒门槛，彻底消除 1M 大窗口模型在 6% 低水位时的噪音干扰。
5. **注意力衰减窗口与步数预算平衡**：短步距（`<= 40` 步）内的重复读取属于纯上下文浪费，拦截收益极高；但跨越 40 步以上的深层长任务末尾，模型对早期文件细节的注意力已自然衰减，编辑前重读校对属于防幻觉刚需——按轨迹步距自动衰减放行，既保住高频去重 ROI，又守住单轮 `MAX_INVOCATIONS` 步数预算。

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
