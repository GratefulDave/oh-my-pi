# Class and Module Diagrams

## Top-level modules

```mermaid
flowchart TB
  subgraph CLI
    cli[cli.ts]
    main[main.ts]
    commands[cli-commands.ts]
  end

  subgraph Runtime
    sdk[sdk.ts createAgentSession]
    AS[session/agent-session.ts AgentSession]
    SM[session/session-manager.ts SessionManager]
    Messages[session/messages.ts]
  end

  subgraph Models
    MR[config/model-resolver.ts]
    Registry[config/model-registry.ts]
    Settings[config/settings.ts]
  end

  subgraph Tools
    Builtin[tools/index.ts]
    Task[task/executor.ts]
    Job[tools/job.ts]
    IRC[tools/irc.ts]
    MCP[mcp/*]
  end

  subgraph Extensions
    Loader[extensions/loader.ts]
    Runner[extensions/runner.ts]
    Types[extensions/types.ts]
    Shared[extensibility/shared-events.ts]
    Plugins[plugins/manager.ts]
  end

  cli --> main
  main --> sdk
  main --> MR
  main --> Settings
  sdk --> AS
  sdk --> SM
  sdk --> Registry
  sdk --> Builtin
  sdk --> MCP
  sdk --> Loader
  Loader --> Runner
  Runner --> AS
  AS --> SM
  AS --> Messages
  AS --> Task
  Task --> sdk
  Task --> IRC
  Task --> Job
```

Citations: root flow (`packages/coding-agent/src/main.ts:716-1060`), SDK construction (`packages/coding-agent/src/sdk.ts:794-2166`), task executor child session creation (`packages/coding-agent/src/task/executor.ts:1277-1322`), extension loader/runner (`packages/coding-agent/src/extensibility/extensions/loader.ts:332-609`, `packages/coding-agent/src/extensibility/extensions/runner.ts:172-900`).

## Core runtime class relationships

```mermaid
classDiagram
  class AgentSession {
    +sessionManager
    +settings
    +yieldQueue
    +prompt(text, options)
    +promptCustomMessage(message, options)
    +switchSession(file)
    +newSession(options)
    +dispose()
  }

  class SessionManager {
    -sessionId
    -sessionFile
    -leafId
    -fileEntries
    +appendMessage(message)
    +appendCustomMessageEntry(customType, content, display)
    +appendModelChange(model, role)
    +appendCompaction(...)
    +buildSessionContext()
    +getTree()
    +branch(id)
  }

  class Agent {
    +state
    +prompt(message)
    +abort()
    +replaceMessages(messages)
  }

  class ExtensionRunner {
    +initialize(actions, contextActions)
    +emit(event)
    +emitToolCall(event)
    +emitToolResult(event)
    +emitContext(messages)
  }

  class ModelRegistry {
    +getAvailable()
    +find(provider, id)
    +getApiKey(model, sessionId)
    +registerProvider(name, config, sourceId)
    +suppressSelector(selector, until)
  }

  AgentSession --> Agent
  AgentSession --> SessionManager
  AgentSession --> ExtensionRunner
  AgentSession --> ModelRegistry
  SessionManager --> AgentSession : persisted context
```

`AgentSessionConfig` lists constructor dependencies (`packages/coding-agent/src/session/agent-session.ts:252-336`). `CreateAgentSessionOptions` and `CreateAgentSessionResult` are SDK-facing contracts (`packages/coding-agent/src/sdk.ts:234-364`).

## Session entry model

```mermaid
classDiagram
  class SessionHeader {
    type='session'
    version
    id
    title
    cwd
    parentSession
  }
  class SessionEntryBase {
    type
    id
    parentId
    timestamp
  }
  class SessionMessageEntry {
    type='message'
    message
  }
  class ModelChangeEntry {
    type='model_change'
    model
    role
  }
  class CompactionEntry {
    type='compaction'
    summary
    firstKeptEntryId
    tokensBefore
    preserveData
  }
  class CustomEntry {
    type='custom'
    customType
    data
  }
  class CustomMessageEntry {
    type='custom_message'
    customType
    content
    display
    attribution
  }
  class ModeChangeEntry {
    type='mode_change'
    mode
    data
  }

  SessionEntryBase <|-- SessionMessageEntry
  SessionEntryBase <|-- ModelChangeEntry
  SessionEntryBase <|-- CompactionEntry
  SessionEntryBase <|-- CustomEntry
  SessionEntryBase <|-- CustomMessageEntry
  SessionEntryBase <|-- ModeChangeEntry
```

Grounding: entry contracts in `packages/coding-agent/src/session/session-manager.ts:57-253`.

## Extension API and runner

```mermaid
classDiagram
  class ConcreteExtensionAPI {
    +on(event, handler)
    +registerTool(tool)
    +registerCommand(name, options)
    +registerShortcut(key, options)
    +registerFlag(name, options)
    +registerMessageRenderer(customType, renderer)
    +registerProvider(name, config)
    +events
  }
  class Extension {
    +path
    +handlers
    +tools
    +commands
    +flags
    +shortcuts
    +messageRenderers
  }
  class ExtensionRuntime {
    +flagValues
    +pendingProviderRegistrations
    +sendMessage()
    +sendUserMessage()
    +setActiveTools()
    +setModel()
  }
  class ExtensionRunner {
    +getAllRegisteredTools()
    +getRegisteredCommands(reserved)
    +createContext()
    +createCommandContext()
    +emit(event)
  }

  ConcreteExtensionAPI --> Extension
  ConcreteExtensionAPI --> ExtensionRuntime
  ExtensionRunner --> ExtensionRuntime
  ExtensionRunner --> Extension
```

Grounding: `ConcreteExtensionAPI` (`packages/coding-agent/src/extensibility/extensions/loader.ts:120-260`), extension object creation (`packages/coding-agent/src/extensibility/extensions/loader.ts:262-275`), runner runtime (`packages/coding-agent/src/extensibility/extensions/runner.ts:172-900`).

## Task/subagent modules

```mermaid
flowchart LR
  TaskTool[task tool] --> Executor[runSubprocess]
  Executor --> ChildSDK[createAgentSession child]
  ChildSDK --> ChildSession[AgentSession]
  Executor --> Progress[AgentProgress]
  Executor --> Artifacts[summary/transcript/manifest artifacts]
  Executor --> Channels[EventBus subagent channels]
  ChildSession --> Yield[yield tool]
  Yield --> Finalize[finalizeSubprocessOutput]
```

Grounding: executor types (`packages/coding-agent/src/task/executor.ts:174-233`), lifecycle (`packages/coding-agent/src/task/executor.ts:615-1777`), output finalization (`packages/coding-agent/src/task/executor.ts:302-393`).
