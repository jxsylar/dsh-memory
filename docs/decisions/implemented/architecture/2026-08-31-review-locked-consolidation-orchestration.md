# Review-locked consolidation orchestration

## Problem

The separate preparation, worker, receipt, and commit boundaries need one owner that prevents concurrent model calls, records every post-prepare failure, preserves manual retry history, and resumes a durable commit without asking the model again.

## Decision

Run one manual attempt under the deterministic review lock after backend-neutral preparation. Return successful terminal receipts immediately, skip the worker for a strictly empty event log, otherwise invoke the isolated worker once and pass its validated plan to the receipt-first commit coordinator. Classify pre-barrier failures into the closed receipt states and append a new attempt only on explicit retry.

Before preparing the current source revision, discover the oldest `committing` receipt for that source Session from the controlled review directory. Inspect its persisted worker Session through `SessionPersistence`, require exactly one matching user-role evidence message and proposal tool call, and re-run Host proposal validation against the receipt-owned Workspace generation. The commit coordinator then verifies the proposal hash and planned revisions before recovery. Never call the model during recovery; a later explicit trigger handles any newer source revision.

## Alternatives considered

- Lock only the final Workspace commit. Concurrent requests could pay for duplicate model calls before either reaches CAS.
- Automatically retry malformed output or Provider failure. This makes one user action consume an unpredictable number of requests.
- Recover from receipt hashes alone. Hashes verify content but cannot reconstruct it.
- Read the worker JSONL file directly. This couples the plugin to one SessionPersistence backend.

## Consequences

- Concurrent requests for one review produce at most one model call after a successful terminal result.
- Failure history remains minimal and auditable while proposal bodies stay only in the worker Session.
- A failed attempt is retried only by another explicit user action.
- Runtime wiring and Browser RPC remain a separate slice, and real DSH assembled replay still requires verification.
- A recovery action finishes at most one oldest pending review; processing a newer source revision requires another explicit trigger.
