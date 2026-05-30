# task

> Launch subagents for parallel, optionally isolated work.

## Source
- Entry: `packages/coding-agent/src/task/index.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/task.md`
- Key collaborators:
  - `packages/coding-agent/src/task/types.ts` — dynamic schema, progress/result types, output caps.
  - `packages/coding-agent/src/task/discovery.ts` — discover project/user/plugin/bundled agents.
  - `packages/coding-agent/src/task/agents.ts` — bundled agent definitions and frontmatter parsing.
  - `packages/coding-agent/src/task/executor.ts` — create child sessions, run subagents, collect output.
  - `packages/coding-agent/src/task/parallel.ts` — concurrency-limited scheduling and async semaphore.
  - `packages/coding-agent/src/task/worktree.ts` — isolation mode parsing/PAL backend materialisation, patch capture, branch merge.
  - `packages/coding-agent/src/task/output-manager.ts` — session-scoped `agent://` id allocation.
  - `packages/coding-agent/src/task/simple-mode.ts` — `default` / `schema-free` / `independent` field gating.
  - `packages/coding-agent/src/internal-urls/agent-protocol.ts` — resolve `agent://<id>` to saved subagent output.
  - `packages/coding-agent/src/tools/index.ts` — tool registration and recursion-depth gating.
  - `packages/coding-agent/src/sdk.ts` — child-session router/tool wiring and per-subagent `AgentOutputManager`.
  - `docs/task-agent-discovery.md` — deeper discovery and precedence notes.
  - `docs/handoff-generation-pipeline.md` — session artifact/handoff persistence patterns used by the wider session layer.

## Inputs

### Default mode (`task.simple = "default"`)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `agent` | `string` | Yes | Default agent name, or `auto` for deterministic content-based routing. Each task may override with optional `tasks[].agent`. |
| `tasks` | `Array<{ id: string; description: string; assignment: string; agent?: string }>` | Yes | Batch of small, self-contained task items. `id` max length 48 in schema; duplicate ids are rejected case-insensitively at runtime. |
| `context` | `string` | No | Shared background prepended to every subagent system prompt. Trimmed before use. |
| `schema` | `string` | No | JSON-encoded JTD schema. Overrides agent/session output schema when this mode allows task-level schemas. |
| `isolated` | `boolean` | No | Only present when the tool is created with isolation enabled. Requests isolated execution for the whole batch. |

`tasks[].description` is UI-only. `tasks[].assignment` is the actual per-task instruction.

### Schema-free mode (`task.simple = "schema-free"`)

Same as default, except `schema` is rejected by `validateTaskModeParams(...)` in `packages/coding-agent/src/task/index.ts`.

### Independent mode (`task.simple = "independent"`)

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `agent` | `string` | Yes | Default agent name, or `auto` for deterministic content-based routing. Each task may override with optional `tasks[].agent`. |
| `tasks` | `Array<{ id: string; description: string; assignment: string; agent?: string }>` | Yes | Same item shape, but each `assignment` must carry all required background because shared `context` is disabled. |
| `isolated` | `boolean` | No | Same conditional field as above. |

In this mode both `context` and `schema` are rejected.

## Outputs
The tool returns one text block plus `details: TaskToolDetails`.

`details` fields:
- `projectAgentsDir: string | null` — nearest discovered project `agents/` dir.
- `results: SingleResult[]` — one entry per task in input order for synchronous execution; empty for async-launch responses.
- `totalDurationMs: number`
- `usage?: Usage` — sum of per-subagent assistant-message usage.
- `outputPaths?: string[]` — written `.md` artifact paths for completed subagent outputs.
- `progress?: AgentProgress[]` — live or final per-task progress snapshots.
- `async?: { state: "running" | "completed" | "failed"; jobId: string; type: "task" }` — present for background execution updates/results.

`SingleResult` includes:
- identity: `index`, `id`, `agent`, `agentSource`, `description`, optional `assignment`
- status: `exitCode`, optional `error`, optional `aborted`, optional `abortReason`
- output: `output`, `stderr`, `truncated`, `durationMs`, `tokens`
- artifact metadata: `outputPath?`, `patchPath?`, `branchName?`, `nestedPatches?`, `outputMeta?`
- extracted tool data: `extractedToolData?` from registered subprocess tool handlers such as `yield` and `report_finding`

