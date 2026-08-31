# Architecture

本文只描述 `dsh-memory` 已经实现的代码结构和请求流。稳定产品规则见 [design.md](design.md)，未实现工作见 [roadmap.md](roadmap.md)。

## 组件图

```text
Agent step                         Web Browser
    │                                   │
    │ Prompt context / memory_update    │ loopback RPC /memory
    ▼                                   ▼
┌──────────────────────────────────────────────────┐
│ Host Cordis plugin: @hr98w/dsh-memory            │
│                                                  │
│ Prompt + Tool ────────────────► MemoryStore      │
│ Session catalog ──────────────► SessionPersistence│
│ Consolidation runner ─► worker Agent             │
│          │              │                        │
│          ├─► receipts/debug                      │
│          └─► MemoryStore CAS                     │
└───────────────────────┬──────────────────────────┘
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
| `src/session-catalog.ts` | 基于 SessionPersistence snapshot 与 live Agent registry 的只读资格投影 |
| `src/consolidation-identity.ts` | review 与内部 worker Session 的稳定身份格式 |
| `src/session-consolidator.ts` | M3 Host 核心；冻结稳定 Session 逻辑事件与目标 Workspace generation |
| `src/consolidation-proposal.ts` | M3 proposal 的封闭解析、evidence 校验、规范化与 Workspace preview |
| `src/consolidation-worker.ts` | M3 单次 worker；隔离模型路由、Prompt、runtime context 和工具能力，并保留可回放 Session |
| `src/consolidation-settings.ts` | 插件整理模型的 CAS 配置，以及 DSH 活跃文本模型目录投影 |
| `src/consolidation-debug.ts` | 每次 attempt 的脱敏、append-only JSONL 运维诊断 |
| `src/consolidation-receipt.ts` | M3 receipt 与事务核心；review lock、durable intent、Workspace CAS 和 crash-window 收敛 |
| `src/consolidation-replay.ts` | 从持久化 worker Session 的逻辑事件重建并重新校验 proposal plan |
| `src/consolidation-runner.ts` | M3 手动整理编排；串联 prepare、单次 worker、失败 receipt、replay 与 commit |
| `src/client/MemorySection.tsx` | 响应式 Global、Workspace、Sessions 与 Model 设置界面；内部 revision 不直接展示 |
| `src/client/locales.ts` | Memory 设置页完整的 `zh` / `en` 文案字典 |
| `cordis.patch.yml` | Bundle patch；向 Host 组合插入唯一的 `dsh-memory` row |

## MemoryStore

`MarkdownMemoryStore` 是 `ctx.memoryStore` 的第一版 Service Provider。模型工具、Browser API 和未来的 `SessionConsolidator` 都是 Consumer，不直接操作文件。

Global revision 是规范化后 `GLOBAL.md` UTF-8 内容的 SHA-256。Workspace revision 按文件名排序，对每个详细文件的文件名和完整 UTF-8 内容做长度前缀哈希；派生的 `MEMORY.md` 不参与 revision。

Workspace commit 在同一 scope 的进程内锁中完成：读取并比较 revision，构造下一代完整 record 集合，写到 sibling staging 目录，交换当前目录，再删除 backup。Global commit 使用同目录临时文件加 rename。所有 Markdown 统一保留一个末尾换行。

`previewWorkspaceChanges()` 是 Workspace batch 的纯计算边界。preview 与 commit 共享记录校验、内容规范化、排序、索引和 revision 算法；语义未变化的 batch 保留当前 revision 且不交换目录。

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

当前 endpoints 是 `status`、`global/read`、`global/replace`、`workspaces/list`、`workspace/read`、`workspace/commit`、`sessions/list`、`sessions/consolidate`、`models/read` 和 `models/select`。Host 从合法 Workspace 目录派生稳定 opaque id，Browser 只用该 id 选择详情或提交变更；所有 Workspace wire value 均不暴露 cwd、内部 key 或绝对路径。

Workspace 编辑先保留在 Browser 草稿中。保存时 Browser 根据已读取 generation 构造确定性的 delete-then-put batch，并连同 expected revision 一次提交；Host 双重解析后重新通过 opaque id 解析目录，再调用 `MemoryStore` 做 CAS 和完整 generation 发布。冲突只返回当前 revision，不覆盖或清除 Browser 草稿。

Session 列表连续调用两次 `SessionPersistence.listSnapshots()`，以 source-qualified revision 判断观察期间是否稳定，再通过 live Agent registry 否决正在运行的 Session，并使用 `MemoryStore` 的 cwd 规则投影 opaque Workspace id 与显示名。内部 `session-memory-review-…-attempt-…` worker Session 在分类前直接排除，不能递归成为整理来源。标题来自 DSH 日志中的最新 `session/title` 事件：live Session 读取 `sessionProjections.snapshot()`，cold Session 读取 identity-checked `sessionProjectionCache.cachedSnapshot()`；缓存缺失或异常时降级为无标题。列表不扫描 JSONL、不读取完整事件，也不调用模型；它附带最新 receipt 的浏览器安全摘要，并区分该 receipt 是否属于当前 source revision。Browser 按 opaque Workspace id 分组，保留无 cwd 或不可解析条目的“未归属”分组，不按可能重名的显示名合并。若相关 Host 服务不存在，`sessions/list` 返回显式 unavailable 状态，Headless 组合仍可加载。

`sessions/consolidate` 只接受 Session id，并同步等待一次显式 attempt。Host 在明确注入 `sessionPersistence`、`agents`、`sessions`、`systemPrompt` 和 `tools` 的可选 child fiber 中组装 consolidator、受限 worker、receipt store、replay 与 runner；服务缺失时 endpoint 明确不可用，不影响其他 Consumers。响应仅返回终态、恢复标记、review id、attempt 和变化数量，不暴露模型路由、cwd、Workspace key 或 revision。Browser 双重解析响应，完成后刷新列表，因此同 revision 的终态 receipt 和后续新增对话形成的新 revision 都能被识别。

worker 监听自身 scope 的 `agent/error`：Agent loop 收敛到 idle 后若捕获到错误，才归类为 Provider 失败；创建、flush、dispose 和其他未知异常归类为内部错误。每次 attempt 同时把阶段、route、计数和脱敏错误链追加到 `$DSH_HOME/memory/debug/<review-id>/attempt-<n>.jsonl`。日志不复制 evidence、memory/proposal 正文，写日志失败只产生 Host warning，不改变 receipt 结果。

`models/read` 从可选 `llm` 服务的 `listProviders()` 与 `listModels()` 投影当前活跃且支持文本输入的模型。`models/select` 重新验证 route 仍在活跃目录中，再以 revision CAS 原子保存 `$DSH_HOME/memory/settings.yml` 并更新后续 attempt 使用的 worker route。Browser 不读取配置文件、Provider 凭据或环境变量。

M3 的第一条 Host 边界由 `SessionConsolidator.prepare()` 实现：先取得唯一 snapshot 并排除 live/无 cwd Session，再通过 `SessionPersistence.inspect()` 读取完整逻辑事件，同时读取当前 Workspace generation，最后重新观察 snapshot 与 live registry。只有 source metadata/revision 未变化时才返回克隆事件、确定性 turn evidence、Workspace records/revision、consolidator version 与 review id。`src/consolidation-evidence.ts` 使用 DSH `foldSurface()` 保留当前消息 surface；每轮只投影真实 user 文本、compaction replacement summary、最后一条非空 assistant 文本和工具名称/状态，排除普通插件 context、request 元数据、chunks、生命周期事件及工具参数/结果正文。该阶段不调用模型、不写 receipt，也不修改记忆；后续提交仍必须再次检查 source 并通过 `MemoryStore` CAS 检查 target。

第二条 Host 边界由 `SessionConsolidator.planProposal()` 实现。它把 worker 输出视为不可信值，拒绝未知字段、非法 record、空或越界 evidence、同名多次变化和不存在的删除目标；合法变化规范化为按名称排序的 delete-then-put batch。随后调用 `MemoryStore` 共享 preview 算法计算最终 records、index 和 planned revision；语义相同的 put 被收敛为 `no-change`。该阶段仍不写 receipt 或 Workspace。

第三条边界由 `SessionConsolidationWorker.run()` 实现。每次 attempt 创建独立 Agent/Session，并把 Host 已解析的 source cwd 仅写入 Session header，使 DSH 原生历史页能在 worker dispose 后读取审计记录；`suppressRuntimeContext()` 仍阻止 cwd 派生的动态上下文进入模型。worker 使用插件显式配置的 provider/model，只装配一个 complete system prompt，拒绝全部继承工具，再注册唯一的 scoped `memory_review_propose`。该工具向模型暴露完整的 put/delete 嵌套 schema，Host parser 仍拒绝未知字段、缺少 evidence 或越界 range。冻结的 turn evidence 与 Workspace records 作为 user-role 消息注入；完整 source events 保持 Host-only。proposal tool 调用、Host 校验结果和模型实际输入都进入 worker Session。模型引用的 evidence range 必须精确匹配一个已提供 turn，不能引用被过滤事件。动态输入默认最多 128 KiB，超过时在创建 Agent 前形成 `evidence-too-large`；debug 只记录筛选前后数量与字节数。`agent/pre-step` 在第二步前拒绝继续，tool 调用后结束当前 turn，因此每个 attempt 至多发起一次 Provider 请求。结束、失败或取消时要求 flush 确认存在持久化 Consumer，再 dispose live Agent。

该 worker 已通过真实 DSH 成功与非法 proposal 失败链路验证；自动组装回放测试仍待补。完整状态机与数据契约见 [session-consolidation.md](session-consolidation.md)。

`ConsolidationCommitCoordinator` 实现提交屏障：在同一 review lock 内二次确认 source、比较 frozen target revision，先原子写入不含记忆正文的 `committing` receipt，再通过 `MemoryStore.commitWorkspace()` 做一次 CAS。重入 `committing` 时，当前 Workspace 等于 before revision 就重放同一份已验证 plan，等于 planned after 就只补写 `committed`，其他 revision 收敛为 `target-conflict`；恢复 plan 的 proposal hash、before 和 planned after 必须与 durable intent 完全一致。`committed` 与 `no-change` 终态直接幂等返回。

`SessionConsolidationRunner` 在 review lock 内检查既有终态、计算 attempt、执行至多一次 worker，并把结果交给提交屏障。严格空事件 Session 直接形成 `no-change`，不创建 worker。取消、source changed、非法 proposal、Provider 失败和内部编排错误形成带 attempt 分类的终态 receipt；失败只能由下一次显式调用重试。并发触发同一 review 时，后进入者读取先完成的终态，不会再次调用模型。

若已有 `committing` receipt，runner 通过 `WorkerSessionPlanReplay` 调用 `SessionPersistence.inspect()`，从 worker 的 user-role evidence 和唯一 proposal tool call 重建 plan，再由 receipt hash 与 before/after revision 校验后恢复，绝不重新调用模型。该路径只读取后端无关的逻辑事件，不扫描 JSONL。

runner 在 prepare 新 revision 前扫描受控的 `reviews/review-*.md`，按 source Session 查找最早的 `committing` receipt。即使 source 已增长，它也先用 receipt 的 Host-owned Workspace key 定位目标，从旧 worker evidence 重建 plan 并完成或收敛旧事务；本次调用不会同时启动新 review。下一次显式触发才处理 source 的新 revision。

后续 endpoint 见 [roadmap.md](roadmap.md)；新增 endpoint 时必须同时增加 Host 与 Browser 的非法 wire-value 测试。

## 当前缺口

- worker 的真实 DSH 组装回放验证；
- 发布前真实界面 GIF；
- 自动整理、访问记录与淘汰。

实现顺序和验收条件见 [roadmap.md](roadmap.md)。这些能力必须复用现有 `MemoryStore`，不能从 UI、工具或 worker 绕过校验与 revision。
