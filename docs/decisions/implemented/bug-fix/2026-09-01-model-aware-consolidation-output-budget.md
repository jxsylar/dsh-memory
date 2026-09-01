# Model-aware consolidation output budget

## Problem

The consolidation worker used a fixed 4096-token output limit. A real `deepseek-v4-flash` attempt spent all 4096 tokens on reasoning, reached `max-tokens`, and never called `memory_review_propose`. Raising the fixed value blindly could exceed a different selected model's adapter-owned output limit. The presence of provider/model defaults in Bundle configuration also made their relationship to the Settings selection unclear.

## Decision

Raise the plugin's desired output ceiling to 8192 tokens. Before creating each worker Agent, resolve the exact selected route through DSH `llm.resolveModelInfo(provider, model)` and use the smaller of the plugin ceiling and the returned `defaultMaxTokens`; when DSH does not publish a limit, retain the plugin ceiling. Reject invalid model metadata or a resolver result that attempts to exceed the configured ceiling.

Strengthen the complete worker Prompt to request the smallest useful proposal, avoid narration and alternative drafts, prefer `no-change` when evidence is insufficient, and call `memory_review_propose` as soon as a decision exists. Advance the consolidator version to `m3-turn-evidence-v4` because model-visible instructions changed.

The Settings page remains authoritative for provider/model after the first save. Bundle defaults only bootstrap an absent settings file; `maxTokens`, timeout, and input bytes remain operational ceilings rather than model identity.

## Alternatives considered

- Send 8192 to every model. This ignores lower adapter-owned limits and can turn a valid route into a rejected request.
- Omit `maxTokens` and inherit each adapter default. Some defaults are intentionally very large, which removes the plugin's cost guard.
- Keep 4096 and change only the Prompt. This reduces waste but leaves little room for reasoning models and substantial valid proposals.
- Add a per-model token field to the Memory UI. DSH already owns route capability metadata, and asking users to duplicate it creates stale configuration.

## Consequences

- Low-limit models retain their DSH-owned cap; higher-limit and unknown-cap models receive at most 8192 tokens.
- The selected route still comes from Memory Settings, while first-run and operational defaults remain explicit.
- Model-capability resolution is part of worker setup and produces dedicated Debug stages.
- Previously successful source revisions receive a new review identity under the changed Prompt semantics.