Artifacts and side channels:
- Every subagent with an artifacts dir writes `<id>.md`; `agent://<id>` resolves to that file.
- If the output file is JSON, `agent://<id>/<path>` and `agent://<id>?q=<query>` perform JSON extraction in `packages/coding-agent/src/internal-urls/agent-protocol.ts`.
- When the parent session persists artifacts, each subagent also gets `<id>.jsonl` session history.
- Isolated patch mode writes `<id>.patch` per successful task before merge.
- Async mode returns immediately after job registration, then emits `onUpdate(...)` progress snapshots and later hands completion to the session async-job pipeline.

## Flow
1. `TaskTool.create(...)` in `packages/coding-agent/src/task/index.ts` calls `discoverAgents(session.cwd)` once to build the dynamic prompt description from current agents and `task.simple` capabilities.
2. `execute(...)` validates mode-gated fields with `validateTaskModeParams(...)`.
3. It decides async vs sync:
   - sync when `async.enabled` is false
   - sync when the selected cached agent has `blocking === true`
   - sync when `tasks.length === 0`
   - otherwise async job scheduling
4. Async path:
   - allocate unique output ids with `AgentOutputManager.allocateBatch(...)`
   - create one async job per task through `AsyncJobManager.instance().register(...)`
   - limit concurrent job bodies with `Semaphore(task.maxConcurrency)` from `packages/coding-agent/src/task/parallel.ts`
   - each job body calls `#executeSync(...)` with a one-task batch and the preallocated id
   - `onUpdate(...)` emits aggregate `progress` snapshots and `details.async`
5. Sync path (`#executeSync(...)`) rediscovers agents from disk via `discoverAgents(...)`, so runtime resolution can differ from the earlier prompt description.
6. It resolves the requested agent with `getAgent(...)`, rejects unknown or disabled agents, and enforces parent spawn policy plus `PI_BLOCKED_AGENT` self-recursion prevention.
7. It derives the effective output schema in priority order: task call `schema` (if allowed) → agent frontmatter `output` → inherited parent session schema.
8. It validates task ids: missing ids and case-insensitive duplicates are immediate errors.
9. If `isolated` was requested, it requires a git repo (`getRepoRoot(...)` / `captureBaseline(...)`), maps `task.isolation.mode` through `parseIsolationMode(...)`, and materialises the actual backend through `ensureIsolation(...)`.
10. It chooses an artifacts dir from the parent session when available, otherwise a temp dir, and writes `context.md` there when IRC is disabled and `session.getCompactContext?.()` returns content.
11. It allocates unique ids again if the caller did not preallocate them, then builds `tasksWithUniqueIds`.
12. For each task, it seeds an `AgentProgress` entry and runs `runTask(...)` through `mapWithConcurrencyLimit(...)` using `task.maxConcurrency`.
13. Non-isolated `runTask(...)` calls `runSubprocess(...)` directly with parent cwd.
14. Isolated `runTask(...)`:
   - creates an isolation workspace through `ensureIsolation(...)` using the PAL backend selected by `task.isolation.mode`
   - applies the captured baseline when required by the backend
   - runs `runSubprocess(...)` inside that workspace
   - on success, either commits to a per-task branch (`mergeMode === "branch"`) or captures a patch with `captureDeltaPatch(...)`
   - always cleans up the isolation workspace/backend
15. `runSubprocess(...)` in `packages/coding-agent/src/task/executor.ts` creates a child agent session with:
   - isolated settings snapshot via `Settings.isolated(...)`, forcing `async.enabled = false` and `bash.autoBackground.enabled = false`
   - child `agentId` / `parentTaskPrefix` equal to the allocated task id
   - child internal URL router and `AgentOutputManager` from `packages/coding-agent/src/sdk.ts`
   - the shared `context`, optional `context.md` reference, optional isolation worktree path, output schema, and IRC peer roster in the system prompt template
16. Child tool availability is derived from the agent definition plus runtime guards:
   - explicit `agent.tools` if provided
   - auto-add `task` when the agent has `spawns` and recursion depth allows it
   - remove `task` at or past `task.maxRecursionDepth`
   - expand `exec` to `eval` and `bash`
   - strip parent-owned `todo_write` after session creation
17. `runSubprocess(...)` subscribes to child agent events, coalesces progress updates every 150 ms, forwards lifecycle/progress events on the parent event bus, and extracts tool data through `subprocessToolRegistry`.
18. The child must finish through the hidden `yield` tool. If it does not, `runSubprocess(...)` sends up to 3 reminder prompts; the last reminder forces `toolChoice = yield` when supported.
19. Finalization uses `finalizeSubprocessOutput(...)` to reconcile raw assistant text, `yield` payloads, structured schemas, `report_finding` data, and abort states. Output is truncated with `MAX_OUTPUT_BYTES` / `MAX_OUTPUT_LINES` before returning to the parent, but the full raw output is still written to `<id>.md`.
20. After all sync tasks finish, `#executeSync(...)` aggregates usage, collects artifact paths, and if isolation was used merges results back:
   - branch mode: cherry-pick per-task branches with `mergeTaskBranches(...)`, then delete merged branches with `cleanupTaskBranches(...)`
   - patch mode: combine non-empty patch artifacts, dry-check with `git.patch.canApplyText(...)`, then apply or leave manual artifacts
   - nested repo patches are applied separately with `applyNestedPatches(...)`
