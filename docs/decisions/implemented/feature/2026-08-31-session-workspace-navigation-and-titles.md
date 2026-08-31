# Session Workspace navigation and titles

## Problem

A flat Session list becomes difficult to scan across many projects. Workspace display names can collide, some persisted Sessions have no safe Workspace association, and deriving a title by loading or guessing from ordinary messages would add cost and duplicate DSH semantics.

## Decision

Return an opaque Workspace id and display name with every safely resolvable Session summary. The Browser first presents Workspace groups keyed by the opaque id, then renders only the selected group's Sessions. Keep Sessions without a safe association in an explicit localized unassigned group instead of hiding them or merging them into a guessed Workspace.

Expose the Session title as a nullable, browser-safe value. Its authority is DSH's latest log-backed `session/title` event: read live Sessions through `sessionProjections.snapshot()` and cold Sessions through the identity-checked `sessionProjectionCache.cachedSnapshot()`. Never load a complete Session log merely to decorate the list. Missing, malformed, or failed projection reads degrade to an untitled label and do not fail candidate discovery.

The title and Workspace grouping are presentation metadata only. Session id remains the consolidation identity, while eligibility, receipts, source stability, and commit checks remain unchanged.

## Alternatives considered

- Group by Workspace display name. Different absolute Workspace identities can share a basename and would be incorrectly merged.
- Hide cwd-less or invalid Workspace Sessions. This would remove useful diagnostics and make persisted Sessions appear to disappear.
- Use the first user message as the title. DSH already owns title generation, rename, persistence, and last-wins semantics through `session/title`.
- Call `SessionQuery.readTitleSnapshots()` for every refresh. It is backend-neutral but loads and folds logical logs; the projection cache exists specifically to decorate list rows without those reads.

## Consequences

- Session browsing scales by Workspace and preserves same-name Workspace isolation.
- Listing still performs no full event-log reads and no model calls.
- Recently changed cold titles may be as fresh as the latest durable projection checkpoint; opening the Session can produce a fresher projection later.
- Deployments without the projection services remain compatible and show untitled Sessions.
