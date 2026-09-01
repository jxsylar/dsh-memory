# Session 整理设计

本文维护 M3 手动 Session Consolidator 的详细设计与当前语义，包括完整闭环、状态机、数据契约、失败和恢复边界。

稳定产品边界仍以 [design.md](design.md) 为准，已经落地的事实见 [architecture.md](architecture.md)，实施顺序见 [roadmap.md](roadmap.md)，非平凡且已经实施的选择由 `docs/decisions/implemented/` 记录。

## 1. 文档状态

本文用三种标记区分确定性：

| 标记 | 含义 |
|---|---|
| 已确定 | 已由稳定设计或现有实现约束，不在 M3 中随意改变 |
| 计划 | 当前推荐方案，讨论确认后按切片实现 |
| 待讨论 | 会显著影响安全、用户体验或数据格式，写代码前需要确认 |

M3-A 至 M3-E 已实现：稳定输入、双作用域 proposal 校验、受限多轮 worker、手动 attempt 编排、失败 receipt、并发去重、Global/Workspace CAS、跨 source revision 的 pending recovery、`sessions/consolidate` RPC、Sessions UI、可选详细 debug 日志和整理模型选择。新版 Global/Workspace 整理已通过人工 Web 验证；自动组装回放和发布 GIF 尚未完成。

## 2. 目标与非目标

### 2.1 目标

- 从一个持久化 Session 的完整逻辑事件中提取可复用的 Global 与当前 Workspace 记忆；
- 由模型判断语义，由 Host 决定 scope、校验 proposal、检查 revision 并提交；
- 整理过程写入独立 worker Session，模型实际看到的输入和输出可以回放；
- 成功、无变化、取消、冲突、非法输出和 Provider 失败都有稳定 receipt；
- 相同 source revision 与 consolidator version 的成功结果幂等，不重复调用模型；
- 崩溃恢复不能导致重复模型调用、部分 Workspace 写入或无法解释的成功状态。

### 2.2 非目标

- 不跨 Workspace 搜索、比较或提升记忆；
- 不自动调度、批量整理或后台重试；
- 不增加向量库、Provider 聚合、importance、tag 或知识图谱；
- 不让 Browser、worker Agent 或 proposal 直接操作 memory root、cwd、Workspace key 或文件路径；
- 不把历史 Session 当作第二份长期记忆，也不复制完整对话到 receipt。

## 3. 术语与身份

| 名称 | 含义 |
|---|---|
| source Session | 用户选择作为学习证据的持久化 Session |
| source revision | `SessionPersistence.listSnapshots()` 返回的 source-qualified 不透明 revision |
| target Workspace | 由 source Session 的权威 cwd 解析出的唯一 Workspace |
| target revisions | 整理开始时读取到的 Global 与 Workspace revision |
| worker Session | 只负责一次整理尝试的独立 DSH Session，保存模型可见输入和 proposal 过程 |
| proposal | worker 提出的结构化 `replace-global | put | delete | no-change` 语义结果 |
| review | 一个 source revision、consolidator version 和 target Workspace 的稳定逻辑整理单元 |
| attempt | 同一 review 下的一次 worker 尝试；失败后只能由用户手动重试 |
| receipt | `$DSH_HOME/memory/reviews/<review-id>.md` 下的 Host 权威审计记录 |

### 3.1 Review identity

已确定：review id 由以下值使用长度前缀编码后计算 SHA-256：

```text
consolidator version
+ source Session id
+ source revision
+ target Workspace key
```

它不包含时间、模型名或 attempt，因此同一证据与同一整理语义具有稳定身份。consolidator 的 Prompt、proposal schema、清洗规则或提交语义发生不兼容变化时必须提升 version。

## 4. 完整请求流程