21. The final text summary is rendered from `packages/coding-agent/src/prompts/tools/task-summary.md` and includes `agent://<id>` handles for outputs that exist.

## Modes / Variants
- Execution mode
  - Sync inline execution — default path.
  - Async background execution — one async job per task item when `async.enabled` is on and the chosen agent is not marked `blocking`.
- Simple mode
  - `default` — accepts shared `context` and per-call `schema`.
  - `schema-free` — accepts `context`, rejects `schema`.
  - `independent` — rejects `context` and `schema`; each assignment stands alone.
- Isolation backend
  - `none` — no isolation.
  - `auto` — choose the best available PAL backend for the current platform/filesystem.
  - `apfs`, `btrfs`, `zfs`, `reflink`, `overlayfs`, `projfs`, `block-clone`, `rcopy` — explicit PAL backend selection.
  - Legacy aliases are still accepted: `worktree` maps to `rcopy`; `fuse-overlay` maps to `overlayfs`; `fuse-projfs` maps to `projfs`.
- Isolation merge strategy
  - Patch mode — capture/apply root patches, keep patch artifacts when application fails.
  - Branch mode — commit each task onto `omp/task/<id>` branch, cherry-pick into parent, preserve failed branches for manual resolution.
- Agent source
  - Project custom agents — nearest project config/plugin agent directories, first by source-family precedence.
  - User custom agents — user config/plugin agent directories after project dirs of the same source family.
  - Bundled agents — appended last from `packages/coding-agent/src/task/agents.ts`.
- Bundled agent types
  - `explore` — read-only scout with structured handoff output.
  - `plan` — architecture/planning agent; may spawn `explore`.
  - `designer` — UI/UX specialist.
  - `reviewer` — review agent with `report_finding` extraction.
  - `task` — general-purpose worker with full capabilities.
  - `quick_task` — low-reasoning mechanical worker using the same task prompt body.
  - `librarian` — source-grounded external API/library researcher.
  - `oracle` — senior-engineer consultation/delegation agent; may spawn `explore`.

## Side Effects
- Filesystem
  - Writes `context.md` when IRC is disabled, plus `<id>.jsonl` and `<id>.md` under the session artifacts dir or a temp task dir.
  - In isolated patch mode writes `<id>.patch` artifacts.
  - Creates/removes PAL isolation workspace directories/backends.
  - In branch mode creates temporary worktrees and task branches.
- Network
  - Child sessions may use whichever networked tools/models their active tool set permits.
  - MCP proxy tools can call existing parent MCP connections with a 60_000 ms timeout.
- Subprocesses / native bindings
  - PAL/native isolation operations through `@oh-my-pi/pi-natives`.
  - Git operations for baseline capture, patch apply, branches, cherry-pick, commits.
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Creates child `AgentSession` instances with isolated settings snapshots.
  - Registers async jobs in `AsyncJobManager.instance()` for background task mode.
  - Emits `task:subagent:event`, `task:subagent:progress`, and `task:subagent:lifecycle` on the parent event bus.
  - Allocates session-scoped output ids through `AgentOutputManager` so `agent://` remains unique across invocations and resumes.
  - Shares the parent `local://` root with subagents by passing `localProtocolOptions` through `createAgentSession(...)`.
- User-visible prompts / interactive UI
  - Async mode streams aggregate progress updates.
  - Missing-`yield` recovery sends up to three internal reminder prompts to the child session.
  - Final summaries include `<system-notification>` blocks for isolation fallbacks or merge failures.
- Background work / cancellation
  - Parent abort stops scheduling new work, aborts active child sessions, and marks unscheduled tasks as skipped.
  - Async jobs keep their own cancellation via `AsyncJobManager`.

