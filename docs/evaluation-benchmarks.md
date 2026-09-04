# LoCoMo 与 LongMemEval 评测调研

本文整理 LoCoMo 与 LongMemEval 的现有调研，作为 `dsh-memory` M4 评测设计的输入。内容只覆盖目前已经确认的资料和初步测试方案；尚未确认的实现细节明确留待后续决定。

## 1. 评测目标

两套数据集都通过“先经历长期对话，再回答历史相关问题”评估长期记忆，但侧重点不同：

- LoCoMo 更适合观察持续人物关系和生活经历经过多次整理后是否仍可用；
- LongMemEval 更适合观察大量干扰历史下的信息提取、跨 Session 推理、时间推理、知识更新和拒答；
- 两者都以问答正确率为主要结果，但 `dsh-memory` 还应记录记忆体积、上下文用量、调用成本和延迟，避免把“保存全部历史”误认为高效记忆。

本文暂不设计 Global/Workspace 隔离专项评测。两套数据集都没有项目 Workspace 标注，这部分需要后续补充一套较小的 `dsh-memory` 原生数据集。

## 2. LoCoMo

### 2.1 是什么

LoCoMo 是面向超长期对话记忆的评测集。当前常用的 LoCoMo-10 包含 10 组长期对话，每组由两位人物跨多个 Session 持续交流，并配有基于历史对话的问题和标准答案。

一组样本大致包含：

- `sample_id`；
- 两位说话者及按时间排序的 `session_<n>`；
- 每个 Session 的日期时间；
- 每轮对话的 speaker、文本和对话 id；
- 可选图片地址、图片描述和检索词；
- QA 问题、答案、类别及 evidence 对话 id；
- 数据集另外提供 Session summary、observation、事件总结等内容，但第一阶段只需要原始对话和 QA。

原始 benchmark 还包含事件总结和多模态对话任务。`dsh-memory` 第一阶段只考虑 QA。

参考资料：

