# dsh-progress-beat

DeepSeek Harness（DSH）插件：**让 agent 在长时间「思考 + 工具调用」中途输出用户可见的进度说明**，而不是一路静默到任务结束才说话。

## 它解决什么问题

较新的 flash 类模型（如 1017 版本）在 agent 任务里倾向于「连续调用工具、只在最终答复时输出文本」。UI 上就表现为：几十分钟里只有工具卡片在滚，用户不知道模型在干什么。

本插件用三条互补的机制把进度说话重新塞回执行过程：

| 机制 | 挂载位置 | 作用 | 默认 | 节奏 |
|---|---|---|---|---|
| 常驻进度规则 | `ctx.systemPrompt.section()` | 每次请求都带上的常驻规则：预计多次调用时先说计划；进入新阶段或长时间没说明时先播报。 | 开 | `promptEvery`（文案里「每约 N 次」的 N）+ `sectionOrder`（插入位置，默认 4） |
| 用户轮提醒 | `agent/pre-step` → 该轮 `messages` | 按轮次注入一条提醒，提醒模型本轮边做边说。 | 关 | `nudgeEveryTurns`（每 N 轮一次，默认 1） |
| 沉默提醒 | `agent/pre-step` → 追加 notice | **按沉默算，不按调用总数算**：自上次播报以来累计 N 次调用、或沉默超过 T 秒，先到先算。 | 开 | `every`（默认 8 次）+ `silentSeconds`（默认 180 秒）+ `minGapSeconds` / `maxRemindersPerTurn` / `dripSeconds` |

默认开启的是**常驻规则 + 沉默提醒**：前者是每请求一段静态规则，后者只在模型真的沉默时才注入（200 次调用的实测是 6 条）。用户轮提醒默认关闭，打开后按 `nudgeEveryTurns` 的节奏在该轮入口 step 注入一条（默认每轮一次，同一轮的后续 step 不重复）。三路都关时插件只贡献一个 system prompt section，连 `agent/pre-step` 钩子都不注册。

三条都不改会话内容、不吞工具结果、不阻塞调用：注入的 notice 走 `source.form = 'notice'`，模型可见、带归属、可审计。

## 控制面板

插件列表里 `dsh-progress-beat` 这一行会多出一个**配置**入口，打开就是可视化表单，不用手改 YAML：

面板按**三个机制**分成三个可折叠分组，折叠态只留机制名与开关，展开才露出该机制的细项：
| 分组（开关字段） | 组内控件 | 说明 |
|---|---|---|
| **常驻进度规则**<br>`injectPrompt` | `promptText` | 规则文本，支持 `{{every}}` |
| | `promptEvery` | 规则文本里「每累计约 N 次」的 N（2–50，默认 6）。只决定过程播报的节奏，开局的「先说打算怎么做」不跟它走 |
| | `sectionOrder` | `systemPrompt.section()` 的排序号（默认 4：人设 0、其它插件指令 2、工具声明 100 起） |
| **用户轮提醒**<br>`nudgeOnUserTurn` | `userTurnText` | 随用户输入注入的文本，支持 `{{every}}` |
| | `nudgeEveryTurns` | 每几轮提醒一次：1 表示每轮，3 表示每三轮（1–20） |
| **沉默提醒**（默认开）<br>`nudgeOnToolCalls` | 节奏预设 | 安静 12 / 标准 8 / 密集 4（同时填 `every` 与 `promptEvery`） |
| | `every` | 沉默调用阈值：自上次播报以来累计多少次调用触发（2–100，默认 8） |
| | `silentSeconds` | 沉默时间阈值（秒）：超过这么久没播报也提醒（默认 180） |
| | `maxRemindersPerTurn` | 每轮提醒预算；0 表示关掉这一路，非 0 时预算用尽后会降级成慢速提醒 |
| | `nudgeText` | 命中阈值时注入的文本，支持 `{{count}}` / `{{seconds}}` / `{{every}}` / `{{remind}}` |
| | 高级：`minGapSeconds` / `dripSeconds` | 两条提醒的最小间隔（默认 60 秒）／预算用尽后的慢速间隔（默认 300 秒） |
面板是「暂存 + 保存」模型：改动先留在表单里，点**保存**才写入；每个字段可单独**重置**回默认，也可以**全部重置**。字段旁出现「已覆盖」徽标表示它被用户改过、不再跟随默认值。

保存走宿主的 settings 服务，写进 profile 的 `cordis.patch.yml` 并由 Loader 热应用——面板保存即生效，重启后仍然有效。插件侧的 `Config` schema 是这一切的依据：宿主把它投影成表单（`ctx.configForms`），面板只负责渲染与暂存，不自建存储。

> Config 里每个字段都声明了 `.volatile()`：宿主只把 volatile 字段投影成可编辑表单，漏掉时该命名空间根本不会出现在表单列表里，写入会被拒绝（面板上表现为「宿主没有接受这次写入」）。volatile 的变更由 Loader 就地推进运行中的引用，不会重跑插件的 `apply`，所以插件自己监听 `loader/volatile-update` 重建 system prompt 规则与钩子——保存后面板提示的「已热应用」指的就是这一步。

> 面板注册在插件管理页的 `plugins.row.config` 插槽，键为 `dsh-progress-beat#dsh-progress-beat`。浏览器半侧随 Loader 行走，关掉这一行面板也随之消失。

## 配置

控制面板改的就是下面这份 Config；也可以直接在 profile patch 里写：

```yaml
- insert:
    - id: dsh-progress-beat
      name: 'dsh-progress-beat'
      inject: [systemPrompt]
      config:
        # ① 常驻进度规则（system prompt section）
        injectPrompt: true        # 是否注册常驻规则
        promptEvery: 6            # 规则文本里「每累计约 N 次」的 N（2–50，仅影响过程播报）
        sectionOrder: 4           # section 排序号（0–99，默认 4，工具声明在 100 起）
        # ② 用户轮提醒（agent/pre-step）
        nudgeOnUserTurn: false    # 是否随用户输入注入（默认关）
        nudgeEveryTurns: 1        # 每几轮提醒一次：1 每轮，3 每三轮（1–20）
        # ③ 沉默提醒（agent/pre-step，按沉默而非调用总数）
        nudgeOnToolCalls: true    # 是否开启（默认开）
        every: 8                  # 沉默调用阈值：自上次播报以来累计多少次调用（2–100）
        silentSeconds: 180        # 沉默时间阈值（秒），与调用次数先到先算
        maxRemindersPerTurn: 6    # 每轮预算；0 表示关掉这一路
        minGapSeconds: 60         # 两条提醒之间的最小间隔（秒）
        dripSeconds: 300          # 预算用尽后的慢速提醒间隔（秒），不会彻底静音
        # promptText / userTurnText / nudgeText 可整段替换，支持 {{every}} / {{count}} / {{seconds}} / {{remind}} 占位
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
