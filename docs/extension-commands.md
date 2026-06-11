# Lex extension commands

Current live `lex`/`omp` setup loads these managed extensions from `~/.omp/agent/settings.json`:

- `antigravity-adapter`
- `pi-minimizer-gain`
- `pi-observer`
- `pi-distill`
- `pi-actor-swarm`
- `pi-omnidelegate`
- `pi-software-factory`
- `swarm-extension`
- `profile-manager`
- `semantic-search`

Use these commands inside an interactive `lex`/`omp` session unless noted otherwise.

## Quick choice guide

| Need | Use |
|---|---|
| Run a YAML-defined multi-agent workflow | `swarm-extension` `/swarm run ...` or standalone `omp-swarm ...` |
| Coordinate a project-local actor mailbox/dashboard | `pi-actor-swarm` `/swarm-init`, `/swarm-send`, `/swarm-status` |
| Ask external Claude/Codex/Gemini agents for a second opinion | `pi-omnidelegate` `/delegate ...` |
| Watch session/tool/subagent/token activity live | `pi-observer` `/observe` |
| Export observer stats | `pi-observer` `/observe-export ...` |
| Show native minimizer savings | `pi-minimizer-gain` `/gain` |
| Toggle or inspect tool-output compression | `pi-distill` `/distill*` |
| Scaffold/check factory workflow files | `pi-software-factory` `/factory-*` |
| Switch model profiles | `profile-manager` `/pm ...` |
| Build/search the cwd semantic index | `semantic-search` `/semantic-*` |
| Use Antigravity-backed models | `antigravity-adapter` model provider/login commands |

## `swarm-extension`: YAML workflow runner

Use this when the workflow itself should run agents from a YAML graph.

Interactive commands:

```text
/swarm run path/to/swarm.yaml
/swarm status <name>
/swarm help
```

Standalone runner for long-running work:

```bash
omp-swarm path/to/swarm.yaml
```

Minimal YAML:

```yaml
swarm:
  name: audit
  workspace: ./workspace
  mode: parallel

  agents:
    security:
      role: security-reviewer
      task: |
        Review src/auth for security issues.
        Write findings to security.md.

    maintainer:
      role: code-reviewer
      task: |
        Review src/auth for maintainability issues.
        Write findings to maintainability.md.

    summary:
      role: analyst
      waits_for:
        - security
        - maintainer
      task: |
        Read security.md and maintainability.md.
        Write final-summary.md.
```

Modes:

- `parallel`: run all agents at once unless dependencies impose order.
- `sequential`: run once in declaration/dependency order.
- `pipeline`: repeat the graph `target_count` times.

Runtime state/logs are written under `<workspace>/.swarm_<name>/`.

## `pi-actor-swarm`: mailbox coordination layer

Use this when you need a project-local actor dashboard, messages, persistent state, stale-agent visibility, or JSONL postmortem logs. This is not the YAML runner.

```text
/swarm-init my-swarm
/swarm-init my-swarm --policy priority
/swarm-init my-swarm --policy round-robin --stale-ttl-ms 900000
/swarm-status
/swarm-send scout inspect packages/pi-observer and report risks
/swarm-send builder implement the observer export
/swarm-logs export
/swarm-logs export .omp/swarm/run.jsonl
/swarm-reset
```

Default agents:

- `scout`
- `builder`
- `reviewer`
- `qa`

Project state persists at `.omp/swarm/state.json`.

Routing policies:

- `priority`
- `round-robin`
- `broadcast`
- `direct`

## `pi-omnidelegate`: external AI delegation

Use this to send a bounded prompt to external Claude/Codex/Gemini agents through `acpx`, `tmux`, or `cmux`, then collect their reports in the current session.

```text
/delegate "review this branch and find bugs"
/delegate --backend acpx --agents gemini,claude "compare these two approaches"
/delegate --agents codex --mode prompt "explain packages/pi-observer architecture"
/delegate --session ext-review --timeout 60000 "long running task"
/delegate-results list
/delegate-results show
/delegate-results show 1
/delegate-results clear
```

Options:

