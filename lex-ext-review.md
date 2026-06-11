# Lex extension gap analysis

Date: 2026-06-11
Branch: `extensions`

## Current Inventory

Local inventory is based on each package's `package.json` and active extension registration in `.omp/settings.json`. The official registry baseline is `https://pi.dev/packages`, sorted by Most downloads, which currently shows `1-50 / 3844` packages.

| Package directory | Package name | Version | Author | Current surface | Registration / output | Status |
|---|---:|---:|---|---|---|---|
| `packages/pi-observer/` | `pi-observer` | `15.10.12-lex` | David Andrews | Runtime extension; `/observe`; tracks session, turn, tool, token, IRC, and subagent lifecycle/progress events; registers a `job` renderer. | Manifest: `./dist/observer.bundle.js`; settings: `packages/pi-observer/dist/observer.bundle.js`. | Fork-original, off-Lex safe per `docs/extensions-build-and-test.md`. |
| `packages/antigravity-adapter/` | `@oh-my-pi/antigravity-adapter` | `15.10.12-lex` | Derek Rynd | Runtime provider extension; registers `opencode-antigravity/*` models through `opencode-antigravity-auth`; reuses upstream OAuth/account/quota/stream transforms. | Manifest/settings: `./dist/antigravity.bundle.js` / `packages/antigravity-adapter/dist/antigravity.bundle.js`. | Fork-original provider bridge; fragile/fork-only per docs; README should keep the upstream-auth ToS warning. |
| `packages/pi-distill/` | `pi-distill` | `15.10.12-lex` | David Andrews | Runtime extension; `tool_result` hook compresses large MCP/tool JSON/YAML/text into artifact-backed summaries; `/distill`, `/distill-stats`, `/distill-gain`. | Manifest/settings: `./dist/distill.bundle.js` / `packages/pi-distill/dist/distill.bundle.js`. | Fork-original, restored; only target package with a `CHANGELOG.md`. |
| `packages/pi-omnidelegate/` | `pi-omnidelegate` | `15.10.12-lex` | David Andrews | Runtime extension; `/delegate`; external Claude/Codex/Gemini delegation through `acpx`, `tmux`, or `cmux`; writes full orchestration reports to artifacts. | Manifest/settings: `./dist/omnidelegate.bundle.js` / `packages/pi-omnidelegate/dist/omnidelegate.bundle.js`. | Fork-original, off-Lex safe. |
| `packages/pi-software-factory/` | `pi-software-factory` | `15.10.12-lex` | David Andrews | Hybrid extension + CLI; `/factory-init`, `/factory-status`; bins `factory-init`, `factory-doctor`; scaffolds `.omp/factory/*` and checks factory health. | Manifest/settings: `./dist/factory.bundle.js` / `packages/pi-software-factory/dist/factory.bundle.js`; build emits CLI bins too. | Fork-original, off-Lex safe; `tool_call` safety hook is currently a no-op placeholder. |
| `packages/pi-actor-swarm/` | `pi-actor-swarm` | `15.10.12-lex` | David Andrews | Runtime extension; mailbox-driven swarm commands `/swarm-init`, `/swarm-status`, `/swarm-send`, `/swarm-reset`; default scout/builder/reviewer/qa agents. | Manifest/settings: `./dist/swarm.bundle.js` / `packages/pi-actor-swarm/dist/swarm.bundle.js`. | Fork-original, off-Lex safe; state is in-memory only. |
| `packages/pi-minimizer-gain/` | `pi-minimizer-gain` | `15.10.12-lex` | David Andrews | Runtime extension; `/gain`; visualizes native minimizer token savings, current/all scopes, and diagnostics. | Manifest/settings: `./dist/gaing.bundle.js` / `packages/pi-minimizer-gain/dist/gaing.bundle.js`. | Fork-original; off-Lex blocked until native `pi-natives` minimizer binding lands. |
| `packages/swarm-extension/` | `@oh-my-pi/swarm-extension` | `15.10.12-lex` | Derek Rynd | Runtime extension + bin `omp-swarm`; `/swarm run <file.yaml>` and `/swarm status`; YAML DAG/pipeline orchestration. | Manifest says `./src/extension.ts`; settings/docs use `packages/swarm-extension/dist/extension.bundle.js`. | Upstream package modified by the fork; keep separate from `pi-actor-swarm` until the two swarm models are deliberately reconciled. |

