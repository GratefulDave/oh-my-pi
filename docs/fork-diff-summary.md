# Fork Diff Summary: GratefulDave/oh-my-pi vs can1357/oh-my-pi

Generated: 2026-06-01

## Repo Context

| Attribute | Upstream | Fork |
|---|---|---|
| Owner | can1357 | GratefulDave |
| Stars | 9,252 | — |
| Forks | 750 | — |
| Language | TypeScript | TypeScript |
| License | MIT | MIT |

## Version Baseline

| Reference | Tag/Cherry-Pick | Version |
|---|---|---|
| Upstream tip | `v15.7.4` (latest) | `15.7.4` |
| Fork tip | `15.7.3-lex` | `15.7.3-lex` |
| Fork point (merge base) | `f06d28933` (~`v3.24.0` era) | — |

- **Fork point**: commit `f06d28933` (upstream ~`v3.24.0`)
- **Upstream ahead by**: 4,753 commits
- **Our commits**: 4,239
- **Diff**: 1,465 files changed, +73,652 / −115,828

## Important Note on Attribution

The diff is computed as `upstream/main..HEAD`. Because upstream has deleted/renamed files since the fork point, many items show as `+` additions that are actually **upstream-originated code retained in the fork** after upstream removed it (calculator, recipe, hindsight). Only items marked **fork-original** were created by this fork's commits.

---

## 1. Fork-Original TypeScript Code Subsystems

These are real TS modules (classes, imports, exports in `packages/coding-agent/src/`) created by fork commits. **Not** skill prompts.

### 1.1 Actor System — fork-original

6 files, real runtime code:

| File | Purpose |
|---|---|
| `src/actor/index.ts` | Entry point |
| `src/actor/mailbox-router.ts` | Process-wide actor mailbox routing with IRC coordination |
| `src/actor/orchestrator.ts` | Actor orchestrator |
| `src/actor/output-contract.ts` | Structured output contracts for actors |
| `src/actor/run-state.ts` | Actor run state management |
| `src/actor/types.ts` | Actor type definitions |
| `src/registry/mailbox.ts` | Registry mailbox module |

### 1.2 External Agent Orchestration — fork-original

| File | Purpose |
|---|---|
| `src/external-agents/index.ts` | Entry point |
| `src/external-agents/runner.ts` | External agent runner (+485 lines) |
| `src/external-agents/types.ts` | Types for orchestration |

### 1.3 Software Factory System — fork-original

| File | Purpose |
|---|---|
| `src/factory/doctor.ts` | Factory diagnostics |
| `src/factory/scaffold.ts` | Project scaffolding |
| `src/factory/template-manifest.ts` | Template manifest handling |
| `src/cli/factory-cli.ts` | Factory CLI commands |
| `src/commands/factory.ts` | Factory slash command |
| `src/commands/discover.ts` | Discovery command |

Plus template directory under `src/factory/templates/software-factory/`.

### 1.4 Gain / Minimizer Overlay — fork-original

| File | Purpose |
|---|---|
| `src/minimizer-gain.ts` | Gain computation engine (+778 lines) |
| `src/cli/gain-cli.ts` | Gain CLI (+617 lines) |
| `src/commands/gain.ts` | Gain slash command |
| `src/modes/components/minimizer-gain-overlay.ts` | TUI overlay component (+527 lines) |
| `test/minimizer-gain.test.ts` | Tests (+1,234 lines) |

### 1.5 Session Observer Overhaul — fork-original (partial)

| File | Nature |
|---|---|
| `src/modes/components/session-observer-overlay.ts` | Major rewrite (+738 lines) |
| `src/modes/session-observer-registry.ts` | Large rewrite (+569 lines) |
| `src/modes/session-observer-standalone.ts` | New (+63 lines) |
| `src/modes/session-observer-window.ts` | New (+204 lines) |
| `test/session-observer-overlay.test.ts` | Tests (+732) |
| `test/session-observer-registry.test.ts` | Tests (+1,509) |
| `test/session-observer-window.test.ts` | Tests (+440) |

### 1.6 Antigravity Adapter — fork-original package

New `packages/antigravity-adapter/` — bridges Lex to OpenCode/Antigravity providers:

| File | Purpose |
|---|---|
| `src/auth-adapter.ts` | Authentication adapter |
| `src/stream-adapter.ts` | Streaming adapter |
| `src/models.ts` | Model resolution |
| `src/opencode-client-adapter.ts` | OpenCode client bridge |
| `src/extension.ts` | Extension entry |
| `test/bridge.test.ts` | Tests (+515) |

