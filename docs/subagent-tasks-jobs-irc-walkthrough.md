# Subagent Lifecycle Walkthrough

A detailed trace through a concrete scenario: the main agent spawns two oracle subagents in parallel via `task`, one subagent IRCs the main agent with a question, and the main agent polls the async jobs to collect results.

---

## Scenario

```
Main agent ("0-Main") calls:
  task(
    agent: "oracle",
    tasks: [
      { id: "LookupFoo", description: "Find foo", assignment: "Search the codebase for foo..." },
      { id: "LookupBar", description: "Find bar", assignment: "Search the codebase for bar..." }
    ]
  )
```

Settings: `async.enabled = true`, `irc.enabled = true`, `task.maxConcurrency = 2`.

---

## Phase 1: Task Tool Dispatch

### `TaskTool.execute()` — `packages/coding-agent/src/task/index.ts:270`

```ts
async execute(_toolCallId, rawParams, signal, onUpdate) {
  const params = rawParams as TaskParams;
  const asyncEnabled = this.session.settings.get("async.enabled");
  const selectedAgent = this.#discoveredAgents.find(agent => agent.name === params.agent);

  // oracle is non-blocking and async is enabled → async path
  if (!asyncEnabled || selectedAgent?.blocking === true) {
    return this.#executeSync(...);  // blocked agents always run sync
  }

  const manager = AsyncJobManager.instance();
  const taskItems = params.tasks ?? [];  // [LookupFoo, LookupBar]
```

**Decision point**: The `oracle` agent definition has no `blocking: true` flag and `async.enabled` is on → async path.

### Output ID allocation — `task/index.ts:302`

```ts
const outputManager = this.session.agentOutputManager
  ?? new AgentOutputManager(this.session.getArtifactsDir ?? (() => null));
const uniqueIds = await outputManager.allocateBatch(taskItems.map(t => t.id));
```

Each task gets a unique output ID. These become `agent://<id>` URLs the caller can read later.

### Job registration — `task/index.ts:348` (inside the async for-loop)

```ts
const jobId = manager.register(
  "task",
  `task ${taskItem.id}`,
  async (ctx) => {
    // Acquire concurrency semaphore
    await semaphore.acquire();
    try {
      // Run the same sync execution logic
      const result = await this.#executeSingleTask(taskItem, ...);
      completedJobs++;
      return formatResult(result);
    } finally {
      semaphore.release();
    }
  },
  { ownerId: "0-Main", onProgress: ... }
);
```

Two jobs registered: one for LookupFoo, one for LookupBar. Both use a `Semaphore` so they respect `task.maxConcurrency = 2` — both can run simultaneously.

### Immediate return — `task/index.ts:420`

```ts
return {
  content: [{ type: "text", text: "Started 2 background tasks. Use job.poll([...]) to wait." }],
  details: {
    async: { state: "running", jobId: "job-abc123", type: "task" },
    progress: getProgressSnapshot(),
  },
};
```

The main agent's turn completes. The two subagent jobs are running in the background. The main agent sees the tool result and continues its next turn.

---

## Phase 2: Subagent Creation — Both Running in Parallel

Each job's `run` callback calls through to `#executeSingleTask()` → `runSubprocess()` in `executor.ts`.

### `runSubprocess()` — `packages/coding-agent/src/task/executor.ts:1000+`

```ts
export async function runSubprocess(options: ExecutorOptions): Promise<SingleResult> {
  const id = options.id;  // "LookupFoo" / "LookupBar"
  const agent = options.agent;
  const ircEnabled = settings.get("irc.enabled");
```

#### Model resolution

```ts
const { model } = await resolveModelOverrideWithAuthFallback({
  agentModelPatterns: options.agent.model ? [options.agent.model] : [],
  agentName: agent.name,
  parentActiveModel: options.parentActiveModelPattern,
  // Falls back to parent session's model if agent has no credentials
});
```

#### System prompt construction — `executor.ts:1123`

