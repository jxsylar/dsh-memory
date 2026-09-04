# Bounded recovery for LoCoMo Agent steps

## Problem

An ingest or QA Agent can use every allowed step reading or updating memory and end as `blocked` before emitting its short final response. Ingest can also report a successful write before ending with `Done`, which the runner previously rejected even though the required terminator was present.

## Decision

Accept an ingest response when its final non-empty line is `Done`, with optional punctuation. When an ingest or QA turn reaches the evaluation step limit, continue the same Session once with a short instruction to stop searching and finish from evidence already present. Include usage, tool calls, and elapsed time from both turns in the recorded result.

Do not retry arbitrary ingest failures because a model or Provider failure may occur after a memory write. A failed sample from an older run without ingest checkpoints must use a new isolated run directory.

## Alternatives considered

- Increase the step limit for every request. This changes normal evaluation cost and encourages more searching even when unnecessary.
- Retry the original ingest prompt in a new Session. This may repeat memory writes and distort both memory content and cost.
- Treat every blocked ingest as successful. The memory operation may be incomplete, so this is unsafe.

## Consequences

- Normal successful turns are unchanged.
- A step-limited turn gets at most one additional model request, and that cost remains visible.
- Previously successful samples remain valid; only failed samples need a clean rerun.
