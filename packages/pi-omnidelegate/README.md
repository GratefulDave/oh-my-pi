# pi-omnidelegate

OMP extension for delegating work to external AI agents (Claude, Codex, Gemini) via acpx/tmux/cmux.

## Installation

```bash
bun add pi-omnidelegate
```

Or manually reference in `.omp/settings.json`:

```json
{
  "extensions": ["/path/to/pi-omnidelegate"]
}
```

## Usage

From within an OMP session:

```
/delegate "prompt"
/delegate --backend acpx --agents gemini,claude "compare Rust vs Zig"
/delegate --agents codex --mode prompt "explain this code"
/delegate --session my-session --timeout 60000 "long running task"
```

### Options

- `--backend` — Backend to use: `acpx` (default), `tmux`, `cmux`
- `--agents` — Comma-separated agent providers: `gemini` (default), `claude`, `codex`
- `--session` — Session name for the external agents
- `--mode` — Mode: `exec` (default) or `prompt`
- `--timeout` — Timeout in milliseconds

### Settings

Default values can be configured via flags:

```
--delegate-default-backend acpx
--delegate-default-agents gemini,claude
--delegate-default-mode exec
```

## Dependencies

- `acpx`, `tmux`, or `cmux` must be installed on the system
- The extension checks backend availability at runtime
