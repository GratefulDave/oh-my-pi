# Operational Runbook

## Startup or mode dispatch bug

1. Check argv normalization in `runCli()`: bare argv becomes `launch`; help/version/subcommands bypass rewrite (`packages/coding-agent/src/cli.ts:53-67`).
2. Check `runRootCommand()` early exits before session creation: version, list-models, export, RPC file-arg rejection (`packages/coding-agent/src/main.ts:716-781`).
3. Check settings/profile/env overrides before model/session setup (`packages/coding-agent/src/main.ts:794-846`).
4. Check mode flags: `isInteractive`, `autoPrint`, and `mode` decide interactive/RPC/ACP/print path (`packages/coding-agent/src/main.ts:829-831`, `packages/coding-agent/src/main.ts:964-1058`).

## Missing or wrong resumed history

1. Inspect `createSessionManager()` flag branch: `--fork`, `--no-session`, `--resume`, `--continue`, `autoResume`, and `--session-dir` each choose different storage behavior (`packages/coding-agent/src/main.ts:401-467`).
2. Inspect `SessionManager.setSessionFile()` / `open()` / `continueRecent()` for loaded file, cwd, terminal breadcrumb, and session dir (`packages/coding-agent/src/session/session-manager.ts:1846-1888`, `packages/coding-agent/src/session/session-manager.ts:3180-3217`).
3. Inspect migrations and blob resolution before assuming JSONL corruption (`packages/coding-agent/src/session/session-manager.ts:311-373`, `packages/coding-agent/src/session/session-manager.ts:879-896`).
4. Inspect `buildSessionContext()`: only active leaf-to-root path enters LLM context; sibling branch entries are intentionally excluded (`packages/coding-agent/src/session/session-manager.ts:506-761`).

## Message exists in transcript but not sent to model

Check boundaries in this order:

1. `SessionEntry` type: `CustomEntry` is state-only; `CustomMessageEntry` participates in context (`packages/coding-agent/src/session/session-manager.ts:130-144`, `packages/coding-agent/src/session/session-manager.ts:189-209`).
2. Active branch path: `buildSessionContext()` walks current leaf to root (`packages/coding-agent/src/session/session-manager.ts:555-561`).
3. Compaction: a compaction entry can replace earlier history with summary and selected kept messages (`packages/coding-agent/src/session/session-manager.ts:623-696`).
4. Dangling tool-use cleanup: assistant tool calls without paired tool results are stripped before replay (`packages/coding-agent/src/session/session-manager.ts:704-749`).
5. `convertToLlm()`: bash/python messages marked excluded do not enter provider context; file mentions and summaries are transformed (`packages/coding-agent/src/session/messages.ts:367-473`).

## Model missing or fallback surprise

1. Identify whether selection came from CLI, scoped `enabledModels`, remembered default role, resumed session, extension provider, or first-available fallback (`packages/coding-agent/src/main.ts:571-657`, `packages/coding-agent/src/sdk.ts:923-999`, `packages/coding-agent/src/sdk.ts:1402-1443`).
2. For CLI selector bugs, use `resolveCliModel()` and `parseModelPattern()` behavior (`packages/coding-agent/src/config/model-resolver.ts:470-535`, `packages/coding-agent/src/config/model-resolver.ts:1082-1232`).
3. For enabled-model restrictions, `resolveAllowedModels()` can intentionally return empty when patterns match no available model (`packages/coding-agent/src/config/model-resolver.ts:1041-1069`).
4. For extension providers, confirm provider registrations were queued during extension load and processed before deferred model resolution (`packages/coding-agent/src/extensibility/extensions/loader.ts:257-259`, `packages/coding-agent/src/sdk.ts:1372-1417`).
5. For retry-time switching, inspect selector suppression, fallback chains, and temporary model changes (`packages/coding-agent/src/session/agent-session.ts:7118-7393`, `packages/coding-agent/src/session/agent-session.ts:7462-7556`).

## Repeated retries or quota failures

