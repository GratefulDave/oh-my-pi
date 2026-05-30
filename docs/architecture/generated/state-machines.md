# State Machines

## Session lifecycle

```mermaid
stateDiagram-v2
  [*] --> Constructing: createAgentSession()
  Constructing --> Idle: AgentSession created
  Idle --> Streaming: prompt()
  Streaming --> Persisting: message_end
  Persisting --> Recovery: agent_end
  Recovery --> Retrying: retryable error
  Retrying --> Streaming: scheduled continuation
  Recovery --> Compacting: context threshold/overflow/incomplete
  Compacting --> Streaming: retry or continue after summary
  Recovery --> Idle: no maintenance work
  Idle --> Switching: switchSession()/newSession()
  Switching --> Idle: messages restored/reset
  Idle --> Disposing: dispose()
  Streaming --> Aborting: abort()/signal
  Aborting --> Recovery: agent_end aborted
  Disposing --> [*]
```

Grounding:

- construction: `createAgentSession()` (`packages/coding-agent/src/sdk.ts:794-2166`);
- prompt path: `AgentSession.prompt()` and `#promptWithMessage()` (`packages/coding-agent/src/session/agent-session.ts:3930-4255`);
- event handling/recovery: `#handleAgentEvent()` (`packages/coding-agent/src/session/agent-session.ts:1390-1825`);
- session switch/new: `newSession()` and `switchSession()` (`packages/coding-agent/src/session/agent-session.ts:4802-4905`, `packages/coding-agent/src/session/agent-session.ts:8235-8310`);
- disposal: `dispose()` (`packages/coding-agent/src/session/agent-session.ts:2770-2810`).

## SessionManager persistence state

```mermaid
stateDiagram-v2
  [*] --> MemoryOnly: inMemory()
  [*] --> NewPersistent: create()/open()/continueRecent()
  NewPersistent --> DeferredDisk: no assistant and not ensured
  DeferredDisk --> Rewriting: first assistant or ensureOnDisk
  Rewriting --> Flushed: full JSONL rewrite done
  Flushed --> Appending: hot path append entry
  Appending --> Flushed: writeSync ok
  Appending --> PersistError: write/prepare error
  Rewriting --> PersistError: rewrite error
  Flushed --> Rewriting: full rewrite needed
  Flushed --> Closed: close()
  MemoryOnly --> Closed: close()
```

`SessionManager._persist()` chooses deferred, rewrite, or synchronous append paths (`packages/coding-agent/src/session/session-manager.ts:2487-2533`). Entries are append-only except explicit rewrite operations; branch changes move leaf pointer rather than deleting entries (`packages/coding-agent/src/session/session-manager.ts:2880-3028`).

## Subagent lifecycle

```mermaid
stateDiagram-v2
  [*] --> Preflight
  Preflight --> Aborted: parent signal already aborted
  Preflight --> SessionSetup: settings/model/session/tools
  SessionSetup --> Running: child AgentSession created
  Running --> WaitingForYield: assignment prompt done
  WaitingForYield --> Reminder1: no yield
  Reminder1 --> Reminder2: no yield
  Reminder2 --> Reminder3: no yield
  Reminder3 --> Finalize: forced yield reminder done
  WaitingForYield --> Finalize: yield/error
  Finalize --> Completed: exitCode 0
  Finalize --> Failed: exitCode nonzero
  Finalize --> Aborted: timeout/signal/yield abort
```

Grounded in `runSubprocess()` and `finalizeSubprocessOutput()` (`packages/coding-agent/src/task/executor.ts:615-1777`, `packages/coding-agent/src/task/executor.ts:302-393`).

## Extension event transformation

```mermaid
stateDiagram-v2
  [*] --> NoHandlers
  NoHandlers --> ReturnOriginal: context/input/provider payload unchanged
  [*] --> HandlerChain: handlers registered
  HandlerChain --> TimedOut: per-handler timeout
  TimedOut --> HandlerChain: error emitted, continue/undefined
  HandlerChain --> Blocked: tool_call block or handler throw
  HandlerChain --> Modified: result/payload/messages/system prompt changed
  HandlerChain --> Cancelled: session_before_* returns cancel
  HandlerChain --> Completed: no blocking/cancel
```

Grounding: `#runHandlerWithTimeout()` (`packages/coding-agent/src/extensibility/extensions/runner.ts:498-535`), generic `emit()` (`packages/coding-agent/src/extensibility/extensions/runner.ts:538-569`), `emitToolCall()` (`packages/coding-agent/src/extensibility/extensions/runner.ts:614-647`), and transform emitters (`packages/coding-agent/src/extensibility/extensions/runner.ts:571-899`).

## Retry and compaction decision order

```mermaid
flowchart TD
  AgentEnd[agent_end] --> Last{last assistant?}
  Last -->|none| Done[no maintenance]
  Last -->|error| Retryable{retryable?}
  Retryable -->|yes| Retry[handleRetryableError]
  Retryable -->|no| Done
  Last -->|non-error| Compact{compaction needed?}
  Compact -->|yes| Promote{context promotion?}
  Promote -->|yes| Continue[continue with promoted model]
  Promote -->|no| Summarize[auto-compaction]
  Compact -->|no| Todo{unfinished todo guard?}
  Todo -->|yes| Reminder[todo reminder/rewind]
  Todo -->|no| Done
```

`#handleAgentEvent()` runs retry before compaction and todo checks (`packages/coding-agent/src/session/agent-session.ts:1760-1825`). Retry and fallback are in `packages/coding-agent/src/session/agent-session.ts:6950-7588`; compaction/context promotion are in `packages/coding-agent/src/session/agent-session.ts:5780-5876`, `packages/coding-agent/src/session/agent-session.ts:6118-6185`, and `packages/coding-agent/src/session/agent-session.ts:6561-6868`.

## Tool result mutation path

```mermaid
sequenceDiagram
  participant Tool as Tool
  participant Wrapper as ExtensionToolWrapper/AgentSession
  participant Runner as ExtensionRunner
  participant Agent as Core Agent

  Tool->>Wrapper: result content/details/isError
  Wrapper->>Runner: tool_result event
  Runner->>Runner: each handler may modify fields
  Runner-->>Wrapper: modified result or undefined
  Wrapper-->>Agent: final tool result
```

`emitToolResult()` cumulatively applies content/details/isError changes (`packages/coding-agent/src/extensibility/extensions/runner.ts:571-612`). `emitToolCall()` can block pre-execution (`packages/coding-agent/src/extensibility/extensions/runner.ts:614-647`).