- [LoCoMo 官方仓库](https://github.com/snap-research/locomo)
- [LoCoMo 论文](https://aclanthology.org/2024.acl-long.747/)
- [OpenViking LoCoMo benchmark](https://github.com/volcengine/OpenViking/tree/main/benchmark/locomo)

### 2.2 侧重点和特点

LoCoMo 的对话更接近两个人长期相处形成的生活叙事，适合测试：

- 单个历史事实能否被保留；
- 分散在多个 Session 的事实能否组合；
- 日期、先后关系和相对时间能否正确推理；
- 人物经历、关系和事件细节经过长期整理后是否仍然可用；
- 同一份长期记忆能否回答多道不同问题。

常见 QA 类别包括 single-hop、multi-hop、temporal、open-domain 和 adversarial。为保持与 OpenViking Claude Code 结果一致，`dsh-memory` 第一版在问答前过滤 category 5（adversarial），只报告类别 1～4 的总体与分类正确率。若以后评估拒答能力，应建立单独实验，不能把结果混入这一口径。

它的主要限制是：

- 数据是人和人的对话，不是天然的用户—Agent Session；
- 历史规模相对有限，激进保存全部细节可能换来较高 QA 分数；
- 单一正确率无法反映记忆压缩、上下文成本、过期事实和隐私风险。

### 2.3 OpenViking 测试 Claude Code 的参考流程

OpenViking 为 Claude Code 提供 Prompted、SDK iso、SDK no-iso 和 e2e 四条路径。其中 Prompted 是原生 Claude Code Auto Memory 基线：

```text
读取一个 LoCoMo sample
  -> 按日期依次读取 session_1、session_2 ...
  -> 每个 LoCoMo Session 单独执行一次 claude -p
  -> Claude Code 自行决定是否把内容写入项目 MEMORY.md 或详细记忆文件
  -> 全部 Session 写入完成
  -> 每道题使用一次新的 claude -p
  -> QA 调用只获得当前日期、问题和项目 Auto Memory，不获得原始对话
  -> 保存回答、token、费用和耗时
  -> LLM Judge 将回答与标准答案比较
  -> 汇总总正确率和分类正确率
```

写入阶段默认把一个 Session 格式化成带日期的 group chat 文本，没有额外要求 Claude “记住全部内容”。同一个 LoCoMo sample 使用同一个项目目录，不同问题使用新的 Claude Code 调用。

这条流程值得复用的核心不是 Claude CLI，而是三个边界：

1. 记忆形成阶段看不到未来问题和答案；
2. QA 阶段看不到原始历史；
3. 同一 sample 的问题共享同一份已形成的记忆，但问题之间不共享临时对话上下文。

当前 dsh-memory runner 进一步把记忆 QA 放在独立 DSH Home 中：只复制整理完成时的 Global/Workspace Markdown，不复制 source Session、receipt 或 debug 数据。记忆 QA guard 只暴露受限的 `read`，所以各题可以用独立 Session 有界并发，并共享 QA 开始前生成的同一份冻结记忆快照；问答阶段既不能读取原始证据，也不能写入记忆污染后续结果。baseline 没有历史或记忆，也不暴露任何工具，避免模型寻找并不存在的 Workspace index。

参考实现：

- [Claude Code benchmark 说明](https://github.com/volcengine/OpenViking/tree/main/benchmark/locomo/claudecode)
- [`ingest.py`](https://github.com/volcengine/OpenViking/blob/main/benchmark/locomo/claudecode/ingest.py)
- [`eval.py`](https://github.com/volcengine/OpenViking/blob/main/benchmark/locomo/claudecode/eval.py)
- [`judge.py`](https://github.com/volcengine/OpenViking/blob/main/benchmark/locomo/claudecode/judge.py)

## 3. LongMemEval

### 3.1 是什么

LongMemEval 是面向长期用户—助手交互的 QA 评测集，共有 500 个评测实例。每个实例包含一个问题、一个带大量干扰信息的历史 Session 集合、标准答案和答案所在位置。

LongMemEval 将核心能力分为：

- Information Extraction；
- Multi-Session Reasoning；
- Temporal Reasoning；
- Knowledge Updates；
- Abstention。

Information Extraction 在数据类型上进一步分为：

- `single-session-user`：答案来自用户消息；
- `single-session-assistant`：答案来自助手消息；
- `single-session-preference`：回答需要正确利用用户偏好。

一条评测实例大致包含：

- `question_id`、`question_type`；
- `question`、`answer` 和 `question_date`；
- `haystack_session_ids`、`haystack_dates`；
- `haystack_sessions`，其中每个 turn 已标明 `user` 或 `assistant`；
- `answer_session_ids`；
- 答案所在 turn 的 `has_answer: true` 标记。

参考资料：

- [LongMemEval 官方仓库](https://github.com/xiaowu0162/LongMemEval)
- [LongMemEval 论文](https://arxiv.org/abs/2410.10813)
- [LongMemEval cleaned 数据](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned)

### 3.2 数据构成

官方数据提供三种主要规模：

| 数据 | 用途 |
|---|---|
| `longmemeval_oracle` | 只保留证据 Session，用于验证回答模型和建立理论上限，不作为正式记忆输入 |
| `longmemeval_s_cleaned` | 每个实例约 115K tokens 的历史，适合作为第一阶段正式评测 |
| `longmemeval_m_cleaned` | 每个实例约 500 个 Session、约 1.5M tokens，用于后续压力测试 |

第一阶段计划使用官方 cleaned 数据，不使用已经被其替代的原始版本。实际下载地址、文件哈希和固定 revision 待实现评测脚本时记录。

### 3.3 侧重点和特点

LongMemEval 更接近真实 Agent 的 Session 语义：历史已经由 user/assistant turn 组成，并带有明确时间。它特别适合测试：

- 用户和助手两侧的信息是否都会进入可用记忆；
- 大量无关 Session 中能否找到正确信息；
- 多个 Session 的信息能否聚合、比较和计算；
- 新事实出现后能否正确处理旧事实；
- 相对时间和事件顺序能否被正确解释；
- 历史没有答案时是否明确拒答，而不是根据相似记忆猜测。

LongMemEval 同时提供 evidence Session 和 answer turn 标记，因此理论上可以区分：

```text
没有形成相关记忆
  vs
形成了记忆但 Agent 没有找到
  vs
找到了记忆但推理或回答错误
```

具体如何把 `dsh-memory` 的 Markdown 文件读取映射回 evidence Session，尚未确定。第一阶段可以只做端到端 QA；检索 Recall@k、NDCG@k 和文件级 provenance 作为后续增强。

LongMemEval 用更长历史和干扰 Session 降低了“全部保存即可得高分”的收益，但它仍没有限制系统可持久化的总量，因此仍需额外报告记忆大小和问答上下文成本。

### 3.4 官方数据使用与评测流程

LongMemEval 官方仓库没有提供面向任意产品的一键 ingest runner。它提供的是：

- 已编译好的 Oracle、S 和 M 数据；
- 构造自定义长度历史的脚本；
- 论文所用的检索、长上下文和 RAG 实验代码；
- 接受任意系统答案的统一 QA Judge 与统计脚本。

因此，测试 `dsh-memory` 时需要自行实现“历史导入和提问”，再把答案交给官方评测器。

#### 准备数据和评测环境

官方 README 当前建议从 cleaned 数据集下载三个 JSON 文件：

```sh
mkdir -p data
cd data
wget https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json
wget https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
wget https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_m_cleaned.json
```

如果只需要给自己的系统判分，不需要运行论文中的检索模型，可以使用官方的最小 Python 依赖：

```sh
conda create -n longmemeval-lite python=3.9
conda activate longmemeval-lite
pip install -r requirements-lite.txt
```

`dsh-memory` 第一阶段只需要：

- `longmemeval_s_cleaned.json`：正式写入和 QA 输入；
- `longmemeval_oracle.json`：官方 Judge 查找问题、标准答案和类别的 reference。

Oracle 文件作为 Judge reference 并不意味着 QA Agent 可以看见 Oracle Session。`longmemeval_m_cleaned.json` 暂时不进入第一阶段。

#### 运行被测系统

对 `longmemeval_s_cleaned.json` 中的每个评测实例，测试 adapter 大致执行：

```text
读取 question_id
  -> 创建与其他实例隔离的记忆环境
  -> 将 haystack_session_ids、haystack_dates、haystack_sessions 对齐
  -> 按 haystack_dates 顺序逐个导入历史 Session
  -> 导入前删除 has_answer 等评测专用字段
  -> 每个 Session 结束后触发一次 dsh-memory 整理
  -> 所有历史写入完成后创建新的 QA Session
  -> 提供 question_date 和 question
  -> 收集 Agent 最终回答作为 hypothesis
  -> 追加写入 hypotheses.jsonl
```

输出文件必须保证每个问题一行，并至少包含：

```json
{"question_id":"example-id","hypothesis":"the answer produced by the system"}
```

正式提交给 Judge 的文件不需要包含标准答案、evidence 或内部运行统计。调用次数、receipt、tokens、费用、延迟和记忆体积应写入另一份 `run-results.jsonl` 或同类内部结果文件，避免污染官方最小输出协议。

#### 使用官方 Judge

生成 hypotheses 后，按照官方入口使用 GPT-4o Judge：

```sh
export OPENAI_API_KEY=YOUR_API_KEY
export OPENAI_ORGANIZATION=YOUR_ORGANIZATION  # 只有需要时才设置

cd src/evaluation
python3 evaluate_qa.py \
  gpt-4o \
  /absolute/path/to/hypotheses.jsonl \
  ../../data/longmemeval_oracle.json
```

`evaluate_qa.py` 会按 question type 使用不同判分说明，并在 `question_id` 以 `_abs` 结尾时检查回答是否正确识别为不可回答。当前脚本把 `gpt-4o` 映射到固定的 GPT-4o 模型版本，并为每个 hypothesis 写入 `autoeval_label`。

相关入口见官方 [`evaluate_qa.py`](https://github.com/xiaowu0162/LongMemEval/blob/main/src/evaluation/evaluate_qa.py) 和 [`print_qa_metrics.py`](https://github.com/xiaowu0162/LongMemEval/blob/main/src/evaluation/print_qa_metrics.py)。

当前仓库 README 对聚合输出文件名和 `print_qa_metrics.py` 参数的示例与脚本接口存在差异。实现时应固定 LongMemEval commit，并以该 commit 中脚本实际生成的文件名为准。按照当前 `print_qa_metrics.py` 的接口，聚合逻辑是：

```sh
python3 print_qa_metrics.py \
  /path/to/evaluate_qa_output.jsonl \
  ../../data/longmemeval_oracle.json
```

最终保留：

- hypotheses 原始输出；
- Judge 增加 `autoeval_label` 后的逐题日志；
- 总正确率；
- 各 question type 的正确率；
- 任务问题与 abstention 问题的分组结果；
- 完整运行配置和数据集哈希。

#### 官方检索和长上下文流程的用途

官方仓库还提供两类可选基线：

```text
完整历史
  -> run_generation.sh 使用 full-history-session
  -> Reader 直接读取 S 或 Oracle 历史

检索增强
  -> run_retrieval.sh 建立 turn/session 粒度的检索结果
  -> run_generation.sh 读取 retrieval log
  -> Reader 基于 top-k 历史回答
```

这些脚本适合建立 Full History、Oracle 和官方 RAG 基线，但不应替代 `dsh-memory` 自己的记忆形成与渐进式读取链路。官方 retrieval 指标会跳过 abstention 实例，因为这些问题没有标准答案位置；端到端 QA Judge 仍应保留 abstention。

如果第一阶段只评估 `dsh-memory`，最小链路可以缩减为：

```text
下载 S Cleaned + Oracle
  -> 自己的 adapter 导入 S 历史
  -> dsh-memory 整理并回答
  -> 输出 hypotheses.jsonl
  -> 官方 evaluate_qa.py 判分
  -> 官方 print_qa_metrics.py 聚合
  -> 自己的 report 脚本补充记忆体积和资源成本
```

## 4. 两套评测的分工

| 维度 | LoCoMo | LongMemEval |
|---|---|---|
| 交互关系 | 人与人的开放域长期聊天 | 用户与助手的任务型长期交互 |
| 评测单位 | 少量长期对话，每份历史回答多道题 | 500 个实例，每道题带一份 haystack 历史 |
| 历史规模 | 平均约 9K tokens，最多约 35 个 Session | S 约 115K tokens；M 约 1.5M tokens |
| 主要能力 | 生活经历、人物关系、细节、多跳和时间推理 | 信息提取、多 Session 推理、更新、时间和拒答 |
| Assistant 信息 | 没有标准 Agent 角色语义 | 明确测试 assistant 消息 |
| 更新事实 | 不是独立重点 | 独立的 knowledge-update 类别 |
| 无答案处理 | adversarial 类别 | 明确的 abstention 实例 |
| 诊断标注 | QA evidence 对话 id | evidence Session + answer turn |

建议将它们分别定位为：

```text
LoCoMo
  -> 观察长期叙事经过多次整理后，记忆形成质量是否稳定

LongMemEval
  -> 观察记忆系统在规模、干扰、变化和无答案条件下是否可靠
```

## 5. 共同评测原则

### 5.1 防止答案泄漏

记忆形成阶段只能读取历史 Session，不得读取：

- 问题；
- 标准答案；
- QA 类别；
- evidence id；
- `has_answer` 标记。

这些字段只允许进入评测器和 Judge。

### 5.2 隔离评测实例

- LoCoMo：一个 sample 使用一个隔离的 `DSH_HOME` 和一个测试 Workspace；该 sample 的多道题共享形成后的记忆。
- LongMemEval：一个 `question_id` 使用一个隔离的 `DSH_HOME` 和一个测试 Workspace，避免 Global 跨实例污染。
- 每道 QA 都创建新的 Agent Session，避免前一道问题的临时上下文影响后一道问题。

当前 LoCoMo runner 为每次 sample 运行创建仓库外独立的临时 `HOME`、`DSH_HOME` 和 Workspace。它只复制源 DSH Home 的模型设置与凭证，并拒绝位于 dsh-memory 仓库内的显式 run directory。自动生成的 sandbox 在成功后删除；显式 run directory 以及失败或中断的现场会保留，便于续跑和诊断。

DeepSeek Harness 官方 benchmark 说明建议用 Python SDK，并为独立任务使用不同 Workspace 与 Session id。当前 runner 因此显式传入临时路径，为历史导入和逐题 QA 创建独立 Session id，并从 SDK 的结构化结果读取最终回答、结束原因和事件。通用示例推荐的 `sdk-minimal` 不包含 runtime context，无法验证 dsh-memory 的记忆注入；本评测改用完整 `sdk` profile，再通过评测专用 Agent guard 覆盖角色、限制 step 和收窄工具。Ingestion 固定低 reasoning，只能读取隔离 memory root 并提交记忆；记忆 QA 只能读取隔离 memory root；baseline 不暴露工具。三个条件只改变可用历史记忆以及是否在相同在线记忆形成后追加 Consolidator。

参考资料：

- [DeepSeek Harness BENCHMARK.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/BENCHMARK.md)
- [DeepSeek Harness Python SDK 指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/python-sdk.md)

### 5.3 QA 不能回看原始历史

正式 `dsh-memory` 条件下，QA Agent 只能获得：

- Global Memory；
- 当前 Workspace 的 `MEMORY.md`；
- 按需读取的 Workspace 详细 Markdown。

不允许通过额外工具读取用于形成记忆的原始 LoCoMo/LongMemEval 历史。完整历史条件只能作为单独的上限基线。

### 5.4 固定模型与预算

同一组可比较结果应固定：

- consolidator 模型及版本；
- QA 模型及版本；
- Judge 模型及版本；
- Prompt 版本；
- 输入、输出 token 上限；
- 数据集文件哈希；
- dsh-memory 与 DeepSeek Harness 版本。

Claude Code 与 DSH 的完整产品比较会同时包含各自 Agent Prompt 和工具差异，不能直接解释为纯记忆机制差异。如果需要隔离记忆本身，应增加“相同 QA 模型和 Prompt，只替换记忆产物”的组件级比较。

## 6. dsh-memory 测试流程

### 6.1 共用流水线

```text
Dataset loader
  -> 将 benchmark history 转换成 DSH Session fixture
  -> Agent 按时间顺序阅读 Session，并可在线写入记忆
  -> 按实验条件决定是否触发 dsh-memory Consolidator
  -> 保存在线形成指标，以及可选的整理 receipt 与资源统计
  -> 创建隔离的 QA Agent Session
  -> 提交 question_date + question
  -> 收集 hypothesis、模型用量和实际打开的记忆文件
  -> 使用数据集官方或兼容 Judge 判分
  -> 按类别汇总正确率、成本、延迟和记忆体积
```

第一阶段使用完整 SDK profile 驱动真实 Agent Session 导入。固定 Prompt 只说明输入是历史对话，并允许 Agent 将未来有用的信息写入记忆；不提供 QA 问题、答案或 evidence，也不让模型重新生成历史。两个 dsh-memory 条件使用完全相同的导入过程，其中只有一个额外运行 Consolidator。

历史导入和 QA 都由官方 Python SDK 驱动。runner 可分别复用 SDK runtime 以减少启动开销，但每段历史和每道题都使用新的 Session id；模型、profile、数据文件 SHA-256、SDK 版本、结束原因和 usage 事件写入评测产物。开发期间通过 `--dsh-source` 为源码 checkout 生成临时 wrapper，再作为公开 `dsh_bin` 参数交给 SDK，避免依赖 SDK 私有启动参数，也确保本地 bundle 使用匹配的 DSH 包图。手动 Session 整理当前仍通过隔离 Web profile 的 loopback RPC 触发，因为 Python SDK 不提供 dsh-memory 的 Browser RPC。LoCoMo Judge 独立读取已保存的 hypotheses，通过 OpenAI-compatible Chat Completions 判分；它不创建 DSH Session，也不要求重新运行 QA。

长运行可绑定显式 run directory。runner 校验 sample、数据哈希、模型、DSH 命令和插件路径，只跳过当前 source revision 已成功或无变化的整理 receipt；失败 attempt 继续重试。若一个 Consolidator attempt 明确以 `max-tokens` 结束且未提交 proposal，评测把它记录为被忽略的整理尝试，保留该次耗时与 Token 后继续后续 Session；其他整理失败仍中止 sample。ingest、整理和 QA 都输出逐项进度，失败或中断时保留隔离目录、失败摘要和可选脱敏 Debug 日志，避免无诊断信息地清理现场或重复支付已经成功的整理调用。

### 6.2 LoCoMo 适配

LoCoMo 是两个人的对话，不能直接假设其中一人就是 Agent。初步方案是把每个 LoCoMo Session 作为“用户提供的一段带 speaker 和日期的聊天记录”写入一个 DSH Session：

```text
for sample in locomo:
    create isolated profile and workspace

    for source_session in chronological_order(sample.sessions):
        create a fresh DSH Agent Session
        ask it to read the dated group-chat transcript
        allow optional online memory writes
        close Session
        consolidate Session once only in memory-consolidate mode

    freeze resulting Global and Workspace memory

    for qa in sample.questions:
        create fresh QA Session in the same workspace
        ask current_date + qa.question
        save hypothesis and usage
```

当前实现采用上述“用户提供带 speaker 和日期的聊天记录”映射。它保留说话者、时间和 dialogue id，同时避免把两位人物错误映射成 DSH 的 user/assistant。该映射对整理质量的影响仍需通过 `conv-26` 冒烟验证。

### 6.3 LongMemEval 适配

LongMemEval 的角色已经与 DSH 一致，可以按原始 turn 持久化：

```text
for item in longmemeval:
    create isolated profile and workspace

    for history_session in chronological_order(item.haystack_sessions):
        create DSH Session with item.haystack_dates timestamp
        persist every user and assistant turn exactly
        close Session
        consolidate Session once

    create fresh QA Session in the same workspace
    ask item.question_date + item.question
    save {question_id, hypothesis, usage}
```

导入前必须移除 `has_answer` 等评测标记，不能让 consolidator 或 QA Agent 看见。正式结果输出可使用官方要求的 JSONL：

```json
{"question_id":"...","hypothesis":"..."}
```

随后使用 LongMemEval 官方 `evaluate_qa.py` 和 `print_qa_metrics.py` 生成总分及分类结果。Judge 的确切模型和运行参数需要与最终报告一起固定。

### 6.4 建议的脚本职责

LoCoMo 第一版使用一个独立、非通用化的目录：

```text
benchmark/locomo/
├── run.py               # 隔离、导入、整理与 QA
├── dataset.py           # LoCoMo sample/session/QA 解析
├── judge.py             # 独立、可续跑的二元 LLM Judge
├── score.py             # Accuracy、分类结果与效率汇总
├── recorder/            # 仅用于读取 worker 数值指标的 bundle
└── tests/               # 无模型单元测试
```

主 runner 的职责应保持简单：

```text
load -> isolate -> agent ingest -> optional consolidate -> ask -> persist result
```

判分和统计与实际 Agent 调用分开，使已有 hypotheses 可以重复判分，不必再次支付 ingest 和 QA 成本。

## 7. 基线和指标

### 7.1 建议基线

| 基线 | 目的 |
|---|---|
| No Memory (`baseline`) | 测量模型无历史时的猜测和先验能力 |
| dsh-memory (`memory`) | 测量在线 `memory_update` 与 Markdown 渐进披露 |
| dsh-memory + Consolidation (`memory-consolidate`) | 在相同在线形成过程后，测量 Session 整理带来的增益与成本 |
| Oracle / Evidence Only | 测量回答模型获得正确证据后的上限 |
| Full History | 测量完整历史读取能力；不能作为 dsh-memory 正式条件 |
| Claude Code Auto Memory | 可选产品级外部对照，优先用于 LoCoMo |

### 7.2 建议指标

核心结果：

- QA 总正确率；
- LoCoMo category 1～4 分类正确率；
- LongMemEval 各 question type 及 abstention 正确率；
- 成功、失败和未完成数量。

效率结果：

- 原始历史 tokens；
- 最终 Global 与 Workspace Markdown bytes/tokens；
- 记忆压缩率；
- 每题实际进入上下文的 tokens；
- 每题读取的详细记忆文件数量；
- ingest/consolidation/QA/Judge 的调用次数、tokens、费用和延迟。

LoCoMo 的正式报告按阶段核算：Ingestion 记录每段历史 Agent Session 的耗时与全部模型 usage；QA 逐题记录从 Agent 接题到最终答案的端到端耗时；Consolidation 从持久化 worker Session 的数值 usage 事件统计模型调用、Token 和 worker 耗时；Judge 单独记录每题请求次数、耗时和 usage。最后分别报告四个阶段及全流程 Token/费用，不能用 QA 输入 Token 代替记忆形成成本。Reasoning 是输出 Token 的子集，只展示、不重复加入总 Token 或费用。Provider 不返回价格时，只有提供带来源与日期的显式 USD/百万 Token 费率才能计算费用，否则显示未知。

可选诊断：

- evidence retention；
- Session/turn/file 级 recall；
- Recall@k、NDCG@k；
- 旧事实对 knowledge-update 的干扰；
- 无证据时引用错误记忆或编造答案的比例。

不能把所有“没有被题目询问的记忆”直接视为错误记忆，因为 QA 集不等于用户未来全部需求。可以称其为未被当前问题覆盖的保留内容，而不是 false positive。

## 8. 推荐实施顺序

### 阶段一：LoCoMo 单样本纵向切片

选择一个 sample，跑通：

```text
三组隔离导入 -> 可选逐 Session 整理 -> 多问题 QA -> Judge -> 资源报告
```

先验证角色映射、时间保留、Session 隔离和 QA 无历史泄漏。

### 阶段二：LongMemEval 小规模烟测

每类选择至少一个实例，覆盖：

- user；
- assistant；
- preference；
- multi-session；
- temporal；
- knowledge-update；
- abstention。

目标是诊断能力缺口，不发布总分。

### 阶段三：分层子集

每类选择 5～10 道，总量约 50 道。固定数据清单，作为开发期间可重复运行的回归集。

### 阶段四：正式结果

- 完整 LoCoMo-10；
- 完整 LongMemEval-S Cleaned；
- 暂不承诺 LongMemEval-M。

LongMemEval-S 粗略可能需要约两万次 Session 整理，实际数量和成本需要读取固定数据文件后再计算。完整运行前应先通过 smoke 和分层子集估算费用。

## 9. 待确认事项

- 固定的 LoCoMo 与 LongMemEval 数据 revision 和文件哈希；
- consolidator、QA 和 Judge 使用的模型与预算；
- 如何记录每次 QA 实际打开的 Markdown 文件和上下文 tokens；
- 如何把生成的记忆记录映射回 LongMemEval evidence Session；
- 是否需要组件级记忆产物比较，还是第一阶段只做完整产品链路；
- 全量 LongMemEval-S 的实际 Session 数、调用次数和预算；
- `dsh-memory` 原生 Global/Workspace 隔离评测集的范围。
