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

## 设计来源与开源致谢（Credits & Inspirations）

本项目站在以下三个优秀开源项目的肩膀上二次整合开发，特此致谢并明确注明借鉴边界（完整许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）：

| 项目 | 协议 | 借鉴 / 复用内容 | `agy-dart` 的融合改造 |
| :--- | :---: | :--- | :--- |
| **[INK-Q/agy-fast](https://github.com/INK-Q/agy-fast)** | MIT | 复用其零依赖 4 工具批处理引擎（`batch_search`、`apply_edits`、`read_slices`、`run_checks`）、`SessionStart` 仓库快照、`<=8.8 KB` 零溢盘规范、多模态 TTFT 卫生规则与本地 `benchmark.mjs` | 封装为插件内 `agy-dart_fast` 服务，合并进统一启动钩子（关闭上游覆盖式自更新），并与上下文护栏共享一套路由仲裁表 |
| **[Domush/antigravity-plugin-context-mode](https://github.com/Domush/antigravity-plugin-context-mode)** | MIT | 复用并改造其零依赖 `node:sqlite` FTS5（Porter BM25 + Trigram RRF）引擎、8 个 `ctx_*` 工具、`PreToolUse` 护栏与 Aux Pane Sidecar 实时面板 | 封装为 `agy-dart_context` 服务，修复 `${PLUGIN_ROOT}` 路径、补全 `sidecars/` 安装、消除硬编码作者路径、单次 Hook 复用 SQLite 连接、默认阈值调至 **16 KB / 410 行**、强制截断响应 **`<= 8.8 KB`**、独立数据库 `~/.agy-dart/context.db` |
| **[mksglu/context-mode](https://github.com/mksglu/context-mode)** | Elastic-2.0（**不含其代码**） | 借鉴其开创的“Thinking in Code”沙盒过滤思想、双 FTS5 索引 RRF 融合范式，以及 v2 中豁免 Agent 自用 `SKILL.md`/规则文件的工程设计 | 仅架构思想参考，零代码引入；据此为 `PreToolUse` 新增 `SKILL.md` / `AGENTS.md` / `GEMINI.md` 与内置技能目录自动白名单 |

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
# 全局安装到 ~/.gemini/config/plugins/agy-dart
node scripts/install.mjs install --mode balanced-16k

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
# 运行本仓库端到端集成测试（双 MCP 握手、8.8 KB 硬封顶、16 KB 策略、SKILL.md 白名单、安装器干跑）
npm test

# 跑几天真实任务后，离线分析本地 Antigravity 轨迹的轮次/缓存/额度收益（纯本地，不上传任何数据）
node ~/.gemini/config/plugins/agy-dart/fast/benchmark.mjs analyze --local --recent 10
```

---

## 开源协议

本项目基于 [MIT License](LICENSE) 开源；复用组件保留其原有 MIT 版权声明，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
