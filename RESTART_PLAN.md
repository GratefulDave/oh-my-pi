# Restart Plan — Unified Background Agents

## Current state

- Branch: `feature/unified-background-agents`
- Last commit: `ec7a47a0a Add structured background agent run metadata`
- Base: `main` at merged PR #40 `21edf0dd9 Merge pull request #40 from GratefulDave/fix/opencode-antigravity-oauth`
- Tracked worktree: clean after commit.
- Untracked local config/cache dirs remain; do not stage unless explicitly requested.

## Correct agent/model policy for restart

Use Gemini 3.5 Flash directly for cheap/planning/read-only workers:

- Preferred selector: `opencode-antigravity/gemini-3.5-flash:medium`
- Legacy alias now supported by committed work: `AG-gemini-3.5-flash:medium`
- Avoid `pi/smol` until config/role failure diagnostics are finished, because previous task fanout failed at `pi/smol -> AG-gemini-3.5-flash:medium` with `Google API error (404): Requested entity was not found` before the alias fix was committed.

When spawning task agents, pass explicit agent model override if the tool/runtime supports it, or use worker assignments that explicitly say the intended model is Gemini 3.5 Flash and avoid `explore` if it still hardcodes `pi/smol` in the current runtime.

## Completed slice

### Slice 1 — Core run metadata + structured handoff artifacts

Committed in `ec7a47a0a`.

Implemented:

- `AgentRunPresentation`, `AgentRunArtifactRef`, `AgentRunMetadata`, `AgentRunManifest` types.
- `AsyncJob.runMetadata` and register option plumbing.
- `job.list`/`job.poll` details include `runMetadata` without changing text rendering.
- `SessionObserverRegistry` stores `runMetadata` from task lifecycle/progress events.
- `runSubprocess` emits structured `<id>.manifest.json` beside existing `<id>.md` output when artifacts dir exists.
- Async task jobs attach initial metadata and copy final metadata back into progress/job state.
- Legacy AG selector compatibility added in model resolver so `AG-gemini-3.5-flash:medium` can resolve to `opencode-antigravity/gemini-3.5-flash`.

Verified before commit:

- `bun test packages/coding-agent/test/async-job-manager.test.ts packages/coding-agent/test/task/executor-warnings.test.ts packages/coding-agent/test/model-resolver.test.ts` → 87 pass.
- `bun run check:types` from `packages/coding-agent` → pass.
- `bunx biome check` on touched files → pass.
- `git diff --check` → pass.

Known unrelated full-check issue:

- Full `check:ts` still fails on pre-existing formatting/import issues outside touched files:
  - `packages/antigravity-adapter/src/auth-adapter.ts`
  - `packages/antigravity-adapter/src/stream-adapter.ts`
  - `packages/coding-agent/src/config/model-registry.ts`
  - `packages/coding-agent/src/session/agent-session.ts`
  - existing unrelated tests.

## Remaining work

### Slice 2 — cmux/tmux visible pane attachments

Goal: visible panes/windows are presentation attached to core run/job state, not separate orchestration.

Critical files:

- `packages/coding-agent/src/external-agents/types.ts`
- `packages/coding-agent/src/external-agents/runner.ts`
- `packages/coding-agent/src/slash-commands/builtin-registry.ts`
- `packages/coding-agent/src/modes/components/external-orchestration-monitor.ts`
- tests near external agent runner / slash command behavior
- `docs/adrs/external-agent-orchestration.md`

Required behavior:

- External agent result includes `AgentRunMetadata` or equivalent compatible run metadata.
- `tmux` backend records session name in `presentation`.
- `cmux` backend records pane/window identity if available; if cmux CLI cannot return id, record session/command and mark capture as terminal-only.
- Multi-provider cmux delegate must allocate distinct tracked presentations per provider; do not send all providers into one ambiguous split.
- `acpx` remains structured/captured backend.
- Terminal backends must not pretend to capture assistant text if they are fire-and-forget.

Verification:

- Unit tests with mocked command runner for tmux/cmux result metadata.
- Test that multiple cmux providers produce separate metadata entries.
- `bun run check:types` in `packages/coding-agent`.

Suggested agent split:

1. `VisibleRunnerAgent` — `runner.ts` + `types.ts` only.
2. `VisibleCommandUiAgent` — `builtin-registry.ts` + `external-orchestration-monitor.ts` only.
3. `VisibleDocsTestsAgent` — docs + tests only.

Use Gemini 3.5 Flash for docs/tests/review. Use stronger model only for runner/API design if needed.

### Slice 3 — Plugin bridge for `@gotgenes/pi-subagents`

Goal: plugin-launched subagents appear in native Lex observer as read-only sessions/cards.

Critical files:

- `packages/coding-agent/src/modes/session-observer-registry.ts`
- `packages/coding-agent/src/extensibility/extensions/types.ts` only if event metadata typing needs extension
- optional new bridge module under `packages/coding-agent/src/extensibility/extensions/` or `packages/coding-agent/src/task/`
- docs for plugin compatibility

Evidence from installed plugin:

- `/Users/davidandrews/.lex/plugins/node_modules/@gotgenes/pi-subagents/src/index.ts`
- plugin emits `subagents:started`, `subagents:completed`, `subagents:failed`, `subagents:compacted`, and persists `subagents:record`.
- plugin sends `subagent-notification` messages with output file/transcript path.

Required behavior:

- Subscribe to stable `subagents:*` event bus events.
- Convert events into `ObservableSession` entries with `kind: "subagent"` and plugin source metadata.
- Include transcript/output file as artifact refs where available.
- Observer-only first: no cancel/control unless plugin exposes stable public API.
- Do not import plugin internals.

