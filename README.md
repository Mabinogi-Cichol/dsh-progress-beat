# dsh-progress-beat

DeepSeek Harness（DSH）插件：**让 agent 在长时间「思考 + 工具调用」中途输出用户可见的进度说明**，而不是一路静默到任务结束才说话。

## 它解决什么问题

较新的 flash 类模型（如 1017 版本）在 agent 任务里倾向于「连续调用工具、只在最终答复时输出文本」。UI 上就表现为：几十分钟里只有工具卡片在滚，用户不知道模型在干什么。

本插件用两条互补机制把进度说话重新塞回执行过程：

| 机制 | 挂载位置 | 作用 |
|---|---|---|
| 进度规则 | `ctx.systemPrompt.section()`（order 4） | 每次请求都带上的常驻规则：预计多次调用时先说计划；每约 N 次工具调用或进入新阶段，先说 1–2 句进度再继续。 |
| 兜底提醒 | `tools/post-execute` → `additionalContexts` | 按工具调用次数计数，每 N 次注入一条 `notice`。模型想沉默也会被硬提醒一次，同时会话里留下一条可见的合成消息。 |

两条都不改会话内容、不吞工具结果、不阻塞调用：注入的 notice 走 `source.form = 'notice'`，模型可见、带归属、可审计。

## 配置

```yaml
- insert:
    - id: dsh-progress-beat
      name: 'dsh-progress-beat'
      inject: [systemPrompt]
      config:
        every: 4                    # 累计多少次工具调用后强制播报（>=2）
        maxRemindersPerTurn: 12     # 单轮最多注入多少次提醒，防刷屏 / 刷 token
        injectPrompt: true          # 是否注册 system prompt 规则
        # promptText / nudgeText 可整段替换，支持 {{every}} / {{count}} 占位
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

装完确认 profile 的 `package.json` 里 `dsh.profile.bundles` 含 `dsh-progress-beat`。运行中的 loader 会热加载新增条目；若 UI 的「插件列表」没刷新，切走再切回该标签页（它只在挂载时拉一次快照）。

> 注意：桌面版 GUI 启动的是 `desktop` profile（`%USERPROFILE%\.dsh\profiles\desktop`），`dsh web` 用的是 `web` profile。装错 profile 时插件在界面上完全不可见——「插件列表」是 cordis loader 条目的只读投影。

## 卸载

```powershell
dsh plugin --profile desktop remove dsh-progress-beat
# 并从 profile package.json 的 dsh.profile.bundles 中删掉同名条目
```

## 自测

```powershell
node test\smoke.mjs
```

覆盖：section 注册与占位符替换、注入节奏、单轮配额、`block` 分支透传、无 agent 直连调用不计数、新用户提示词清零、关闭 prompt 注入。

## 限制

进度是否「说得好」本质仍是模型行为，插件只能通过常驻规则 + 周期提醒提高概率，不能 100% 程序化锁死。想让节奏更密就把 `every` 调到 2–3；觉得吵就调到 6–8 或把 `injectPrompt` 关掉只留兜底提醒。