```ts
systemPrompt: defaultPrompt => {
  const ircPeers = ircEnabled ? renderIrcPeerRoster(id) : "";
  const ircSelfId = ircEnabled ? id : "";
  return prompt.render(subagentSystemPromptTemplate, {
    agent: agent.systemPrompt,
    context: options.context?.trim() ?? "",
    worktree: worktree ?? "",
    outputSchema: normalizedOutputSchema,
    contextFile: contextFileForPrompt,
    ircPeers,      // "- `0-Main` — Main (main, idle)"
    ircSelfId,     // "LookupFoo"
  });
}
```

The `renderIrcPeerRoster` function (`executor.ts:83`) queries the live `AgentRegistry`:

```ts
function renderIrcPeerRoster(selfId: string): string {
  const peers = AgentRegistry.global()
    .list()
    .filter(ref => ref.id !== selfId && (ref.status === "running" || ref.status === "idle"));
  if (peers.length === 0) return "- (no other live agents)";
  return peers.map(peer => `- \`${peer.id}\` — ${peer.displayName} (${peer.kind}, ${peer.status})`).join("\n");
}
```

When LookupFoo starts, it sees: `"0-Main" — Main (main, running)`. When LookupBar starts moments later, it also sees both `"0-Main"` and `"LookupFoo"` — each subagent's system prompt reflects the live roster at creation time.

#### Session creation — `executor.ts:1108`

```ts
const { session } = await createAgentSession({
  cwd,
  model,
  toolNames,            // subagent tool set (restricted subset)
  requireYieldTool: true,  // subagent MUST call yield
  systemPrompt: ...,    // includes IRC roster
  agentId: id,          // "LookupFoo" / "LookupBar"
  agentDisplayName: agent.name,  // "oracle"
  spawns: spawnsEnv,    // which agents this subagent can spawn
  taskDepth: childDepth, // recursion depth tracker
  ...
});
```

This calls into `AgentRegistry`:

```ts
// Inside createAgentSession or session init:
AgentRegistry.global().register({
  id: "LookupFoo",
  displayName: "oracle",
  kind: "sub",
  parentId: "0-Main",
  status: "running",
  session: sessionRef,
});
```

At this point, both subagents are visible in the registry and addressable via IRC.

---

## Phase 3: IRC Interaction — Subagent Asks Main Agent

Suppose `LookupFoo` encounters ambiguity about the assignment and wants clarification.

### `irc.list` — `packages/coding-agent/src/tools/irc.ts:97`

```ts
#executeList(registry, senderId) {
  const peers = registry.listVisibleTo(senderId);
  // Returns: [{ id: "0-Main", displayName: "Main", kind: "main", status: "idle" },
  //           { id: "LookupBar", displayName: "oracle", kind: "sub", status: "running" }]
}
```

LookupFoo sees both the main agent and its sibling.

### `irc.send(to: "0-Main", message: "The assignment says search foo, but I found foo_v1 and foo_v2. Which one?")`

#### `IrcTool.#executeSend()` — `irc.ts:126`

```ts
async #executeSend(registry, senderId, params, signal) {
  const to = "0-Main";
  const message = "The assignment says search foo...";

  // Resolve target
  const ref = registry.get("0-Main");
  // ref.status === "idle" — the main agent is between turns
  const targets = [ref];

  const awaitReply = true;  // default for non-broadcast

  // Dispatch to each target in parallel
  const dispatches = targets.map(async target => {
    const targetSession = target.session;
    const result = await targetSession.respondAsBackground({
      from: "LookupFoo",
      message,
      awaitReply: true,
      signal,
    });
    deliveries.push(target.id);
    if (result.replyText) {
      replies.push({ from: target.id, text: result.replyText });
    }
  });
  await Promise.all(dispatches);

  // Return to LookupFoo
  return {
    content: [{ type: "text", text: "Delivered to 1 peer(s): 0-Main\n\n## Replies\n### 0-Main\nUse foo_v2." }],
    details: { op: "send", from: "LookupFoo", to: "0-Main", delivered: ["0-Main"],
               replies: [{ from: "0-Main", text: "Use foo_v2." }] },
  };
}
```

#### What happens inside `respondAsBackground()` — `agent-session.ts:7570`