Verification:

- Synthetic EventBus tests: emit `subagents:started/completed/failed`; assert observer session state/artifacts.
- Existing core task observer tests must still pass.
- `bun run check:types` in `packages/coding-agent`.

Suggested agent split:

1. `PluginBridgeCoreAgent` — registry/bridge implementation.
2. `PluginBridgeTestsAgent` — synthetic event tests.
3. `PluginBridgeDocsAgent` — docs only.

Use Gemini 3.5 Flash for all three unless type design gets tricky.

### Slice 4 — Host command contract docs/runtime

Goal: document and start standardizing away from legacy hardcoded `pi` spawns.

Critical files:

- `docs/extension-loading.md`
- `docs/environment-variables.md`
- `packages/coding-agent/src/extensibility/plugins/legacy-pi-compat.ts` only if adding comments/runtime env injection
- cmux runner code if env is injected there

Required behavior/documentation:

- Current workaround: user shell can pass/alias `lex -> pi` from `~/.zshrc`.
- Mark workaround as migration debt.
- Future contract:
  - generic: `PI_AGENT_COMMAND=lex`
  - backend override: `PI_CMUX_AGENT_COMMAND=lex`
  - backend override wins if both set.
- Lex should set these env vars for child processes it launches where feasible.
- Legacy packages should read host-command env instead of spawning `pi` directly.

Verification:

- Docs check/touched-file biome check.
- If runtime env injection added, unit test command env construction.

Suggested agent split:

1. `HostCommandDocsAgent` — docs only.
2. `HostCommandRuntimeAgent` — runtime env injection only if chosen.

Use Gemini 3.5 Flash.

### Slice 5 — Smol/model 404 diagnostics and fallback

Goal: no silent task fanout failure when role selector resolves to missing provider entity.

Critical files:

- `packages/coding-agent/src/config/model-resolver.ts`
- `packages/coding-agent/src/task/index.ts`
- `packages/coding-agent/src/task/executor.ts`
- `packages/coding-agent/test/model-resolver.test.ts`
- relevant task/executor tests

Current status:

- Commit already adds legacy AG selector resolution tests and support.
- Remaining work: better runtime diagnostics/fallback when provider still returns 404 at generation time.

Recommended behavior:

- For `pi/smol`/agent-role failures, error message must include:
  - role/selector requested (`pi/smol`, `AG-gemini-3.5-flash:medium`, etc.)
  - resolved provider/model (`opencode-antigravity/gemini-3.5-flash`)
  - provider error (`Google API error (404): Requested entity was not found.`)
- Fallback policy:
  - default: diagnostic only for normal implementation agents.
  - allow fallback for read-only planning/explore agents to parent/default model, but mark metadata: `runtimeFallbackUsed: true`, `fallbackFrom`, `fallbackTo`.
- Do not silently route around model config.

Verification:

- Model resolver tests for AG aliases.
- Executor/session tests for surfaced selector/provider diagnostics.
- If fallback implemented, tests prove metadata records fallback.

Suggested agent split:

1. `ModelDiagnosticAgent` — error metadata/diagnostic surfacing.
2. `ModelFallbackAgent` — optional fallback behavior for read-only planning agents.
3. `ModelTestsAgent` — tests.

Use Gemini 3.5 Flash for tests/diagnostics. Use stronger model only if session fallback path is hard.

### Slice 6 — Bounded three-level orchestration policy

Goal: explicitly support expensive orchestrator -> workers -> cheap scouts/reviewers, max depth 2.

Critical files:

- `packages/coding-agent/src/config/settings-schema.ts` only if adding preset/docs text
- `docs/task-agent-discovery.md`
- agent docs / built-in agent frontmatter if needed

Current behavior:

- `task.maxRecursionDepth` defaults to `2`.
- At max depth, child task tool is removed.

Required work:

- Document recommended model hierarchy:
  - root: expensive orchestrator
  - L1: worker/planner/reviewer agents
  - L2: cheap Gemini 3.5 Flash scouts/reviewers
  - no L3+
- Prefer explicit `spawns` allowlists over `*`.
- L2 agents should return structured handoff manifests.

Verification:

- Existing recursion-depth tests or new focused test if behavior not already covered.
- Docs touched-file format check.

Suggested agent split:

1. `DepthPolicyDocsAgent` — docs only.
2. `DepthPolicyTestsAgent` — only if missing coverage.

Use Gemini 3.5 Flash.

## PR #40 review

Do not review PR #40 again. User explicitly said not to review the last PR again.

Keep PR #40 only as background context:

- Last merged PR: `#40 Fix opencode-antigravity OAuth fallback`
- Merge commit: `21edf0dd9`
- Slice 5 should build on current branch state and committed alias support, not reopen PR review.

## Execution instructions for restarted session

1. Start on branch `feature/unified-background-agents`.
2. Do not reimplement Slice 1; it is committed.
3. First action: verify branch/status.
4. Use explicit Gemini 3.5 Flash capable agents; avoid hardcoded `explore` if it still routes through `pi/smol` in that session.
5. Run slices in order unless user reprioritizes:
   1. cmux/tmux visible pane attachments.
   2. plugin bridge.
   3. host command contract.
   4. smol/model 404 diagnostics/fallback.
   5. bounded depth docs/policy.
6. After each slice:
   - run focused tests
   - run `bun run check:types` in `packages/coding-agent` when coding-agent touched
   - run touched-file Biome check
   - commit focused slice if green.
7. Do not stage untracked local config/cache dirs.