### 1.7 Status Line Segment Editor — fork-original

| File | Purpose |
|---|---|
| `src/modes/components/status-line-segment-editor.ts` | Interactive status line config (+360) |
| `src/modes/components/status-line.ts` | Modified |
| `src/modes/components/status-line/presets.ts` | Modified |
| `src/modes/components/status-line/segments.ts` | Modified |

### 1.8 External Orchestration Monitor (TUI) — fork-original

| File | Purpose |
|---|---|
| `src/modes/components/external-orchestration-monitor.ts` | TUI monitor (+282) |
| `test/modes/components/external-orchestration-monitor.test.ts` | Tests (+339) |

### 1.9 Skills Overlay — fork-original

| File | Purpose |
|---|---|
| `src/modes/components/skills-overlay.ts` | Skills UI overlay (+163) |
| `src/extensibility/skills.ts` | Modified skills loader |

---

## 2. Upstream-Originated Code Retained (Deleted/Renamed Upstream)

These files originated from `can1357` commits but no longer exist on `upstream/main` — upstream deleted or renamed them. Our fork kept them (or cherry-picked before removal). They show as `+` in the diff against current upstream/main.

### Calculator Tool

| File | Status in upstream |
|---|---|
| `src/tools/calculator.ts` (+540) | Created and then **deleted** by can1357 (`remove deprecated calc tool as it is completely useless with eval`) |
| `src/prompts/tools/calculator.md` (+10) | Deleted alongside |

### Recipe / Task Runner Tool

| File | Status in upstream |
|---|---|
| `src/tools/recipe/` (8 files, +871 total) | Created (as `run_command`) and later **deleted** by can1357 (`removed recipe tool and all runner implementations`) |
| `src/prompts/tools/recipe.md` (+16) | Deleted alongside |

### Hindsight Memory Tools

| File | Status in upstream |
|---|---|
| `src/tools/hindsight-recall.ts` (+68) | Created by can1357, then **renamed** to Memory tools (`renamed Hindsight tools to Memory`) |
| `src/tools/hindsight-reflect.ts` (+57) | Same rename |
| `src/tools/hindsight-retain.ts` (+56) | Same rename |
| `test/hindsight-tools.test.ts` (+318) | Tests moved alongside rename |

### Profile System

| File | Status in upstream |
|---|---|
| `src/cli/profile-cli.ts` (+272) | Fork-modified version of upstream-originated profile code |
| `src/commands/profile.ts` (+66) | Fork patch on existing upstream feature |
| `src/modes/components/profile-selector.ts` (+49) | Fork patch |
| `src/config/model-profile-presets.ts` (+18) | Fork patch |
| `test/profile-cli.test.ts` (+128) | Fork tests |

---

## 3. Renamed / Restructured Packages

### mnemopi → mnemosyne

`packages/mnemopi/` renamed to `packages/mnemosyne/`. Entire source tree moved, new `embeddings.ts` and `runtime-options.ts` added, various files modified. Old CHANGELOG replaced.

### swarm-extension (upstream-*modified*)

`packages/swarm-extension/` exists upstream. Fork added new files:

| File | Lines |
|---|---|
| `src/swarm/events.ts` | +117 |
| `src/swarm/format.ts` | +43 |
| `src/swarm/inspect.ts` | +65 |
| `src/swarm/reservations.ts` | +78 |
| `src/swarm/runtime.ts` | +22 |
| `src/swarm/state.ts` | +55 |
| `src/swarm/tasks.ts` | +89 |
| `src/swarm/types.ts` | +11 |
| `test/swarm-mesh.test.ts` | +106 |

---

## 4. Skill Prompts (Markdown Only — Not Code)

These are plain markdown files with YAML frontmatter, not TypeScript subsystems. They instruct the agent how to behave.

| Path | Purpose |
|---|---|
| `.omp/skills/auggie-codebase-first/SKILL.md` | Override Auggie code retrieval to correct repo owner/name |
| `.omp/skills/github-tool-issue/SKILL.md` | Tool issue reporting skill |
| `.omp/skills/factory-bundle-guide/SKILL.md` | Routing guide for factory bundle selection |
| `.omp/skills/semantic-compression/SKILL.md` | Compression/prompt optimization skill (may be upstream-copied) |
| `.omp/skills/system-prompts/SKILL.md` | System prompt authoring skill (may be upstream-copied) |

