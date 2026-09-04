# Host-owned Agent memory revisions

## Problem

The model-facing `memory_update` tool required an opaque `expected_revision`. Real LoCoMo ingestion showed an Agent spending many model steps trying to derive that value from files even though it had no semantic value and could not be reconstructed from `MEMORY.md` alone. Removing CAS entirely would allow stale model output to overwrite newer memory.

## Decision

Keep revision comparison inside `MemoryStore`, but remove revision from ordinary Agent context, tool arguments, and tool results. When dynamic memory context is assembled, retain the exact Global and current-Workspace generations in a Host-only observation keyed by the live Agent object. `memory_update` resolves its precondition only from that observation; it never falls back to the latest store revision. A missing, mismatched, or stale observation fails closed. Successful writes advance the observation for a later tool call from the same Agent.

Expose Workspace model writes as one `update_workspace` batch of complete `put` and `delete` changes. Browser editing and Session consolidation retain their explicit durable revision contracts because they span UI requests or receipt recovery rather than one live Agent context.

## Alternatives considered

- Remove revision checks and rely only on the scope lock. This serializes commits but still permits a later writer whose content was generated from a stale snapshot to overwrite newer memory.
- Hold the scope lock from prompt assembly through model execution. Model work may take minutes, may never write, and crosses multiple requests, so this would block unrelated Consumers and make failure recovery unsafe.
- Improve only the field description. This leaves the model responsible for copying a machine token and does not prevent unnecessary investigation.
- Read the latest revision immediately before every tool commit. This defeats optimistic concurrency because the proposed content may have been generated from an older snapshot.

## Consequences

- Models express memory intent without seeing or transporting hashes.
- Stale writes remain rejected under the existing per-scope lock and CAS check.
- Two Workspace record changes can publish as one complete generation and one tool call.
- Runtime observation is intentionally ephemeral; a resumed Agent must assemble context before writing.
- Model-visible tool calls are simpler, while Browser and Consolidator protocols remain unchanged.
