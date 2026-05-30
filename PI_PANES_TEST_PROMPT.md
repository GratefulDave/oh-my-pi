# Agent Cards Observer Test Prompt

Use this prompt in rebuilt Lex to test and, if needed, implement unified card observability for native task agents, background agents, async jobs, and plugin-style subagents. This is not a visible pane/window spawning prompt.

```text
Investigate and fix agent observability in `packages/coding-agent` so native task agents, background agents, async jobs, and plugin-style subagents are all viewable through the same card-based monitoring surface.

Hard requirements:
- You MUST use native `task` subagents in parallel for investigation and implementation.
- Do NOT use /delegate, acpx, tmux, or cmux.
- Main agent MUST delegate multi-file edits; do not do all implementation yourself.
- After implementation, update affected docs to match final user-visible behavior and architecture.
- Verify every changed behavior with focused tests and package-scoped checks.

Target behavior:
- Background agents should be viewable the same way as subagents.
- Async jobs and native task subagents should surface as embedded cards in the same observer/status UI by default.
- Plugin/background agents that emit stable lifecycle events should also surface as cards in same observer/status UI.
- Visible terminal panes/windows require a separate pane/window backend or plugin; native task cards must not spawn tmux/cmux panes or windows when those backends are forbidden.
- Cards should converge on one user model:
  - label/title
  - active/completed/failed/aborted status
  - progress if available
  - run metadata
  - transcript/artifact links if available
  - visible-pane/window presentation metadata only when a backend/plugin reports it
  - task-job progress correlated by async job id and `runMetadata.runId`, not original task item id
- Read-only vs controllable agents may differ in controls, but not in visibility model.

Implementation expectations:
- Audit current flows for:
  1. native task subagent lifecycle/progress
  2. async job registration/progress/completion delivery
  3. session observer / card UI surfaces
  4. plugin `subagents:*` bridge path
  5. external visible-pane/window run metadata reported by pane/window-capable integrations
- Then implement whatever is missing so tasks/async jobs/background agents all update same card-based observer surface.
- If current architecture splits these concepts, unify on shared observable session/run metadata instead of parallel UI state.
- Do not spawn visible panes/windows in the native task path; represent terminal-only or pane-backed output honestly in metadata/cards.

Verification requirements:
- Add or update focused tests proving:
  - native task subagents appear in card/observer state
  - async jobs update same observable/card state
  - plugin/background subagents update same observable/card state when lifecycle events arrive
  - completion/failure/progress transitions are reflected consistently
- Run focused `bun test` for changed areas.
- Run `bun run check:types` in `packages/coding-agent`.
- Run biome on touched files.

Documentation requirements:
- After code and tests are green, update any affected docs so they match final behavior.
- At minimum, update docs covering session/subagent observation, async jobs, plugin/background subagents, and visible run metadata if those behaviors changed.
- Keep docs repo-grounded; do not describe behavior that is not implemented and verified.

Final response format:
- subagents used
- files changed
- tests/checks run
- whether unified card behavior now covers:
  - task subagents
  - background agents
  - async jobs
  - plugin subagents
- unresolved gaps only
```
