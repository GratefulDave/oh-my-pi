# Subagent Tasks, Jobs, and IRC

How the three coordination systems work together.

## The Three Systems

| System | Tool | Purpose |
|--------|------|---------|
| **Tasks** | `task` | Spawn subagents to do parallel work |
| **Jobs** | `job` | Track/poll/cancel async background work (tasks or long bash) |
| **IRC** | `irc` | Live message passing between concurrently running agents |

---

## 1. Task Spawning

`packages/coding-agent/src/task/index.ts`

When the main agent calls `task`, two paths exist:

### Sync path (default, or when `async.enabled` is false, or agent is `blocking`)

1. `TaskTool.execute()` validates the agent exists, is not disabled, and recursion depth isn't exceeded.
2. Optionally sets up **worktree isolation** (git worktree so subagent can commit/patch in isolation).
3. Runs tasks in parallel via `mapWithConcurrencyLimit(tasks, maxConcurrency, runTask)` using a semaphore.
4. Each `runTask` calls `runSubprocess()` in `executor.ts`:
   - Creates an `AgentSession` with a subagent-specific system prompt (includes context, output schema, IRC peer roster).
   - Registers the session in **`AgentRegistry`** with an ID like `"3-AuthLoader"` — this is what makes it visible to IRC.
   - Calls `session.prompt(assignment)` → `session.waitForIdle()`.
   - Subagent **must call `yield`** to complete. Retries up to 3 times with reminders if it doesn't.
   - Finalizes output (extracts yield data, validates against schema), disposes session → unregisters from `AgentRegistry`.
5. Returns `AgentToolResult` with aggregated usage, per-task results, artifact IDs (`agent://<id>`).

### Async path (when `async.enabled` is true and agent is non-blocking)

1. Allocates output IDs via `AgentOutputManager.allocateBatch()`.
2. For each task item, calls **`AsyncJobManager.register("task", label, runFn)`** — each job internally acquires a semaphore and runs the same `#executeSync()` logic.
3. Returns immediately with job IDs and `async: { state: "running", jobId }`.
4. The caller later calls `job.poll([id])` to wait for completion.

### Observer cards

Task subagents and async jobs also surface through the session observer registry. Sync and async task runs publish lifecycle/progress events with the task label, agent name, status, latest progress, and optional `sessionFile`. The `AgentRunMetadata` (`runId`, cwd/worktree, presentation metadata when supplied, artifacts) is optional and producer-dependent. Current native sync task lifecycle/progress events expose lifecycle, progress, and `sessionFile`, while async task-job and plugin paths supply run metadata for observer cards. Native `task` and async jobs use embedded observer-card presentation by default; they do not spawn tmux/cmux panes or windows. Visible pane/window details are presentation metadata reported by a pane/window-capable backend or plugin. Async task-job progress is correlated by the async job id and `runMetadata.runId`, not by the original task item id. Async bash jobs publish job lifecycle/progress metadata through `AsyncJobManager`. The observer overlay renders a transcript only when `sessionFile` exists and can be parsed. Otherwise it still renders the observable card metadata and states that captured transcript is unavailable.

Async jobs remain controlled through `job`: observer cards show run state, but polling, cancellation, and completion delivery still use the `job` tool.

---

## 2. Job Tracking

`packages/coding-agent/src/tools/job.ts`, `packages/coding-agent/src/async/job-manager.ts`

**`AsyncJobManager`** is a process-global singleton holding a `Map<string, AsyncJob>`:

```ts
interface AsyncJob {
  id: string;
  type: "bash" | "task";
  status: "running" | "completed" | "failed" | "cancelled";
  abortController: AbortController;
  promise: Promise<void>;   // resolves when work is done
  resultText?: string;
  errorText?: string;
  ownerId?: string;         // agent registry id (e.g. "0-Main")
}
```

Key behaviors:

- **Owner scoping**: Every job carries `ownerId`. `cancel`/`poll`/`list` all filter by owner — a subagent **cannot** touch its parent's or sibling's jobs.
- **`job.list`**: Snapshots all jobs visible to the caller.
- **`job.poll([ids])`**: Waits via `Promise.race(job.promises + timeout + abort)`. Sends progress updates every 500ms. Calls `acknowledgeDeliveries()` to suppress redundant delivery.
- **`job.cancel([ids])`**: Sets status to `"cancelled"`, aborts the controller. Cross-agent cancel rejected.
- **Auto-delivery**: Jobs that complete outside a `poll` call are enqueued for delivery with exponential backoff (500ms base, 30s max, jitter). The agent sees them as injected background messages.

---

## 3. IRC Messaging

`packages/coding-agent/src/tools/irc.ts`, `packages/coding-agent/src/registry/agent-registry.ts`