```text
Browser: sessions/consolidate({ sessionId })
  -> Host 运行时解析 request，只接受 Session id
  -> 重新检查持久化 snapshot 与 live Agent registry
  -> SessionPersistence.inspect() 读取完整逻辑事件
  -> MemoryStore 读取 Global 与 source cwd 对应的 Workspace generation
  -> 再次检查 source snapshot 与 live 状态
  -> 生成 review id，并取得 review lock
  -> 已有成功 receipt：直接返回，不调用模型
  -> 未完成 committing receipt：执行崩溃恢复，不调用模型
  -> 创建新的 worker Session attempt
  -> 将完整日志投影为紧凑 turn evidence
  -> 注入整理规则、turn evidence、Global 正文和现有 Workspace records
  -> worker 可多轮调用 memory_review_propose 校验草稿
  -> 唯一通过校验的 final=true proposal 结束 attempt
  -> Host 解析、校验并规范化 Global/Workspace proposal
  -> no-change：写 terminal receipt，返回
  -> changes：计算预期 post revision
  -> 最后检查 source revision 与 live 状态
  -> 先写 committing receipt
  -> MemoryStore 使用 frozen Global/Workspace revision 做 CAS commit
  -> 写 committed receipt
  -> Browser 刷新 Sessions 与 Workspace 页面
```

UI 中显示的“可以整理”只是一次轻量候选判断，不是授权。真正触发时必须完整重做上述检查。

## 5. 阶段一：候选资格与稳定输入

### 5.1 列表阶段

已确定：Sessions UI 通过两次 `listSnapshots()` 做只读分类，不读取完整事件。只有满足以下条件才显示为候选：

- snapshot id 在两次观察中各出现一次；
- source revision 相同；
- Agent registry 中不存在同 id Agent；
- header 带合法绝对 cwd，并能解析为 Workspace。

Agent registry 存在表示 Agent 仍然 live，可能是 `idle` 或 `running`。为了防止 idle Agent 随后继续接收消息，二者都不能整理。计划将 UI 文案从“正在运行”改为更准确的“Agent 仍处于活动状态”。

### 5.2 触发阶段

已确定：触发整理后不信任列表结果。Host 重新执行：

1. 取得唯一的第一次 snapshot；
2. 排除 live、无 cwd 和非法 Workspace；
3. 使用 `SessionPersistence.inspect()` 读取完整逻辑事件，而不是扫描 JSONL；
4. 验证 inspection metadata 与 snapshot 的 id、createdAt、cwd 一致；
5. 读取 Global content/revision 与当前 Workspace records、index 和 revision；
6. 再次读取 snapshot，并再次排除 live；
7. 仅在 source metadata 和 revision 未变化时生成 frozen input。

Global 与 target Workspace 都不在模型调用期间加锁。它们通过 frozen revisions 和最终 `MemoryStore` CAS 检测并发变化，避免长时间持有文件写锁。

### 5.3 空白 Session

已实现：若确定性投影后没有任何 user、compaction summary、最终 assistant 文本或工具状态，Host 直接产生 `no-change` receipt，不创建 worker。这样可以避免空白或只有生命周期事件的 Session 消耗模型调用。

## 6. 阶段二：Worker Session

### 6.1 生命周期

已实现：每个 attempt 创建一个新的 worker Agent/Session，身份从 review id 与 attempt number 派生。worker 完成、失败或取消后先 flush 持久化 Session，再 dispose live Agent handle，持久化 Session 保留用于回放。

worker Session 不使用 source Session id，不 resume source，也不把 source events 当成 Session seed。source 是证据，worker 是一次新的审查过程，两者在 receipt 中显式关联。

### 6.2 Workspace 与上下文

