# Workspace batch editing

## Problem

Workspace management needed create, edit, rename, and delete operations without letting each field change publish a partial Markdown generation. A stale Browser also needed to preserve its draft instead of overwriting newer memory.

## Decision

Keep Workspace edits as a Browser-local working copy. On save, diff it against the last `workspace/read` response and submit one non-empty canonical batch: unique deletes first, then unique puts. Send only the opaque Workspace id, expected revision, and closed record values.

The Host parses the batch, resolves the id through the current catalog, and delegates one revision-checked generation commit to `MemoryStore`. A revision mismatch returns conflict without retrying, refreshing, or clearing the Browser draft. The user must explicitly discard changes before refresh or Workspace switching can replace that draft.

## Alternatives considered

- Commit each field or record immediately. This could expose partial generations and make multi-record changes difficult to review or undo before saving.
- Automatically refresh and replay a stale draft. This could silently reinterpret a rename or delete against newer memory.
- Let the Browser send files or paths. This would bypass the Host-owned scope and record validation boundary.

## Consequences

- Every UI save publishes at most one complete Workspace generation and rebuilds `MEMORY.md` once.
- Rename and replacement are expressible as delete-then-put operations in one atomic batch.
- Conflicts require explicit user resolution, but unsaved text remains available for copying or revision.
- The Browser owns transient draft UX only; Markdown and `MemoryStore` remain authoritative.