### Agent Definitions (YAML frontmatter + rules)

| Path | Purpose |
|---|---|
| `.omp/agents/actor-runtime-auditor.md` | Agent to audit actor system at runtime — complements actor code, not the code itself |
| `.omp/agents/provider-boundary-guardian.md` | Agent to enforce provider boundary separation |

### Custom Slash Commands

| Path | Purpose |
|---|---|
| `.omp/commands/fix-issues.md` | `/fix-issues` slash command |
| `.omp/commands/release.md` | `/release` slash command |
| `.omp/commands/review-prs.md` | `/review-prs` slash command |
| `.omp/commands/triage.md` | `/triage` slash command |

### Stream Rule

| Path | Purpose |
|---|---|
| `.omp/rules/ts-hook-fetch.md` | Stream-injection rule for fetch hook |

---

## 5. Symlinked Library Skills (Point to `the-library/`)

These are symlinks to `~/PycharmProjects/the-library/skills/`. Zero bytes in repo.

| Location | Skill |
|---|---|
| `.claude/skills/factory-discovery` | → `the-library/skills/factory-discovery` |
| `.claude/skills/factory-librarian` | → `the-library/skills/factory-librarian` |
| `.claude/skills/factory-orchestrator` | → `the-library/skills/factory-orchestrator` |
| `.claude/skills/mcp-server-factory` | → `the-library/skills/mcp-server-factory` |
| `.codex/skills/actor-swarm-coordinator` | → `the-library/skills/actor-swarm-coordinator` |
| `.codex/skills/factory-orchestrator` | → `the-library/skills/factory-orchestrator` |
| `.codex/skills/incident-factory-commander` | → `the-library/skills/incident-factory-commander` |
| `.codex/skills/schema-migration-orchestrator` | → `the-library/skills/schema-migration-orchestrator` |
| `.codex/skills/workspace-worktree-manager` | → `the-library/skills/workspace-worktree-manager` |
| `.omp/agent/skills/actor-swarm-coordinator` | → `the-library/skills/actor-swarm-coordinator` |
| `.omp/agent/skills/autonomous-factory-orchestrator` | → `the-library/skills/autonomous-factory-orchestrator` |
| `.omp/agent/skills/factory-orchestrator` | → `the-library/skills/factory-orchestrator` |
| `.omp/agent/skills/incident-factory-commander` | → `the-library/skills/incident-factory-commander` |
| `.omp/agent/skills/schema-migration-orchestrator` | → `the-library/skills/schema-migration-orchestrator` |
| `.omp/agent/skills/workspace-worktree-manager` | → `the-library/skills/workspace-worktree-manager` |

---

## 6. Removed Upstream Functionality

### Full Subsystems Removed

| Subsystem | Path | Est. Lines |
|---|---|---|
| **Cursor provider** | `packages/ai/src/providers/cursor/` | ~21K (protobuf) |
| **Setup wizard** | `packages/coding-agent/src/modes/setup-wizard/` | ~1.2K |
| **OMfG controller/rule** | `packages/coding-agent/src/modes/controllers/omfg-*` | ~930 |
| **Auto-thinking classifier** | `packages/coding-agent/src/auto-thinking/` | ~180 |
| **Builtin discovery rules** | `packages/coding-agent/src/discovery/builtin-rules/` | ~640 |
| **Shake compaction** | `packages/agent/src/compaction/shake.ts` + tool-protection.ts | ~460 |

### Specific Files Removed

