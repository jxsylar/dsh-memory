# dsh-memory LoCoMo Benchmark

<p align="center">
  <a href="README.md">中文</a> · English
</p>

This benchmark follows the end-to-end structure of [OpenViking's Claude Code LoCoMo benchmark](https://github.com/volcengine/OpenViking/tree/main/benchmark/locomo/claudecode): it feeds LoCoMo history to real Agents in chronological order, then asks questions in fresh Sessions. An independent LLM Judge labels each answer as `CORRECT` or `WRONG`, with category 5 excluded.

The three modes change only the memory mechanism while using the same model, questions, and scoring process:

```text
baseline
  → QA

memory
  → ingest historical Sessions in order
  → Agent forms memory with memory_update
  → QA

memory-consolidate
  → ingest historical Sessions in order
  → Agent forms memory with memory_update
  → Consolidator reviews those Sessions
  → QA
```

The QA Agent cannot see raw conversations, gold answers, or evidence. Memory modes can use only the Markdown memory formed beforehand; baseline has no history, memory, or tools. Every run uses an isolated temporary `DSH_HOME`, Workspace, and set of Sessions, so it does not contaminate the user's normal DSH data.

## Setup

Run all commands from the dsh-memory repository root. The repository already includes `benchmark/locomo/data/locomo10.json`.

```sh
pnpm run build

python3 -m venv benchmark/locomo/.venv
benchmark/locomo/.venv/bin/pip install -r benchmark/locomo/requirements.txt
```

Configure the model under test. `DSH_SOURCE` must point to a built DeepSeek Harness source checkout. Model credentials are copied from the current `~/.dsh` into the isolated run environment.

```sh
# Absolute path to a local DeepSeek Harness source checkout
export DSH_SOURCE=/absolute/path/to/deepseek-harness

# Provider ID already configured and available in DSH
export DSH_PROVIDER=deepseek-official

# Model ID used by that Provider for ingestion, consolidation, and QA
export DSH_MODEL=deepseek-v4-flash

# Number of QA Sessions running concurrently within each sample; lower on rate limits
export QA_CONCURRENCY=4

# Number of samples running concurrently during a full evaluation
export SAMPLE_CONCURRENCY=2

# Isolated sandbox root; it may contain run state and copied model credentials
export LOCOMO_RUN_ROOT="${TMPDIR:-/tmp}/dsh-memory-locomo-runs"

# Output directory for QA, Judge, and Score artifacts
export LOCOMO_RESULT_ROOT="$PWD/benchmark/locomo/.tmp/results"
```

## Test conv-26

`conv-26` contains 19 non-empty historical Sessions and 152 category 1–4 questions.

Start with a five-question smoke test:

```sh
# Answer only the first five evaluable questions in each mode
export QUESTION_LIMIT=5
benchmark/locomo/run_conv26.sh baseline
benchmark/locomo/run_conv26.sh memory
benchmark/locomo/run_conv26.sh memory-consolidate
```

Then run the complete `conv-26` sample:

```sh
# Answer all 152 category 1–4 questions in conv-26
export QUESTION_LIMIT=all
benchmark/locomo/run_conv26.sh baseline
benchmark/locomo/run_conv26.sh memory
benchmark/locomo/run_conv26.sh memory-consolidate
```

Results are written to `benchmark/locomo/.tmp/results/conv-26-<mode>-<question-count>-v4.jsonl`.

## Test all of LoCoMo-10

The following commands run all category 1–4 questions across all ten samples:

```sh
benchmark/locomo/run_all.sh baseline
benchmark/locomo/run_all.sh memory
benchmark/locomo/run_all.sh memory-consolidate
```

Results are written to `benchmark/locomo/.tmp/results/locomo10/<mode>/<sample>-v4.jsonl`. A full evaluation makes many model calls; maximum QA concurrency is approximately `SAMPLE_CONCURRENCY × QA_CONCURRENCY`.

## Judge and Score

The Judge uses an OpenAI-compatible Chat Completions API. This example uses the DeepSeek API:

```sh
# OpenAI-compatible API root; a compatible proxy also works
export LOCOMO_JUDGE_ENDPOINT=https://api.deepseek.com

# API key used only by the Judge
export LOCOMO_JUDGE_API_KEY=<your-api-key>

# Model ID accepted by that API
export LOCOMO_JUDGE_MODEL=deepseek-chat
```

Judge and score all three complete `conv-26` results:

```sh
for mode in baseline memory memory-consolidate; do
  result="benchmark/locomo/.tmp/results/conv-26-${mode}-all-v4.jsonl"
  judged="${result%.jsonl}.judged.jsonl"
  score="${result%.jsonl}-score.json"

  benchmark/locomo/.venv/bin/python benchmark/locomo/judge.py "$result" --output "$judged"
  benchmark/locomo/.venv/bin/python benchmark/locomo/score.py "$judged" --output "$score"
done
```

Judge and score every LoCoMo-10 result:

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

Judge Accuracy is the primary score. Reports also include accuracy for the four question categories, auxiliary token F1, and stage-specific latency and Token usage for Ingestion, QA, Consolidation, and Judge.

## Generate the complete report

After Judge and Score finish for all three modes, generate the self-contained interactive HTML report:

```sh
benchmark/locomo/.venv/bin/python benchmark/locomo/report.py
```

Open [`locomo10-report.html`](locomo10-report.html) to explore overall and category accuracy, all ten sample comparisons, stage-level cost, complete Prompts, and filterable per-question results. The report excludes Agent traces, tool calls, and full context. Generating it does not call a model.

The canonical raw, judged, score, and meta artifacts behind the current report are preserved in [`results/locomo10`](results/locomo10/) for auditing individual answers and aggregate statistics. The runner still writes to the ignored `.tmp/results` directory by default. The repository's `results` directory is a path-sanitized publication snapshot and is not overwritten by later runs.

Failed or interrupted sandboxes are preserved and may contain copied model credentials. Delete them after debugging. Add `--debug` to a command when investigating consolidation failures.

If an Ingest or QA Agent reaches the evaluation step limit, the runner sends one recovery request in the same Session and combines latency and Token usage from both calls. If a Consolidator reaches `max-tokens` without submitting a proposal, the runner records its usage, skips that Session, and continues; other consolidation failures still stop the sample. Only failed samples need to be rerun.

See [evaluation research](../../docs/evaluation-benchmarks.md) for additional design background.
