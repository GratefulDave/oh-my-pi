# pi-software-factory

OMP software factory extension — scaffolding, health checks, runtime safety enforcement, and pane-backed Claude Code worker orchestration.

## Installation

```bash
bun add pi-software-factory
```

## CLI Usage

```bash
# Scaffold a factory for the current project
bunx pi-software-factory init --preset standard

# Check factory health
bunx pi-software-factory doctor
```

## In-Session Usage

Once the factory is scaffolded and the extension is loaded:

```text
/factory-init --preset strav
/factory-init --dry-run
/factory-init --list-presets
/factory-upgrade --dry-run
/factory-status
/factory-plan --orchestrator claude --workers builder,reviewer --run-id demo "ship pane support"
/factory-launch demo --dry-run
/factory-pane-status demo --lines 40
/factory-send demo builder "continue"
/factory-gate demo builder approved --verifier reviewer --evidence evidence/builder.md
/factory-runs
/factory-show demo
```

## Pane factory mode

- OMP-main: `/factory-plan --orchestrator omp ...` then `/factory-launch` launches Claude Code worker panes.
- Claude-main: `/factory-plan --orchestrator claude ...` then `/factory-launch` launches a lead Claude Code pane plus worker panes; the lead assignment includes direct `cmux send` and `cmux read-screen` commands for the worker panes.
- OMP persists run state in `.omp/factory/runs/<run-id>/` in both modes.
- Worker panes are Claude Code panes. Alternate team runtimes are intentionally not used in this preset.

## Structure

After scaffolding, these files are created:

```text
.omp/
  settings.json
  agents/
    factory-verifier.md
  factory/
    factory.json
    safety.rules.json
    runs/
    scripts/
      verify.sh
    prompts/
      meta-prompt.md
      verify-on-stop.md
      claude-main-orchestrator.md
      omp-main-orchestrator.md
```

## Runtime Extension

The extension provides:
- `/factory-status` — Check factory configuration health.
- `/factory-init` — Scaffold factory files for the current project, with dry-run and preset listing options.
- `/factory-upgrade --dry-run` — Report create/update/conflict buckets for `.omp/factory/*` templates.
- `/factory-plan` — Create `.omp/factory/runs/<run-id>/` plan, lane, assignment, and audit state.
- `/factory-launch` — Launch Claude Code panes through the cmux backend or print the dry-run launch plan.
- `/factory-pane-status` — Read pane output from the recorded workspace and surface ids.
- `/factory-send` — Send follow-up instructions to a launched worker pane.
- `/factory-gate` — Record verifier gates and lane verification outcomes.
- `/factory-runs` and `/factory-show` — Inspect saved runs, lanes, pane refs, and gates.
- `tool_call` hook — Warns or blocks matching tool calls from `.omp/factory/safety.rules.json`.