**`AgentRegistry`** is a process-global singleton. Every agent session (main + all subagents) registers at creation with a structured ID like `"0-Main"`, `"3-AuthLoader"`.

### `irc.list`

Calls `registry.listVisibleTo(senderId)` → returns all running/idle agents except the caller. Output: `"3 peer(s):"` + list of `{ id, displayName, kind, status }`.

### `irc.send(to, message, awaitReply?)`

1. Resolves targets from registry. `"all"` broadcasts to all visible peers.
2. For each target, calls `targetSession.respondAsBackground({ from, message, awaitReply, signal })`.
3. `respondAsBackground()` creates an **ephemeral side-channel turn**:
   - Builds incoming prompt: `"[IRC from 0-Main → you] Should I prefer JWT or session cookies?"`
   - Calls `runEphemeralTurn()` — uses the recipient's model, system prompt, and history to generate a reply **without blocking the recipient's main loop**. The recipient could be mid-tool-call and still reply.
   - Both the incoming message and auto-reply are queued as `irc:incoming` / `irc:autoreply` custom messages for deferred injection into the recipient's persisted history.
4. Replies are collected and returned to the sender.

---

## How They Fit Together

```
Main agent calls task(agent: "oracle", tasks: [{ id: "LookupFoo", ... }])
  │
  ├─ SYNC PATH ──────────────────────────────────────────────────┐
  │  runSubprocess()                                             │
  │    → AgentRegistry.register("3-LookupFoo", status: "running") │
  │    → session.prompt(assignment)                              │
  │    → subagent runs...                                         │
  │        │                                                     │
  │        ├─ subagent calls irc.list → sees "0-Main"            │
  │        ├─ subagent calls irc.send(to: "0-Main", ...)         │
  │        │   → main agent's respondAsBackground() fires        │
  │        │   → ephemeral reply returned without blocking main  │
  │        └─ subagent calls yield → output captured             │
  │    → AgentRegistry.remove("3-LookupFoo")                     │
  │    → result returned directly to caller                      │
  │                                                              │
  └─ ASYNC PATH ─────────────────────────────────────────────────┤
     AsyncJobManager.register("task", label, runFn)               │
       → returns immediately with jobId                           │
       → subagent runs in background (same sync logic inside)     │
       → main agent continues working                             │
       → main agent calls job.poll([jobId]) later                 │
       → result delivered via poll or auto-delivery               │
```

**The critical insight**: IRC works **during** sync execution, not just async. Even when the main agent is blocked waiting for `waitForIdle()`, the subagent can IRC the main agent and get an ephemeral side-channel reply without the main agent's main loop being interrupted. The subagent sees the reply as part of its conversation, and the main agent sees the exchange injected into its history for its next turn.

In the async case, jobs and IRC are doubly useful — the main agent can fire off multiple async tasks, poll or cancel them with `job`, and coordinate with running subagents via `irc` while they all execute concurrently. The same runs appear as observer cards when they publish lifecycle/progress metadata; the card is visibility, not a replacement control API.

---

## Key Files

| File | Role |
|------|------|
| `packages/coding-agent/src/task/index.ts` | `TaskTool` — spawns subagents, sync/async orchestration, worktree isolation, patch/branch merge |
| `packages/coding-agent/src/task/executor.ts` | `runSubprocess()` — in-process subagent execution; creates AgentSession, tracks progress, finalizes output |
| `packages/coding-agent/src/task/types.ts` | Shared types: `AgentDefinition`, `AgentProgress`, `AgentRunMetadata`, `SingleResult`, `TaskParams`, schemas |
| `packages/coding-agent/src/task/discovery.ts` | `discoverAgents()` — loads agent definitions from bundled + user + project directories |
| `packages/coding-agent/src/task/parallel.ts` | `mapWithConcurrencyLimit()` + `Semaphore` — parallel execution with concurrency cap |
| `packages/coding-agent/src/modes/session-observer-registry.ts` | `SessionObserverRegistry` — turns task/plugin lifecycle and progress events into observable cards |
| `packages/coding-agent/src/modes/components/session-observer-overlay.ts` | Observer overlay — transcript viewer when a session file exists; metadata card when it does not |
| `packages/coding-agent/src/tools/job.ts` | `JobTool` — poll/cancel/list async background jobs |
| `packages/coding-agent/src/tools/irc.ts` | `IrcTool` — list live agents, send messages via `respondAsBackground()` |
| `packages/coding-agent/src/async/job-manager.ts` | `AsyncJobManager` — process-global singleton for registering, tracking, delivering background jobs |
| `packages/coding-agent/src/registry/agent-registry.ts` | `AgentRegistry` — process-global registry of all live AgentSession instances |
| `packages/coding-agent/src/session/agent-session.ts` | `AgentSession.respondAsBackground()` — ephemeral side-channel reply for IRC |