Additional local package relevant to registry gaps: `packages/mnemopi/` is `@oh-my-pi/pi-mnemopi@15.10.12-lex`, a local SQLite memory engine with CLI `mnemopi`, but it is not an `omp.extensions` runtime package.

Additional already-available infrastructure outside `packages/`: context-mode MCP tooling is present in this agent environment and should be treated as present infrastructure, not a missing registry gap.

## `pi-actor-swarm` vs `swarm-extension`

These are different swarm models and should not be collapsed in planning:

- `pi-actor-swarm` is Lex's low-level mailbox/coordination layer. Its extension entry is `packages/pi-actor-swarm/src/extension.ts`; it registers `/swarm-init`, `/swarm-status`, `/swarm-send`, and `/swarm-reset`. It creates a default scout/builder/reviewer/qa agent set, supports routing policies `priority`, `round-robin`, `broadcast`, and `direct`, and stores the active swarm in memory via `packages/pi-actor-swarm/src/mailbox.ts`. Treat it as a live message bus/dashboard primitive, not a YAML pipeline runner.
- `swarm-extension` is the upstream package modified by the fork. Its extension entry is `packages/swarm-extension/src/extension.ts`; it registers one `/swarm` command with subcommands `/swarm run <file.yaml>`, `/swarm status <name>`, and `/swarm help`. It parses YAML definitions with `name`, `workspace`, `mode` (`pipeline`, `parallel`, `sequential`), `target_count`, and agent `role`/`task`/dependency fields via `packages/swarm-extension/src/swarm/schema.ts`, builds dependency waves, runs `PipelineController`, and persists state/logs under `.swarm_<name>/` through `StateTracker`.
- Keep both: `pi-actor-swarm` is Lex's mailbox layer; `swarm-extension` is the YAML batch pipeline executor and should be considered a fallback/legacy OMP pathway under the Strav-first operating model. Do not add another registry swarm/team/actor runtime as the primary orchestrator unless it plugs into `herder-strav`/`cmux-strav`.

## Custom Enhancements

These are future work items for Lex-owned or fork-maintained extensions, not changes made by this report.

### 1. `pi-software-factory` — make factory safety real before adding more orchestration

- Implement the `tool_call` safety hook in `packages/pi-software-factory/src/extension.ts`; read `.omp/factory/safety.rules.json` from `ctx.cwd`, match configured tool names/argument patterns, and block or warn according to the rule file. Replace the current placeholder rather than wrapping it with another no-op.
- Add `/factory-init --dry-run` and `/factory-init --list-presets`; dry-run prints exact files that would be written without touching disk, list-presets prints scaffold presets from `packages/pi-software-factory/src/scaffold.ts`.
- Add `/factory-upgrade --dry-run`; compare existing `.omp/factory/*` files with current templates and report create/update/conflict buckets without overwriting user files.

### 2. `pi-omnidelegate` — preserve and reuse delegation output

- Add `/delegate-results list|show|clear`, backed by session artifacts already written via `ctx.sessionManager.saveArtifact(fullReport, "external-orchestration")` in `packages/pi-omnidelegate/src/extension.ts`.
- Add per-agent streaming into `DelegateMonitorComponent` while `runExternalAgentsParallel()` is still running; do not wait for the final report before showing output.
- Add same-session result reuse keyed by provider/backend/mode/cwd/prompt hash; reuse only exact matches and expose reuse in the monitor.

### 3. `pi-actor-swarm` — make swarms durable enough for factory lanes

- Replace in-memory `config`, `mailboxes`, and `messageCounter` in `packages/pi-actor-swarm/src/mailbox.ts` with a disk-backed project store under `.omp/swarm/state.json`; keep an in-memory cache but persist after every state-changing operation.
- Add `/swarm-logs export [path]`; write message history and final agent states as JSONL for observer/factory postmortems.
- Add stale-agent detection: store `lastActivityMs` on each `SwarmAgent`, mark agents stale after a configurable TTL, and render stale state in `SwarmDashboard`.

