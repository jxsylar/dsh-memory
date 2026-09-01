# Exclude archived Session candidates

## Problem

DSH archives a Session by retaining its persistence data and adding its id to the Workspace Registry's global archive set. The Memory Session catalog reads persistence snapshots, so archived Sessions remained visible and could still be submitted directly for consolidation.

## Decision

When the optional Workspace Registry is available, omit every archived Session from the Host-side candidate catalog. Do not expose archived Sessions as disabled Browser rows.

Reuse the same live archive predicate in `SessionConsolidator`: reject an archived source before inspection, after the stable preparation reobservation, and immediately before the commit barrier. Keep the registry optional so Headless compositions without DSH Workspace management retain the existing persistence-driven behavior.

An already durable `committing` receipt continues to use the existing recovery path. Archive filtering prevents new work; it does not invalidate or strand a commit intent that may already have changed authoritative memory.

## Alternatives considered

- Filter only in the Browser. This would transfer unnecessary rows and allow direct RPC callers to bypass the restriction.
- Show archived Sessions as disabled candidates. DSH archive semantics hide Sessions from ordinary grouping surfaces, so omission is more consistent and needs no additional wire state or localized UI.
- Make Workspace Registry mandatory. This would break Headless and minimal profiles even though Session persistence remains usable there.

## Consequences

- Archived Sessions remain on disk and available to DSH archive/history behavior but disappear from Memory's consolidation picker.
- Direct consolidation of an archived Session fails before a worker or model call.
- A Session archived during a new attempt cannot enter the commit barrier.
- No Browser protocol or localization change is required.