1. Confirm error is retryable: transient transport/envelope, usage-limit, and Antigravity quota are retryable; context overflow is handled by compaction (`packages/coding-agent/src/session/agent-session.ts:6950-7008`).
2. Inspect auth storage usage-limit marking and credential switching (`packages/coding-agent/src/sdk.ts:1888-1921`, `packages/coding-agent/src/session/agent-session.ts:7462-7556`).
3. Inspect configured `retry.fallbackChains` and current role primary model. Fallback candidates require both model resolution and API key (`packages/coding-agent/src/session/agent-session.ts:7190-7335`).
4. If Antigravity is involved, inspect derived OpenAI Codex fallback selectors (`packages/coding-agent/src/session/agent-session.ts:7044-7108`).

## Extension handler does not fire

1. Confirm path discovery: native capability, installed plugins, workspace packages, then configured paths (`packages/coding-agent/src/extensibility/extensions/loader.ts:538-607`).
2. Confirm extension factory loaded and called `pi.on(event, handler)` (`packages/coding-agent/src/extensibility/extensions/loader.ts:278-307`, `packages/coding-agent/src/extensibility/extensions/loader.ts:139-143`).
3. Confirm event name is one of the runner-supported names. Generic lifecycle events use `emit()`; tool/input/context/provider/before-agent events have dedicated emitters (`packages/coding-agent/src/extensibility/extensions/runner.ts:538-899`).
4. Check timeout/error isolation: most handler errors emit through `onError()` and return undefined rather than crashing the session (`packages/coding-agent/src/extensibility/extensions/runner.ts:498-535`).
5. For startup credential invalidation, remember `credential_disabled` can be buffered until `initialize()` wires UI/runtime context (`packages/coding-agent/src/extensibility/extensions/runner.ts:191-293`).

## Task/subagent stuck or bad output

1. Check max recursion and runtime cap from settings; max depth removes `task`, runtime cap aborts child session (`packages/coding-agent/src/task/executor.ts:682-701`, `packages/coding-agent/src/task/executor.ts:804-820`).
2. Check child model resolution and auth fallback to parent active model (`packages/coding-agent/src/task/executor.ts:1201-1227`, `packages/coding-agent/src/config/model-resolver.ts:827-868`).
3. Check whether child called `yield`; executor sends up to three reminders and final named tool choice when possible (`packages/coding-agent/src/task/executor.ts:1437-1508`).
4. Check `finalizeSubprocessOutput()` for null yield, missing yield, schema fallback, and `report_finding` merging (`packages/coding-agent/src/task/executor.ts:302-393`).
5. Check artifacts: transcript `.jsonl`, summary `.md`, and manifest `.manifest.json` are written when `artifactsDir` is provided (`packages/coding-agent/src/task/executor.ts:1671-1728`).

## Async job missing from follow-up

1. Only top-level sessions own `AsyncJobManager`; subagents use the parent instance and must not dispose it (`packages/coding-agent/src/sdk.ts:1100-1122`, `packages/coding-agent/src/sdk.ts:1954-1964`).
2. Completed job output is formatted and enqueued into `YieldQueue` unless delivery is suppressed (`packages/coding-agent/src/sdk.ts:1108-1119`).
3. Large async results are persisted as artifacts and surfaced with `artifact://` links (`packages/coding-agent/src/sdk.ts:1080-1098`).
4. Job tool snapshots visible running/completed jobs through `tools/job.ts`.

## Storage backend checks

### JSONL session storage

- Persistent sessions may not appear on disk until an assistant message exists unless `ensureOnDisk()` has run (`packages/coding-agent/src/session/session-manager.ts:2487-2501`).
- Hot-path append is synchronous after truncation/externalization (`packages/coding-agent/src/session/session-manager.ts:2513-2530`).
- Large/image content can be externalized into BlobStore; inspect blob refs before declaring data lost (`packages/coding-agent/src/session/session-manager.ts:1079-1178`).

### SQL storage

- Confirm table name matches allowlist and dialect-specific DDL/upsert path.
- Remember sync reads/listing use mirror; `flush()`/`close()`/`drain()` are needed to observe queued write failures.
- Source: `packages/coding-agent/src/session/sql-session-storage.ts`.

### Redis storage

- Confirm `create()` was awaited so mirror was warmed via SCAN.
- Check `${prefix}file:${path}` strings and `${prefix}meta` hash mtimes.
- Source: `packages/coding-agent/src/session/redis-session-storage.ts`.

## Safe verification commands

- Format/lint generated docs only: `biome check docs/architecture/generated --no-errors-on-unmatched`.
- If source behavior changes later, run focused package checks rather than relying on docs generation.
