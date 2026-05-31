# Tier C — Progress Log

Last updated: 2026-05-28
Predecessors: PR #5 (Tier A) + PR #6 (Tier B) merged earlier same day

## Status table

| Group | SHAs | PR | State |
|-------|------|----|-------|
| **O** Obsidian/vault:// | `1709172bf` `509963bd6` | #7 | ✅ MERGED 2026-05-28T14:01Z |
| **V** Vertex Claude rawPredict | `3ea4981ee` `e8b510160` `ac7f6e4d1` | #8 | ✅ MERGED 2026-05-28T14:38Z |
| **K** EventLoopKeepalive | `6fb1983fb` `af2011f5a` `c1fa0e9f5` (squashed) | #9 | ✅ MERGED 2026-05-28 (timestamp in gh) |
| **I** Incomplete recovery | `5053a6a4d` | #10 | ✅ MERGED 2026-05-28 (timestamp in gh) |
| **H** Hashline rewrite + shim | `91d15b2ec` `7c6457652` `7fa55750f` `7dd00c015` (PR1 of N) | — | 🟡 executor running |
| **A** Auth-gateway strict + 429 | `6491fff8f` `b4238b10d` | — | 🟡 executor running |

## Workflow refinements that worked

1. **Discovery → architecture → executor → review** lane sequencing held — no group landed without all three gates passing
2. **Worktree per group** prevented cross-contamination (no `git stash` thrash, no branch-switch churn)
3. **Architect-escalation halt** (Group H — discovery underestimated `computeFileHash` consumer count) — agent stopped clean, architect re-decided shim approach
4. **Architecture revision in place** (Group H) — single architecture.md updated to reflect new shim plan, executor relaunched
5. **Agent SendMessage resume** worked for Group V (saved ~30K tokens of re-execution)
6. **caveman-investigator** for read-only discovery — ~60% smaller tool-result vs verbose investigation; main thread context preserved

## Workflow gaps surfaced

1. **Discovery under-scoped Group H by ~8 consumers** — `cavecrew-investigator` reported "only one substantive consumer (`diff.ts`)" when real surface was 6 prod + 2 tests + 1 benchmark. Discovery prompt should explicitly demand: "grep for ALL imports of every public hashline export, not just `applyEdits`".
2. **Discovery under-stated Group I conflict surface** — claimed "SINGLE-CHERRY-PICK" but cherry-pick hit 41 conflict markers on `agent-session.ts`. Manual surgical port was actually needed.
3. **Worktree-vs-repo path resolution** caused spurious test "regressions" in Group O verification (filterUserScoped) — pattern: capture true baseline ON SAME WORKTREE at parent commit before comparing.
4. **Stop-hook ENOTDIR/EISDIR errors** from harness probing `.git/config` (worktree pointer file) and `.omc/autopilot` (directory) — harmless noise but creates false retry prompts.

## Mergeable PRs after H + A land

If both succeed:
- Total Tier C PRs: 6 (O, V, K, I, H, A)
- Tier C followups: 6+ migration PRs from H shim path (read.ts, search.ts, ast-edit.ts, ast-grep.ts, file-mentions.ts, typescript-edit-benchmark/runner.ts, shim-removal cleanup)

## Cumulative upstream parity after Tier A+B+C lands

Original upstream delta v15.5.7..v15.5.9: 36 commits.
- Tier A (10 commits): clean cherry-picks
- Tier B (3 commits): selective manual ports
- Tier C (so far O+V+K+I = 9 commits squashed): architectural ports
- Tier C pending: H (4 commits squashed into 1 PR + N follow-ups) + A (2 commits)
- Tier C skipped permanently: `674d9b00a` codex web search (fork removed codex provider)

Total cumulative landed if H+A succeed: ~28 of 36 upstream commits (78% parity). Remaining 8 are formatting/CHANGELOG-only entries already covered.

## Pending decisions if H or A halts

- **H halt path**: shim signature mismatch with old anchor format → revert to dual-grammar bridge? Or define shim return as wrapped tag, force minor consumer migration in same PR?
- **A halt path**: `stream.ts` divergence on 429 path → land 6491fff8f alone, defer b4238b10d to follow-up?

## Next session goals if Tier C completes

1. Land H follow-up migration PRs (6 small mechanical edits — parallelizable)
2. Land H shim-removal PR (final cleanup)
3. Version bump 15.5.7 → 15.5.10 (or 15.6.0 if H is BREAKING for downstream consumers)
4. Update CHANGELOG with cumulative Tier A+B+C summary