已实现：worker Session header 使用 `$DSH_HOME/memory/consolidator-workspace` 专属 cwd，使其持久化日志与正常项目 Session 物理分离。Web Host 提供 Workspace Registry 时，插件创建或复用 `Memory Consolidation` DSH Workspace，并在 worker flush 成功后挂接 Session；Headless 等没有该可选服务的组合仍使用专属 cwd，只是不建立原生 UI 分组。该字段不进入 worker 的动态输入，`suppressRuntimeContext()` 继续关闭所有普通 Workspace runtime context；Browser、proposal 与模型仍看不到 cwd。Memory Session catalog 在分类前同时排除受控 worker id 和专属 cwd 下的全部 Session，所以该 Workspace 整体不出现在会话整理页面；Host prepare 再按 cwd 拒绝直接请求，避免任何内部审计 Session 成为整理来源。target Workspace 仍只来自冻结的 source scope，不能由 worker 的运行归属或 proposal 修改。既有 worker Session 不做迁移。

worker 的模型可见信息分两部分：

1. system-role 静态规则：职责、Global/Workspace 归属、保留/拒绝标准、proposal schema、禁止事项；
2. user-role runtime context：review id、turn evidence、Global 正文、现有 Workspace records 和明确任务。

动态输入必须通过 DSH 可记录的消息/context 通道进入 worker Session，不能只藏在临时闭包、request middleware 或日志外对象中。

### 6.3 能力限制

已实现：worker 先以 scoped restriction 拒绝全部继承工具，再只注册一个 scoped proposal tool：`memory_review_propose`。工具参数声明 `final`、Global `replace-global`、Workspace `put/delete`、record 与 evidence range；Host parser 仍执行第二层严格校验。`final=false` 只校验草稿并允许下一轮，只有校验通过的 `final=true` 才结束 attempt。它不获得：

- `memory_update`；
- 文件读写、shell、网络或 MCP 工具；
- Browser RPC、MemoryStore 或 SessionPersistence；
- 任意 root、path、cwd、Workspace id/key 或 expected revision。

实现使用 Agent setup scope 中的 `tools.restrict({ allow: [] })` 与本地 `tools.register()`。complete system section 替代普通 system prompt，并通过 `suppressRuntimeContext()` 关闭普通动态上下文。Worker 可以进行多轮 Provider 请求；全部 draft tool call 与结果都进入 Session，只有最终调用会执行 `concludeTurn()`。真实 DSH 组装测试仍需证明最终 request header 与持久化 replay 的一致性。

### 6.4 模型与运行限制

已实现：完整 source events 只留在 Host。模型可见 turn evidence 通过 DSH `foldSurface()` 计算当前消息 surface，并按原始 `turn/start` / `turn/end` 保存证据范围：

- 只保留 `source.kind=user` 的文本 user message；普通插件注入的 runtime context 被排除；
- surface replacement 产生的 compaction summary 保留，已被遮蔽的旧消息不重复进入；
- 每个 turn 只保留最后一条非空 assistant 文本；
- tool 只保留名称和成功/失败，不保留参数、结果正文、call id 或 metadata；
- request header/context、assistant chunks、turn/step 边界、title 和其他日志事件不进入模型；
- 非文本 user block 变成类型占位，凭据做 best-effort 脱敏，超过 4 KiB 的 fenced code block 变成带字节数的占位。

完整事件不被修改，仍用于 source stability、receipt coverage 和审计。筛选不是末尾截断；动态 user-role 输入（turn evidence、Global 正文和 Workspace records）默认上限 128 KiB，超过时不创建 Agent，并写入 `evidence-too-large` receipt。debug 记录 source event/evidence 的数量和字节数，但不记录正文。

已确定：整理 worker 使用插件自己的显式模型配置，不继承 Host 当前默认模型路由。第一版默认固定为当前 DSH 中成本较低的路由：

```yaml
provider: deepseek-official
model: deepseek-v4-flash
maxTokens: 8192
timeoutMs: 120000
maxInputBytes: 131072
```

这是一个可覆盖的首次启动默认 route，不做价格查询，也不在运行时自动选择“最便宜”模型。Memory 设置页从 DSH 活跃模型目录读取可用文本模型，API key 仍由 DSH Models 页面管理；插件只以 CAS 保存 provider/model。设置文件存在后，保存的 route 覆盖默认 provider/model。修改只影响之后开始的 attempt，已经运行或写入 receipt 的 attempt 保留其快照 route。插件同时保留：