### 4. `pi-observer` — turn live monitoring into durable diagnostics

- Add `/observe-export json|csv [path]`; export accumulated stats from `stats-collector.ts` without resetting runtime counters.
- Add a filter input for IRC/subagent detail panes; filter by agent id, status, tool name, or substring so high-volume factory runs remain readable.
- Replace hardcoded `REFRESH_INTERVAL_MS = 500` in `packages/pi-observer/src/dashboard.ts` with a flag or config value; default remains 500ms.

### 5. `pi-distill` — expose compression policy and attribution

- Extend `packages/pi-distill/src/config.ts` so `builtinSkip` can be overridden from config/env; keep the current built-in list as the default.
- Add optional whitelist mode: when configured, compress only named verbose tools instead of every non-skipped tool above `minBytes`.
- Track per-tool candidate count, hit count, and saved bytes in `stats.ts`; surface them in `/distill-stats` so factory runs can identify noisy tools.

### 6. `pi-minimizer-gain` — make gain data useful outside the overlay

- Add ignored-command configuration for missed-minimization diagnostics so low-value commands such as `echo` can be excluded.
- Add JSONL export of daily totals and per-command totals from the data already loaded by `loadMinimizerGainContext()`.
- Add a per-file-extension or path-pattern breakdown when source paths are available in minimized output. If no path signal exists, emit an explicit `unknown` bucket rather than guessing.

### 7. `antigravity-adapter` — keep as fork-only provider bridge unless upstream support appears

- Add compatibility smoke docs for `omp login opencode-antigravity` and one model selection command from README, e.g. `opencode-antigravity/antigravity-claude-sonnet-4-6` or current equivalent.
- Add a focused test around existing-token probe plus refresh failure mapping in `auth-adapter.ts`; do not duplicate upstream plugin internals.
- Keep the ToS risk warning in README; do not upstream this package while docs classify it as fragile/fork-only.

### 8. `swarm-extension` — reconcile metadata and role

- Align package manifest/runtime registration: either make `package.json` point at `./dist/extension.bundle.js` like `.omp/settings.json`, or document why this package intentionally loads source while settings load dist.
- Keep YAML DAG pipeline orchestration here and mailbox coordination in `pi-actor-swarm`; do not merge them until one command surface is chosen.
- Add a smoke that validates `/swarm run <file.yaml>` still works after the bundle/manifest decision.

## Gap Analysis & Integration

Registry candidates below were absent from `packages/*/package.json` by exact package-name search. Do not vendor third-party source into `packages/` first. Evaluate through the official registry path, `pi install npm:<package>`, and only vendor or fork after a compatibility smoke proves the package works and a source patch is required.

`context-mode` is intentionally excluded from the missing list because context-mode MCP tooling is already available in this environment. Treat `herder-strav`/`cmux-strav` as the long-term orchestration layer; registry packages should plug into that framework, not replace it. Use direct `omp` entrypoints only when no `strav` CLI flow is used.

### Already available; integrate, do not add

1. `context-mode` — `131.5K/mo`, registry type `package`.
   - Why it matters: highest-download registry package; FTS5 knowledge base, sandboxed code execution, and intent-driven search directly reduce token/context load for factory lanes and delegated agents.
   - Decision: keep using the already-present context-mode MCP tooling outside `packages/`; document it as a required/recommended factory dependency and route large read/search/test-output analysis through it. Do not copy it into `packages/` or list it as a missing extension.

### Add/evaluate first

1. `pi-web-access` — `90.8K/mo`, registry type `extension`.
   - Why: web search, URL fetch, GitHub repo clone, PDF extraction, YouTube/video analysis; directly strengthens `pi-omnidelegate` research agents and software-factory discovery lanes.
   - Decision: evaluate this as the default web-capability extension. Do not also add `@juicesharp/rpiv-web-tools` unless provider-pluggability is needed; overlapping web tools will confuse agents.

2. `pi-lens` — `26K/mo`, registry type `extension`.
   - Why: real-time LSP/linter/formatter/typecheck/structural feedback; complements `pi-software-factory` verification gates before CI.
   - Decision: add as an optional factory verification extension; wire it to factory status/reporting only after its diagnostics format is read and smoke-tested.

