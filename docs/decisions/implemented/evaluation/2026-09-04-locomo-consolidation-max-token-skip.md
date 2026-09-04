# Skip max-token consolidation attempts in LoCoMo

## Problem

A LoCoMo sample consolidates many historical Sessions before QA. A worker can spend its complete model-aware output budget on reasoning and end with `max-tokens` before calling `memory_review_propose`. The plugin correctly records this as an unsuccessful `invalid-proposal`, but aborting the sample discards the opportunity to evaluate all other successful consolidation attempts and makes one truncated Session decide the entire condition.

## Decision

Keep the plugin's production failure semantics unchanged. In the LoCoMo runner only, inspect the durable worker Session through the evaluation recorder after an unsuccessful attempt. Continue with the next source Session only when the RPC status is `invalid-proposal` and the worker's final `turn/end` reason is exactly `max-tokens`. On a resumed sandbox, apply the same check to the latest current receipt before calling the Consolidator so an already-observed truncation is not retried.

Retain the unsuccessful status in run metadata and add `ignored: true` with `ignore_reason: max-tokens`. Record every worker attempt for that review and aggregate their model calls, usage and elapsed time so consolidation and full-process cost include retries as well as the ignored work. Any malformed proposal, Provider failure, internal error, conflict, cancellation, missing metric, or other finish reason still aborts the sample.

## Alternatives considered

- Treat every `invalid-proposal` as ignorable. This would hide schema, evidence, and Host validation defects.
- Mark truncation as `no-change` in the plugin. The Session was not successfully reviewed, so a success receipt would be false and would alter normal product behavior.
- Retry until one attempt succeeds. This makes evaluation cost and memory state depend on an unbounded retry policy.
- Abort the complete sample. This overweights one omitted consolidation and prevents QA over the memory that was successfully formed and consolidated.

## Consequences

- One truncated worker contributes no memory change, while later Sessions are still reviewed.
- Reports can count and display ignored consolidation attempts and include their real cost.
- The comparison remains deterministic about the policy: one explicit attempt per Session in a run, with no hidden retry.
- The evaluation recorder now projects the last worker turn finish reason in addition to numeric metrics; it still uses `SessionPersistence.inspect()` and does not scan storage files.
