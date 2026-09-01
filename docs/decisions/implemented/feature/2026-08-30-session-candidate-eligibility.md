# Session candidate eligibility

## Problem

The Sessions UI needs to identify safe consolidation candidates without assuming JSONL storage, loading full event logs, or allowing a currently running Session to be reviewed. One lightweight snapshot alone also cannot show whether its source changed during the listing operation.

## Decision

Build a read-only Host catalog from two consecutive `SessionPersistence.listSnapshots()` observations. A Session is eligible only when its id occurs exactly once in both observations, its source-qualified revision is unchanged, it has an absolute cwd resolvable by the existing Workspace identity rule, and the live Agent registry has no Agent under the same Session id.

Return all first-observation Sessions to the Browser with an explicit eligibility result and one closed reason vocabulary: `live`, `missing-cwd`, `workspace-unavailable`, or `unstable`. Check liveness before other reasons so a currently running Session is never presented as eligible. Do not return cwd, source revision, or backend location. Until M3 creates receipts, return `latestReceipt: null` explicitly.

The later [dedicated consolidation Session Workspace decision](../architecture/2026-09-01-dedicated-consolidation-session-workspace.md) adds one controlled omission: Sessions in the plugin-owned operational cwd are excluded before classification and are also rejected by Host preparation.

## Alternatives considered

- Scan `.dsh` JSONL files. This would couple the plugin to one persistence backend and bypass validated logical storage APIs.
- Trust one snapshot observation. M3 would still recheck before commit, but the browsing UI could present a source already changing during refresh as stable.
- Hide every ineligible Session. This would make an empty list ambiguous and prevent the UI from explaining live or malformed candidates.
- Load or inspect every Session. M2 only needs metadata and should not pay full-log cost or trigger recovery behavior.

## Consequences

- Listing performs two lightweight backend metadata reads but no full event reads and no model calls.
- The Browser can explain why a persisted Session is disabled without receiving filesystem authority or source revision tokens.
- A Session changing continuously remains visible but disabled until a later stable refresh.
- M3 must repeat liveness and revision checks at consolidation time; list eligibility is observational, not an authorization token.
