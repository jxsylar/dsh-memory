# Architecture

本文只描述 `dsh-memory` 已经实现的代码结构和请求流。稳定产品规则见 [design.md](design.md)，未实现工作见 [roadmap.md](roadmap.md)。

## 组件图

```text
Agent step                    Web Browser
    │                              │
    │ SystemPrompt.context         │ Connection RPC /memory
    │ memory_update                │
    ▼                              ▼
┌─────────────────────────────────────────┐
│ Host Cordis plugin: @hr98w/dsh-memory   │
│                                         │
│ Prompt Consumer    Tool Consumer   RPC  │
│          └──────────┬───────────────┘    │
│                     ▼                    │
│            MemoryStore Service          │
│                     │                    │
└─────────────────────┼────────────────────┘
                      ▼
          $DSH_HOME/memory Markdown
```

仓库是一个 npm Bundle 包，但运行时有两个独立 Cordis 树：Host entry 运行在 Node 进程，Browser entry 运行在网页。二者只能通过 Connection RPC 交换受校验的 wire value，Browser 不直接访问 Host `ctx` 或文件系统。

## 文件与职责

| 文件 | 职责 |
|---|---|
| `src/index.ts` | Host Cordis entry；组合 Service、Prompt、Tool 和 loopback RPC Consumer |
| `src/memory-store.ts` | Markdown Provider；格式校验、revision、CAS、scope lock、原子发布和索引重建 |
| `src/protocol.ts` | Host/Browser 共用的 wire 类型和双侧运行时解析 |
| `src/client/index.ts` | Browser Cordis entry；注册中英文字典与 `settings.section`，并封装 `/memory` Client |
| `src/client/MemorySection.tsx` | 响应式 Status、Global 编辑器及后续 Workspaces/Sessions 页面席位；内部 revision 不直接展示 |
| `src/client/locales.ts` | Memory 设置页完整的 `zh` / `en` 文案字典 |
| `cordis.patch.yml` | Bundle patch；向 Host 组合插入唯一的 `dsh-memory` row |

## MemoryStore

`MarkdownMemoryStore` 是 `ctx.memoryStore` 的第一版 Service Provider。模型工具、Browser API 和未来的 `SessionConsolidator` 都是 Consumer，不直接操作文件。

Global revision 是规范化后 `GLOBAL.md` UTF-8 内容的 SHA-256。Workspace revision 按文件名排序，对每个详细文件的文件名和完整 UTF-8 内容做长度前缀哈希；派生的 `MEMORY.md` 不参与 revision。

Workspace commit 在同一 scope 的进程内锁中完成：读取并比较 revision，构造下一代完整 record 集合，写到 sibling staging 目录，交换当前目录，再删除 backup。Global commit 使用同目录临时文件加 rename。所有 Markdown 统一保留一个末尾换行。

## Workspace identity

v0.1 使用 lexical absolute cwd 作为身份输入：`path.resolve(cwd)` 后计算 SHA-256 的前 16 个十六进制字符，并以 cwd basename 的安全 slug 作为可读前缀：

```text
<slug>-<sha256(normalized-absolute-cwd)[0:16]>
```

该规则不调用 `realpath`，因此 symlink 别名是不同 Workspace；目录移动也产生新 Workspace。这样不会因目录暂时不存在而改变身份，也不会在 Prompt assembly 中触发外部文件系统解析。显式迁移/合并属于后续能力。

## Agent 读取流程

```text
AgentLoop assembles one step
  -> dsh-memory static rules section
  -> dsh-memory dynamic context provider
  -> read GLOBAL.md
  -> resolve current Session header.cwd
  -> derive current workspace key
  -> validate detailed records and derive MEMORY.md in memory
  -> return Global + current index + detailed directory
  -> existing runtime-context projection logs changed snapshots
  -> Agent uses normal read/grep/glob for selected detailed files
```

Prompt provider 是同步 API，因此 `MemoryStore.renderContext()` 使用同步、完整文件读取。Mutation 通过 rename 发布，避免 provider 读到半个文件。格式损坏会使 assembly 显式失败，不会静默丢掉记忆。

## Agent 写入流程

```text
memory_update(change)
  -> DSH tool schema validates the discriminated union
  -> resolve Global or exec.agent.session.header.cwd
  -> MemoryStore lock + revision compare
  -> validate name/description/type/content
  -> publish Global file or complete Workspace generation
  -> return operation + new revision
  -> normal DSH tool lifecycle logs call and result
```

Tool 不接收 memory root、Workspace key、cwd 或任意路径。Workspace scope 永远来自当前执行 Agent。

## Browser 请求流程

```text
Memory Settings
  -> ctx.connection.rpc.call('/memory', endpoint, payload)
  -> Connection enforces loopback authority
  -> Host dsh-memory handler validates payload
  -> MemoryStore
  -> Host validates/constructs response
  -> Browser parses unknown response again
  -> component renders or reports error
```

当前 endpoints 是 `status`、`global/read` 和 `global/replace`。后续 endpoint 见 [roadmap.md](roadmap.md)；新增 endpoint 时必须同时增加 Host 与 Browser 的非法 wire-value 测试。

## 当前缺口

- Workspace Registry 驱动的 Browser 列表与管理；
- SessionPersistence Consumer 和手动 Consolidator Agent；
- review receipt；
- UI 的 Workspaces/Sessions 实际数据流；
- 自动整理、访问记录与淘汰。

实现顺序和验收条件见 [roadmap.md](roadmap.md)。这些能力必须复用现有 `MemoryStore`，不能从 UI、工具或 worker 绕过校验与 revision。
