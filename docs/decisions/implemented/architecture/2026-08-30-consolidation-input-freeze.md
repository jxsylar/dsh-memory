# Consolidation input freeze

## Problem

Session consolidation must read a complete backend-neutral logical event log without accepting a stale eligibility result as authorization. `SessionPersistence.inspect()` returns events but not the source-qualified revision, and the target Workspace may change before a later commit.

## Decision

Introduce a Host-only `SessionConsolidator.prepare()` boundary. It observes exactly one persistence snapshot, rejects a live or cwd-less Session, resolves the Workspace through `MemoryStore`, calls `SessionPersistence.inspect()`, captures the current Workspace generation, then observes the source snapshot again. Preparation succeeds only when source metadata and revision remain identical and the Session is still not live.

The returned input contains cloned logical events, the current Workspace records and revision, a consolidator version, and a deterministic review id derived from the version, source identity, source revision, and Workspace key. The later [turn evidence projection decision](../simplification/2026-08-31-turn-evidence-projection.md) adds a deterministic model-facing projection while keeping these complete events Host-only. Preparation does not call a model or mutate memory.

## Alternatives considered

- Trust the earlier Sessions UI eligibility result. It is observational and can become stale before a user triggers consolidation.
- Use `load()` or scan JSONL. `inspect()` is the non-mutating backend-neutral API and preserves the persistence abstraction.
- Read events once without a second snapshot. Because inspection does not carry its source revision, this cannot prove which listed generation supplied the events.

## Consequences

- A later proposal/commit stage receives one explicit source and target generation and can rely on `MemoryStore` CAS for target drift.
- Full event loading happens only after cheap liveness, identity, cwd, and snapshot checks.
- Worker creation, proposal validation, receipts, RPC, and UI remain separate follow-up slices; this boundary deliberately exposes none of them yet.
