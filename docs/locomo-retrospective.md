# 用 LoCoMo-10 检查一个 Markdown 记忆插件

做 dsh-memory 是一次练手：用 Markdown 保存 Global 和 Workspace 记忆，在新请求里提供索引，让 Agent 按需打开详细文件。历史 Session 还可以手动交给 Consolidator 整理。

实现能运行之后，我想知道两个问题：形成的记忆能否帮助后续问答？再整理一遍是否值得？于是跑了 LoCoMo-10，并保存了三种模式的结果。

这篇复盘基于仓库中的[结果快照](../benchmark/locomo/results/README.md)，数值可以在[在线报告](https://hr98w.github.io/dsh-memory/)逐题查看。这里没有新增模型实验。

## 测了什么

执行方式参考 OpenViking 的 [Claude Code LoCoMo benchmark](https://github.com/volcengine/OpenViking/tree/main/benchmark/locomo/claudecode)。这是流程上的借鉴，不表示模型、Prompt、工具和预算完全一致，也不据此与其分数横向排名。

| 模式 | 问答前的步骤 | QA 可使用的信息 |
|---|---|---|
| Baseline | 无历史导入 | 问题本身，没有历史、记忆和工具 |
| Memory | 按时间顺序导入对话，Agent 使用 memory_update 保存记忆 | 已形成的 Markdown 记忆 |
| Memory + Consolidate | 独立导入形成记忆，再整理这些 Session | 整理后的 Markdown 记忆 |

十组 conversation 的历史导入共涉及 272 个 Session。排除 Category 5 后，每种模式有 1,540 道题。运行元数据中的被测模型是 `deepseek-official / deepseek-v4-flash`。

每题使用新的 QA Session；记忆模式的 QA 只允许读隔离的记忆目录，不能读取原始对话、答案、源码或其他 Session。独立 LLM Judge 对照标准答案评分；主要指标是总正确题数除以总有效题数，而不是十组百分比的简单平均。可复制命令和 Judge 设置见[评测文档](../benchmark/locomo/README.md)。

## 看到的结果

| 模式 | 正确 / 有效题 | Accuracy |
|---|---:|---:|
| Baseline | 40 / 1,540 | 2.60% |
| Memory | 1,125 / 1,540 | 73.05% |
| Memory + Consolidate | 1,195 / 1,540 | 77.60% |

Baseline 的非零分数并不代表它记住了历史。它只能依靠模型常识、问题线索或猜测作答。这个对照回答的是“给历史问题提供经过提炼的记忆是否有用”，没有回答“记忆是否比直接提供完整历史更好”。

在这套设置里，记忆模式回答出了更多历史问题。但 Consolidation 没有在每组都提高准确率。例如：

| Conversation | Memory | Memory + Consolidate |
|---|---:|---:|
| conv-26 | 131 / 152（86.18%） | 103 / 152（67.76%） |
| conv-41 | 133 / 152（87.50%） | 135 / 152（88.82%） |
| conv-44 | 96 / 123（78.05%） | 87 / 123（70.73%） |

可能的解释包括重新归纳时遗漏具体事实、调整索引影响 QA 找到信息，以及模型调用的随机性。仅凭分数无法确认是哪一种原因。

尤其要注意：两种记忆模式分别完成 Ingestion，没有共享同一份冻结的初始记忆。Ingestion Agent 已读过完整对话并提炼事实，与 Consolidator 的作用存在重叠。因此总体增加的 70 个正确回答、约 4.55 个百分点，不能单独解释为 Consolidation 的稳定因果收益。

## 整理有成本，为什么总 Token 反而少了

下面是保存的 score 文件按阶段相加的 Token，总量包含输入、缓存写入、缓存读取和输出；Reasoning 是输出的子集，不再重复加一次。

| 阶段 | Memory | Memory + Consolidate |
|---|---:|---:|
| Ingestion | 6,271,192 | 6,326,090 |
| QA | 22,188,685 | 17,760,835 |
| Consolidation | 0 | 2,664,863 |
| Judge | 678,522 | 667,011 |
| 合计 | 29,138,399 | 27,418,799 |

Consolidator 增加了 276 次模型调用。与此同时，两组 QA 的调用次数分别为 4,018 和 3,548，所以增加一个处理阶段，并不必然使全流程调用更多。本次 QA Token 的减少抵消了整理开销，但这不证明整理总能节省 Token；还需要控制初始记忆并重复实验。

三组 QA 的并发配置不一致，报告没有用 QA 时间做横向效率结论。费用需要按明确的模型费率计算，当前快照没有完整费率，不能把未知价格视为免费。上述统计是保留结果所记录的阶段成本，不是所有开发试跑、失败后放弃的运行和重新评测的账单总额。

## 跑通实验时学到的事

一个意外的耗时来源是 `expected_revision`。早期工具让模型提交一个机器版本号，Agent 花了多轮调查它。后来改成 Host 保存 Agent 读到的 revision，模型只提交修改意图，Workspace 修改合并成一个 batch。它说明工具接口本身也会影响记忆形成成本。决策细节见 [Host-owned revisions](decisions/implemented/architecture/2026-09-03-host-owned-agent-memory-revisions.md)。

另一个问题是环境隔离。把评测工作目录放在源码仓库内，会让普通 Coding Agent 有机会看到数据集和其他测试文件。最终 runner 改用仓库外的沙箱与受限工具，QA 只接触冻结记忆，旧的污染状态不能续跑。边界见 [Agent isolation](decisions/implemented/bug-fix/2026-09-03-locomo-agent-isolation.md)。

失败处理也会改变实验：最终 runner 在达到 step 上限时允许一次收尾续写；Consolidator 因输出上限结束且未提交 proposal 时，记录该次失败和成本，继续整理其他 Session。它们属于实验策略，应当和正常结果一起披露。

## 这次实验的局限

- 每种模式只有一组最终完整结果，没有多次独立重复的均值、方差或置信区间。
- 开发过程中处理过失败、重试和重跑。Memory 的 conv-41 曾在观察到异常低分后单独重跑，并替换最终快照。这不是预先固定的随机重复方案，可能引入选择偏差；不能用最终分数推断稳定期望。
- Ingestion、QA 和 Judge 都有 LLM 参与，Judge 也可能误判。公开逐题结果是为了让人复核，不等于所有 verdict 已由人工确认。
- 两种记忆模式独立形成初始记忆；这次也没有 full-context 或其他记忆系统的对照。
- LoCoMo 的历史问答不等于真实开发中的偏好遵循、经验迁移或错误避免。保留更多对话细节可能提高答题率，却不一定产生更适合日常工作的长期记忆。

目前的结果支持继续使用和打磨这条简单的 Markdown 记忆路径。若以后专门研究 Consolidation，优先从同一份已形成的记忆分叉，固定模型、预算与重试规则，预先选定测试范围并重复运行，再比较准确率和完整成本。
