# Contributing to dsh-memory

感谢你参与 `dsh-memory`。项目仍处于预发布阶段，提交变更前请先阅读 [AGENTS.md](AGENTS.md) 中的产品边界和实现规则。

## 开发环境

- Node.js `^22.19.0 || >=24.0.0`；
- pnpm；
- 涉及真实 UI 或安装流程时，需要一份可运行的 DeepSeek Harness Web profile。

```sh
pnpm install
pnpm run check
```

## 提交变更

1. 先创建 Issue 或在 Pull Request 中清楚描述问题、期望行为和范围；小型修复可以直接提交 PR。
2. 保持改动聚焦，不混入无关重构或生成文件手工修改。
3. 为行为变化补充相应单元测试；只报告实际运行过的验证。
4. UI 变化请构建 Client，并在真实安装页面人工验证。发布前应附真实截图或 GIF。
5. 非平凡架构、行为、安全、持久化或协议选择，应在 `docs/decisions/implemented/` 增加决策记录。
6. 提交前运行 `pnpm run check`。

详细命令与验证矩阵见 [docs/development.md](docs/development.md)。

## 设计边界

- 保持 Session-native、local-first；
- 权威记忆必须是 `$DSH_HOME/memory` 下可读的 Markdown；
- 持久 scope 只包含 `global` 和 `workspace`；
- 所有持久写入必须通过 `MemoryStore`；
- Browser/Host wire value 必须在两侧进行运行时校验；
- 不要添加跨 Workspace recall、外部记忆 Provider 或模型侧 `memory_recall`，除非先完成明确的设计变更和证据评估。

## Pull Request 说明

请在 PR 中包含：

- 变更目的和用户可见结果；
- 涉及的关键文件或决策；
- 实际运行的测试命令及结果；
- 尚未验证的部分；
- UI 改动的截图或 GIF（如适用）。

## English

Contributions are welcome. Before changing behavior, read [AGENTS.md](AGENTS.md) and the relevant documents under `docs/`. Keep changes scoped, add tests for behavior changes, run `pnpm run check`, and report only checks that were actually executed. UI changes require verification in a real installed DSH Web page and should include a screenshot or GIF before release.