## Limits & Caps
- Per-subagent output truncation: `MAX_OUTPUT_BYTES = 500_000` and `MAX_OUTPUT_LINES = 5000` in `packages/coding-agent/src/task/types.ts`. Full raw output is still written to `<id>.md` before truncation is returned to the caller.
- Progress coalescing in child execution: `PROGRESS_COALESCE_MS = 150` in `packages/coding-agent/src/task/executor.ts`.
- Recent output tail for progress: `RECENT_OUTPUT_TAIL_BYTES = 8 * 1024` and `recentOutput` keeps the last 8 non-empty lines in `packages/coding-agent/src/task/executor.ts`.
- Missing-`yield` reminder retries: `MAX_YIELD_RETRIES = 3` in `packages/coding-agent/src/task/executor.ts`.
- MCP proxy timeout: `MCP_CALL_TIMEOUT_MS = 60_000` in `packages/coding-agent/src/task/executor.ts`.
- Task id schema cap: `tasks[].id` `maxLength: 48` in `packages/coding-agent/src/task/types.ts`.
- Prompt text says ids should be `≤32` chars, but the runtime schema allows 48; this mismatch is real.
- Async/full sync parallelism both use `task.maxConcurrency` from settings:
  - sync path: `mapWithConcurrencyLimit(...)`
  - async path: `Semaphore(...)` around job bodies
- Recursion depth gate: `task.maxRecursionDepth` from settings; `packages/coding-agent/src/tools/index.ts` hides the `task` tool at or beyond the limit, and `runSubprocess(...)` also strips child `task` access at max depth.
- Final inline summary preview per task uses `fullOutputThreshold = 5000` chars in `packages/coding-agent/src/task/index.ts`; longer outputs are summarized while `agent://<id>` points to the full artifact.

## Errors
- Most validation failures are returned as normal tool text with empty `results`, not thrown:
  - invalid simple-mode fields
  - unknown/disabled agent
  - missing tasks
  - missing/duplicate task ids
  - spawn-policy denial
  - requesting `isolated` while isolation mode is `none`
- Isolated execution without a git repo returns `Isolated task execution requires a git repository. ...`.
- Backend resolution can return a hard error (`ProjFS isolation initialization failed...`) or a non-fatal warning with fallback to `worktree`.
- `mapWithConcurrencyLimit(...)` fails fast on non-abort worker exceptions; already completed results are preserved only in the thrown path’s local state, not surfaced unless the caller catches and converts them.
- Child-session failures surface as `SingleResult.exitCode = 1` with `stderr`/`error` populated.
- If the child omits `yield`, `finalizeSubprocessOutput(...)` injects warnings such as `SYSTEM WARNING: Subagent exited without calling yield tool after 3 reminders.`
- Async scheduling failures are accumulated per task; if no jobs start, the tool returns `Failed to start background task jobs: ...`.
- `agent://<id>` resolution errors are model-visible when another tool reads them: no session, no artifacts dir, missing id, conflicting extraction syntax, or invalid JSON for extraction.

## Notes
- Agent discovery precedence is first-wins by exact name: project dirs before user dirs within a source family, plugin agent dirs after config dirs, bundled agents last. See `packages/coding-agent/src/task/discovery.ts` and `docs/task-agent-discovery.md`.
- `TaskTool.create(...)` caches discovered agents only for description rendering and the async blocking-agent decision. `#executeSync(...)` rediscovers agents each call.
- Custom agent frontmatter can override bundled agents by name. Bundled definitions are embedded at build time in `packages/coding-agent/src/task/agents.ts`.
- Child sessions do not inherit conversation history automatically. The only built-in carry-over is shared `context`, optional `context.md`, workspace tree/skills/context files, and shared `local://` root.
- `Settings.isolated(...)` gives each child a session-isolated settings snapshot; tool enablement is recomputed inside the child session rather than sharing mutable parent tool state.
- When the parent passes `mcpManager`, child sessions disable standalone MCP discovery and instead get proxy tools that reuse the parent connections.
- Plan mode mutates an `effectiveAgent` with a read-only tool subset and plan-mode prompt text, but `runSubprocess(...)` is still invoked with `agent` rather than `effectiveAgent`. Model/thinking/schema overrides use the effective agent; prompt/tool/spawn restrictions do not fully flow through this call path.
- Branch-mode merge temporarily stashes the parent repo before cherry-picking task branches. A stash-pop conflict is treated as merge failure and leaves recovery state behind.
- Patch-mode only applies combined root patches if every successful task produced a patch and `git.patch.canApplyText(...)` succeeds.
- Nested git repos are handled separately from the root repo. They are copied into isolated worktrees, diffed independently, and merged later with `applyNestedPatches(...)` because parent git cannot track their file-level changes.
- `agent://` ids are numeric-prefixed (`0-Task`, `1-Task`, nested like `0-Parent.0-Child`) by `AgentOutputManager`; this is what prevents artifact collisions across repeated or nested task invocations.
