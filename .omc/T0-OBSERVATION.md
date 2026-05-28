# T0 Observation — Chain handling mode (Phase 0 of minimizer-filter-remediation)

## Evidence
- `crates/pi-shell/src/minimizer/engine.rs:90-104` `apply()` (whole-buffer FFI entry point) returns `passthrough(captured).labeled("compound")` for `CommandPlan::Chain`.
- `crates/pi-shell/src/shell.rs:627-714` shows that `SegmentedChain` mode IS executed, but only from `Shell::run` / `execute_shell` (per-segment invocations).
- The JS bash-executor uses `applyShellMinimizer` at `packages/coding-agent/src/exec/bash-executor.ts:8,480`, which lands in `pi-natives/src/shell.rs::apply_shell_minimizer` (whole-buffer only, never invokes the segmented runner).
- `plan.rs::analyze` already correctly returns `Chain { segments }` for `git A && git B`-style commands (proven by `safe_and_chain_is_segmented` test at plan.rs:324).

## Conclusion
**Mode α** — the FFI call from JS never invokes the segmented runner. `git A && git B && git C` chains are correctly classified as `Chain` by `plan::analyze`, but `engine::apply` deliberately returns passthrough for them on the whole-buffer path. Fixing this would require an FFI extension (e.g. exposing the segmented runner to JS, or running each segment through Shell.run independently).

## Decision
Phase 4 (T2b chain decomposer) is **DEFERRED**. No code change in Phase 4 — recorded as deferred FFI work in the final commit body.
