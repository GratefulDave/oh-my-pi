# Bugfix Plan — Minimizer Gain Recording / `/gain` Output

**Status:** pending approval
**Date:** 2026-05-27
**Branch:** upstream-v15.4-parity
**Scope:** `packages/coding-agent` — minimizer gain recording, aggregation, and `/gain` slash + `omp gain` CLI surfaces.

---

## 1. Requirements Summary

User reports that token and byte savings from the bash command minimizer are not being correctly recorded or displayed via the `/gain` slash command and `omp gain` CLI. Verify the full pipeline end-to-end across five focus areas (recording, aggregation, command output, `--days` handling, `kind` consistency) and fix any defects found.

Working-tree state (already staged-ish, uncommitted) shows partial work has begun:

- `packages/coding-agent/src/slash-commands/builtin-registry.ts` — `/gain` now parses `--all`, `--days N`, `-d N`, `--discover`, `--missed` (previously rejected/silently ignored).
- `packages/coding-agent/test/acp-builtins.test.ts` — added 3 ACP tests covering `--all`, `--discover`, `--days 7`.
- `packages/coding-agent/CHANGELOG.md` — entry for the slash-command argument fix.

This plan covers the **remaining diagnosis + verification work** plus any extra fixes uncovered.

## 2. Trace Findings (per bug report item)

### 2.1 Recording logic — `bash-executor.ts`
Reference: `packages/coding-agent/src/exec/bash-executor.ts:301-365`.

- Line 302: gate is `minimized && minimized.text !== minimized.originalText`. Confirmed correct.
- Line 325: `savedBytes = Math.max(0, minimized.inputBytes - minimized.outputBytes)`.
- Lines 339-352: `recordMinimizerGain` invoked with `inputBytes`, `outputBytes`, `savedBytes`, conditional `savedTokens`, `exitCode`, `kind`.
- Line 348: `savedTokens = Math.max(0, countTokens(originalText) - countTokens(text))` — only set when `savedBytes > 0`.
- Line 351: `kind: savedBytes > 0 ? "saved" : "missed"`.

**Potential defect (S1, low likelihood):** if the native minimizer rewrites text (`text !== originalText`) but reports `inputBytes <= outputBytes` (e.g., normalization that adds bytes), the record is written as `kind: "missed"` even though a real minimization occurred. The user would see the artifact link in the visible output but the record would be excluded from savings sums by `isSavingsRecord` (`minimizer-gain.ts:260`). Need to confirm whether this code path is hit in practice — instrument a unit/integration test.

**Potential defect (S2):** the `kind` field is recorded but `savedTokens` is omitted when `savedBytes === 0`. That is intentional, but combined with S1 it means a "real" rewrite with zero/negative byte gain produces a missed record with no token gain captured. Acceptable, but document.

### 2.2 Aggregation — `minimizer-gain.ts`
Reference: `packages/coding-agent/src/minimizer-gain.ts:207-227, 256-262, 456-463`.

- `summarizeMinimizerGain` filters via `isSavingsRecord` → `isSavedRecord(record) && record.savedBytes > 0`.
- `isSavedRecord`: `kind === undefined || kind === "saved"` — legacy records (no `kind`) treated as saved.
- `addRecord` line 461: `estimatedTokensSaved += record.savedTokens ?? Math.floor(record.savedBytes / 4)` — token estimate when `savedTokens` absent.
- `usesEstimatedTokensSaved` flips to `true` if ANY record in the summary lacked `savedTokens`. UI then prefixes label with "Estimated".

**Aggregation reads correct.** No defect found here.

### 2.3 Command output — `/gain` slash + `runGainCommand`
- `/gain` ACP path: `builtin-registry.ts:545-548` → `buildGainSlashReport(runtime.cwd, parsed)` → `loadMinimizerGainContext({cwd, all, days})`. Correct.
- `/gain` TUI path: `builtin-registry.ts:549-554` → `showGainOverlay(runtime, parsed.all ? 1 : 0)`. Overlay calls `loadMinimizerGainContext` twice (current + all). **Defect (S3):** TUI overlay path **ignores `parsed.days`** — `loadMinimizerGainContext` is invoked without `days`, so `--days N` in the TUI silently defaults to 30. Fix below.
- `omp gain` CLI: `gain-cli.ts:80-93` → `readMinimizerGain({sinceDays: cmd.days, cwd})`. Correct.

