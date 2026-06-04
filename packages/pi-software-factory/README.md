# pi-software-factory

OMP software factory extension — scaffolding, health checks, and runtime safety enforcement for project workflows.

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

```
/factory-init --preset standard   # Scaffold factory files
/factory-status                   # Check factory health
```

## Structure

After scaffolding, these files are created:

```
.omp/
  settings.json                    # Project settings (memory backend, extensions)
  agents/factory-verifier.md       # Verifier agent prompt
  factory/
    factory.json                   # Factory configuration
    safety.rules.json              # Safety enforcement rules
    scripts/verify.sh              # Verification oracle
    prompts/
      meta-prompt.md               # Factory meta-prompt
      verify-on-stop.md            # Post-turn verification prompt
```

## Runtime Extension

The extension provides:
- `/factory-status` — Check factory configuration health
- `/factory-init` — Scaffold factory files for the current project
- `tool_call` hook — Safety rule enforcement (future)
