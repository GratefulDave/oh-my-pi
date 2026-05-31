# Tier C Group H — Hashline Rewrite Discovery Report

Generated: 2026-05-28
Owner: factory-discovery (cavecrew-investigator)
Read-only: yes (no code edits, no memory writes, no PRs)
Source: Tier C plan section 11 handoff prompt

## Goal

Enumerate every fork-specific hashline behavior that must survive the upstream rewrite, classify each against the 4 upstream SHAs, and surface architect decision points before any code edit.

## Upstream SHAs in scope

| SHA | Subject | Files | LOC Δ |
|-----|---------|-------|-------|
| `91d15b2ec` | `fix(hashline)!: removed single-number hunk header shorthand` | 8 | +89/-105 |
| `7c6457652` | `feat(hashline): replaced file-hash anchors with opaque snapshot-store tags` | 50 | +1761/-719 |
| `7fa55750f` | `feat(hashline): introduced explicit range syntax and repeat edit kind` | 22 | +606/-508 |
| `7dd00c015` | `feat: hashline improvements for spark` | 36 | +1048/-1834 |

Combined: ~116 files, ~+3500/-3166 LOC. Architectural rewrite, not a refactor.

## Fork commits (behavioral locks)

| SHA | Subject | Behavior locked |
|-----|---------|-----------------|
| `b1be46e4d` | `fix(hashline): added preflight write guards and duplicate target rejection` | Preflight validation per batch section; reject duplicate canonical paths (e.g. `a.ts` vs `./a.ts`) |
| `ffa71615d` | `fix(cherry-pick): resolve b12e4698a hashline package migration conflicts` | Package migration path resolution to `@oh-my-pi/hashline` subpath |
| `09222fcb1` | `chore(hashline): drop empty test script` | Test infrastructure cleanup (non-behavioral) |

Note: cavecrew-investigator surfaced 3 fork commits. The Tier C plan stated "20+ commits" based on prior session memory — that earlier figure likely counted ALL `git log --grep=hashline` matches across the repo, not just `packages/hashline` package-scoped. Real fork-specific commits to the *package* are 3.

## Fork-specific behaviors → upstream verdict

| Behavior | Lock test | Upstream verdict | Breaks at SHA |
|----------|-----------|------------------|---------------|
| Preflight write policy (`Filesystem.preflightWrite`) | `packages/coding-agent/test/core/hashline.test.ts:~92` | PRESERVED — abstract method survives rewrite | None |
| Duplicate canonical target rejection | `packages/coding-agent/test/core/hashline.test.ts:~92+` | PRESERVED — logic kept in `Patcher.applyPatch()` | None |
| `autoDropPureInsertDuplicates` option | `packages/hashline/src/apply.ts` (`detectReplaceOnBlankTarget`) | **BROKEN** — option removed by 7dd00c015 (-521 LOC of boundary-dup code) | `7dd00c015` |
| Single-number hunk header shorthand (`5:` instead of `5 5:`) | None found | BROKEN — explicit rejection added | `91d15b2ec` |
| 4-hex file-hash anchors (`#a1b2`) | `packages/coding-agent/src/edit/hashline/diff.ts:48` (`computeFileHash`) | BROKEN — replaced with 3-hex session-bound snapshot tags | `7c6457652` |
| `after_anchor` cursor kind (backward insert) | `packages/hashline/src/types.ts:17` (`Cursor` type) | BROKEN — removed from `Cursor` union; forward-only model | `7fa55750f` |
| Anchor-line grammar (`5 10:` for line range) | All fork hashline patches | BROKEN — replaced with `@@ A..B @@` unified-diff style hunks | `7dd00c015` |
| `^A-B` repeat operator | Not in fork (insert-only model) | CHANGED — upstream adds `&A..B` repeat syntax | `7fa55750f` |

## Fork consumers (call sites)

| File | Call sites | Functions called |
|------|-----------|------------------|
| `packages/coding-agent/src/edit/hashline/diff.ts` | 6 | `applyEdits`, `computeFileHash`, `Patch.parse`, `stripBom`, `normalizeToLF` |
| `packages/coding-agent/src/edit/renderer.ts` | 0 direct | `HL_FILE_PREFIX` (constant import only) |

Only one substantive consumer (`diff.ts`). All hashline parsing/application flows through there.

## Critical incompatibilities for architect

1. **Grammar replacement (BROKEN at `7dd00c015` + `91d15b2ec`)**: Every existing fork hashline patch with bare line numbers will fail parsing post-adoption. Anchors `5:` and `5 10:` no longer accepted; must become `@@ 5 @@` and `@@ 5..10 @@`.

2. **File-hash anchor model (BROKEN at `7c6457652`)**: Fork's 4-hex content-derived hash (`#a1b2`) for staleness detection replaced with 3-hex opaque tag bound to an `InMemorySnapshotStore` that becomes a mandatory `Patcher.applyPatch()` input. Global 4096-slot ring replaces per-path LRU.

3. **Cursor model (BROKEN at `7fa55750f`)**: `after_anchor` cursor kind removed. Any model output using backward inserts will break. `Cursor` union narrows.

4. **`autoDropPureInsertDuplicates` removal (BROKEN at `7dd00c015`)**: Fork's blank-target absorb logic disappears. Need to confirm fork's coding-agent prompt + model output doesn't rely on this absorb path.

5. **Preflight + duplicate rejection (PRESERVED)**: fork commit `b1be46e4d` survives — interface stable, but post-rewrite validation must be tested against the new snapshot-store model.

## Open architect questions (G-arch gate input)

1. **Adoption shape**: atomic 4-SHA port, or gradual bridge (dual-parser fork accepts both bare-line AND `@@` formats during a transition window)?
2. **Model-output retraining**: upstream's 91d15b2ec + 7dd00c015 update the coding-agent prompt (`packages/coding-agent/src/prompts/system/system-prompt.md`). Fork's locally-trained / locally-prompted Claude/Codex/Gemini surfaces all need prompt updates. Cost?
3. **Snapshot store lifecycle**: upstream's `InMemorySnapshotStore` is session-bound. Fork's session boundary differs (worktree / per-conversation). How are snapshots invalidated across re-entries?
4. **Migration coverage**: does `b1be46e4d`'s preflight test cover the new patcher with required snapshot-store argument?
5. **Bisect path**: do we land 4 SHAs in one PR (atomic) or 4 separate PRs (bisect-friendly but requires intermediate states to compile)? Upstream's intermediate states will compile because the parser/format are co-changed; partial port likely won't.

## Recommendation to architect

- **DO NOT** attempt to cherry-pick. Conflict on every hashline file.
- **PREFER** a structured replace: branch from `main`, delete `packages/hashline/src/*`, copy upstream tree at `v15.5.9`, then re-apply fork commits `b1be46e4d` + `ffa71615d` semantic changes on top, then update `packages/coding-agent/src/edit/hashline/diff.ts` to call the new API.
- **TEST**: fork's existing hashline tests must be re-authored against new grammar before any model output retraining.
- **RISK GATE**: requires a model-output validation step (run real coding-agent generations against the new parser; estimate % of model outputs that need bridge translation).

## Next gate

G-arch — architect chooses port strategy (atomic vs gradual bridge), test migration plan, and bisect granularity. Required artifact: `.omc/autopilot/tier-c/hashline/architecture.md`.

## Quality bar self-check

- [x] No code edited
- [x] No memory written
- [x] No PR opened
- [x] Evidence is repo-grounded (file:line, SHA, test path)
- [x] Open questions identified for architect (not pre-answered)
- [x] Risk + recommendation separated from facts
