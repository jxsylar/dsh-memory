# Receipt-first Workspace commit

## Problem

A consolidation can crash immediately before or after the Workspace directory swap. Writing only a final receipt can therefore lose the intent for an uncommitted change or leave a committed generation reported as failed. The audit record must also avoid duplicating proposal and memory bodies already retained in the worker Session.

## Decision

Serialize each deterministic review with an in-process review lock. Immediately before commit, recheck the frozen source Session and target Workspace revision. For a real change, atomically persist a `committing` Markdown receipt containing the before revision, content-addressed planned after revision, proposal hash, minimal change hashes, and worker attempt identity. Then call the existing `MemoryStore` Workspace CAS exactly once.

On a later `committing` recovery, compare the current Workspace revision: replay the same validated plan when it equals before, mark committed without another write when it equals planned after, and otherwise finish as target conflict. The supplied recovery plan must match the receipt's proposal hash and both revisions. Successful `committed` and `no-change` receipts return idempotently.

## Alternatives considered

- Write the receipt only after Workspace commit. A crash after the directory swap cannot be distinguished from an uncommitted attempt.
- Store the full proposal or memory content in the receipt. This duplicates potentially sensitive model output and conflicts with the minimal audit format.
- Guess recovery from record names and change hashes. Hashes prove identity but cannot reconstruct missing content.
- Hold the Workspace lock during the model request. This creates a long critical section and couples Provider latency to online memory writes.

## Consequences

- The Workspace remains the authoritative memory generation, while the receipt is the durable transaction intent and audit summary.
- Recovery does not call a model, silently overwrite a newer generation, or accept a different proposal.
- A later orchestration slice must reconstruct the validated recovery plan from the persisted worker Session before entering this coordinator.
- The review lock is process-local; multi-Host access to one memory root remains unsupported.