- 每轮请求的期望输出 token 上限；默认 8192，并通过 DSH `resolveModelInfo()` 取它与所选模型 `defaultMaxTokens` 的较小值，兼容较低上限的 route；该上限不解除，避免多轮调用重复继承过大的 adapter 默认预算；
- 整个 attempt 的端到端 timeout。
- 筛选后动态输入的最大 UTF-8 字节数。

timeout 或用户取消会 abort worker、等待其收敛并保存失败 receipt。第一版不自动换 Provider 或降低输入质量重试。

Prompt 要求 worker 跳过逐项复述和长篇规划，使用工具反馈修正草稿，并在完整 proposal 就绪时提交 `final=true`；证据不足时优先 `no-change`。多轮共享 attempt timeout，每轮仍使用模型感知的输出预算。

## 7. 阶段三：Proposal contract

已实现的模型输出是一个封闭结构，而不是自由 Markdown：

```ts
type ConsolidationProposal =
  | {
      outcome: 'no-change'
      changes: []
    }
  | {
      outcome: 'changes'
      changes: Array<
        | {
            action: 'replace-global'
            content: string
            evidence: Array<{ fromSeq: number; toSeq: number }>
          }
        | {
            action: 'put'
            record: {
              name: string
              description: string
              type: 'feedback' | 'project' | 'reference'
              content: string
            }
            evidence: Array<{ fromSeq: number; toSeq: number }>
          }
        | {
            action: 'delete'
            name: string
            evidence: Array<{ fromSeq: number; toSeq: number }>
          }
      >
    }
```

### 7.1 Host 校验

已实现：Host 执行以下确定性检查：

- 对象只含 schema 允许的字段；
- `no-change` 必须是空 changes；`changes` 必须至少包含一项；
- 每个 evidence range 非空、整数、顺序正确，并精确匹配一个实际提供给模型的 turn range；
- `replace-global` 必须提供完整 Global Markdown，同一 proposal 最多一次；
- `put` record 复用 `MemoryStore` 的 name、description、type、content 校验；
- `delete` 只能引用 frozen Workspace 中存在的记录；
- 同名重复 put/delete 拒绝；更新只使用 put，不允许对同名记录先 delete 再 put；
- 模型不能提交 revision、scope 或路径，也不能选择 source Session 之外的 Workspace；
- Host 将合法变化规范化为“replace-global、delete 按 name 排序、put 按 name 排序”的 batch。

模型给出的顺序、名称、evidence 和内容都不可信。非法 draft 会返回 rejected，允许 Worker 在 attempt timeout 内修复；没有产生合法 final proposal 时写入 `invalid-proposal` receipt。

### 7.2 Evidence redaction

已确定：receipt 不复制 source event 文本、工具结果或完整记忆正文。proposal 只携带 seq range，不携带证据摘录；receipt 只保存 action、memory name、type、evidence range 和内容 hash。

worker Session 自身保留模型可见输入与原始 proposal，以满足回放。

第一版不增加确定性 secret scanner。Prompt 明确要求模型不得把密码、token、私钥或其他认证材料写入持久记忆；Host 仍只执行 schema、范围、MemoryStore 内容约束与 CAS 等确定性校验。这个选择避免引入误报复杂度，但也意味着 Host 不保证识别所有语义上的敏感信息；用户仍可在 Workspace 页面审阅和修正结果。

### 7.3 删除语义

已确定：模型可以提出 `delete`，无需在初次“整理”确认之外逐条二次确认。删除必须：

- 指向 frozen Workspace 中已有的记录；
- 带有至少一个合法 evidence range；
- 与其他变化一起通过 Host 校验和 Workspace revision CAS；
- 记录在 receipt 的 change 摘要中。

