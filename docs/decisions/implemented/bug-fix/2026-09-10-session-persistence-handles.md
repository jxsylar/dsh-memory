# Session persistence handle compatibility

## Problem

The updated DSH persistence service exposes `list(options)` and `open(id, access, options)` instead of `listSnapshots(signal)` and `inspect(id, signal)`. The old calls fail in candidate discovery, consolidation input loading, and worker replay. This is a Host API mismatch, not invalid Browser input.

## Decision

Normalize the service once at each Host composition boundary with `adaptSessionPersistence`. Prefer the complete `list/open` API pair when available; retain the legacy pair otherwise. Do not retry backend errors using another API.

Map metadata listing without changing headers or revision tokens. Read the complete logical log through a read-only handle, propagate cancellation, and always close an acquired handle in `finally`, including read failure and cancellation. Never acquire write ownership or access persistence files directly.

Keep the existing internal `listSnapshots/inspect` face for catalog, consolidator, and replay. The [input freeze decision](../architecture/2026-08-30-consolidation-input-freeze.md) still applies: observe source identity/revision before and after loading and recheck before committing. Only the backend call mapping changes.

## Alternatives considered

- Rename list calls only: leaves source history and recovery broken.
- Switch all Consumers to the new API: duplicates handle lifecycle handling and drops legacy support.
- Scan Session files: breaks backend neutrality and risks bypassing log validation.

## Consequences

No memory format, receipt, prompt, or Browser protocol changes. Unit tests cover both API families, receiver binding, cancellation, read failure, and resource cleanup. Host composition tests exercise list and empty-Session consolidation through both APIs without model calls. Real Web verification remains manual.
