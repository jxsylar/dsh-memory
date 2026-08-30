# Development

仓库开发约束见根目录 [AGENTS.md](../AGENTS.md)。本文只维护命令、验证矩阵和发布步骤。

## 环境

- Node.js `^22.19.0 || >=24.0.0`；
- pnpm；
- 一份可运行的 DeepSeek Harness，用于最终 Bundle 安装冒烟。

## 命令

```sh
pnpm run typecheck
pnpm run test
pnpm run build
```

`pnpm run check` 按上述顺序运行当前代码门禁。

## 验证矩阵

| 改动 | 最小证据 |
|---|---|
| 纯文档 | 检查相对链接、文件名和当前状态描述 |
| MemoryStore | 相关 Store 测试 + typecheck |
| RPC protocol | protocol 测试中的合法与非法 wire value + typecheck |
| Host wiring | plugin 测试；涉及模型可见内容时补 assembled replay/snapshot |
| Browser UI | client build + 真实安装页面；发布前提供截图或 GIF |
| package/Bundle | `pnpm run check` + `npm pack --dry-run` + 隔离 profile 安装冒烟 |

迭代时运行最窄证据；交付代码前运行一次 `pnpm run check`。只报告实际执行过的命令。

## 本地安装冒烟

```sh
pnpm run build
dsh plugin --profile web add /absolute/path/to/dsh-memory
dsh --profile web --dump-config
dsh web --no-open
```

确认：

1. dump config 包含 `id: dsh-memory`；
2. Web boot 没有 `plugin tree failed to load`；
3. `__DSH_BOOT__` 包含 `@hr98w/dsh-memory` Client；
4. 启动页插件清单中的 `/plugins/@hr98w/dsh-memory/client.js?rev=...` 返回 Browser bundle，而不是 SPA fallback；
5. Settings 导航出现 Memory；
6. Global 保存后 revision 变化，旧页面保存得到 conflict；
7. Headless 不包含 `connection` 时仍能加载 Prompt 和 Tool。

Host entry 受 Node ESM module cache 影响，修改后必须重启 Web。Client bundle 变更需要重建、重新安装并刷新页面。

## 发布

发布前运行：

```sh
npm pack --dry-run
pnpm run check
```

检查 tarball 只包含 `lib/`、Bundle patch、README 和 LICENSE。确认没有 `.env`、测试 fixture、Session 或实际 memory 数据。然后在 npm 账号启用 2FA/可信发布流程，并使用 scoped public 发布：

```sh
npm publish --access public
```

未被明确要求时，不执行 publish、push 或创建远程仓库。

## 变更纪律

- 非平凡行为变化增加 `docs/decisions/implemented/<kind>/` 记录；
- 生成的 `lib/` 只由构建产生，不手工编辑；
- 新模型可见内容必须能从 Session 日志重建；
- 新 RPC endpoint 同时验证 request 和 response；
- 新 mutation 必须通过 `MemoryStore`，不得直接写 `$DSH_HOME/memory`。