该能力用于删除已被新证据明确推翻或已不再成立的 Workspace 记忆。Global 使用完整 `replace-global`，不能单独删除片段；模型不能绕过 `MemoryStore` 直接操作文件。

## 8. 阶段四：二次检查与提交

### 8.1 Source check

proposal 通过校验后，Host 再次确认：

- source Session id 仍有唯一 snapshot；
- source revision 与 frozen revision 相同；
- Agent registry 中仍不存在该 Session。

该检查定义本次 review 覆盖的 source generation。检查之后新增的 Session 事件属于新的 revision，应由新的 review 处理，不修改已经提交 receipt 的证据身份。

### 8.2 Target preview

已实现：`MemoryStore` 提供 Global 与 Workspace 的只读 preview 能力，使用 frozen 内容和规范化 changes 分别计算：

- 实际是否发生变化；
- 规范化后的最终 Global 内容或 Workspace records；
- 两个作用域各自的 planned post revision。

preview 与 commit 必须复用同一套校验、规范化和 revision 计算代码，不能各自实现一份算法。

如果 proposal 在两个作用域都没有产生语义变化，Host 将其规范化为 `no-change`，不执行文件交换。

### 8.3 Commit barrier

已实现：Host 在提交前先原子写入 `committing` receipt，其中包含：

- source revision；
- Workspace before/planned revision；
- proposal hash；
- 规范化 change 摘要；
- worker Session id 和 attempt。

随后对实际变化的 Global 与 Workspace 依次调用对应的 `MemoryStore` CAS 写入；expected revision 必须等于各自 frozen revision。冲突时不覆盖，写入 `target-conflict` receipt。恢复调用必须从 worker Session 回放同一份已验证 plan：Workspace before/planned revision 与 receipt 对齐，Global before/planned revision 由 plan 重建，并用 proposal hash 绑定完整双作用域提议；不再次调用模型，也不在 receipt 中保存正文。

进入 commit barrier 后，用户取消不再中断 receipt/Global/Workspace 的一致性收尾。操作最终返回 committed、recovered 或 conflict，而不是声称取消成功。

## 9. Receipt 与崩溃恢复

### 9.1 文件职责

已确定：receipt 位于：

```text
$DSH_HOME/memory/reviews/<review-id>.md
```

它是 Host 权威审计记录，不是 Workspace memory，也不会自动进入 Agent runtime context。所有写入使用同目录临时文件加 rename，并在 review lock 内完成。

当前事务核心已实现的 receipt schema 包括：

- review id、consolidator version；
- source Session id、source revision、covered seq；
- target Workspace key 与 before/after revision；
- 当前状态；
- attempt 列表及每次 worker Session id；
- Provider/model 标识；
- proposal hash；
- 实际 change 的 action、name、type、evidence ranges 和 content hash；
- created/completed timestamps。

attempt 使用封闭状态记录成功、无变化、取消、source changed、target conflict、非法 proposal、Provider failure 或 internal error；失败后的下一次显式触发增加 attempt，不覆盖历史。

它不单独保存 Global before/after revision，也不保存 cwd、完整事件、工具结果、Prompt、proposal 正文或 memory content。Global 计划在恢复时从 worker Session 的最终 proposal 重建，并通过 proposal hash 验证；完整模型过程留在 worker Session。

### 9.2 状态机

```text
prepared
  -> running
  -> proposed
  -> committing
  -> committed

prepared/running/proposed
  -> no-change
  -> cancelled
  -> source-changed
  -> target-conflict
  -> invalid-proposal
  -> provider-failed
  -> evidence-too-large
  -> internal-error
```

`committed` 与 `no-change` 是成功终态。相同 review 再次触发时直接返回已有结果，不创建 worker、不调用模型。

失败终态允许用户手动重试：同一 review id 下增加 attempt，保留旧 attempt 摘要，不覆盖失败历史。第一版没有自动重试。

### 9.3 `committing` 恢复

