# Consolidation proposal validation and preview

## Problem

The consolidation worker will return an untrusted semantic proposal. The Host must reject malformed fields and unsupported scope changes, preserve evidence provenance, and know the exact Workspace generation before entering the later receipt commit barrier. A separately implemented preview algorithm could drift from the actual `MemoryStore` commit result.

## Decision

Add a Host-only closed proposal parser for `put`, `delete`, and `no-change`. It requires exact fields, validates every evidence range against the frozen Session evidence, rejects more than one change for the same memory name, reuses `MemoryStore` record validation, and canonicalizes changes as name-sorted deletes followed by name-sorted puts. The later [turn evidence projection decision](../simplification/2026-08-31-turn-evidence-projection.md) narrows validation from any in-bounds raw range to exact model-visible turn ranges.

Add `previewWorkspaceChanges()` as the pure Workspace generation algorithm. Both preview and `commitWorkspace()` use it for validation, Markdown normalization, deterministic ordering, index generation, and revision calculation. A proposal that produces no semantic record change becomes `no-change`; commit preserves the existing revision and skips the directory exchange.

## Alternatives considered

- Trust the worker tool schema alone. Model output and tool payloads remain hostile at the Host boundary and require runtime parsing.
- Let the worker provide scope, revision, or paths. Those values are Host-owned and are never accepted from the model.
- Compute preview in the Consolidator and repeat the transformation inside `MemoryStore`. Two algorithms could disagree at the commit barrier.
- Treat delete-then-put of one name as an update. Updates already have one canonical representation: `put`.

## Consequences

- M3 can persist a planned post revision before commit without guessing how `MemoryStore` will serialize the generation.
- Invalid evidence, unknown fields, missing delete targets, and duplicate-name changes fail before receipt or Workspace mutation.
- Evidence and changes have deterministic order for later proposal hashing and receipts.
- Worker creation, receipt persistence, final source recheck, RPC, and UI remain later slices.
