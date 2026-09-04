# LoCoMo Agent isolation

## Problem

An explicit benchmark run directory under this repository made repository instructions, benchmark source, the full LoCoMo dataset, and sibling Session artifacts readable by the full SDK Coding Agent. One ingestion Session used many model steps to inspect those files and could see future conversations, invalidating both cost and accuracy measurements.

## Decision

Reject explicit run directories inside the dsh-memory repository and make the convenience runner use an operating-system temporary root. Install an evaluation-only Agent guard into SDK profiles. The guard replaces the Agent role, limits ingestion and memory QA to six model steps, restricts ingestion to `read` plus `memory_update`, restricts memory QA to `read`, and denies reads outside the active isolated `$DSH_HOME/memory`. Baseline has a separate one-step role with no history, memory, or tools; it must answer from the question alone instead of searching for a nonexistent memory index. Disable workspace instruction discovery and telemetry for these Agent runs. Use low reasoning effort for ingestion, record tool names with usage, and version the runner, prompt, and policy so contaminated state cannot resume.

## Alternatives considered

- Rely only on Prompt instructions not to inspect files. The observed Agent ignored that soft boundary while trying to solve revision handling.
- Move the cwd outside the repository but keep unrestricted tools. The Agent could still traverse absolute filesystem paths or inspect sibling source Sessions.
- Use `sdk-minimal`. It omits the runtime context required to exercise dsh-memory.
- Remove file tools entirely. Workspace progressive disclosure requires a read capability during both ingestion and memory-backed QA.

## Consequences

- The Python controller can read the dataset, but evaluation Agents can read only isolated memory Markdown.
- Baseline and memory QA share the same question input and model route, while their tool surfaces truthfully reflect the condition: no tools for baseline and memory-root-only `read` for memory QA.
- Ingestion keeps real Agent-driven online memory formation without inheriting general coding tools or repository instructions.
- Existing repository-local run directories are rejected and old state versions cannot resume; users must start a fresh benchmark run.
- Explicit run directories contain copied credentials and remain user-cleaned artifacts outside the repository.
