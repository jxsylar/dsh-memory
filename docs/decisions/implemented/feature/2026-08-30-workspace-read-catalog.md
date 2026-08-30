# Workspace read catalog

## Problem

The Browser needed to discover and inspect existing Workspace memory before mutation UI could be added. Sending cwd, absolute directories, or the storage key would expose Host identity inputs and let Browser requests select filesystem scope directly.

## Decision

Derive a read-only catalog from valid Workspace directories under the Host memory root. Expose each entry as a stable `workspace:<sha256(internal-key)>` id, a slug display name, revision, and record count. Resolve `workspace/read` ids only against a fresh Host enumeration and return a closed projection containing the derived index and structured records.

Parse list and read requests and responses on both sides of the Connection RPC wire. Do not return cwd, absolute paths, or internal Workspace keys.

## Alternatives considered

- Expose the internal directory key. This would make a storage implementation detail part of the Browser contract.
- Let the Browser submit cwd. This would move authoritative scope selection out of the Host.
- Persist a separate catalog file. The directory set is already authoritative and small enough to derive without introducing synchronization state.

## Consequences

- The Browser can list and inspect Workspace memory without filesystem authority.
- Workspace ids remain stable while the internal key remains stable, but are deliberately not user-facing names.
- Display names are lossy slugs because v0.1 does not persist a separate Workspace title.
- A malformed record in a valid Workspace fails the read path explicitly instead of silently presenting incomplete memory.