```ts
async respondAsBackground(args: { from, message, awaitReply, signal }) {
  // 1. Create incoming record
  const incomingRecord: CustomMessage = {
    role: "custom",
    customType: "irc:incoming",
    content: `[IRC \`LookupFoo\` → you]\n\nThe assignment says search foo...`,
    display: true,
    details: { from: "LookupFoo", message: "..." },
    attribution: "agent",
    timestamp: Date.now(),
  };

  // 2. Emit UI event so the TUI shows it
  this.#emitSessionEvent({ type: "irc_message", message: incomingRecord });

  // 3. Forward relay to main agent's TUI (if this session isn't the main)
  this.#forwardIrcRelayToMain({ from: "LookupFoo", to: "0-Main", body, kind: "message" });

  // 4. If awaitReply, run an ephemeral turn
  const incomingPrompt = prompt.render(ircIncomingTemplate, {
    from: "LookupFoo",
    message: "The assignment says search foo...",
  });
  const { replyText } = await this.runEphemeralTurn({
    promptText: incomingPrompt,
    signal,
  });
  // replyText = "Use foo_v2. That's the one we want."

  // 5. Create autoreply record
  const replyRecord: CustomMessage = {
    role: "custom",
    customType: "irc:autoreply",
    content: `[IRC you → \`LookupFoo\` (auto)]\n\nUse foo_v2.`,
    display: true,
    details: { to: "LookupFoo", reply: "Use foo_v2." },
    attribution: "agent",
    timestamp: Date.now(),
  };

  // 6. Emit UI event + forward relay to main TUI
  this.#forwardIrcRelayToMain({ from: "0-Main", to: "LookupFoo", body: "Use foo_v2.", kind: "reply" });

  // 7. Queue both messages for deferred injection into persisted history
  this.#queueBackgroundExchangeInjection([incomingRecord, replyRecord]);

  return { replyText: "Use foo_v2." };
}
```

**Critical**: `runEphemeralTurn()` runs the main agent's model with the IRC prompt as its single-turn input, using the main agent's system prompt and conversation history as context. The reply is generated **without blocking the main agent's main loop** — if the main agent were mid-tool-call, this would still work. The model processes the question and returns a reply in a side channel.

**Deferred injection**: Both the incoming message and auto-reply are queued. When the main agent next processes its main loop, these records appear in its history as `irc:incoming` and `irc:autoreply` custom messages, so the main agent knows the exchange happened.

**Relay to main TUI**: `#forwardIrcRelayToMain()` sends a display-only `irc:relay` event to the main session's UI. This means the user sees the exchange in the main transcript even though the main agent's main loop wasn't involved. The relay is NOT injected into the main agent's history — it's UI-only.

#### Back in LookupFoo's execution

LookupFoo receives the IRC reply inline and continues its work with the clarification. It proceeds to search for `foo_v2`, completes its findings, and calls:

```
yield({ data: { location: "src/utils/foo.ts:42", summary: "foo_v2 is the active variant" } })
```

---

## Phase 4: Yield and Output Finalization

### Subagent calls `yield` — `executor.ts` (yield handler)

The `yield` tool is always in the subagent's tool set (`requireYieldTool: true`). When called:

1. The subagent's session enters idle state.
2. `waitForIdle()` resolves.
3. `runSubprocess()` extracts the yield data.

If the subagent completes its turn without calling `yield`, the executor retries up to 3 times:

```ts
// executor.ts ~1350
if (!yieldCalled) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await session.prompt(yieldReminder);
    await session.waitForIdle();
    if (yieldCalled) break;
    if (attempt === 3) {
      // Force yield tool choice on final attempt
      await session.prompt(yieldReminder, { toolChoice: buildNamedToolChoice("yield") });
      await session.waitForIdle();
    }
  }
}
```

### Output finalization — `executor.ts`

```ts
const output = finalizeSubprocessOutput({
  rawOutput: sessionOutput,
  yieldData,       // { data: { location: "src/utils/foo.ts:42", ... } }
  outputSchema,    // JTD schema for validation
  reportFindings,  // review findings if review tool was used
});
```

Validates yield data against output schema. If schema is JTD, validates structurally. Extracts `data` field. Normalizes nested JSON strings.

### Session disposal