3. `@vigolium/piolium` — `29.1K/mo`, registry type `extension`.
   - Why: multi-phase security audits with specialist subagents, isolated contexts, capped concurrency, and resumable state; maps cleanly to a factory security lane.
   - Decision: evaluate as the security lane extension before building a new Lex-only security-audit subsystem.

4. `@plannotator/pi-extension` — `31.2K/mo`, registry type `package`.
   - Why: interactive plan review, annotations, and code/PR review; complements the planning/approval model used by software-factory workflows.
   - Decision: evaluate as a human review gate for factory plans and PR readiness.

5. `@juicesharp/rpiv-advisor` — `17.7K/mo`, registry type `extension`.
   - Why: second-opinion reviewer model before action; useful as a factory preflight/review gate and lighter-weight than a whole team runtime.
   - Decision: add only if review gating should be model-to-model inside the session; otherwise keep review in existing `task`/agent workflows.

6. `pi-chrome` — `13.1K/mo`, registry type `extension`.
   - Why: authorized access to an existing signed-in Chrome profile; useful for browser QA lanes and delegated agents needing authenticated web apps.
   - Decision: evaluate only for QA/browser workflows; it is not a default install because it expands credential/browser access.

7. `@gotgenes/pi-permission-system` — `16.8K/mo`, registry type `extension`.
   - Why: permission enforcement complements the currently-unimplemented `pi-software-factory` safety hook.
   - Decision: evaluate after the local factory safety hook contract is defined; if it covers the needed policy model, use it instead of inventing a second permission system.

### Evaluate, but do not add by default because of overlap

1. `pi-mcp-adapter` — `99.2K/mo`.
   - Why it is tempting: high-download MCP adapter.
   - Why not default: this codebase already has MCP discovery/config support in `packages/coding-agent/src/discovery/omp-plugins.ts` plus other MCP discovery providers. Add only if `pi-mcp-adapter` provides runtime behavior not covered by built-in MCP loading.

2. `pi-subagents` (`103.2K/mo`), `@gotgenes/pi-subagents` (`17.2K/mo`), `@tintinweb/pi-subagents` (`16.9K/mo`).
   - Why they are tempting: popular subagent delegation packages; the user has previously referenced Claude Code-style subagent look and feel.
   - Why not default: they overlap with `pi-omnidelegate`, `pi-actor-swarm`, and built-in `task`/subagent behavior. Mine specific features instead: chains, TUI clarification, visual style, and autonomous subagent command ergonomics.

3. `pi-crew` — `10.7K/mo`; `pi-agent-flow` — `16.1K/mo`; `@llblab/pi-actors` — `11.6K/mo`.
   - Why they are tempting: alternative team/actor/flow runtimes.
   - Why not default: they overlap with `pi-actor-swarm`, `swarm-extension`, `pi-software-factory`, and the user-provided long-term `herder-strav`/`cmux-strav` framework. Evaluate architecture and UX for feature-mining only; do not install another orchestration runtime as the primary framework.
   - Decision: if any feature is adopted, expose it through Strav first; use direct `omp` commands only for users who are not running the `strav` CLI.

4. Memory packages: `pi-memory` (`5K/mo`), `pi-hermes-memory` (`10.9K/mo`), `gentle-engram` (`10.1K/mo`), `@samfp/pi-memory` (`8.9K/mo`).
   - Why they are tempting: cross-session memory is useful for delegation and factories.
   - Why not default: this repo already has `@oh-my-pi/pi-mnemopi@15.10.12-lex`. Evaluate `pi-hermes-memory` specifically for secret scanning and procedural skills; do not add a second memory engine unless it replaces or cleanly layers over Mnemopi.

5. Observability/HUD packages: `@raindrop-ai/pi-agent` (`11.4K/mo`), `pi-powerline-footer` (`14.5K/mo`), `pi-hud` (recently published), `@tmustier/pi-session-hud` (recently published).
   - Why they are tempting: factory runs need observability.
   - Why not default: `pi-observer` already covers local live monitoring. Add external tracing (`@raindrop-ai/pi-agent`) only if remote trace export is required; add HUD packages only after confirming they do not duplicate `pi-observer`/status-line surfaces.

