# Tier C Group K — EventLoopKeepalive Architecture Proposal

Generated: 2026-05-28
Source: `.omc/autopilot/tier-c/keepalive/discovery.md` (verdict: PROCEED)
Status: AWAITING USER APPROVAL on E1-E6

## Recommended decisions (architect proposes)

| # | Question | Recommendation | Reasoning |
|---|----------|----------------|-----------|
| **E1** | Port shape | **Squash to final state** — single squashed commit mirroring `c1fa0e9f5` (final-state disposable EventLoopKeepalive), not the 3-commit chain (add → revert → re-add) | Intermediate commits (6fb1983fb add, af2011f5a revert) are noise. Final state is what fork needs. Single commit = bisect-friendly. |
| **E2** | EventLoopKeepalive class location | **`packages/agent/src/utils/yield.ts`** (new file in fork; per upstream) | Self-contained util; reusable across agent + coding-agent. |
| **E3** | Class implementation | **Verbatim upstream**: disposable with `using` declaration, `setInterval(() => {}, 86_400_000).unref()`, `[Symbol.dispose]()` clears interval | No fork-specific needs; upstream design is minimal and correct. |
| **E4** | Apply sites | **Three sites per upstream final state**: (1) `packages/agent/src/agent.ts` around line 846 (`Promise.withResolvers<void>()`) — wrap with `using _ = new EventLoopKeepalive()`; (2) `packages/coding-agent/src/main.ts` interactive entry around `getUserInput()`; (3) `packages/coding-agent/src/modes/interactive-mode.ts` around line 619 (returns the promise) | These are the 3 long-await sites discovery surfaced. Match upstream exactly. |
| **E5** | Test surface | **Add minimal regression test**: instrument idle CPU under `session.prompt()` to confirm <1% sustained idle | Discovery had no fork-CHANGELOG entry — no existing test. Add one to lock the fix. |
| **E6** | Branch + PR shape | Single branch `parity/upstream-keepalive` + single squashed PR | Smallest Tier C surface; quick land. |

## Branch + PR shape (per E6)

- Branch: `parity/upstream-keepalive` (worktree at `../lex-keepalive`)
- 1 commit: `fix(agent): disposable EventLoopKeepalive to prevent Bun busy-wait on idle prompt (squash of 6fb1983fb, af2011f5a, c1fa0e9f5)`
- Single PR titled `parity(upstream): EventLoopKeepalive busy-wait fix (15.5.8 group K)`

## Files touched (estimate)

| File | Lines |
|------|-------|
| `packages/agent/src/utils/yield.ts` | new file (~15 LOC; just the class + a re-export comment) |
| `packages/agent/src/agent.ts` | +3 (import + `using` declaration in prompt() body) |
| `packages/coding-agent/src/main.ts` | +2 (import + drop old wrapper if any) |
| `packages/coding-agent/src/modes/interactive-mode.ts` | +3 (import + `using` before return promise) |
| `packages/agent/test/idle-cpu.test.ts` | new file (~30 LOC regression test) |

Total: ~+53 LOC, 1 commit.

## Verification (G-verify)

```bash
git checkout main && git pull origin main
git worktree add ../lex-keepalive -b parity/upstream-keepalive
cd ../lex-keepalive && bun install
bun test packages/agent packages/coding-agent > /tmp/tierC-keepalive-baseline.out 2>&1
```

Per-package acceptance: fail count delta ≤ 0.

Optional integration smoke: run `omp` in interactive mode for 30s idle, sample CPU; pre-port should show busy-wait spike, post-port should sit at 0%.

## Security review (G-sec NOT required)

No credentials, no external surface. Code-reviewer sufficient.

## Risks

| Risk | Mitigation |
|------|-----------|
| `using` declaration requires TypeScript 5.2+ / Bun support | Bun 1.3.14 supports it; verify in build |
| Wrapping a different `await` than upstream targeted introduces hang | Match upstream call sites EXACTLY |
| Test for idle CPU is flaky on shared CI runners | Use coarse threshold (e.g. <5% over 5s); acceptable noise |

## Open questions (if user wants to override)

- E1 alternative: port all 3 upstream SHAs as separate commits for upstream-history mirroring (more noise, less bisect value)
- E4 alternative: only wrap `agent.ts` site, skip coding-agent sites until evidence of busy-wait there (smaller diff, potential under-fix)
- E5 alternative: skip regression test (faster, but no lock against future regressions)

## Status

- G-disc: ✅
- G-arch: ⏳ awaiting user approval on E1-E6
- G-impl onward: blocked
