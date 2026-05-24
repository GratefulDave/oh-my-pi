# External Agent Orchestration

## Decision

This fork can spawn real external agent sessions as processes. `/delegate` is the current entrypoint. `/orchestrate` is reserved for in-process subagent orchestration workflows.

Supported backends:

- `acpx` — primary backend and default.
- `tmux` — fallback backend that creates a visible terminal session.
- `cmux` — visible terminal backend with an automation bridge.

Supported providers are `claude`, `codex`, and `gemini`.

## Context

A spawned Claude, Codex, or Gemini session is different from calling a model provider through the in-process API.

Direct provider/API usage runs inside the current agent runtime and uses the runtime's model abstraction. External orchestration launches another CLI/session as its own process. That process has its own auth, CLI behavior, tool surface, session state, output format, and terminal visibility depending on backend.

This is useful when the fork needs another real agent runtime instead of another in-process model call.

## Implementation

Implementation files:

- [`packages/coding-agent/src/external-agents/types.ts`](../../packages/coding-agent/src/external-agents/types.ts)
- [`packages/coding-agent/src/external-agents/runner.ts`](../../packages/coding-agent/src/external-agents/runner.ts)
- [`packages/coding-agent/src/slash-commands/builtin-registry.ts`](../../packages/coding-agent/src/slash-commands/builtin-registry.ts)

`types.ts` defines the request/result contract:

- provider: `claude | codex | gemini`
- backend: `acpx | tmux | cmux`
- mode: `exec | prompt`
- prompt, cwd, optional session, optional timeout
- events for status, text, JSON, tool start/end, terminal commands, and errors

`runner.ts` selects the backend from the request, defaulting to `acpx`.

Backend behavior today:

- `acpx` spawns `acpx --cwd <cwd> --format json <provider> [-s <session>] <mode> <prompt>`, reads JSON-line stdout, extracts text/tool events, reads stderr as error events, and supports `timeoutMs` through an abort signal.
- `tmux` creates a detached session with `tmux new-session -d -s <session> <provider>` and sends the prompt with `tmux send-keys`. If no session is supplied, a generated `external-<provider>-<timestamp>` session name is used.
- `cmux` creates a split with `cmux new-split right` and sends `<provider> <prompt>` through `cmux send`.

`builtin-registry.ts` registers `/delegate` as the primary command for external agents. Arguments are selected with flags:

```text
/delegate [--backend acpx|tmux|cmux] [--agents gemini,claude,codex] [--session <name>] [--mode exec|prompt] [--timeout <ms>] <prompt>
```

Defaults:

- backend: `acpx`
- agents: `gemini`
- mode: `exec`
- session: omitted
- timeout: omitted

When more than one provider is selected and a session name is supplied, the provider name is appended to make per-provider session names.

Requests are run in parallel with `runExternalAgentsParallel(...)`.

## First-cut UI behavior

The first cut reports orchestration results rather than opening a dedicated orchestration pane.

- Non-TUI command handling writes a markdown report to command output.
- TUI handling sends a custom message with `customType: "external-orchestration"`, `display: true`, and backend/agent details, then shows a completion status.

There is not yet a dedicated live pane for external orchestration.

## Consequences

- The fork can delegate work to actual Claude/Codex/Gemini sessions instead of only routing through the current process's model API.
- `acpx` gives structured JSON output when available; `tmux` and `cmux` prioritize visible terminal execution and currently return terminal/status events rather than captured assistant text.
- Process spawning depends on external CLIs being installed and authenticated in the user's environment.
- Backend behavior is intentionally uneven: `acpx` is the structured primary path, while terminal backends are operational fallbacks and visibility tools.

## Follow-up items

- Normalize event shapes across `acpx`, `tmux`, and `cmux`.
- Add a live UI pane for external orchestration streams.
- Add cancellation controls for spawned sessions.
- Add follow-up controls for continuing an existing external session.