| File | Est. Lines |
|---|---|
| `packages/agent/src/append-only-context.ts` | +297 |
| `packages/ai/src/auth-broker/client.ts` | +97 |
| `packages/ai/src/auth-broker/types.ts` | +43 |
| `packages/ai/src/auth-broker/wire-schemas.ts` | +38 |
| `packages/ai/src/utils/abortable-iterator.ts` | +69 |
| `packages/ai/src/utils/discovery/cursor.ts` | +306 |
| `packages/ai/src/utils/json-parse.ts` | +34 |
| `packages/ai/src/utils/oauth/deepseek.ts` | +53 |
| `packages/ai/src/utils/oauth/zhipu.ts` | +60 |
| `packages/ai/src/provider-models/special.ts` | +28 |
| `packages/coding-agent/src/cli/completion-gen.ts` | +550 |
| `packages/coding-agent/src/cli/extension-flags.ts` | +48 |
| `packages/coding-agent/src/commands/complete.ts` | +66 |
| `packages/coding-agent/src/commands/completions.ts` | +60 |
| `packages/coding-agent/src/cursor.ts` | +340 |
| `packages/coding-agent/src/discovery/builtin-defaults.ts` | +39 |
| `packages/coding-agent/src/modes/orchestrate.ts` | — |
| `packages/coding-agent/src/modes/ultrathink.ts` | — |
| `packages/coding-agent/src/modes/turn-budget.ts` | — |
| `packages/coding-agent/src/modes/workflow.ts` | — |
| `packages/coding-agent/src/modes/gradient-highlight.ts` | — |
| `packages/coding-agent/src/modes/internal-url-autocomplete.ts` | — |
| `packages/coding-agent/src/modes/magic-keywords.ts` | — |
| `packages/coding-agent/src/session/shake-types.ts` | +43 |
| `packages/coding-agent/src/tiny/device.ts` | +111 |
| `packages/coding-agent/src/tiny/dtype.ts` | +101 |
| `packages/coding-agent/src/tools/approval.ts` | +189 |
| `packages/coding-agent/src/tools/tts.ts` | +133 |
| `packages/coding-agent/src/tools/output-schema-validator.ts` | +132 |
| `packages/coding-agent/src/eval/budget-bridge.ts` | — |
| `packages/coding-agent/src/eval/idle-timeout.ts` | — |
| `packages/coding-agent/src/eval/js/shared/local-module-loader.ts` | +342 |
| `packages/coding-agent/src/extensibility/legacy-pi-ai-shim.ts` | — |
| `packages/coding-agent/src/extensibility/legacy-pi-coding-agent-shim.ts` | — |
| `packages/tui/src/autocomplete.ts` | — |
| `packages/tui/src/stdin-buffer.ts` | — |
| `packages/hashline/src/block.ts` | +84 |
| `packages/hashline/src/messages.ts` | +61 |
| ~80 test files | ~20K+ |

### Removed Documentation

| Doc | Path |
|---|---|
| Approval mode | `docs/approval-mode.md` |
| Keybindings | `docs/keybindings.md` |
| Local models | `docs/local-models.md` |
| LSP config | `docs/lsp-config.md` |
| Mnemosyne backend | `docs/mnemosyne-memory-backend.md` |
| Review prompts | `src/prompts/review-custom-request.md`, `review-headless-request.md` |
| Auto-thinking difficulty | `src/prompts/system/auto-thinking-difficulty-local.md`, `auto-thinking-difficulty.md` |
| OMfG user prompt | `src/prompts/system/omfg-user.md` |
| Project prompt | `src/prompts/system/project-prompt.md` |
| Setup wizard scenes | `src/modes/setup-wizard/scenes/` (8 files) |

---

## 7. Major Modified Core Files

### Session & Agent Runtime

| File | Lines Changed | Nature |
|---|---|---|
| `packages/coding-agent/src/session/agent-session.ts` | +1,440 / −1,107 | Major rewrite |
| `packages/coding-agent/src/task/executor.ts` | +861 / −1,024 | Major rewrite |
| `packages/coding-agent/src/task/index.ts` | +387 / −348 | Major changes |
| `packages/coding-agent/src/task/render.ts` | +534 / −387 | Rendering overhaul |
| `packages/coding-agent/src/main.ts` | +211 / −134 | CLI commands, init |
| `packages/agent/src/agent.ts` | +254 / −220 | Agent loop, types |
| `packages/agent/src/agent-loop.ts` | +78 / −78 | Modified |

### Interactive Mode & TUI

| File | Lines Changed | Nature |
|---|---|---|
| `interactive-mode.ts` | +626 / −494 | Event handling, components |
| `welcome.ts` | +201 / −94 | Modified |
| `model-selector.ts` | +298 / −162 | Modified |
| `oauth-selector.ts` | +120 / −87 | Modified |
| `tool-execution.ts` | +143 / −119 | Modified |
| `packages/tui/src/tui.ts` | +454 / −146 | Modified |
| `packages/tui/src/terminal.ts` | +105 / −37 | Modified |

### LSP

| File | Nature |
|---|---|
| `src/lsp/edits.ts` | +111 / −64 |
| `src/lsp/config.ts` | +109 / −203 |
| `src/lsp/index.ts` | Modified |

### Edit / Hashline