若 Host 在写入 `committing` 后崩溃，重启后再次触发同一 review 时不调用模型。Host 从 Worker Session 重建最终 plan，分别比较 Global 与 Workspace 的当前、before 和 planned revision：

| 两个作用域的状态 | 恢复动作 |
|---|---|
| 都是 before 或 planned | 只提交仍处于 before 的作用域 |
| 都已等于 planned | 补写 committed receipt |
| 任一为其他 revision | 写 target-conflict，不猜测也不覆盖 |

planned after 是内容寻址 revision。即使其他操作独立产生了完全相同 generation，最终状态等价，可以安全收敛为 committed。

若崩溃后 source Session 已增长，runner 在 prepare 新 review 前按 source Session 发现最早的旧 `committing` receipt，先恢复或收敛旧事务；一次用户操作不同时恢复旧事务并启动新模型调用。

## 10. 并发与锁顺序

已实现两层锁：

1. review lock：按 review id 串行化相同 source/version 的触发、attempt 和恢复；
2. `MemoryStore` Global/Workspace scope lock：只包围各自 commit 的短临界区。

不得在模型调用期间持有 memory scope lock。锁顺序固定为先 review、后 Global/Workspace commit。

第一版假设同一个 `$DSH_HOME` 由一个 Host 进程管理；不声称支持多个进程同时写同一 memory root。若未来支持多 Host，需要文件锁或新的事务后端，并单独做设计变更。

## 11. Browser RPC 与 UI

### 11.1 RPC

已实现：

```text
sessions/consolidate({ sessionId })
```

Browser 只提交 Session id。Host 从 persistence snapshot 解析 cwd、Workspace 和 revision。request 与 response 都在 Host/Browser 双侧运行时解析。

第一版 RPC 等待一次手动 attempt 完成，并接受 Connection 的 AbortSignal。若 Web 长连接限制不适合模型调用，再改为 Host job + status endpoint；在验证前不预先增加任务系统。

### 11.2 UI

已实现：

- 只有 eligible Session 显示“整理”按钮；
- 左侧先按 opaque Workspace id 选择分组，右侧按 DSH `session/title` 投影显示 Session；无法解析 Workspace 的条目保留在“未归属”，无标题时显示本地化占位；
- live 状态文案改为“Agent 仍处于活动状态”；
- 执行中禁用页面内的重复触发；RPC 继续接受 Connection AbortSignal；
- 完成后刷新 Sessions；Workspace 可通过对应栏目刷新查看；
- 显示 receipt 状态、attempt 和变化数量，不展示模型路由、内部 revision、cwd、Workspace key 或路径；
- 每个 review 只显示最新一次 attempt；receipt 内部继续保留最小化的完整 attempt 历史；
- 失败后只提供手动重试，不自动重试、不自动切换模型；
- 不轮询所有 Session，也不自动整理。

Sessions UI 会显示每个已有 attempt 的确定性 debug 路径：`$DSH_HOME/memory/debug/<review-id>/attempt-<n>.jsonl`。日志记录 worker/runner 阶段、route、数量和脱敏错误链，不复制 source evidence、memory/proposal 正文或凭据；模型可见正文仍只保留在 worker Session 中。

## 12. 错误分类

| 分类 | 是否写 receipt | 是否修改 Workspace | 是否允许手动重试 |
|---|---|---|---|
| source not found/ambiguous/live/changed | 是，若已生成 review id | 否 | 刷新后再判断 |
| empty/no useful events | `no-change` | 否 | 成功幂等，不需要 |
| user cancelled/timeout | 是 | 否，commit barrier 前 | 是 |
| Provider failure | 是 | 否 | 是 |
| filtered evidence too large | 是 | 否 | 调高 `maxInputBytes` 或等待分块整理能力 |
| invalid proposal | 是 | 否 | 是 |
| target conflict | 是 | 否 | 重新读取后形成新决策 |
| committed | 是 | Global 和/或一个完整 Workspace generation | 成功幂等 |
| crash during committing | 已有 committing receipt | 按恢复表判断 | 不重复调用模型 |