```ts
await session.dispose();
// dispose() calls:
//   AgentRegistry.global().setStatus(id, "completed")
//   AgentRegistry.global().unregister(id)  — removes from IRC visibility
```

---

## Phase 5: Job Completion and Polling

### Job auto-delivery — `async/job-manager.ts:160`

When `runSubprocess()` returns (inside the job's `run` callback):

```ts
job.promise = (async () => {
  try {
    const text = await run({ jobId, signal, reportProgress });
    job.status = "completed";
    job.resultText = text;
    this.#enqueueDelivery(id, text);  // ← enqueue for auto-delivery
    this.#scheduleEviction(id);       // ← evict after retention period (5 min)
  } catch (error) {
    job.status = "failed";
    job.errorText = error.message;
    this.#enqueueDelivery(id, errorText);
    this.#scheduleEviction(id);
  }
})();
```

`#enqueueDelivery` adds the result to the delivery queue. A background delivery loop runs with exponential backoff:

```ts
// job-manager.ts ~250
async #deliveryLoop() {
  while (!this.#disposed) {
    if (this.#deliveries.length === 0) {
      await Bun.sleep(100);
      continue;
    }
    const delivery = this.#deliveries[0];
    const now = Date.now();
    if (now < delivery.nextAttemptAt) {
      await Bun.sleep(Math.min(100, delivery.nextAttemptAt - now));
      continue;
    }
    try {
      await this.#onJobComplete(delivery.jobId, delivery.text);
      this.#deliveries.shift();  // success — remove from queue
    } catch (err) {
      delivery.lastError = err.message;
      delivery.attempt++;
      // Exponential backoff: 500ms * 2^attempt, capped at 30s, with jitter
      const delay = Math.min(DELIVERY_RETRY_BASE_MS * Math.pow(2, delivery.attempt), DELIVERY_RETRY_MAX_MS);
      delivery.nextAttemptAt = now + delay + Math.random() * DELIVERY_RETRY_JITTER_MS;
    }
  }
}
```

The `#onJobComplete` callback (set up by the session plumbing) injects the result as a background message into the main agent's conversation.

### Main agent polls — `job.ts:137`

If the main agent wants to wait explicitly:

```ts
// job.poll(["job-abc123", "job-def456"])
const jobsToWatch = this.#visibleJobs(manager, requestedPollIds, ownerId);
// ownerId = "0-Main" — scoped to main agent's jobs

// Wait loop
const startTime = Date.now();
while (jobsToWatch.some(j => j.status === "running")) {
  await Bun.sleep(500);  // progress updates every 500ms
  if (Date.now() - startTime > pollDurationMs) break;
}

// Suppress redundant delivery since caller already saw results
manager.acknowledgeDeliveries(completedIds);
```

Poll results include per-job status, label, duration, result text, and error text.

---

## Phase 6: Async Job Result Delivery

When the main agent calls `job.poll([...])` and both jobs complete:

### `JobTool.#buildResult()` — `job.ts:~230`

```ts
const lines: string[] = [];
for (const job of completedJobs) {
  lines.push(`## ${job.id} — completed (${formatDuration(job.durationMs)})`);
  lines.push(truncateTail(job.resultText, MAX_OUTPUT_LINES));
}
```

Returns:

```ts
{
  content: [{ type: "text", text: "## job-abc123 — completed (12.4s)\n...\n## job-def456 — completed (8.7s)\n..." }],
  details: {
    jobs: [
      { id: "job-abc123", status: "completed", label: "task LookupFoo", durationMs: 12400, resultText: "..." },
      { id: "job-def456", status: "completed", label: "task LookupBar", durationMs: 8700, resultText: "..." },
    ],
    cancelled: [],
  },
}
```

The main agent can now read the full output via `agent://LookupFoo/yield` and `agent://LookupBar/yield`.

---

## Complete Timeline