### 2.4 `--days` parameter handling
- CLI: `gain-cli.ts:47, 80-82` passes `cmd.days` straight through; validated as positive integer at line 50.
- Slash ACP: `parseGainSlashArgs` correctly parses `--days N` / `-d N` (two-token form), passes through to `loadMinimizerGainContext`.
- Slash TUI: parses but does not pass to overlay (see S3).
- `readMinimizerGain` → `resolveCutoff` (line 400) uses `Date.now() - sinceDays * DAY_MS`. Correct.

### 2.5 `kind` consistency in `bash-executor.ts`
- Saved path (text changed, savedBytes > 0) → `kind: "saved"` ✓
- Pseudo-missed path (text changed, savedBytes === 0) → `kind: "missed"` (see S1).
- Missed paths (text unchanged, or minimizer disabled, or cancelled/timed-out) all route through `buildMinimizerMissedRecord` which hard-codes `kind: "missed"` ✓.
- `dumpCancelledOutput` (lines 423-454) replicates the `kind: savedBytes > 0 ? "saved" : "missed"` rule. Same S1 risk applies.

**No correctness bug in the `kind` assignment** beyond the S1 edge case.

## 3. Defects Confirmed

| ID  | Severity | Location                                                 | Description                                                                                                |
| --- | -------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| S3  | High     | `builtin-registry.ts:295, 305-308` (`showGainOverlay`)   | TUI overlay ignores `--days`; passes only `{cwd, all}` to `loadMinimizerGainContext`. `--days N` no-op in TUI. |
| S1  | Low      | `bash-executor.ts:351, 453`                              | Text-rewriting minimization with `inputBytes <= outputBytes` is logged `missed` and excluded from savings. Edge case; needs evidence before patching. |
| S2  | Info     | `bash-executor.ts:347-349`                               | `savedTokens` omitted when `savedBytes === 0` — by design but should be documented in comment or test. |

## 4. Acceptance Criteria

- [ ] `showGainOverlay` accepts and forwards `--days N` to both `loadMinimizerGainContext` calls (current + all). Reload callback also honors the same `days`.
- [ ] `/gain --days 7` in TUI mode produces overlay with 7-day window (verified via unit test on overlay-loader factory or integration test on `loadMinimizerGainContext` call signature).
- [ ] Slash `/gain --days N` ACP path continues to filter correctly (existing test `renders gain --days 7 report filtering to recent records` still passes).
- [ ] `omp gain --days N` CLI path still filters correctly (covered by `minimizer-gain.test.ts`).
- [ ] Add unit test asserting `bash-executor` records `kind: "saved"` when minimizer reduces bytes, and `kind: "missed"` when it does not — or at least an isolated test on the `kind` selection helper if extracted.
- [ ] Add unit test for S1 edge case: simulate `MinimizerResult` with `text !== originalText` but `inputBytes === outputBytes`; assert recorded `kind` and document expected behavior. Decision point: either (a) keep current "missed" classification (document) or (b) classify as "saved" with zero `savedBytes` (changes summary semantics).
- [ ] All existing tests in `packages/coding-agent/test/minimizer-gain.test.ts` and `acp-builtins.test.ts` pass.
- [ ] `npm run build` and `npm run lint` green for `packages/coding-agent`.

## 5. Implementation Steps

1. **Fix S3 (TUI `--days` propagation)** in `packages/coding-agent/src/slash-commands/builtin-registry.ts`:
   - Change `showGainOverlay(runtime, initialScope)` signature to accept `days?: number`.
   - Pass `days` into both `loadMinimizerGainContext({cwd, all, days})` calls (current + all).
   - Pass `days` into the overlay's reload factory closure.
   - Update caller at the `gain` `handleTui` entry to pass `parsed.days`.

2. **Confirm S1 behavior** (no code change yet):
   - Write a focused unit test that constructs a fake `MinimizerResult` (or call `applyShellMinimizer` with crafted input) where `text !== originalText` and `inputBytes <= outputBytes`. Capture the resulting record via `recordMinimizerGain` against a temp `agentDir`.
   - If the test confirms the edge case is reachable in practice → escalate decision to user via follow-up. If it cannot be reproduced → close as informational.

