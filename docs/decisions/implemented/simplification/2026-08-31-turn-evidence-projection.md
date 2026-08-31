# Turn evidence projection

## Problem

Passing every logical Session event to the consolidation model duplicates request metadata, stream chunks, lifecycle boundaries, injected runtime context, tool arguments, file contents, command output, and intermediate assistant steps. Large coding Sessions can exceed the selected model's context limit, and injected memory can be learned again as if it were new evidence.

## Decision

Keep the complete backend-neutral event log in the frozen Host input, but derive a separate model-facing `sourceEvidence` through DSH `foldSurface()`. Group effective surface nodes by original turn boundaries. Retain human user text, compaction replacement summaries, the last non-empty assistant text in each turn, and tool name plus success/failure. Exclude ordinary plugin user messages, request metadata, chunks, lifecycle events, title events, tool arguments, and tool-result bodies.

Replace non-text user blocks with type-only placeholders, apply best-effort credential redaction, and replace fenced code blocks larger than 4 KiB with a byte-count placeholder. Preserve each evidence turn's original inclusive seq range. A proposal may cite only exact supplied turn ranges; the full log remains authoritative for source stability and receipt coverage.

Do not silently take the newest N turns. Measure the complete replayable worker input after structural projection, including Workspace records. Reject inputs above the configurable `maxInputBytes` limit (128 KiB by default) before Agent creation with terminal `evidence-too-large`. Record only before/after counts and byte sizes in the debug log.

Bump the consolidator version so a source revision previously reviewed under raw-event semantics can be reviewed once under the new projection semantics.

## Alternatives considered

- Send DSH `deriveMessages()` directly. It retains full tool results and plugin runtime context and loses the original event ranges required by proposal provenance.
- Keep only the newest N turns. This can silently discard the durable decision that the review exists to learn.
- Ask a preliminary model to summarize the log. It adds cost, another failure mode, and a second untrusted semantic transformation before the auditable proposal.
- Split every large Session into multiple model calls immediately. Chunk proposal merging, duplicate resolution, and cross-chunk evidence need a separate design after deterministic projection is measured.

## Consequences

- Typical coding Sessions send a much smaller, less repetitive payload while preserving user decisions and final outcomes.
- Tool output and previously injected memory no longer enter the consolidation request by default.
- Very large human messages or Workspace records still fail explicitly instead of being silently truncated.
- Recovery remains replayable because the exact projected input is stored in the worker Session; full source events are not duplicated there.
