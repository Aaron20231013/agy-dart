<div align="center">

<img src="assets/logo.svg" alt="agy-dart logo" width="80" />

# agy-dart

**省 token · 优化缓存命中 · 自动保持缓存温度 · 优化上下文额度 · 抢救崩掉的会话**

不用额外装依赖 · 装好自动在后台工作 · 自带右侧面板

[![License: MIT](https://img.shields.io/badge/License-MIT-10b981.svg)](LICENSE)
[![Node.js >= 22](https://img.shields.io/badge/Node.js-%3E%3D22-38bdf8.svg)](package.json)
[![Security Policy](https://img.shields.io/badge/Security-Policy-818cf8.svg)](SECURITY.md)
[![Glama MCP](https://glama.ai/mcp/servers/zou172866/agy-dart/badges/score.svg)](https://glama.ai/mcp/servers/zou172866/agy-dart)

简体中文 · [English](README.md) · [怎么安装](#怎么安装) · [更新日志](#更新日志) · [安全说明](SECURITY.md) · [开源致谢](THIRD_PARTY_NOTICES.md)

</div>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/architecture-dark.zh-CN.svg" />
    <source media="(prefers-color-scheme: light)" srcset="assets/architecture-light.zh-CN.svg" />
    <img alt="agy-dart 架构示意图" src="assets/architecture-dark.zh-CN.svg" width="860" />
  </picture>
</p>

<p align="center">
  <img alt="开启 agy-dart 前后对比" src="assets/demo-comparison.zh-CN.svg" width="860" />
</p>

---

## 这个插件是干什么的？

省 token，优化缓存命中，自动保持缓存温度，优化上下文额度，必要时可以救因为爆上下文崩掉等原因的会话。

装好之后在后台自动生效，不用记新命令，平时照常打字聊天就行：

### 1. 整合动作
AI 要搜好几个词时一次同时搜完，要改多个文件时一次改完并顺手跑完测试，少跑好几轮重复带上下文的请求。

### 2. 挡住废话
跑一次测试吐出 3000 行日志，插件只挑关键那几句给 AI（比如第 42 行报错，其余 199 个通过），完整原文存进本地备查。遇到几千行的大代码文件，先拉目录再读要改的那几十行。

### 3. 优化缓存命中，自动保持缓存温度
稳住对话开头结构提高缓存命中率；同一个文件没改过，短时间内不让 AI 重复重读。你临时离开、缓存快过期时，可以弹窗提醒，或者在到期前自动发个极轻的信号延长缓存时间（默认每段对话最多自动续 3 次，发新消息归零）。

### 4. 右侧面板与崩溃/卡死抢救
右侧边栏面板直接显示：上下文还有多少、缓存还剩几分钟过期、挡掉了多少废话。
多开项目窗口时，哪个后台窗口上下文快满了，或者一直转圈不出字，右下角会弹窗标明是哪个窗口、哪段对话，点一下弹窗直接切过去。会话真因为爆上下文崩掉或卡死时，在面板点一下复制当前进度摘要，贴到新对话接着往下做。

### 其他内置功能
1. **压缩对话（`/compact`）后恢复上下文线索**：后台记录本轮改过哪些文件、最近一次测试或打包过没过、存过哪些参考资料。跑完 `/compact` 后 AI 可以直接调出这份记录接着做。
2. **长文档与网页存本地检索**：几万字的开发文档或网页可以先按章节存进本地数据库，后面用到哪段按关键词搜哪段。
3. **大日志与大表格先在本地跑脚本筛选**：遇到几十 MB 的日志、CSV 或几万行 JSON，AI 可以在本地沙盒跑几行脚本先做统计（比如筛出报错最多的 5 个接口），只把算出来的结果发回对话；大 JSON 还会自动摘出报错的异常条。
4. **新对话自动附带目录结构**：刚开对话时自动给出一份精简的项目目录、脚本和核心文件清单。
5. **死循环提示**：AI 连续出现「改代码 → 报错 → 改回去 → 又报错」或反复调同一个工具没进展时，在聊天界面弹一行只给用户看的提示（不塞进模型上下文）。
6. **密钥打码、敏感文件与 Git 沙盒防护**：日志或网页里的 API Key、口令自动打码；可拦截 AI 误读 `.env` 等配置文件，并封堵陌生仓库 `.git/config` 挂载外部命令的入口。
7. **单次返回卡在 8.8 KB 以内（智能匀配额）**：Antigravity 工具单次返回超过约 10 KB 会自动落成临时文件让 AI 多读一轮；插件把返回内容控制在 8.8 KB 内，并自动把短检查省下的空间让给真正报错的长堆栈。
8. **面板细分统计与离线测算**：右侧面板能查看上下文花在读文件、终端输出还是子智能体上，以及最近 15 轮缓存命中走势和失效原因；可选开启大文件修改后只读改动行（默认关闭）；命令行支持拿历史记录测算缓存命中与自动续期账本。

> Antigravity 官方更新很勤，可以点一下右上角 **Star** 方便跟进后续兼容更新。

---

## 怎么安装

需要 **Node.js 22 或更高版本**（不用跑 `npm install`）。

### 方法一：终端一行命令直装（免手动克隆）

**Windows（PowerShell）：**

```powershell
irm https://raw.githubusercontent.com/zou172866/agy-dart/main/install.ps1 | iex
```

**macOS / Linux：**

```bash
curl -fsSL https://raw.githubusercontent.com/zou172866/agy-dart/main/install.sh | sh
```

### 方法二：直接发给 Antigravity 装

复制这句发给 Antigravity：

```text
请将 https://github.com/zou172866/agy-dart.git 克隆到临时目录，运行其中的 scripts/install.mjs install 完成全局安装并跑 doctor 自检（Windows 如未安装 rg 请同时传 --install-rg）。
```

### 方法三：克隆仓库自定义安装

```powershell
git clone https://github.com/zou172866/agy-dart.git
cd agy-dart

# Windows PowerShell（加 -InstallRg 可顺手自动安装快速搜索工具 rg）
.\install.ps1 -InstallRg

# macOS / Linux
./install.sh
```

**其他命令：**

```bash
node scripts/install.mjs install                     # 全局安装（若本机存在 GEMINI_HOME 或 T3 ACP 目录会自动同步）
node scripts/install.mjs install --project /项目路径  # 只装到单个项目
node scripts/install.mjs doctor                      # 检查安装状态
node scripts/install.mjs uninstall                   # 卸载
```

装完重启或刷新一下 Antigravity 窗口，新开对话生效。升级重装时会自动保留插件目录下你自建的 `rules/*.local.md`。以前单独装过 `agy-fast` 或 `antigravity-plugin-context-mode` 的话，去插件列表关掉旧的。

---

## 设置调节

自动加热默认关闭。需要时，在右侧 **agy-dart Context** 面板为当前窗口打开“自动续温”。“全局加热”控制所有跟随全局设置的窗口。每次加热都会请求模型回复 `OK` 并产生输入用量，缓存未命中时可能重新处理整段历史。面板也可设置桌面提醒、暂停保护、清理旧记录和调整文件大小限制。

也可以用命令切拦截档位与工具加载方式：

```bash
node scripts/install.mjs mode host-45k              # 默认：普通代码 45 KB、补丁 128 KB 内直读，大日志超 16 KB 拦截
node scripts/install.mjs mode balanced-16k          # 超过 16 KB 先看目录挑重点读
node scripts/install.mjs mode fast-32k              # 普通文件放宽到 32 KB
node scripts/install.mjs mode strict-8k             # 超过 8 KB 拦截
node scripts/install.mjs mode no-read-hook          # 读文件不拦，只拦终端刷屏大日志

node scripts/install.mjs tool-loading fast-eager    # 默认：4 个高频 fast 工具直连预载，8 个 context 工具按需懒加载
node scripts/install.mjs tool-loading lazy          # 12 个工具全部按需懒加载
node scripts/install.mjs tool-loading eager         # 12 个工具全部预载
```

---

## 更新日志

### v1.6.0
- **常用 4 个工具改为默认直连，修好多文件修改偶发丢内容问题**：批量搜索、看目录、改文件、跑检查 4 个高频工具默认直接预载，避开中转层偶尔把多文件改动清空的问题；其余 8 个大日志工具保持按需加载省初始额度（可用 `tool-loading` 切换）。
- **修好缓存自动续期失效，彻底跳过后台子智能体**：清理旧面板进程残留的全局关闭冲突并加防重锁，更新插件后后台面板会自动重启生效；`/boost`、浏览器、工作流派出的子智能体和已关闭的旧对话一律不再发续期请求，也不再挤占面板顶部的续期状态栏。
- **子智能体读文件直接放行，防误改插件目录**：后台子智能体读大文件或重读文件不再弹红字拦截；未传路径误落入插件安装目录时直接拦住，防止误搜或误改插件自身文件。
- **支持一行命令免下载直装**：新增 PowerShell 与 Shell 一行安装命令，不用先手动克隆仓库。
- 换用跨平台通用钩子启动方式；短检查省下的字数额度自动让给长报错堆栈；Git 查询限制只读防外部挂载命令；修 Windows 退出卡死，升级保留 `rules/*.local.md`，补安全说明与深浅色架构图。

### v1.5.4
- **点击提醒直达对应会话**：点右下角弹窗或右侧面板里的跨窗口告警，自动切出对应项目窗口并跳进那段对话；面板新增多窗口会话切换栏。
- **缓存自动续期**：主对话缓存快到期前自动发轻量信号延长热度（自动跳过后台子智能体与批处理任务），面板顶部可按对话独立开关、调次数（默认最多 3 次，发新消息归零）。
- 把当前上下文用量、缓存倒计时和已拦废话量放大移到面板第一栏。

### v1.5.3
- **多窗口弹窗标明项目与对话标题**：右下角提醒和面板告警直接显示目录名（如 `work/agy-dart`）与会话短标题，不露聊天正文。
- **上下文快满了弹窗提醒**：接近上限时右下角提醒一次，跑完 `/compact` 自动重置。

### v1.5.2
- 加快读文件与新对话启动；支持提取几千行 `.html` / `.astro` 和 `.dart` 的代码目录；修 Windows 下 Python / PowerShell 中文乱码，面板切后台自动停刷。

### v1.5.1
- 补全中文面板漏译词；调准文件修改后的拦截建议。

### v1.5.0
- **读取模型实际缓存过期时间**：按近期使用记录读取当前模型的实际缓存过期时间（如 5 分钟或 15 分钟），新开对话直接沿用。
- 新增可选的缓存临期桌面提醒（过期前 1 分钟弹窗），命令行加入自动续期成本测算。

### v1.4.0
- **卡死检测与抢救摘要**：后台发现对话长时间转圈不出字时（避开长打包和电脑休眠），面板标红指出卡在哪一步，并自动生成进度摘要（改过的文件、最后执行的命令、当前步骤），可一键复制去新对话继续。

### v1.3.1
- 跑完 `/compact` 压缩后立即可重读文件；4 KB 以下小切片免拦截；长报错日志额外保留中段报错行。

### v1.3.0
- **分档放行读文件**：普通代码放宽到 45 KB（800 行）、`.patch` 补丁放宽到 128 KB 直读，刷屏日志维持 16 KB 拦截；超限重试一次放行，审补丁和子代理不再卡住。
- 支持列出 `.patch` 改动目录，精简 `git diff` 时保留上下文行。

### v1.2.2
- **长任务不断流**：去掉中途催用户 `/compact` 的旧规则，超过 1 分钟的测试、打包和后台服务直走原生后台通道。
- 挡住误读 `.env`、修 Windows 特殊符号与残留子进程等 42 项问题。

### v1.2.1
- 多文件同时修改出错自动回滚，修路径与命令参数等 76 项稳定性问题。

### v1.2.0
- 配置统一存进 `~/.agy-dart/config.json`；本地面板接口加安全校验；**超大 JSON 自动提取结构、首尾样本与报错项**；新增 `gh`、`kubectl`、`terraform`、`playwright` 输出精简与交接摘要。

### v1.1.0
- **终端输出自动瘦身**：自动清掉 `git`、测试、打包、安装命令里的进度条和刷屏内容，原文存本地备查。
- 同文件未改动防重复读取；AI 反复改错原地打转时给出界面提示；抓网页拦内网地址、日志密钥自动打码、面板一键清理旧数据。

---

## 本地自检命令

```bash
npm test                                    # 跑全套测试
npm run verify:pkg                          # 检查安装包文件完整性
npm run prefix:budget                       # 分别估算 Antigravity 配置的首轮占用和全部工具加载后的占用
npm run cache:audit -- --workspace . --no-live
npm run cache:simulate
```

---

## 致谢与开源协议

[MIT 协议](LICENSE) 开源。部分代码整合改造自同为 MIT 协议的 [INK-Q/agy-fast](https://github.com/INK-Q/agy-fast) 与 [Domush/antigravity-plugin-context-mode](https://github.com/Domush/antigravity-plugin-context-mode)，完整第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## v1.7 CLI

默认安装到 Antigravity。显式使用 `--target claude` 或 `--target codex` 选择其他宿主。`outline <文件>` 输出签名与行号，`session <ID>` 和 `compare <前> <后>` 分析会话账单。

```sh
npx agy-dart install
npx agy-dart doctor
```
