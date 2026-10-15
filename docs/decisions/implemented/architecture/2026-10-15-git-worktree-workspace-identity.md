# Git worktree Workspace identity

## Problem

以 Session 的绝对 cwd 为身份时，同一项目的主仓库、不同位置的 Git worktree 和仓库子目录落入不同 Workspace，项目记忆无法共享。已经由主仓库根目录写入的记忆需要继续可见；用户明确不要求合并以往 worktree 的独立记忆。

## Decision

只在 Host 的 `MemoryStore.scopeForCwd()` 改变身份解析，不增加新的 scope、Browser 参数或模型工具参数。优先从 cwd 查询 Git 共同目录：标准 `.git/` 布局使用共同目录的父目录作为身份，保留主仓库根目录既有 key；非常规布局使用共同目录本身。Git 查询不成功时使用原有的 lexical absolute cwd 身份。Workspace key 格式、Markdown 数据与 revision/CAS 提交方式不变。

旧 worktree 的独立记忆不迁移或自动合并。既有 receipt 恢复仍通过保存的 Workspace key 访问原有目标，不重新解析来源 cwd。

## Alternatives considered

- 对每个 worktree 使用 `git rev-parse --show-toplevel`：得到的是各自 worktree 路径，不能共享。
- 始终使用共同 Git 目录生成 key：结构最直接，但会让标准主仓库现有记忆在升级后不可见。
- 在启动或每次读取时自动合并所有旧目录：需要冲突策略和跨目录事务，超出本次需求。
- 非 Git 或 Git 失败时拒绝 Workspace：会使不存在的历史 cwd 或 Git 临时不可用导致动态上下文组装失败。

## Consequences

- 相同 Git 仓库可共享一个记忆目录、revision 和 Browser Workspace id；不同仓库保持隔离。
- Prompt assembly 会同步调用本机 Git，设置超时并在失败时降级；Git 可用性或仓库布局变化可能改变目标记忆，故不保证跨目录搬迁后的自动迁移。
- 极少见的非常规 Git 目录布局无法沿用旧主仓库 cwd key，但主仓库与 linked worktree 仍共享新的 key。
- 包名切换为 `@jxsylar/dsh-memory` 是 fork 的分发身份变化；插件内部 id 仍为 `dsh-memory`，不支持在同一个 profile 同时启用上游和 fork。
