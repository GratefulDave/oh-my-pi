# Tier C Group I — Incomplete Stop Recovery Discovery Report

## Goal
Determine whether upstream commit 5053a6a4d (fix: incomplete stop recovery logic) can land as a single cherry-pick now that Group O ported vault files, or requires surgical split.

## Upstream SHA in scope
**5053a6a4d** — `fix(coding-agent): corrected coding-agent incomplete stop recovery logic`
- Commit date: 2026-05-28 10:09:34 +0200
- Files touched: 10 (229 insertions, 39 deletions)

## Touched files — fork presence map (post O merge)

| File | Status | LOC delta | Category |
|------|--------|-----------|----------|
| packages/coding-agent/src/extensibility/custom-tools/types.ts | ✓ Present | +1 | Recovery type discriminator |
| packages/coding-agent/src/extensibility/shared-events.ts | ✓ Present | +1 | Recovery type discriminator |
| packages/coding-agent/src/internal-urls/index.ts | ✓ Present | -1 | Vault export reorder |
| packages/coding-agent/src/internal-urls/router.ts | ✓ Present | -1 | Vault import reorder |
| packages/coding-agent/src/internal-urls/vault-protocol.ts | ✓ Present | +50 | Vault formatting only |
| packages/coding-agent/src/modes/controllers/event-controller.ts | ✓ Present | +8 | Recovery reason text UI |
| packages/coding-agent/src/session/agent-session.ts | ✓ Present | +86 | Core recovery logic |
| packages/coding-agent/src/prompts/system/system-prompt.md | ✓ Present | +2 | Vault docs (ellipsis only) |
| packages/coding-agent/test/agent-session-context-promotion.test.ts | ✓ Present | +102 | New test cases |
| packages/coding-agent/test/internal-urls/vault-protocol.test.ts | ✓ Present | +5 | Test type annotation |

**All 10 files present in fork main post-Group O merge.**

## Fork stop-recovery state

**Current fork `#checkCompaction()` in agent-session.ts:**
- Handles 3 cases: overflow + promotion, overflow + no promotion, threshold
- **No "incomplete" (stopReason === "length") case yet**
- Type discriminators in shared-events.ts: `reason: "threshold" | "overflow" | "idle"` (no "incomplete")
- Custom-tools event type: `trigger: "threshold" | "overflow" | "idle"` (no "incomplete")
- Event-controller UI: renders text for overflow/idle only, missing incomplete branch
- `#runAutoCompaction()` signature: `(reason: "overflow" | "threshold" | "idle", ...)` (no "incomplete" parameter)

**Gap:** Fork lacks the entire "output-side incomplete (stopReason === 'length')" recovery path that upstream introduces.

## Fork discriminator types

**shared-events.ts AutoCompactionStartEvent:**
```
reason: "threshold" | "overflow" | "idle"  ← no "incomplete"
```

**custom-tools/types.ts CustomToolSessionEvent trigger:**
```
trigger: "threshold" | "overflow" | "idle"  ← no "incomplete"
```

**Upstream adds "incomplete" to both.** Fork enumeration narrowing will work correctly after cherry-pick; no collision risk.

## Fork handoff code

**Current fork #runAutoCompaction() decision logic:**
- `allowDefer` + handoff strategy + `reason !== "overflow"` → schedule deferred
- `reason !== "overflow"` → allows handoff action; otherwise forces context-full

**Upstream change:** Treats "incomplete" like "overflow" for deferred scheduling (forces inline), but allows handoff action (unlike overflow which forces context-full).

**Critical:** Fork currently allows `reason !== "overflow"` to use handoff. Upstream adds explicit `reason !== "incomplete"` guard, treating incomplete as non-deferrably inline BUT allowing handoff action. This is a logical change—handoff CAN work on output-incomplete (context is fine), unlike input-overflow (context is broken).

## Fork-side divergence since v15.5.7

**Stop-recovery logic paths:** No fork commits since v15.5.7 have modified the `#checkCompaction()` or `#runAutoCompaction()` logic that 5053a6a4d touches. Clean state.

**Vault-protocol.ts:** Fork main already has clean vault-protocol export order. Group O merge appears to have resolved vault-related imports correctly.

## Critical incompatibilities for architect

| Item | Finding | Risk |
|------|---------|------|
| File presence | All 10 files present post-Group O | ✓ None |
| Type discriminators | Clean addition of "incomplete"; no collisions | ✓ None |
| Recovery logic paths | Fork has 0 incomplete handling; upstream adds full path | ✓ Clean addition |
| Vault formatting hunks | Upstream reformats vault-protocol.ts (50 LOC); fork main already has clean state | ✓ Low (formatting only) |
| Deferred compaction guards | Upstream adds `reason !== "incomplete"` guard; fork doesn't have this yet | ✓ Clean addition |
| Handoff action logic | Upstream: incomplete allows handoff (output is fine); overflow forces context-full (input is broken). Fork doesn't have this distinction yet. | ✓ Clean addition |

## Recommendation: SINGLE-CHERRY-PICK vs SPLIT

**VERDICT: SINGLE-CHERRY-PICK ✓**

### Rationale:
1. **All 10 files are present in fork main** (confirmed post-Group O merge).
2. **Zero fork divergence on touched lines** — stop-recovery paths are clean; no prior commits modified `#checkCompaction()` or `#runAutoCompaction()` logic.
3. **Vault changes are minimal and orthogonal:**
   - Export/import reorder: Already correct in fork main (no change needed).
   - Formatting/type annotations: Pure style, applies cleanly.
4. **Type discriminators are additive** — "incomplete" is a new enum value, no collisions.
5. **Recovery logic is entirely new** — fork has no incomplete branch to conflict with upstream's new case.
6. **Test additions are clean** — fork test file exists; new test cases apply without merge conflict.

### Implementation path:
```bash
git cherry-pick 5053a6a4d
```

### Post-pick verification:
- Run fork test suite (especially agent-session-context-promotion.test.ts)
- Verify no lint errors in vault-protocol.ts formatting
- Confirm both "incomplete" enum values appear in both type definitions

## Next gate

- **Architect approval** of single cherry-pick + recovery logic semantics
- **Executor:** Cherry-pick 5053a6a4d onto fork main (parity/upstream-15.5.9-tierA or equivalent branch)
- **QA:** Run coding-agent test suite; confirm no regressions on overflow/threshold paths; validate incomplete recovery fires on `stopReason === "length"`
- **Merge:** Land as-is (no surgical split needed)

---
**Report generated:** 2026-05-28  
**Analyzer:** cavecrew-investigator (Tier C Group I probe)
