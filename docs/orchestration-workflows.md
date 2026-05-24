# Orchestration workflows

This document describes how to use `/delegate` to run external Claude, Codex, or Gemini agent sessions from this fork. `/orchestrate` is reserved for in-process subagent orchestration.

Use these commands when you need another real agent runtime, not just a different in-process model. External agents run as separate CLI processes with their own auth, session state, tools, terminal behavior, and output format.

## External agents vs in-process model selection

Use in-process model or provider selection when:

- you want the current agent runtime to answer with a different configured model
- you do not need a separate CLI session
- you want normal in-process tool handling and session output

Use spawned external agents when:

- you want a second agent implementation to inspect the same work independently
- you want to compare Claude, Codex, or Gemini behavior on the same prompt
- you want the external CLI's own session state, auth, or tool surface
- you want a visible terminal session for inspection or manual follow-up

The current entrypoint:

```text
/delegate [--backend acpx|tmux|cmux] [--agents gemini,claude,codex] [--session <name>] [--mode exec|prompt] [--timeout <ms>] <prompt>
```

Defaults:

- backend: `acpx`
- agents: `gemini`
- mode: `exec`
- session: omitted
- timeout: omitted

## Choosing a backend

### `acpx`: primary structured backend

Use `acpx` first for normal delegation. It runs the selected provider through `acpx --format json`, reads JSON-line output, captures text events when present, and includes the captured text in the command report.

```text
/delegate --backend acpx --agents gemini "review diff"
```

Use this when you want structured output in the current session and do not need to watch a terminal pane.

### `tmux`: visible terminal fallback

Use `tmux` when you want the external agent to run in a visible terminal session, or when structured `acpx` output is not the right fit.

```text
/delegate --backend tmux --agents claude "inspect migration risk"
```

The tmux backend creates a detached tmux session and sends the prompt to the provider CLI. If no session name is supplied, it generates a name like `external-claude-<timestamp>`.

### `cmux`: visible terminal plus automation bridge

Use `cmux` when you want a visible split managed through the cmux automation bridge.

```text
/delegate --backend cmux --agents gemini "review auth changes"
```

The cmux backend creates a right split and sends `<provider> <prompt>` through `cmux send`.

## Example workflows

### Single external reviewer

Run one Gemini reviewer through the structured backend:

```text
/delegate --backend acpx --agents gemini "review diff"
```

This is the default shape for a quick external check. The command returns an External Orchestration report in the current session output.

### Parallel external reviewers

Run Gemini, Claude, and Codex in parallel against the current branch:

```text
/delegate --backend acpx --agents gemini,claude,codex "review current branch"

Each provider receives the same prompt. The report includes one section per provider with status, session if present, exit code, and captured output or terminal/status events.

### Visible terminal inspection

Start a Claude CLI session in tmux for migration-risk inspection:

```text
/delegate --backend tmux --agents claude "inspect migration risk"
```

This is useful when you want to attach to or inspect the external session outside the current command output. The command report records the tmux commands and whether session startup succeeded.

### Visible split inspection

Start Gemini in a cmux split:

```text
/delegate --backend cmux --agents gemini "review auth changes"
```

This is useful when you want a visible split plus cmux automation rather than a detached tmux session.

### Session naming

Pass `--session` to give the external session a stable name:

```text
/delegate --backend acpx --agents gemini --session review "review diff"
```

For a single agent, the session is used as provided. For multiple agents, the provider name is appended so each process gets a distinct session name:

```text
/delegate --backend acpx --agents gemini,claude,codex --session review "review current branch"

That produces per-provider session names such as `review-gemini`, `review-claude`, and `review-codex`.

## Current output behavior

The command currently emits a report; it does not open a dedicated live orchestration pane.

- Non-TUI command handling writes a markdown report to command output.
- TUI command handling sends a displayed custom message with `customType: "external-orchestration"`, backend details, agent details, and the same report content.
- The TUI status line then shows how many selected agents succeeded.

Report content includes:

- backend
- working directory
- agent count
- one section per provider
- status and exit code
- session name when one was used or generated
- captured text for `acpx` when available
- terminal/status/error events when no text was captured

There is not yet a dedicated live pane for streamed external orchestration output.

## Practical tips and limitations

- External provider CLIs must be installed and authenticated in the environment where the command runs.
- Use `acpx` when you want captured assistant text in the report.
- Use `tmux` or `cmux` when terminal visibility matters more than structured captured output.
- `tmux` and `cmux` currently report startup/send status and terminal commands; they do not capture the assistant's full terminal conversation back into the report.
- Keep prompts concrete. Each selected provider gets the same prompt string.
- Use `--timeout <ms>` with `acpx` when you need the spawned process bounded by an abort timeout.
- Use `--mode prompt` only when the target provider/backend supports that mode through the invoked CLI path; the default is `exec`.
