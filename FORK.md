# 本 fork 的修改与安装

本仓库从 [hr98w/dsh-memory](https://github.com/hr98w/dsh-memory) 分叉。未在下文列出的产品能力与评测资料沿用上游；上游的在线 LoCoMo 报告不是本 fork 新跑出的评测结果。

## 与上游相比的修改

1. Git 项目的 Workspace 记忆按共享 Git 目录归属：主仓库、任意位置的 linked worktree，以及仓库内不同子目录的 Session 使用同一份 `$DSH_HOME/memory/workspaces/<workspace-key>/`。普通 `.git/` 布局仍以主仓库根目录生成 key，因此主仓库根目录已经保存的记忆无需迁移；非常规 Git 目录布局则以共享 Git 目录生成 key。非 Git 目录、Git 不可用或 cwd 暂时不存在时，缓存到期后按规范化绝对 cwd 生成 key。
2. npm 包名、Host Bundle 引用和 Browser 模块注册由 `@hr98w/dsh-memory` 改为 `@jxsylar/dsh-memory`，避免与上游 npm 包重名。插件内部 id 仍是 `dsh-memory`，不要在同一个 DSH profile 中同时启用两个版本。
3. 本 fork **不迁移或合并**以前分别写入 worktree 独立 Workspace 的记忆。这些 Markdown 文件不会被删除，但新的 worktree Session 将读取主仓库的共享 Workspace。Git 仓库移动、改动 Git 元数据或在 Git 不可用时运行，仍可能改变解析到的 Workspace；这些情况不进行自动合并。

## 安装 DSH 与本 fork

**已安装 DSH Desktop：**「添加插件」接受 `github:jxsylar/dsh-memory`（GitHub 默认分支；本次改动合入 `main` 后使用），或 `github:jxsylar/dsh-memory#<分支名或提交哈希>`（将占位符换成实际引用）。但本 fork 延续上游的 `lib/` 忽略规则：当前 DSH profile 默认不允许 Git 依赖运行构建脚本，直接输入 GitHub 地址会被拒绝。无需发布 npm 包，但需要单独授权该 Git 依赖的构建；不修改 profile 时请使用下面的本地源码安装。

**使用 DSH CLI：**如果尚未安装 DSH，使用 Node.js 22.19+ 或 24+ 安装官方 CLI；已安装 Desktop 且 `dsh --version` 可用时不必重复安装：

```sh
npm install -g @deepseek-ai/dsh
dsh --version
```

CLI 也接受 GitHub 引用，例如 `dsh plugin --profile web add 'github:jxsylar/dsh-memory#main'`，但同样需要构建授权，不能在默认 profile 里直接安装。[pnpm 的 Git 安装说明](https://pnpm.io/package-sources#git-repository)列出了 `github:` 与 `#branch` 格式。Git 仓库不包含 `lib/`，DSH 随附的 pnpm 会在运行 `prepack` 前检查 profile 的 `allowBuilds`；如需从 GitHub 安装，应按 pnpm 报错提示为**具体 Git 依赖**配置授权，不要允许所有依赖执行脚本。

从**本地 checkout** 安装（需要 pnpm；在仓库根目录执行）：

```sh
pnpm install
pnpm run build
dsh plugin --profile web add .
```

如果尚无本地 checkout，可以先执行 `git clone https://github.com/jxsylar/dsh-memory.git`，进入克隆目录后运行上述命令；clone 获取的是远端分支代码。

完全重启 `dsh web` 才能载入新的 Host Bundle；仅刷新浏览器不够。`@jxsylar/dsh-memory` 是包名，**不等于已发布到 npm**；发布前不要把 `dsh plugin --profile web add @jxsylar/dsh-memory` 当作安装步骤。已安装的上游版本与本 fork 使用同一个内部插件 id，应先确认 Web profile 只加载需要的一个版本。

本 fork 没有修改仓库的 npm 发布工作流：现有工作流只允许上游仓库发布，不会从此 fork 发布。详见 [开发与验证](docs/development.md)。