- `--backend acpx|tmux|cmux`
- `--agents gemini,claude,codex`
- `--mode exec|prompt`
- `--session <name>`
- `--timeout <ms>`

Same-session delegate calls reuse cached results only when provider, backend, mode, cwd, and prompt hash all match.

## `pi-observer`: live session monitor and export

```text
/observe
/observe --refresh-ms 1000
/observe --refresh-interval-ms 250
/observe-export json
/observe-export csv
/observe-export json .omp/observer/stats.json
/observe-export csv .omp/observer/stats.csv
```

`/observe` opens the live dashboard. Use the dashboard filter input to narrow IRC/subagent detail panes by agent id, status, tool name, or substring.

`/observe-export` writes current accumulated stats without resetting runtime counters.

## `pi-distill`: tool-output compression

```text
/distill
/distill-stats
/distill-gain
```

- `/distill`: toggle compression for large MCP/tool JSON/YAML/text outputs.
- `/distill-stats`: show session bytes saved plus per-tool candidate/hit/saved-byte stats.
- `/distill-gain`: show project/global distill savings history.

Config/env controls include built-in skip overrides and optional whitelist mode. Defaults preserve normal compression behavior.

## `pi-minimizer-gain`: native minimizer savings

```text
/gain
/gain --all
/gain --days 7
/gain --missed
/gain --discover
/gain --export-jsonl
/gain --export-jsonl .omp/minimizer-gain-export.jsonl
```

- `--all`: include all known scopes instead of only the current repo scope.
- `--days N`: limit summaries/diagnostics to the last `N` days.
- `--export-jsonl [path]`: export daily and per-command totals. Default path is `.omp/minimizer-gain-export.jsonl`.

Missed-minimization diagnostics can ignore low-value commands through `PI_MINIMIZER_GAIN_IGNORED_COMMANDS` or `~/.omp/agent/extensions/pi-minimizer-gain/config.json` field `ignoredMissedCommands`.

## `pi-software-factory`: factory scaffold and safety

```text
/factory-status
/factory-init
/factory-init --dry-run
/factory-init --list-presets
/factory-init --preset standard
/factory-upgrade --dry-run
/factory-upgrade --dry-run --preset standard
```

Safety hook:

- Reads `.omp/factory/safety.rules.json` from the current project.
- Matches tool names and argument patterns.
- Matching rules can warn or block tool calls.
- Missing or invalid rule files preserve normal behavior.

## `profile-manager`: model profiles

```text
/pm
/pm list
/pm show <name>
/pm create <name>
/pm use <name>
/pm delete <name>
```

Profiles are stored user-wide in `~/.omp/agent/settings.json`, while project `.omp/settings.json` can still shadow the active profile.

Current profile setup includes `openai` as the active model profile.

## `semantic-search`: cwd-local semantic index

```text
/semantic-index build
/semantic-index rebuild
/semantic-index status
/semantic-index build --embeddings
/semantic-index build --embeddings --model <embedding-model> --base-url <url> --concurrency 4
/semantic-search "query text"
/semantic-search "query text" --limit 20
/semantic-search "query text" --no-rerank
/semantic-search "query text" --no-decompose
/semantic-status
```

The extension also registers a `semantic_search` tool for agent/tool use. Indexes are cwd-local.

## `antigravity-adapter`: Antigravity provider bridge

This extension registers `opencode-antigravity/*` models. It does not add slash commands; use normal provider/login/model selection flows:

```bash
omp login opencode-antigravity
omp --model opencode-antigravity/antigravity-claude-sonnet-4-6
```

Current settings enable:

- `openai-codex/*`
- `opencode-antigravity/*`
- `google-antigravity/*`

Keep this bridge fork-only unless upstream support appears; it is intentionally separate from default upstream extension behavior.

## Rebuild/export commands for this fork

After changing extension source in this repo:

```bash
./rebuild-lex.zsh
```

That rebuilds bundles, binary, native cache, and refreshes managed global extensions.

To mirror extension code to the private personal-extension repo:

```bash
bun run extensions:export -- --dest ../omp-personal-extensions --force
```