在 review id 尚未生成前发生的非法 Session id、缺失 snapshot 或非法 cwd，只返回结构化错误；因为还不存在稳定 review 身份，不能安全创建 receipt 文件。

## 13. 验证策略

### 13.1 单元测试

- source snapshot 在 inspect 前后稳定、消失、重复或变化；
- live Agent 在读取前、读取后和最终提交前出现；
- inspection metadata 与 snapshot 不一致；
- 空白 Session 不调用模型；
- proposal 合法与每一种非法字段、range、重复 change，以及 Global/Workspace 联合变化；
- target preview 与实际 commit 产生相同 revision；
- review lock 并发触发只运行一个 worker attempt；
- committed/no-change 幂等；
- committing 三种崩溃恢复分支；
- 取消、timeout、Provider failure、非法 proposal 和 target conflict receipt。

### 13.2 组装与回放测试

- Headless 没有 Web 服务时仍能加载；
- worker 只有 proposal tool，没有 memory/file/shell/network 能力；
- worker 的静态规则、user-role input、proposal tool call/result 都出现在 worker Session；
- replay 能重建模型可见输入；
- source Session 与 worker Session 不混写；
- RPC 对非法 request/response 均拒绝。

### 13.3 人工 Web 验证

- eligible、live、空白、source changed 和 target conflict 状态；
- 成功 replace-global/put/delete/no-change 后 Global、Workspace 页面与 Markdown 一致；
- 刷新或重启后 receipt 状态保持；
- 相同成功 review 再触发不产生新的模型调用；
- 发布前补充一次完整整理 GIF。

## 14. 实施切片

| 切片 | 内容 | 完成证据 |
|---|---|---|
| M3-A | source/target 稳定输入冻结 | 已实现；单元测试覆盖双 snapshot、live、cwd 和 metadata |
| M3-B | 双作用域 proposal schema、parser、canonicalization、preview | 已实现；非法输出、Global/Workspace 联合 commit 与 revision 一致性测试通过 |
| M3-C | 多轮 worker Agent/Session 与单一 proposal tool | 实现与隔离 Host 单元测试已完成；新版人工 Web 调用已验证，自动 assembled replay 待补 |
| M3-D | receipt store、review lock、commit barrier、恢复 | 已实现；覆盖幂等、并发、失败重试、跨 revision pending 发现、逻辑事件回放和 crash window |
| M3-E | `sessions/consolidate` RPC 与 Sessions UI | 已实现 Host/Browser 双侧解析、空 Session 组装测试与真实 Web 成功整理验证 |

先完成每个 Host 边界再接下一层，不先做只有按钮、没有事务语义的 UI。

## 15. 已确认的实现边界

| 主题 | M3 结论 |
|---|---|
| 秘密与敏感信息 | 不增加确定性 secret scanner；依靠 Prompt 约束、最小化 receipt 和用户可审阅性，接受 Host 无法识别所有语义敏感信息的风险 |
| 模型选择 | 使用插件显式 provider/model 配置；默认 `deepseek-official/deepseek-v4-flash`，可由用户覆盖 |
| Worker 工具隔离 | 实现前确认 DSH 当前 scoped restriction API，并以组装测试证明；这是一项实现验证，不再作为产品选择 |
| 失败重试展示 | UI 只显示最新 attempt；receipt 保留最小化历史；失败只能手动重试 |
| 空白与低信息 Session | 只确定性跳过严格空白；其他低信息输入交给模型判断，合法 `no-change` 即成功 |
| 已增长 Session | M3 不做增量 watermark；revision 变化形成新 review，并重新审查完整逻辑事件；增量整理推迟到 M4 评估 |
| 删除 | 允许模型提出带 evidence 的 Workspace `delete`；Global 仅允许完整 `replace-global`；仍受 Host 校验、receipt 审计和 CAS 保护 |