```
t=0ms    Main agent calls task(agent: "oracle", tasks: [LookupFoo, LookupBar])
t=5ms    TaskTool.execute() → async path
t=8ms    AgentOutputManager.allocateBatch() → unique IDs
t=12ms   AsyncJobManager.register("task", "LookupFoo", runFn, { ownerId: "0-Main" })
t=15ms   AsyncJobManager.register("task", "LookupBar", runFn, { ownerId: "0-Main" })
t=18ms   Task tool returns immediately with { async: { state: "running", jobId: "job-abc" } }
t=20ms   ─── Main agent turn ends ───

t=25ms   [LookupFoo] Semaphore.acquire() → ok (0/2 used)
t=30ms   [LookupBar] Semaphore.acquire() → ok (1/2 used)
t=35ms   [LookupFoo] runSubprocess() → model resolution
t=40ms   [LookupBar] runSubprocess() → model resolution
t=50ms   [LookupFoo] renderIrcPeerRoster("LookupFoo") → "- `0-Main` — Main (main, idle)"
t=55ms   [LookupBar] renderIrcPeerRoster("LookupBar") → "- `0-Main` — Main (main, idle)\n- `LookupFoo` — oracle (sub, running)"
t=60ms   [LookupFoo] createAgentSession({ agentId: "LookupFoo", ... })
t=62ms   [LookupBar] createAgentSession({ agentId: "LookupBar", ... })
t=65ms   [LookupFoo] AgentRegistry.register({ id: "LookupFoo", ... })
t=68ms   [LookupBar] AgentRegistry.register({ id: "LookupBar", ... })
t=70ms   [LookupFoo] session.prompt(assignment) → subagent model starts processing

t=75ms   ─── Main agent next turn starts ───
t=80ms   Main agent could work on something else, or call job.list to see status

t=2.3s   [LookupFoo] Hits ambiguity → calls irc.list → sees [0-Main, LookupBar]
t=2.4s   [LookupFoo] calls irc.send(to: "0-Main", message: "Which variant?")
t=2.4s   → Main agent's respondAsBackground() fires
t=2.4s   → runEphemeralTurn() runs main agent's model with IRC prompt
t=3.1s   → Main agent model replies: "Use foo_v2."
t=3.1s   → Reply returned to LookupFoo via IRC tool result
t=3.2s   → Incoming + autoreply queued for main agent's deferred injection
t=3.2s   → Relay forwarded to main TUI (user sees the exchange)
t=3.3s   [LookupFoo] Continues work with clarification

t=8.7s   [LookupBar] Completes → calls yield({ data: {...} })
t=8.8s   [LookupBar] runSubprocess() returns
t=8.9s   [LookupBar] job status → "completed", enqueued for delivery
t=8.9s   [LookupBar] AgentRegistry.setStatus("completed") → unregister()

t=12.4s  [LookupFoo] Completes → calls yield({ data: {...} })
t=12.5s  [LookupFoo] runSubprocess() returns
t=12.6s  [LookupFoo] job status → "completed", enqueued for delivery
t=12.6s  [LookupFoo] AgentRegistry.setStatus("completed") → unregister()

t=12.7s  ─── Main agent calls job.poll(["job-abc", "job-def"]) ───
t=12.8s  Both jobs resolved → results returned
t=12.9s  Main agent reads agent://LookupFoo/yield and agent://LookupBar/yield
```

---

## Key Files Referenced

| File | What it does |
|------|-------------|
| `packages/coding-agent/src/task/index.ts` | `TaskTool` class — sync/async dispatch, semaphore, progress tracking |
| `packages/coding-agent/src/task/executor.ts` | `runSubprocess()` — session creation, yield enforcement, output finalization, IRC roster injection |
| `packages/coding-agent/src/task/parallel.ts` | `Semaphore` + `mapWithConcurrencyLimit()` |
| `packages/coding-agent/src/tools/irc.ts` | `IrcTool` — list/send, calls `respondAsBackground()` |
| `packages/coding-agent/src/tools/job.ts` | `JobTool` — poll/cancel/list, owner-scoped |
| `packages/coding-agent/src/async/job-manager.ts` | `AsyncJobManager` — register, track, deliver, evict |
| `packages/coding-agent/src/registry/agent-registry.ts` | `AgentRegistry` — process-global map of live agent sessions |
| `packages/coding-agent/src/session/agent-session.ts:7570` | `respondAsBackground()` — ephemeral side-channel turn, deferred injection, relay forwarding |
