# Group H — Follow-Up Migration PRs

Generated: 2026-05-28
Predecessor: Group H PR1 (hashline rewrite + `computeFileHash` shim)
Status: BLOCKED on Group H PR1 merge

## Migration roadmap

Each follow-up = single-file rewrite of `computeFileHash(text)` call site to direct `SnapshotStore.recordContiguous(...)` call. After all 6 land, run cleanup PR to delete shim.

| # | Branch | File | Sites | Owner |
|---|--------|------|-------|-------|
| 1 | `parity/hashline-migration-read-ts` | `packages/coding-agent/src/tools/read.ts` | 1 | executor (haiku) |
| 2 | `parity/hashline-migration-search-ts` | `packages/coding-agent/src/tools/search.ts` | 1 | executor (haiku) |
| 3 | `parity/hashline-migration-ast-edit` | `packages/coding-agent/src/tools/ast-edit.ts` | 1 | executor (haiku) |
| 4 | `parity/hashline-migration-ast-grep` | `packages/coding-agent/src/tools/ast-grep.ts` | 1 | executor (haiku) |
| 5 | `parity/hashline-migration-file-mentions` | `packages/coding-agent/src/utils/file-mentions.ts` | 1 | executor (haiku) |
| 6 | `parity/hashline-migration-benchmark` | `packages/typescript-edit-benchmark/src/runner.ts` | 1 | executor (haiku) |
| 7 | `parity/hashline-shim-removal` | shim + test re-author | — | executor (sonnet) — blocks on 1-6 |

## Per-migration template

```bash
git checkout main && git pull origin main
git worktree add ../lex-hl-<name> -b parity/hashline-migration-<name>
cd ../lex-hl-<name>
bun install
```

### Edit pattern

Before (shim path):
```typescript
import { computeFileHash } from "@oh-my-pi/hashline";
const fileHash = computeFileHash(text);
// ... use fileHash as anchor tag
```

After (direct snapshot store):
```typescript
import { InMemorySnapshotStore } from "@oh-my-pi/hashline";
// reuse existing session-scoped store if available via getFileSnapshotStore(session)
const store = getFileSnapshotStore(session) ?? new InMemorySnapshotStore();
const lines = text.split("\n");
const tag = store.recordContiguous(absolutePath, 1, lines, { fullText: text });
// ... use tag as anchor
```

### Per-migration acceptance

- File compiles with no new TS errors
- Touched-package test suite passes (touched module's test file specifically)
- No new biome lint warnings on touched lines

### Commit per migration

```
refactor(coding-agent): migrated <file basename> off computeFileHash shim

Direct call to SnapshotStore.recordContiguous. Part N of 6 in hashline shim removal.

Refs Group H PR1.
```

## Parallel execution plan

All 6 migrations are independent (different files, different call sites). Can run in 6 parallel worktrees + 6 executor agents at sonnet/haiku.

Cost: 6 small executor invocations ≈ same token cost as 1 large one but better bisect granularity + parallelizable wall time.

## Shim removal PR (#7 in sequence)

Blocked on migrations 1-6 all merged. Then:

1. Delete shim export from `packages/hashline/src/index.ts`
2. Re-author `packages/coding-agent/test/core/hashline.test.ts` against new snapshot-store API (~10 sites, 957 LOC)
3. Run full `bun test` on touched packages
4. Verify no remaining call sites: `grep -rn computeFileHash packages/` returns 0
5. Commit: `refactor(hashline): removed computeFileHash shim after all consumers migrated`
6. Open PR titled `parity(upstream): hashline shim removal + test re-author (15.5.8 group H PR 7/7)`

## Risk register

| Risk | Mitigation |
|------|-----------|
| Per-file rewrite reveals an extra call site discovery missed | Each executor scopes to ONE file + tests; if extra surface found, halt + add new migration PR |
| Shim signature subtle bug surfaces only on Nth migration | Tests on each migration catch; halt that migration; fix shim or escalate |
| `getFileSnapshotStore(session)` doesn't exist for non-session contexts | Use ephemeral `new InMemorySnapshotStore()` for those sites |
| Test re-author (PR7) takes longer than expected | Acceptable — final cleanup PR is non-blocking on user workflow once shim is gone |

## Status

- All blocked on Group H PR1 merge
- After PR1 merges, schedule migration PRs 1-6 in any order (parallel possible)
- Final cleanup PR last
