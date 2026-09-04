# Isolated LoCoMo SDK runner

## Problem

The first LoCoMo slice needs to compare plain DSH, online dsh-memory writes, and online writes followed by Session consolidation without leaking benchmark Sessions or memory into the user's normal DSH home. Shelling out to a one-shot Headless command makes final responses and model events difficult to distinguish from process output, while the official minimal SDK profile deliberately omits runtime context and therefore cannot exercise dsh-memory recall.

## Decision

Run QA turns through the official Python SDK with explicit temporary `dsh_home`, workspace, profile, provider, model, and fresh Session ids. Reuse one SDK runtime within each phase, but never reuse a QA Session id.

For local plugin development, accept a DeepSeek Harness source checkout and create a temporary executable wrapper around its `pnpm dsh` command. Pass that wrapper through the SDK's public `dsh_bin` option; do not depend on the private `_launch_args` testing hook. An independently installed DSH executable remains an alternative.

Use the full `sdk` profile for all three conditions. Clone that profile and add dsh-memory only for the two memory conditions. Do not use `sdk-minimal`, because it excludes runtime context. Import each historical conversation through a real Agent Session with a small, fixed prompt that permits saving future-useful facts to memory. Run the Consolidator only in the third condition. Use an evaluation-only bundle solely to inspect numeric worker metrics, and use the isolated Web profile only for dsh-memory's loopback consolidation RPC.

Each sample run owns a fresh temporary `HOME`, `DSH_HOME`, and workspace. Only model settings and credentials are copied from the selected source home. Record the model configuration, SDK version, dataset path and dataset hash beside the hypotheses.

After online formation, and after consolidation when enabled, create a separate QA DSH home containing only the required profiles, model configuration, and the resulting Global/Workspace Markdown snapshot. Do not copy source Sessions, consolidation receipts, or debug logs. Restore that same memory snapshot before every question so a QA turn cannot influence later questions through a memory write.

Long model runs may use an explicit run directory containing a small validated state file. A rerun with the same dataset hash, sample, mode, model, ingest Prompt version, DSH command, and plugin path reuses a completed ingestion. The consolidation condition additionally skips source revisions whose latest receipt is currently `committed` or `no-change`; failed receipts are retried. Print progress for every ingest, consolidation, and QA item. Preserve the sandbox and a machine-readable failure summary on errors or interruption; optional dsh-memory Debug logging supplies the receipt-specific diagnostic file.

Follow the OpenViking Claude Code evaluation boundary after QA: exclude category 5 before applying the question limit, include the latest conversation date in each QA prompt, and grade the saved answers with a separate OpenAI-compatible binary LLM Judge. Keep Judge execution resumable and independent from DSH so hypotheses can be regraded without repeating memory formation or QA. Report total and category 1-4 Judge Accuracy as the primary result; retain deterministic token F1 only as an auxiliary diagnostic.

Keep operational accounting phase-aware. Ingestion and QA record per-item end-to-end latency and every DSH usage event. The evaluation-only recorder reads numeric usage and turn timestamps from each durable Consolidator worker through `SessionPersistence.inspect()`; it does not scan raw Session files or expose conversation content. Judge records its own latency, request count, and usage. The scorer reports Ingestion, QA, Consolidation, Judge, and full-process totals separately. It computes USD cost only from an explicit versioned per-million-token pricing input; missing prices produce `null`, never an inferred zero.

## Alternatives considered

- Use `sdk-minimal` as recommended for generic DSH benchmarks. This cannot test dsh-memory because its prompt composition omits runtime context.
- Keep parsing one-shot Headless stdout. This lacks the SDK's structured final response, finish reason, events, and reusable process lifecycle.
- Call the SDK's private `_launch_args` hook for a multi-part source command. This is not a supported integration contract.
- Persist source conversations mechanically without an Agent call. This can test consolidation alone, but cannot form the online Auto Memory condition requested for the primary comparison.
- Import source conversations by editing Session JSONL. This would bypass the public Session API and couple the benchmark to a storage encoding.
- Run against the user's normal DSH home. This would contaminate real Sessions, profiles, Workspaces, and memory.
- Restart every failed benchmark from an empty home. This repeats successful Provider work and makes long runs unnecessarily expensive.

## Consequences

- All conditions share the same full DSH agent profile; the installed memory bundle and whether consolidation runs are the intended differences.
- The two memory conditions share the same Agent-driven history import, so their only designed difference is the consolidation pass.
- QA receives dsh-memory's real runtime context and can progressively open Markdown memory with normal file tools.
- QA cannot inspect source Session files, and every question starts from the same frozen Markdown state.
- Manual consolidation remains a DSH-specific support step outside the Python SDK.
- Explicit run directories contain copied credentials and are never deleted automatically; users must remove them after collecting results.
- Judge outputs are separate derived files and can be resumed or regenerated without changing raw QA results.
- Reasoning tokens remain visible but are treated as a subset of output tokens for totals and pricing.
- Real model execution still incurs Provider cost and remains an explicit manual benchmark step.