| File | Lines | Nature |
|---|---|---|
| `src/edit/hashline/diff.ts` | +130 / −38 | Modified |
| `src/edit/hashline/execute.ts` | Modified | |
| `src/edit/hashline/filesystem.ts` | +10 | New |
| `src/edit/streaming.ts` | +164 / −79 | Modified |
| `packages/hashline/src/apply.ts` | +49 / −75 | Modified |
| `packages/hashline/src/patcher.ts` | +93 / −7 | Modified |
| `packages/hashline/src/types.ts` | Modified | |

### Python Eval Kernel

| File | Lines | Nature |
|---|---|---|
| `src/eval/py/executor.ts` | +311 / −251 | Heavy rewrite |
| `src/eval/py/prelude.py` | +59 / −18 | Modified |
| `src/eval/py/runner.py` | +289 / −86 | Modified |
| `src/eval/py/runtime.ts` | Modified | |

### Provider & AI Layer

| File | Lines | Nature |
|---|---|---|
| `packages/ai/src/models.json` | −38,959 | Streamlined model catalog |
| `packages/ai/src/providers/anthropic.ts` | +180 / −53 | Modified |
| `packages/ai/src/providers/openai-codex-responses.ts` | +586 / −249 | Heavy rewrite |
| `packages/ai/src/providers/openai-completions.ts` | +308 / −102 | Modified |
| `packages/ai/src/auth-storage.ts` | +584 / −270 | Heavy modification |
| `packages/ai/src/provider-models/openai-compat.ts` | +375 / −79 | Modified |
| `packages/ai/src/stream.ts` | Modified | |

### Tool Implementations

| File | Lines | Nature |
|---|---|---|
| `src/tools/bash.ts` | +321 / −228 | Modified |
| `src/tools/search.ts` | +566 / −759 | Modified |
| `src/tools/find.ts` | +110 / −46 | Modified |
| `src/tools/read.ts` | +125 / −62 | Modified |
| `src/tools/write.ts` | +61 / −47 | Modified |
| `src/tools/irc.ts` | +53 / −15 | Modified |
| `src/tools/report-tool-issue.ts` | +356 / −168 | Modified |

### Slash Commands

| File | Lines | Nature |
|---|---|---|
| `builtin-registry.ts` | +1,322 / −1,354 | Major changes |

### Config / Settings

| File | Lines | Nature |
|---|---|---|
| `settings-schema.ts` | +548 / −130 | Modified |
| `settings.ts` | +266 / −65 | Modified |
| `config-file.ts` | +111 / −9 | Modified |
| `model-registry.ts` | +387 / −179 | Modified |

### Extensions / Plugins

| File | Lines | Nature |
|---|---|---|
| `plugins/manager.ts` | +160 / −42 | Modified |
| `plugins/legacy-pi-compat.ts` | +426 / −176 | Heavy rewrite |
| `plugins/legacy-pi-facade.ts` | +179 | New |
| `extensions/loader.ts` | Modified | |

### SDK

| File | Lines | Nature |
|---|---|---|
| `src/sdk.ts` | +400 / −611 | Modified |

---

## 8. Rust / Native Layer Changes

### pi-shell (Minimizer)

The minimizer engine saw the most Rust-level changes — fork-original additions:

| File | Lines | Nature |
|---|---|---|
| `src/minimizer/detect.rs` | +173 | **New** — minimizer detection |
| `src/minimizer/filters/ai_smart.rs` | +383 | **New** — AI-smart output filter |
| `src/minimizer/filters/binary_tools.rs` | +121 | **New** — binary tool filter |
| `src/minimizer/filters/rust_tools.rs` | +170 | **New** — Rust tool filter |
| `src/minimizer/engine.rs` | +379 / −240 | Major rewrite |
| `src/minimizer/config.rs` | +191 / −33 | Modified |
| `src/minimizer/plan.rs` | +308 / −113 | Modified |
| `src/minimizer/primitives.rs` | +50 | New |
| `src/minimizer/filters/git.rs` | +1,657 / −1,393 | Massive rewrite |
| `src/minimizer/filters/mod.rs` | +498 / −236 | Restructured |
| `src/minimizer/filters/bun.rs` | +368 / −190 | Modified |
| `src/minimizer/filters/cargo.rs` | +359 / −373 | Modified |
| `src/minimizer/filters/cloud.rs` | +970 / −690 | Modified |
| `src/minimizer/filters/docker.rs` | +523 / −389 | Modified |
| `src/minimizer/filters/listing.rs` | +696 / −547 | Modified |
| `src/minimizer/filters/system.rs` | +413 / −333 | Modified |
| `src/minimizer/filters/pkg.rs` | +546 / −464 | Modified |
| `src/shell.rs` | +894 / −260 | Heavy rewrite |
| `tests/minimizer_chain_flag_matrix.rs` | +260 | New test |
| `benches/fixtures/` | multiple | New benchmark fixtures |

