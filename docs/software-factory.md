# Software Factory

`lex factory` scaffolds project-scoped `.omp` assets for repeatable software workflows.

## Goals

- Keep verifier, safety, workflow, and learning assets inside target repo.
- Avoid `~/.omp` interference across unrelated workspaces.
- Make onboarding for new repos and retrofitting existing repos predictable.

## Commands

### `lex factory init`

Scaffold repo-local software-factory assets.

Common forms:

```bash
lex factory init --dry-run
lex factory init --preset standard
lex factory init --preset software-factory --existing
lex factory init --preset software-factory --existing --enable-memory
```

Flags:

- `--preset minimal|standard|software-factory`
  - `minimal`: skeleton only, verifier/workflow conservative.
  - `standard`: verifier enabled on demand, safety scaffold, memory off by default.
  - `software-factory`: full workflow/verifier scaffold, still repo-local.
- `--dry-run`: print plan without writing files.
- `--yes`: apply without confirmation prompt.
- `--existing`: import legacy repo assets conservatively.
- `--force`: overwrite existing factory-managed files.
- `--enable-memory`: write project `.omp/settings.json` with `memory.backend = "icm"`.

### `lex factory status`

Show installed scaffold status for current repo:

- files present vs missing
- bundled version vs installed version
- whether user-scoped extension may shadow project behavior
- legacy config roots detected in repo

### `lex factory doctor`

Validate current repo scaffold without mutating anything:

- required files present
- `factory.json` parses
- workflow JSON parses
- safety rules parse
- configured paths stay inside repo

## What gets generated

Main repo-local areas:

```text
.omp/extensions/software-factory/
.omp/factory/
.omp/agents/
.omp/prompts/
.omp/rules/
.omp/skills/
```

Important files:

- `.omp/factory/factory.json`
  - repo-local contract for verifier, safety, workflow, and memory behavior
- `.omp/factory/safety.rules.json`
  - project-scoped guardrails
- `.omp/factory/workflows/*.json`
  - repeatable workflow definitions
- `.omp/factory/prompts/*.md`
  - meta/verifier/workflow prompts
- `.omp/factory/scripts/verify.sh`
  - verification oracle entrypoint
- `.omp/extensions/software-factory/index.ts`
  - runtime extension template

## Presets

### minimal

Use when repo wants placeholders first.

Behavior:
- keeps scaffold light
- no memory backend change
- verifier config remains conservative

### standard

Use when repo wants basic repeatability but not full workflow automation.

Behavior:
- project-scoped safety scaffold
- verifier scaffold available
- memory still off unless explicitly enabled

### software-factory

Use when repo wants reusable planning/implementation/verification loop assets.

Behavior:
- enables fuller workflow scaffold in `.omp/factory/workflows/`
- includes planner / implementer / reviewer / verifier assets
- still repo-local and explicit

## Existing repo integration

Use `--existing` when repo already has:

- `.omp`
- `.claude`
- `.codex`
- `.gemini`
- `.pi`

Current behavior:
- imports legacy roots into `.omp/factory/imported/`
- writes import report
- does not auto-enable imported workflows
- warns instead of mutating user-scoped config

## Safety model

Factory safety is defense-in-depth, not sandboxing.

Current template can:
- block obviously destructive bash commands
- require confirmation for secret files and manifest/lockfile changes
- warn on risky operations

It cannot guarantee safety against all indirect or encoded paths. For stronger isolation, use task/worktree isolation or future sandbox backends.

## Verifier model

Factory verifier is repo-local and explicit.

Current template supports:
- manual `/verify`
- configurable `agent_end` verifier trigger through `factory.json`
- bounded corrective follow-up loop
- strict machine-parseable verifier report format

### Missing oracle

An oracle is trustworthy pass/fail check.

Examples:
- real test command
- fixture-backed validator
- deterministic script for expected output

If `.omp/factory/scripts/verify.sh` is still placeholder-only, verifier should report **oracle gap**, not pretend verification happened.

## Memory / learning

Factory scaffold does not force memory on.

When `--enable-memory` is used, project `.omp/settings.json` gets:

```json
{
  "memory": {
    "backend": "icm"
  }
}
```

Recommended durable lessons:
- resolved errors with root cause, fix, verification
- workflow improvements worth encoding into templates
- repo conventions that materially change execution
- missing oracle/fixture gaps worth fixing later

Do not retain:
- raw command output
- transient progress
- guesses
- unverified claims

## Onboarding flow

Recommended sequence for new repo:

1. `lex factory init --dry-run`
2. choose preset
3. scaffold with `lex factory init ...`
4. edit `.omp/factory/scripts/verify.sh`
5. adjust `.omp/factory/safety.rules.json`
6. tune prompts/workflows for repo stack
7. run `lex factory doctor`

## Troubleshooting

### `lex factory init --dry-run` hangs or starts agent session

Likely stale installed binary.

Check:

```bash
lex --help
```

If `factory` missing from command list, rebuild/install current binary.

### `factory doctor` reports path escapes repo

A factory config path is absolute or resolves outside current repo. Move it under repo-local `.omp/factory/` or another repo-local path.

### verifier says oracle missing

Edit `.omp/factory/scripts/verify.sh` and replace placeholder with real repo checks.
