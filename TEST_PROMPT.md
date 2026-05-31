Test and fix Pi agent observability across BOTH execution modes.

Critical repo navigation rule:
- Do not pass space-joined paths as one path.
- Tool paths must be separate array entries.
- Before reading any path, discover it with `find` or a directory `read`.
- Do not assume `packages/coding-agent/src/ui` or `packages/coding-agent/src/app` exist.

Known likely roots:
- `packages/coding-agent/src/modes`
- `packages/coding-agent/src/modes/components`
- `packages/coding-agent/src/tools`
- `packages/coding-agent/src/task`
- `packages/coding-agent/src/async`
- `packages/coding-agent/src/extensibility`
- `docs`

Goal:
- Native Pi task/background agents must appear as observer cards.
- Visible pane/window agents must spawn through the cmux/pi-subagents path, not acpx.
- Both modes must share the same observer card surface: status, label, progress, run metadata, artifacts, pane/window metadata when present.

Hard constraints:
- Do not use acpx.
- Do not use `/delegate`.
- Use native Pi task agents for implementation/review work.
- Use cmux/pi-subagents only for the visible-pane test lane.
- If visible panes do not open, diagnose and fix the real cause: extension loading, config namespace, event bridge, command env, or backend spawn path.
- Do not fake pane metadata without a real pane/window spawn.

Observer auto-open requirement:
- When native task agents or async jobs start, automatically open/show the session observer surface.
- Do not require the user to press the observer shortcut to verify cards.
- If current product cannot auto-open observer on background activity, implement that behavior behind a safe setting/default suitable for this test, or document the exact missing hook and stop as failed.
- The test fails if task/job cards exist internally but no observer surface appears automatically.
- Do not continue to the cmux visible-pane lane if embedded native task/async job cards do not auto-open.

Test matrix:

1. Native task subagents
   - Spawn at least 3 parallel native task agents.
   - Confirm observer cards appear while running.
   - Confirm cards update completed/failed status.
   - Confirm Enter expands transcript/details.

2. Async jobs
   - Start one async bash job and one async task job.
   - Confirm both appear as observer cards.
   - Confirm progress updates.
   - Confirm completion/error state is visible.
   - Confirm `job list`, `job poll`, and observer card state agree.

3. Visible pane/window agents
   - Spawn at least one cmux/pi-subagents visible pane/window agent.
   - Confirm real pane/window opens.
   - Confirm observer card appears for that same run.
   - Confirm card includes presentation metadata: mode pane/window, backend cmux, session/pane id if available.
   - Confirm completion/failure updates card.

4. Mouse/card interaction
   - Verify observer cards can be expanded by keyboard Enter.
   - Verify mouse click on a card expands/selects it.
   - If mouse click is unsupported, implement it or document exactly why TUI input layer cannot support it yet.
   - Do not claim click works without testing.

5. Docs
   - Update docs after code is green.
   - Explain difference between embedded observer cards and visible pane/window agents.
   - Explain how to monitor cards, expand cards, and use `job` controls.

Verification:
- Add/adjust focused tests for observer registry/card metadata.
- Add/adjust focused tests for async job card updates.
- Add/adjust focused tests for click/keyboard expansion if supported by component test surface.
- Run focused tests.
- Run `bun run check:types` in `packages/coding-agent`.
- Run Biome check on touched files.
- Rebuild Lex if source/prompt changes require it.

Final answer:
- Say whether native cards worked.
- Say whether async job cards worked.
- Say whether visible panes opened.
- Say whether click-to-expand works.
- List exact verification commands and results.