### pi-natives

| File | Lines | Nature |
|---|---|---|
| `src/ast.rs` | +679 / −547 | Heavy rewrite |
| `src/shell.rs` | +110 / −29 | Modified |
| `src/keys.rs` | +121 / −176 | Modified |

### pi-ast

| File | Nature |
|---|---|
| `src/block.rs` | **Removed** (−223) |
| `src/language/mod.rs` | Modified |

---

## 9. CI / Build / Infrastructure

| File | Lines | Nature |
|---|---|---|
| `.github/workflows/ci.yml` | +261 / −212 | Modified |
| `.github/actions/build-native/action.yml` | +103 / −62 | Modified |
| `package.json` | +328 / −719 | Scripts, deps |
| `Cargo.toml` | +3 / −1 | Workspace members |
| `Cargo.lock` | +664 / −1,060 | Updated |
| `bun.lock` | +944 / −1,698 | Updated |
| `.gitignore` | +9 | Extended |
| `rebuild-lex.zsh` | +58 | **New** — rebuild script |
| `lex-cherry-pick-swarm.yaml` | +72 | **New** — swarm config |
| `rtk.md` | +303 | **New** — RTK documentation |
| `.omp/settings.json` | +35 | **New** — project settings |
| `.omp/agent/config.yml` | +23 | **New** — agent config |

---

## 10. Documentation Changes

| Doc | Lines | Nature |
|---|---|---|
| `docs/adrs/` (5 files) | ~270 | **New** — architectural decisions |
| `docs/orchestration-workflows.md` | +182 | **New** |
| `docs/software-factory.md` | +220 | **New** |
| `docs/subagent-tasks-jobs-irc.md` | +157 | **New** |
| `docs/subagent-tasks-jobs-irc-walkthrough.md` | +540 | **New** |
| `docs/extensions-to-remove.md` | +62 | **New** |
| `docs/tools/recipe.md` | +155 | **New** (upstream-deleted doc) |
| `docs/tools/calc.md` | +71 | **New** (upstream-deleted doc) |
| `docs/tools/ast-dump.md` | +30 | **New** |
| `docs/architecture/generated/` (11 files) | ~1,100 | **New** — generated maps |
| `AGENTS.md` | +51 / −50 | Modified |
| `README.md` | +48 / −34 | Modified |
| `CHANGELOG.md` (root) | +154 | Fork changes |

---

## Quick Reference: What's What

| Item | Type | Origin |
|---|---|---|
| Actor system | TypeScript code (`packages/coding-agent/src/actor/`) | **Fork-original** |
| External agent orchestration | TypeScript code (`src/external-agents/`) | **Fork-original** |
| Software factory | TypeScript code (`src/factory/`) + templates | **Fork-original** |
| Gain/minimizer overlay | TypeScript code (`minimizer-gain.ts`, `gain-cli.ts`, TUI) | **Fork-original** |
| Session observer overhaul | TypeScript code + tests | **Fork-original** (partial) |
| Antigravity adapter | Separate package `packages/antigravity-adapter/` | **Fork-original** |
| Status line segment editor | TypeScript code | **Fork-original** |
| External orchestration monitor | TypeScript code + tests | **Fork-original** |
| Skills overlay | TypeScript code | **Fork-original** |
| Rust minimizer additions | Rust (`ai_smart.rs`, `binary_tools.rs`, `rust_tools.rs`, `detect.rs`) | **Fork-original** |
| Calculator tool | TypeScript code (`tools/calculator.ts`) | Upstream-originated, kept after upstream deleted |
| Recipe tool | TypeScript code (`tools/recipe/`) | Upstream-originated, kept after upstream deleted |
| Hindsight tools | TypeScript code | Upstream-originated, kept after upstream renamed to Memory |
| Profile system | TypeScript code | Fork-patched upstream feature |
| swarm-extension additions | TypeScript code (events, format, inspect, etc.) | Fork-modified upstream package |
| mnemosyne | Renamed package (was mnemopi) | Fork-renamed upstream package |
| `.omp/skills/*` | Markdown skill prompts | Fork-created |
| `.omp/agents/*` | YAML+markdown agent defs | Fork-created |
| `.claude/skills/*`, `.codex/skills/*` | Symlinks to `the-library/` | Skill library references |
