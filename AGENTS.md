# AGENTS.md

本仓库的改动约定，给在这里写代码的 agent 与维护者。

## 发版与更新

DSH 插件市场判断「有没有更新」看的是 `package.json` 的 `version`，不是提交。

依据：`dsh-market` 的 `gitVersionUpdate`（上游 #824）——浮动 GitHub 安装会比较远端默认分支 `HEAD` 上 `package.json` 的 `version` 与已装版本；只有读不到版本时，才退回比较 commit。

因此：

- **日常提交不要动 `version`。** 市场不会提示更新，只会把这类提交记成 `unreleasedCommit`（有提交、未发版）。
- **只在发版时 bump `version`**，并且与 tag 放在同一个提交里。
- tag 名与 `version` 保持一致（`v0.3.0` ↔ `0.3.0`），别让 tag 和市场判定对不上。

发版流程：

```powershell
# 1. 改 package.json 的 version（例如 0.2.0 → 0.3.0）
# 2. 提交
git commit -am "chore: 0.3.0"
# 3. 打同名 tag 并推送
git tag -a v0.3.0 -m "v0.3.0"
git push origin main --follow-tags
```

### 两个会让判定失效的做法

1. **不要用 `#分支` / `#tag` / `#semver:` 安装**，例如 `github:Mabinogi-Cichol/dsh-progress-beat#main`。带 ref 的 spec 会跳过版本比较、退回 commit 比较，于是每次 push 都被当成更新。README 里也不要这样推荐。
2. **不要给市场条目加 `tarball:` 字段**（`awesome-dsh-plugin` 仓库的 `data/plugins/*.yml`）。加了之后市场改用 archive 安装，而 archive 的更新判定是「仅当条目同时映射了同名 npm 包才检查」，等于不再提示更新。

## 提交前

DSH 的启动是全有或全无：一个加载失败的插件会让整个进程起不来，用户只看得到崩溃框。所以推之前至少跑一遍：

```powershell
node --check lib\index.js
node --check client.js
node test\smoke.mjs
node test\panel-smoke.mjs
node test\config-form.mjs
node test\host-settings.mjs
node test\scenarios.mjs
```

后两个测试分别固定「Config 字段必须是 volatile」与「宿主 dsh-settings 确实接受本插件写入」；它们会直接 import 宿主的 `@deepseek-ai/dsh-settings`、`@deepseek-ai/cordis`，走的是同一个 `node_modules/@deepseek-ai` junction。`test/scenarios.mjs` 用假时钟跑「调用速度 × 播报习惯」的固定剧本，钉住每条提醒的落点——改默认参数时它会立刻告诉你节奏变了。

## 插件装的坑

- `dsh.client` 里**不要**加 `immediately: true`：启动会把这个 entry 当成必须激活项，激活不了就直接报 `web boot: N entry did not activate` 并终止启动。判定逻辑在 `dsh-app-boot` / 前端 boot，`immediately` 的 entry 被视为 required。
- 浏览器半侧要注册到 **`plugins.bundle.config`**（键为包名）才会显示在组合包页面上；`plugins.row.config`（键 `<包名>#<行 id>`）只给那一行加一个「配置」控件，两者不是一回事。
- `configForms` 应当作为**可选**服务获取（`ctx.get('configForms')`），不要放进 `inject`：放进去而宿主未提供时，整个面板会静默不出现。
- **`Config` 的每个字段都要 `.volatile()`**。宿主 `dsh-settings` 的 `volatileForm()` / `isVolatilePath()` 只投影 volatile 字段：没有 volatile 的命名空间根本不出现在 `describe()` 里，写入会抛 `Plugin entry "<ns>" has no volatile fields`，面板上只表现为「宿主没有接受这次写入」——没有任何地方提示「你漏了 volatile」。`test/host-settings.mjs` 里有一份反例对照固定这个症状。
- volatile 字段在 `apply(ctx, config)` 里是**引用对象**（`{ get(), [write] }`）而不是值，直接参与运算会得到 `[object Object]`。
- 只改 volatile 字段的配置变更**不会重跑 `apply`**：Loader 把新值就地写进运行中 fiber 的引用，然后广播 `loader/volatile-update`。插件必须自己监听这个事件按新值重建挂载点（本插件的 `sync()`），否则「保存成功但行为没变」。
- 面板保存的失败分支不要用闭包里的 `error` 判断（它是上一次渲染的值），否则具体报错会被通用文案覆盖——这正是最初只看到「宿主没有接受这次写入」的原因之一。
- 面板的三个机制组是原生 `<details>`/`<summary>`。`<summary>` 里的开关按钮必须 `preventDefault()` + `stopPropagation()`，否则点开关会连带把分组折叠起来。
- 三个「节奏」概念语义不同，别合并：`promptEvery` 只决定常驻规则/用户轮文案里 `{{every}}` 展开成几；`every` 是**沉默调用阈值**（自上次播报以来累计多少次调用）；`nudgeEveryTurns` 是用户轮提醒的轮次间隔。节奏预设会同时写 `every` 与 `promptEvery`。
- 沉默提醒的判定全在 `agent/pre-step`，不再用 `tools/post-execute`：调用数从会话里数（`role === 'tool'` 的消息，遇到带文字的 assistant 消息即停），所以「模型说过话」天然把计数与计时一起归零。别把计数改成独立累加器，否则会丢掉「按沉默算」这个核心性质。
- 沉默提醒有四道闸门，顺序是：双阈值触发（调用数 / 沉默秒数）→ `minGapSeconds` → 每轮预算 → 预算用尽后的 `dripSeconds` 慢速滴灌。预算打满**不等于**静音，这个区分是设计要点，别写回「超预算即 return」。它默认开启（`nudgeOnToolCalls: true`），用户轮提醒默认关闭；改默认值时记得同步 `lib/index.js` 的 `DEFAULTS`、`client.js` 的 `FALLBACK`、`cordis.patch.yml` 和 README 四处。
- 时钟统一走 `ctx.get('time')?.now()`（缺席时回退 `Date.now()`），测试靠它在 pre-step 里注入假时间；判定里不要直接调 `Date.now()`；`resolveConfig` 对所有节奏字段都有硬下限（`minGapSeconds` ≥ 10、`silentSeconds` ≥ 30、`dripSeconds` ≥ 60），测试里写 0 会被回落到默认值。
- 本地以 `link:` 安装时，`import '@deepseek-ai/schemastery'` 解析不到宿主包，需要一个指向 dsh 安装目录的 `node_modules/@deepseek-ai` junction（该目录已在 `.gitignore` 内）。
- 宿主只对**配置文件**（profile patch）开 HMR（`hmr.config.root: []`，模块根是 opt-in）。改了 `lib/index.js` / `client.js` 后必须重载插件行或重启 DSH：浏览器侧刷新只能拿到新的客户端模块，宿主半侧的 schema 还是旧的。
