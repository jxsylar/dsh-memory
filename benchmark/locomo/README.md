# dsh-memory LoCoMo 评测

<p align="center">
  中文 · <a href="README.en.md">English</a>
</p>

这套评测整体参考 [OpenViking 的 Claude Code LoCoMo benchmark](https://github.com/volcengine/OpenViking/tree/main/benchmark/locomo/claudecode) 的端到端组织方式：把 LoCoMo 历史对话依次交给真实 Agent，最后用新的 Session 回答问题。评分同样使用独立 LLM Judge 判断 `CORRECT` 或 `WRONG`，并排除 category 5。

三种模式只改变记忆机制，使用相同的模型、问题和评分方式：

```text
baseline
  → QA

memory
  → 按顺序导入历史 Session
  → Agent 使用 memory_update 形成记忆
  → QA

memory-consolidate
  → 按顺序导入历史 Session
  → Agent 使用 memory_update 形成记忆
  → Consolidator 整理这些 Session
  → QA
```

QA 看不到原始对话、标准答案或 evidence。记忆模式只能使用此前形成的 Markdown 记忆；baseline 没有历史、记忆和工具。每次运行都使用独立的临时 `DSH_HOME`、Workspace 和 Session，不会污染用户自己的 DSH 数据。

## 准备

以下命令都在 dsh-memory 仓库根目录执行。仓库已经包含 `benchmark/locomo/data/locomo10.json`。

```sh
pnpm run build

python3 -m venv benchmark/locomo/.venv
benchmark/locomo/.venv/bin/pip install -r benchmark/locomo/requirements.txt
```

配置被测模型。`DSH_SOURCE` 指向已经构建的 DeepSeek Harness 源码目录；模型凭据读取自当前 `~/.dsh`。

```sh
# 本地 DeepSeek Harness 源码的绝对路径
export DSH_SOURCE=/absolute/path/to/deepseek-harness

# DSH 中已经配置并可用的 Provider ID
export DSH_PROVIDER=deepseek-official

# 该 Provider 下用于导入、整理和 QA 的模型 ID
export DSH_MODEL=deepseek-v4-flash

# 每个 sample 同时执行的 QA 数量；遇到限流时可调低
export QA_CONCURRENCY=4

# 全量评测时同时执行的 sample 数量
export SAMPLE_CONCURRENCY=2

# 隔离沙箱目录；其中可能包含运行状态和模型凭据副本
export LOCOMO_RUN_ROOT="${TMPDIR:-/tmp}/dsh-memory-locomo-runs"

# QA、Judge 和 Score 结果的保存目录
export LOCOMO_RESULT_ROOT="$PWD/benchmark/locomo/.tmp/results"
```

## 测试 conv-26

`conv-26` 包含 19 段非空历史 Session 和 152 道 category 1～4 问题。

先用 5 道题冒烟：

```sh
# 每种模式只回答前 5 道有效问题
export QUESTION_LIMIT=5
benchmark/locomo/run_conv26.sh baseline
benchmark/locomo/run_conv26.sh memory
benchmark/locomo/run_conv26.sh memory-consolidate
```

确认无误后，运行完整 `conv-26`：

```sh
# 回答 conv-26 的全部 152 道 category 1～4 问题
export QUESTION_LIMIT=all
benchmark/locomo/run_conv26.sh baseline
benchmark/locomo/run_conv26.sh memory
benchmark/locomo/run_conv26.sh memory-consolidate
```

结果位于 `benchmark/locomo/.tmp/results/conv-26-<mode>-<题数>-v4.jsonl`。

## 测试全部 LoCoMo-10

以下命令会运行全部 10 个 sample、全部 category 1～4 问题：

```sh
benchmark/locomo/run_all.sh baseline
benchmark/locomo/run_all.sh memory
benchmark/locomo/run_all.sh memory-consolidate
```

结果位于 `benchmark/locomo/.tmp/results/locomo10/<mode>/<sample>-v4.jsonl`。全量评测会产生较多模型调用；最大 QA 并发约为 `SAMPLE_CONCURRENCY × QA_CONCURRENCY`。

## Judge 和 Score

Judge 使用 OpenAI-compatible Chat Completions API。下面以 DeepSeek API 为例：

```sh
# OpenAI-compatible API 根地址，也可以填写代理地址
export LOCOMO_JUDGE_ENDPOINT=https://api.deepseek.com

# Judge API 的密钥
export LOCOMO_JUDGE_API_KEY=<your-api-key>

# 上述 API 实际接受的模型 ID
export LOCOMO_JUDGE_MODEL=deepseek-chat
```

为完整 `conv-26` 的三组结果评分：

```sh
for mode in baseline memory memory-consolidate; do
  result="benchmark/locomo/.tmp/results/conv-26-${mode}-all-v4.jsonl"
  judged="${result%.jsonl}.judged.jsonl"
  score="${result%.jsonl}-score.json"

  benchmark/locomo/.venv/bin/python benchmark/locomo/judge.py "$result" --output "$judged"
  benchmark/locomo/.venv/bin/python benchmark/locomo/score.py "$judged" --output "$score"
done
```

为全部 LoCoMo-10 结果逐个评分：

```sh
for mode in baseline memory memory-consolidate; do
  for result in benchmark/locomo/.tmp/results/locomo10/$mode/conv-*-v4.jsonl; do
    judged="${result%.jsonl}.judged.jsonl"
    score="${result%.jsonl}-score.json"

    benchmark/locomo/.venv/bin/python benchmark/locomo/judge.py "$result" --output "$judged"
    benchmark/locomo/.venv/bin/python benchmark/locomo/score.py "$judged" --output "$score"
  done
done
```

Score 以 Judge Accuracy 为主，同时给出四类问题的准确率、辅助 token F1，以及 Ingestion、QA、Consolidation、Judge 各阶段的耗时和 Token。

## 生成完整报告

三种模式全部完成 Judge 和 Score 后，生成自包含的交互式 HTML：

```sh
benchmark/locomo/.venv/bin/python benchmark/locomo/report.py
```

打开[在线交互式报告](https://hr98w.github.io/dsh-memory/)即可查看总体与分类准确率、十组对比、分阶段成本、完整 Prompt 和可筛选的逐题结果。报告不包含 Agent trace、工具调用或完整上下文；生成过程不会调用模型。

本次报告对应的 canonical raw、judged、score 和 meta 文件保存在 [`results/locomo10`](results/locomo10/)，方便复核单题结果和统计来源。Runner 的默认输出仍是 Git 忽略的 `.tmp/results`；仓库内 `results` 只是经过本机路径清理的发布快照，不会被后续运行自动覆盖。

失败或中断的沙箱会被保留，其中可能包含模型凭据副本；排查完成后应删除。整理问题可在命令末尾增加 `--debug`。

Ingest 或 QA 达到评测 step 上限时，runner 会在同一 Session 中追加一次“停止搜索并完成”的恢复请求，并合并两次调用的耗时与 Token。Consolidator 若因输出达到 `max-tokens` 而没有提交 proposal，runner 会记录该次调用的耗时和 Token、跳过这一段 Session 并继续；其他整理失败仍会中止 sample。仍然失败时，只需重跑对应 sample；已经成功的 sample 不需要重跑。

更多设计背景见 [评测调研](../../docs/evaluation-benchmarks.md)。
