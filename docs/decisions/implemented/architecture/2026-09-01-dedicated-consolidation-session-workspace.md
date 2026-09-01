# Dedicated consolidation Session Workspace

## Problem

The one-shot consolidation worker originally copied the source Session cwd into its own header. This made the audit Session readable through DSH history, but its physical log was stored beside normal project Sessions. Because the plugin created the Agent directly instead of using the normal Session controller, the worker was also not attached to a native DSH Workspace and appeared as ungrouped in the UI.

## Decision

Use `$DSH_HOME/memory/consolidator-workspace` as the fixed operational cwd for every new consolidation worker. Create the directory privately before Agent creation. When the optional DSH Workspace Registry is available, create or reuse a native Workspace titled `Memory Consolidation`, require it to resolve to that exact directory, and attach the worker Session after persistence flush succeeds. Without the registry, retain the dedicated cwd and physical separation while leaving native grouping unavailable.

This operational Workspace is not a memory scope. The target memory Workspace remains the frozen scope derived from the source Session, and the worker cannot select or change it. Existing worker Sessions are not migrated.

Exclude every Session whose cwd is the dedicated operational directory from the Memory Session catalog, regardless of Session id, so the Workspace never appears on the consolidation page. Repeat the exclusion in Host preparation so a caller cannot bypass the catalog and consolidate an internal audit Session through the RPC endpoint.

## Alternatives considered

- Keep the source cwd. This preserves native history readability but mixes internal audit logs with normal project Sessions.
- Use a cwd without a native Workspace. This physically separates logs but leaves workers under the UI's ungrouped bucket in Web deployments.
- Attach workers to the source DSH Workspace. This keeps project history mixed and visually implies that the worker is a normal project conversation.
- Rewrite or move existing Session logs. This requires persistence-backend migration semantics and risks invalidating durable references; the behavior applies only to new attempts.

## Consequences

- New worker logs are physically isolated from source project Session directories.
- Web deployments show workers under one dedicated native Workspace instead of source Workspaces or the ungrouped bucket.
- The dedicated Workspace remains visible in DSH's ordinary Session history but is absent from Memory's consolidation source picker.
- Headless compositions do not gain a mandatory Web service dependency.
- Failure to prepare the dedicated Workspace or attach a flushed Session is an explicit internal worker failure with debug stages.
- Session placement and memory mutation authority remain separate concepts.
