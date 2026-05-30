# Coding Agent Architecture Pack

Generated documentation for `packages/coding-agent`. Scope is repo-grounded architecture, not source modification.

## Contents

- [System overview](./system-overview.md)
- [Runtime and session flow](./runtime-session-flow.md)
- [Task orchestration](./task-orchestration.md)
- [Extension/plugin EventBus](./extensions-eventbus.md)
- [Model resolution and fallback](./model-resolution-fallback.md)
- [State machines](./state-machines.md)
- [Class and module diagrams](./class-module-diagrams.md)
- [Data contracts](./data-contracts.md)
- [Operational runbook](./operational-runbook.md)

## Source-grounding method

Native task agents inspected independent slices, then this pack reconciled their findings with direct reads of core files. Citations use `path:line-line` and symbol names.

Primary sources:

- CLI/root launch: `packages/coding-agent/src/cli.ts:53-70`, `packages/coding-agent/src/main.ts:272-345`, `packages/coding-agent/src/main.ts:401-467`, `packages/coding-agent/src/main.ts:547-707`, `packages/coding-agent/src/main.ts:716-1065`
- SDK/session construction: `packages/coding-agent/src/sdk.ts:234-364`, `packages/coding-agent/src/sdk.ts:794-2204`
- Session runtime: `packages/coding-agent/src/session/agent-session.ts` symbols `AgentSession`, `prompt`, `switchSession`, retry/fallback and compaction handlers
- Session persistence: `packages/coding-agent/src/session/session-manager.ts:57-253`, `packages/coding-agent/src/session/session-manager.ts:506-775`, `packages/coding-agent/src/session/session-manager.ts:1760-1805`, `packages/coding-agent/src/session/session-manager.ts:2487-2778`, `packages/coding-agent/src/session/session-manager.ts:2880-3259`
- Task orchestration: `packages/coding-agent/src/task/executor.ts:174-233`, `packages/coding-agent/src/task/executor.ts:302-393`, `packages/coding-agent/src/task/executor.ts:615-1777`, `packages/coding-agent/src/task/types.ts`
- Extensions: `packages/coding-agent/src/extensibility/extensions/loader.ts:1-609`, `packages/coding-agent/src/extensibility/extensions/runner.ts:1-900`, `packages/coding-agent/src/extensibility/extensions/types.ts:137-1248`, `packages/coding-agent/src/extensibility/shared-events.ts:1-344`
- Model resolution: `packages/coding-agent/src/config/model-resolver.ts:470-535`, `packages/coding-agent/src/config/model-resolver.ts:613-868`, `packages/coding-agent/src/config/model-resolver.ts:934-1402`, `packages/coding-agent/src/config/model-registry.ts`
- Operational storage/jobs: `packages/coding-agent/src/session/sql-session-storage.ts`, `packages/coding-agent/src/session/redis-session-storage.ts`, `packages/coding-agent/src/session/agent-storage.ts`, `packages/coding-agent/src/async/job-manager.ts`, `packages/coding-agent/src/config/settings-schema.ts`
