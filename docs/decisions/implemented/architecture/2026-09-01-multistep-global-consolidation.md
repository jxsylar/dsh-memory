# Multi-step Global and Workspace consolidation

## Problem

The original worker allowed one Provider request and one Workspace-only proposal. It could not correct an invalid draft, refine a proposal through tool feedback, or preserve durable cross-project preferences in Global memory.

## Decision

Keep the isolated worker and its single scoped `memory_review_propose` capability, but allow multiple Agent steps. Each call carries a complete proposal plus `final`: `final=false` validates a draft and permits another step; only an accepted `final=true` concludes the attempt. Replay uses the unique final call while retaining every draft and result in the worker Session.

Freeze Global content/revision together with the source Workspace generation. The proposal schema adds `replace-global` beside Workspace `put` and `delete`; every change still requires exact model-visible evidence. The Host previews both scopes, rejects duplicate or malformed changes, writes a durable intent, and performs revision-checked `MemoryStore` commits. Recovery reconstructs the final plan from the worker Session and compares each scope with its before and planned revisions.

Keep the model-aware 8192-token per-request ceiling. Multiple steps need a bounded request budget more than an unbounded one: omitting the ceiling could inherit unexpectedly large adapter defaults and multiply cost across steps. The selected model's lower declared limit still wins, while the attempt timeout remains the total execution bound.

## Alternatives considered

- Give the worker ordinary filesystem or `memory_update` tools. This would expose paths and allow writes before source/target rechecks and the receipt barrier.
- Commit every tool call immediately. A later model or Provider failure would leave an attempt with partially applied semantic work.
- Remove all output limits. Multi-step execution would make an adapter's large default apply repeatedly without a plugin-owned cost guard.
- Run separate Global and Workspace reviews. This duplicates evidence processing and cannot express one coherent final decision from the same Session.

## Consequences

- One attempt may use multiple Provider requests, but produces exactly one accepted final proposal.
- The worker can affect only Global and the source Session's Workspace; it still receives no paths, revisions, arbitrary Workspace selectors, inherited tools, or direct `MemoryStore` access.
- Global and Workspace changes remain model proposals until the Host commit barrier.
- Prompt/schema semantics changed, so newly created reviews use an advanced consolidator version; existing receipts remain valid historical results.
