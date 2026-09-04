# Parallel LoCoMo QA Sessions

## Problem

LoCoMo QA questions are independent, but the runner processed them serially through one reusable SDK runtime. A 100-question sample therefore spent most wall-clock time waiting for one Provider response at a time. Resetting the same QA memory directory before every question also made direct parallelization unsafe.

## Decision

Run QA with a bounded thread pool over distinct DSH Session ids while sharing one already-started Python SDK runtime. Default to four concurrent Sessions and expose `--qa-concurrency`; the conv-26 helper maps `QA_CONCURRENCY` to that option.

For LoCoMo-10, run each sample in its own isolated runner process and sandbox. The `run_all.sh` helper defaults to two concurrent samples and exposes `SAMPLE_CONCURRENCY`; total Provider concurrency is therefore approximately `SAMPLE_CONCURRENCY × QA_CONCURRENCY`.

For memory modes, create the frozen QA memory snapshot once before the QA phase. The evaluation guard exposes only `read`, so concurrent Sessions share that immutable Markdown tree without per-question reset. Only the coordinator writes JSONL, buffering out-of-order completions until preceding dataset positions are available. Record both the configured concurrency and QA phase wall-clock elapsed time in run metadata.

## Alternatives considered

- Start one DSH process per question. This repeats profile startup and increases process and memory cost unnecessarily.
- Give each question a copied DSH Home. This maximizes isolation but adds large profile copies and obscures the cost of the memory system with filesystem overhead.
- Share one mutable memory tree and reset it from worker threads. Concurrent deletion and reads can race, producing missing files or inconsistent context.
- Parallelize ingestion or consolidation. Both phases intentionally evolve shared memory in chronological order and must remain serial.

## Consequences

- QA wall-clock time can decrease without changing prompts, question selection, memory content, scoring, or per-question Session isolation.
- One runtime receives concurrent `session/prompt` requests; the SDK separates request waiters and Session notification subscriptions.
- Provider rate limits become the practical ceiling, so concurrency remains configurable and can be set to one for the previous behavior.
- Running multiple samples in parallel multiplies Provider concurrency by each sample's QA concurrency and therefore requires an external total-concurrency budget.
