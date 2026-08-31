# Consolidation failure diagnostics

## Problem

The Agent loop contains model-turn failures and reports them through the scoped `agent/error` event. Waiting for the worker to become idle therefore does not itself reject. The consolidation runner also classified every unknown failure as `provider-failed`, which hid Agent construction, strict injection, Session flush, and disposal failures behind a misleading UI state.

## Decision

The worker listens to its own scoped `agent/error` event and converts a captured model-turn error into an explicit Provider failure after the Agent becomes idle. Agent creation, Session flush, and Agent disposal use separate internal runtime errors. The runner classifies only the explicit Provider error as `provider-failed`; unexpected and setup failures become `internal-error`.

Each attempt also appends stage and error-chain diagnostics to `$DSH_HOME/memory/debug/<review-id>/attempt-<n>.jsonl`. Debug entries include identities, selected route, counts, error names, messages, codes, causes, and stacks. They exclude source events, memory bodies, proposal bodies, and credentials, and apply a best-effort credential redaction before writing mode-0600 files.

The worker composition fiber declares `systemPrompt` and `tools` in addition to `sessionPersistence`, `agents`, and `sessions`, because its Agent setup reads all five capabilities.

The first real diagnostic run also established another Host environment fact: DSH `defineTool()` treats `parameters` as an implicit property map, not as a standard JSON Schema object root. The proposal tool therefore declares `outcome` and `changes` directly under `parameters`. A later real model run showed that leaving each change as unconstrained JSON led the model to emit `op` instead of the required `action` and omit evidence. The tool now projects exact nested put/delete object schemas while the existing Host parser remains the final authority. The local DSH-tools test stub enforces the property-map shape so the outer registration failure is caught before a real Web run.

Because the model-visible Prompt and proposal schema changed, the consolidator version advances to `m3-turn-evidence-v3`; the same source generation is reviewed under a new deterministic review id instead of mixing old and new attempt semantics.

## Alternatives considered

- Depend only on the Markdown receipt. Receipts are stable product audit records and deliberately omit detailed operational errors.
- Write source events and model payloads into the debug file. The worker Session already retains replayable model-visible input, while duplicating it would increase secret and privacy exposure.
- Treat every failure as a Provider error. This makes wiring defects indistinguishable from upstream failures and sends debugging in the wrong direction.
- Keep a permissive standard JSON Schema object under `parameters`. DSH interprets its `type` key as a parameter named `type` and rejects the string value during Agent setup.

## Consequences

- The Settings page can point users to one deterministic local file for an attempt.
- Provider and plugin-internal failures have different receipt/UI states.
- A debug-write failure never changes the consolidation outcome; it is emitted as a Host warning.
- Redaction is defense in depth, not a guarantee that arbitrary secrets embedded in unusual error messages can always be recognized.
- Tool schema shape now has a local contract test matching the runtime compiler's implicit-root convention.