6. Sandboxing packages: `pi-agent-sandbox`, `pi-landstrip`.
   - Why they are tempting: stronger runtime isolation.
   - Why not default: registry listing marks them as recently published; add after the local factory safety hook and permission-system evaluation define the desired enforcement boundary.

### Strav integration rule

All registry integrations must preserve `herder-strav`/`cmux-strav` as the long-term orchestration framework. Add web, review, security, browser, memory, and diagnostic capabilities as tools or gates invoked by Strav-managed lanes. Only document direct `omp` entrypoints as the fallback when the workflow is launched without the `strav` CLI.

## Verification Sources

- Local inventory: read `package.json` for `packages/pi-observer`, `packages/antigravity-adapter`, `packages/pi-distill`, `packages/pi-omnidelegate`, `packages/pi-software-factory`, `packages/pi-actor-swarm`, `packages/pi-minimizer-gain`, and `packages/swarm-extension`.
- Active registration: read `.omp/settings.json` lines 2-12; it registers the seven target packages, `swarm-extension`, and profile-manager.
- Build/status classification: searched `docs/extensions-build-and-test.md`, which lists bundle outputs and classifies off-Lex safe, fragile, and blocked packages.
- Swarm distinction: read `packages/pi-actor-swarm/src/extension.ts`, `packages/pi-actor-swarm/src/mailbox.ts`, `packages/swarm-extension/src/extension.ts`, `packages/swarm-extension/src/swarm/schema.ts`, and `packages/swarm-extension/src/swarm/state.ts`.
- Registry baseline: read `https://pi.dev/packages`, which shows `1-50 / 3844`, Sort packages: Most downloads, package types, descriptions, and downloads/month on package cards.
- Missing-candidate check: exact package-name regex over `packages/*/package.json` returned no matches for the recommended missing registry packages.
- Strav constraint: local search found no in-repo references to `herder-strav`, `cmux-strav`, or `strav`; the Strav rule is recorded as a user-provided operating constraint rather than a repository-discovered fact.

## Assumptions/Operating Constraints

- High-value means registry downloads/month plus direct complementarity to `pi-software-factory`, `pi-omnidelegate`, `pi-actor-swarm`, or `pi-observer`.
- Registry popularity is volatile. Before installing a candidate, re-read `https://pi.dev/packages` and the candidate package page because versions/downloads may have changed.
- Third-party registry packages should remain external installs first. Vendoring into `packages/` is a fallback only when a compatibility patch is required and should then follow the Lex fork personal-extension export policy.
- If `pi-mcp-adapter` duplicates built-in MCP discovery, do not add it; use existing MCP support and document the registry package as redundant for this fork. Apply the same principle to `context-mode`: use the already-present runtime tooling instead of installing or vendoring a second copy.
- If a candidate conflicts with existing slash commands (`/swarm`, `/delegate`, `/todo`, `/ask`, or observer/HUD surfaces), keep the local Lex extension enabled and trial the registry package in an isolated profile before changing default settings.
- User-provided operating decision: `herder-strav`/`cmux-strav` is the long-term framework; `omp` is the entry point only when a workflow does not use the `strav` CLI. If later repository discovery finds dedicated Strav integration files, update this report to anchor recommendations to those files instead of generic extension settings.

## Integration verification checklist

Use this only when turning the report into actual extension installs:

1. Re-read the candidate's registry page and install exactly one candidate with the registry command, e.g. `pi install npm:pi-web-access`.
2. Start through the Strav path first when available; use a fresh `lex`/`omp` session only for fallback/OMP-entrypoint validation.
3. Confirm the candidate's documented command/tool appears.
4. Run the candidate's smallest documented behavior smoke: web search/fetch for web tools, a diagnostic pass for `pi-lens`, or a dry-run review for advisor/plannotator.
5. Only after that smoke passes, update Lex extension configuration or docs.
6. If any source package under `packages/` changes, finish with `./rebuild-lex.zsh` per the Lex fork rebuild contract.
