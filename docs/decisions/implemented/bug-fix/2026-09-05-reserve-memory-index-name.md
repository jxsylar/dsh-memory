# Reserve the Workspace index name

## Problem

The valid kebab-case record name `memory` produced `memory.md`, which aliases the generated `MEMORY.md` on case-insensitive filesystems. On macOS a commit succeeded, then index generation overwrote the record and subsequent reads failed with missing YAML frontmatter.

## Decision

Reject the index basename case-insensitively in the shared Store name validator before publishing any batch. Test that a batch deleting an existing record and inserting the reserved name rejects without changing records, index, or revision. Keep the rejection platform-independent.

## Alternatives considered

- Detect filesystem case sensitivity: gives the same data different validity on different machines.
- Rename the generated index: breaks the established progressive-disclosure layout.
- Silently rename a model proposal: changes its intent and references.

## Consequences

New conflicting records are rejected with a descriptive error. Existing damaged files are not automatically repaired: overwritten content requires a backup or Session evidence. An intact legacy `memory.md` on a case-sensitive disk must be renamed together with its frontmatter `name` while writers are stopped, before loading it with this version. Back up the Workspace first; do not rename the generated index as though it were a detailed record.
