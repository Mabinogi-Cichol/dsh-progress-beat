# dsh-progress-beat

DeepSeek Harness（DSH）插件：**让 agent 在长时间「思考 + 工具调用」中途输出用户可见的进度说明**，而不是一路静默到任务结束才说话。

## 它解决什么问题

较新的 flash 类模型（如 1017 版本）在 agent 任务里倾向于「连续调用工具、只在最终答复时输出文本」。UI 上就表现为：几十分钟里只有工具卡片在滚，用户不知道模型在干什么。

本插件用三条互补的机制把进度说话重新塞回执行过程：

| 机制 | 挂载位置 | 作用 | 默认 |
|---|---|---|---|
| 进度规则 | `ctx.systemPrompt.section()`（order 4） | 每次请求都带上的常驻规则：预计多次调用时先说计划；进入新阶段时先说 1–2 句进度再继续。 | 开 |
| 用户轮提醒 | `agent/pre-step` → 该轮 `messages` | 每条用户输入时，随这一轮的消息注入一条提醒。 | 关 |
| 工具调用提醒 | `tools/post-execute` → `additionalContexts` | 按工具调用次数计数，每 N 次注入一条。模型想沉默也会被硬提醒一次。 | 关 |

默认只保留进度规则：两路注入都关闭时，插件只贡献一个 system prompt section，连 `agent/pre-step` 钩子都不注册。打开用户轮提醒后，每个 turn 在入口 step 注入一条（同一轮的后续 step 不重复）；打开工具调用提醒后，另外按次数注入。

三条都不改会话内容、不吞工具结果、不阻塞调用：注入的 notice 走 `source.form = 'notice'`，模型可见、带归属、可审计。

## 控制面板

插件列表里 `dsh-progress-beat` 这一行会多出一个**配置**入口，打开就是可视化表单，不用手改 YAML：

| 控件 | 字段 | 说明 |
|---|---|---|
| 随用户输入提醒 | `nudgeOnUserTurn` | 每条用户输入时注入一条提醒（默认关） |
| 用户轮提醒文本 | `userTurnText` | 随用户输入注入的文本，支持 `{{every}}` |
| 按工具调用注入 | `nudgeOnToolCalls` | 额外按调用次数注入（默认关） |
| 节奏预设 | `every` | 一键切换 安静 8 / 标准 4 / 密集 2 |
| 播报步频 | `every` | 每多少次工具调用注入一条（2–50，仅上面开关开启时生效） |
| 单轮提醒上限 | `maxRemindersPerTurn` | 每个计数周期内最多注入多少条；0 表示关掉这一路 |
| 常驻进度规则 | `injectPrompt` | 是否注册 system prompt 规则 |
| 常驻规则文本 | `promptText` | 支持 `{{every}}` 占位符 |
| 工具调用提醒文本 | `nudgeText` | 支持 `{{every}}` / `{{count}}` 占位符 |

面板是「暂存 + 保存」模型：改动先留在表单里，点**保存**才写入；每个字段可单独**重置**回默认，也可以**全部重置**。字段旁出现「已覆盖」徽标表示它被用户改过、不再跟随默认值。

保存走宿主的 settings 服务，写进 profile 的 `cordis.patch.yml` 并由 Loader 热应用——面板保存即生效，重启后仍然有效。插件侧的 `Config` schema 是这一切的依据：宿主把它投影成表单（`ctx.configForms`），面板只负责渲染与暂存，不自建存储。

> 面板注册在插件管理页的 `plugins.row.config` 插槽，键为 `dsh-progress-beat#dsh-progress-beat`。浏览器半侧随 Loader 行走，关掉这一行面板也随之消失。

## 配置

控制面板改的就是下面这份 Config；也可以直接在 profile patch 里写：

```yaml
- insert:
    - id: dsh-progress-beat
      name: 'dsh-progress-beat'
      inject: [systemPrompt]
      config:
        nudgeOnUserTurn: false      # 每条用户输入时注入一条提醒（默认关）
        nudgeOnToolCalls: false     # 额外按工具调用次数注入（默认关）
        every: 4                    # nudgeOnToolCalls 开启时，每多少次调用注入一条
        maxRemindersPerTurn: 12     # 每个计数周期最多注入多少条，0 表示关掉这一路
        injectPrompt: true          # 是否注册 system prompt 规则
        # promptText / userTurnText / nudgeText 可整段替换，支持 {{every}} / {{count}} 占位
```

## 安装

> profile 名按你的入口选：桌面版 GUI 启动的是 `desktop` profile，`dsh web` / 浏览器版用的是 `web` profile。

**方式一：从 GitHub 直接装（推荐）**

```powershell
dsh plugin --profile desktop add github:Mabinogi-Cichol/dsh-progress-beat
```

**方式二：本地克隆后装**

```powershell
git clone git@github.com:Mabinogi-Cichol/dsh-progress-beat.git
dsh plugin --profile desktop add <克隆目录的绝对路径>
```

装完确认 profile 的 `package.json` 里 `dsh.profile.bundles` 含 `dsh-progress-beat`。运行中的 loader 会热加载新增条目；若 UI 的「插件列表」没刷新，切走再切回该标签页（它只在挂载时拉一次快照），或刷新页面让浏览器半侧重新入图。

> 注意：桌面版 GUI 启动的是 `desktop` profile（`%USERPROFILE%\.dsh\profiles\desktop`），`dsh web` 用的是 `web` profile。装错 profile 时插件在界面上完全不可见——「插件列表」是 cordis loader 条目的只读投影。

**依赖解析**：Host 半侧 import `@deepseek-ai/schemastery`（Config schema 需要可投影的 schema 对象）。以 `link:` 方式安装时，Node 从仓库目录向上解析，因此本机需要一个指向 DSH 安装的 `node_modules`：

```powershell
$target = "<DSH>\resources\app\dsh\node_modules\@deepseek-ai"
New-Item -ItemType Junction -Path .\node_modules\@deepseek-ai -Target $target
```

`node_modules/` 已在 `.gitignore` 内。缺少这一步时插件加载失败、进度播报整体不生效，而不仅是面板。

## 卸载

```powershell
dsh plugin --profile desktop remove dsh-progress-beat
# 并从 profile package.json 的 dsh.profile.bundles 中删掉同名条目
```

## 自测

```powershell
node test\smoke.mjs          # Host：注入节奏、配额、block 透传、轮次清零
node test\panel-smoke.mjs    # Client：注册键、注入面、summary/page 两视图
```

`smoke.mjs` 覆盖：section 注册与占位符替换、注入节奏、单轮配额、`block` 分支透传、无 agent 直连调用不计数、新用户提示词清零、关闭 prompt 注入。

`panel-smoke.mjs` 用 mock 的 ModuleLoader 与 React 执行浏览器半侧，覆盖：factory 能被 `load()` 接收、`apply` 不抛错、面板注册到 `plugins.row.config` 且键为 `<包名>#<行 id>`、注入面含表单控制器、五个字段与保存控件都被渲染。

## 限制

进度是否「说得好」本质仍是模型行为，插件只能通过常驻规则 + 周期提醒提高概率，不能 100% 程序化锁死。想让节奏更密就把 `every` 调到 2–3；觉得吵就调到 6–8 或把 `injectPrompt` 关掉只留兜底提醒。
