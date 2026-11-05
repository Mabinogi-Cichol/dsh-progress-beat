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
```

## 插件装的坑

- `dsh.client` 里**不要**加 `immediately: true`：启动会把这个 entry 当成必须激活项，激活不了就直接报 `web boot: N entry did not activate` 并终止启动。判定逻辑在 `dsh-app-boot` / 前端 boot，`immediately` 的 entry 被视为 required。
- 浏览器半侧要注册到 **`plugins.bundle.config`**（键为包名）才会显示在组合包页面上；`plugins.row.config`（键 `<包名>#<行 id>`）只给那一行加一个「配置」控件，两者不是一回事。
- `configForms` 应当作为**可选**服务获取（`ctx.get('configForms')`），不要放进 `inject`：放进去而宿主未提供时，整个面板会静默不出现。
- 本地以 `link:` 安装时，`import '@deepseek-ai/schemastery'` 解析不到宿主包，需要一个指向 dsh 安装目录的 `node_modules/@deepseek-ai` junction（该目录已在 `.gitignore` 内）。
