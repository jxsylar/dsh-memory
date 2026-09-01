# Isolated one-shot consolidation worker

## Problem

Session consolidation needs model judgment, but a worker must not inherit ordinary Agent memory context, filesystem or network tools, Workspace authority, or the ability to retry malformed output through extra model steps. Its exact model-visible evidence and proposal process must also remain reconstructable after the live Agent is disposed.

## Decision

Create one fresh Agent/Session for every review attempt without source Session reuse. Give it a dedicated durable cwd and DSH Workspace according to the later [dedicated consolidation Session Workspace decision](2026-09-01-dedicated-consolidation-session-workspace.md); the target memory Workspace still comes from the frozen source scope. During the unpublished Agent setup scope, install one complete static system section, suppress all ordinary runtime context, deny all inherited tools, and register only the scoped `memory_review_propose` tool. Pin the worker to the plugin's explicit provider, model, output-token ceiling, and attempt timeout; the later [model-aware output budget decision](../bug-fix/2026-09-01-model-aware-consolidation-output-budget.md) refines the effective ceiling per selected DSH model.

Inject the frozen model-facing evidence and current Workspace records as a user-role plugin message. The later [turn evidence projection decision](../simplification/2026-08-31-turn-evidence-projection.md) refines that evidence from complete source events to a deterministic compact projection while retaining full events Host-side. The proposal tool exposes the complete nested put/delete schema, then passes its still-untrusted value to the Host parser and preview boundary, records an accepted/rejected result, and concludes the turn. Reject every pre-step after step one, so missing, malformed, or repeated tool use never causes a second Provider request. On every exit, require a successful persistence flush before disposing its live Agent handle. Internal worker ids are excluded from the Memory Session candidate catalog.

## Alternatives considered

- Reuse or resume the source Session. This mixes evidence with the review transcript and can inherit source cwd, tools, and runtime context.
- Omit cwd from the worker header. DSH persists the transcript, but its native ordinary-Session history controller deliberately rejects cwd-less Sessions as not found.
- Mark the worker as a DSH subagent. Subagent history requires a durable parent address and subagent descriptor projection that this internal worker does not produce.
- Run an unlogged direct model call. This loses the model-visible request and proposal lifecycle needed for replay and audit.
- Rely only on Prompt instructions to avoid other tools. This does not provide capability isolation.
- Let the Agent retry an invalid proposal. This increases cost and makes one attempt's meaning nondeterministic.

## Consequences

- Each attempt uses at most one Provider request and has a deterministic worker Session identity.
- Dynamic evidence, the proposal tool call, and its Host acceptance result are retained in a native-history-readable worker Session, while paths, Workspace keys, cwd, and revisions are withheld from the model.
- Worker Sessions can never become consolidation sources even though their durable header carries the dedicated cwd.
- The worker can propose but cannot commit memory; later receipt and commit barriers remain Host responsibilities.
- Unit tests can prove the local isolation contract, but a real DSH assembled replay test is still required before claiming end-to-end reconstructability.