3. **Documentation tightening** (`minimizer-gain.ts`):
   - Add a one-line comment near `isSavingsRecord` (~`minimizer-gain.ts:260`) clarifying that records with `kind: "saved"` but `savedBytes === 0` are intentionally excluded from totals (only the historical `kind: undefined` legacy path benefits from this gate).

4. **Test additions** in `packages/coding-agent/test/minimizer-gain.test.ts`:
   - `recordMinimizerGain` with `kind: "saved"` and `savedBytes: 0` is **excluded** from `summarizeMinimizerGain`.
   - `recordMinimizerGain` with `kind: undefined` and `savedBytes > 0` is **included** (legacy path).
   - `loadMinimizerGainContext` honors `days` filter at the boundary (already partly covered; add one more explicit assertion).

5. **Test addition** in `packages/coding-agent/test/acp-builtins.test.ts` (or a TUI-targeted spec if available):
   - Assert that the `gain` TUI handler builds an overlay context with the requested `days` value. Implementation hint: spy on `loadMinimizerGainContext` or refactor `showGainOverlay` to expose its context loader via DI for testability. If DI is too invasive, settle for an ACP-layer regression test confirming `parseGainSlashArgs` returns `days` correctly (already exists implicitly).

6. **CHANGELOG entry** (append to the existing unreleased "Fixed" block in `packages/coding-agent/CHANGELOG.md`):
   - "Fixed `/gain` TUI overlay ignoring `--days N`; now matches the ACP/CLI behaviour."

## 6. Verification Steps

```
npm --workspace packages/coding-agent run lint
npm --workspace packages/coding-agent test -- --testPathPattern "minimizer-gain|acp-builtins"
npm --workspace packages/coding-agent run build
```

Manual smoke (post-build, with a populated `~/.local/share/oh-my-pi/minimizer-gain.jsonl`):

- `omp gain --days 7` — confirm scope label, Saved Bytes, Estimated/Tokens Saved.
- `omp gain --days 7 --discover` — confirm top commands.
- `omp gain --days 7 --missed` — confirm missed list.
- Inside TUI: `/gain --days 7` — confirm overlay header reflects 7d window.
- Inside TUI: `/gain --all --days 7` — confirm both scope tabs filtered to 7d.

## 7. Risks & Mitigations

- **R1: Refactoring `showGainOverlay` to thread `days` may interact with the existing overlay rerender contract.** Mitigation: pass `days` through closure; do not change the overlay component's public API.
- **R2: S1 edge case might be unreachable in real shells, so test may be flaky / brittle to mock.** Mitigation: keep the test isolated to `recordMinimizerGain` boundary (do not invoke real `applyShellMinimizer`) and gate it behind a clear "documents current behavior" describe block.
- **R3: Modifying `isSavingsRecord` to count `kind: "saved"` with `savedBytes === 0` would silently change historical aggregates.** Mitigation: do NOT change semantics in this plan; document instead. Escalate if user wants different behavior.
- **R4: Tests touching `recordMinimizerGain` must isolate `agentDir` to avoid polluting the user's real gain log.** Mitigation: continue using `withTempAgentDir` pattern already established in `minimizer-gain.test.ts`.

## 8. Out of Scope

- Native minimizer (`@oh-my-pi/pi-natives`) byte/token reporting accuracy — treat its outputs as truth.
- UI rendering of the overlay component beyond the scope-tab plumbing.
- `omp gain --json` schema changes.
- Cross-cwd realpath behaviour beyond the existing test coverage.

## 9. Follow-ups

- If S1 edge case is reproducible: open a separate ticket to decide between "missed" classification (current) vs. "saved with 0 bytes" classification. Requires product call.
- Consider extracting the `kind` decision (`savedBytes > 0 ? "saved" : "missed"`) into a small helper in `minimizer-gain.ts` so both `bash-executor` recording sites share one definition.

---

**Awaiting explicit approval.** On approval, target execution path:
- `oh-my-claudecode:ralph` for sequential implementation with verification (recommended — single-file edits, small surface area), OR
- direct executor pass since the change list is short.
