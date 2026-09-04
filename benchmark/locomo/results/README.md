# LoCoMo-10 result snapshot

This directory preserves the canonical artifacts behind the published [interactive report](https://hr98w.github.io/dsh-memory/). It contains one complete LoCoMo-10 run for each evaluation mode:

```text
locomo10/
├── baseline/
├── memory/
└── memory-consolidate/
```

Each mode contains four files per Conversation:

| Suffix | Contents |
|---|---|
| `-v4.jsonl` | Raw QA predictions and per-question runtime metrics |
| `-v4.judged.jsonl` | Raw predictions plus the LLM Judge verdict and reasoning |
| `-v4-score.json` | Per-Conversation accuracy, category, Token, call, and cost summary |
| `-v4.meta.json` | Run configuration and phase metrics |

The committed metadata omits the original machine's absolute `agent_patch`, `data`, `result`, and `sandbox` paths. No model output, metric, version, or evaluation verdict was changed.

The benchmark runner still writes new results to the ignored `benchmark/locomo/.tmp/results` directory by default. This folder is a published snapshot, not a live output target. To rebuild an HTML report from the snapshot without invoking a model:

```sh
benchmark/locomo/.venv/bin/python benchmark/locomo/report.py \
  --results benchmark/locomo/results/locomo10 \
  --output /tmp/dsh-memory-locomo10-report.html
```
