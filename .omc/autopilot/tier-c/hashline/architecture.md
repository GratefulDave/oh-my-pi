# Tier C Group H — Hashline Rewrite Architecture (REVISED post-discovery-gap)

Generated: 2026-05-28 (revised after executor halt + scope re-discovery)
Source: `.omc/autopilot/tier-c/hashline/discovery.md` + executor escalation report
Status: REVISED architecture — user-approved best-practices: SHIM + adapt-to-shim

## Discovery gap (logged for librarian)

Original discovery claimed only `packages/coding-agent/src/edit/hashline/diff.ts` consumes `computeFileHash`. Executor halt revealed:

| File | `computeFileHash` sites |
|------|------------------------|
| `packages/coding-agent/src/edit/hashline/diff.ts` | 1 |
| `packages/coding-agent/src/tools/read.ts` | 1 |
| `packages/coding-agent/src/tools/search.ts` | 1 |
| `packages/coding-agent/src/tools/ast-edit.ts` | 1 |
| `packages/coding-agent/src/tools/ast-grep.ts` | 1 |
| `packages/coding-agent/src/utils/file-mentions.ts` | 1 |
| `packages/coding-agent/test/core/hashline.test.ts` | ~10 |
| `packages/coding-agent/test/edit-diff.test.ts` | 1 |
| `packages/typescript-edit-benchmark/src/runner.ts` | 1 |

Also: fork is closer to v15.5.9 than discovery framed. Upstream `assertUniqueCanonicalPaths` and `Filesystem.preflightWrite` already present — fork's `b1be46e4d` semantics largely upstream-covered. Only `HashlineFilesystem.preflightWrite` (plan-mode integration) survives outside `packages/hashline`.

## Revised decisions (locked)

| # | Question | Decision |
|---|----------|----------|
| **A1** | Port shape | **Two-PR sequence**: PR1 = hashline package replace + shim + diff.ts rewrite; PR2..N = per-consumer migration |
| **A2** | Replace strategy | Wholesale copy `packages/hashline` from v15.5.9 |
| **A3** | Fork commit preservation | Re-verify `b1be46e4d` against upstream `assertUniqueCanonicalPaths` + `Filesystem.preflightWrite`. **Only re-apply the plan-mode `HashlineFilesystem.preflightWrite` adapter** (outside `packages/hashline`). Other preflight + dup-target behavior already covered upstream. |
| **A4** | Consumer rewrite scope (**SHIM**) | **PR1 ships shim**: new `packages/hashline` exports deprecated `computeFileHash(text)` that internally calls `InMemorySnapshotStore.recordContiguous(...).fullText` to produce a tag. **Only `diff.ts` rewrites to new API in PR1.** Other 5 consumers + benchmark + tests stay on shim. |
| **A4b** | Consumer migration follow-ups | One PR per consumer file: `read.ts`, `search.ts`, `ast-edit.ts`, `ast-grep.ts`, `file-mentions.ts`, `typescript-edit-benchmark/runner.ts`. Each ~20-line mechanical edit. Bisect-friendly. |
| **A4c** | Shim removal | Final cleanup PR removes shim from `packages/hashline` after all consumers migrated |
| **A5** | Prompt update | Copy upstream system-prompt.md hashline grammar changes verbatim. Do NOT touch Group O `{{#if hasObsidian}}` block. |
| **A6** | Test corpus (**ADAPT-TO-SHIM**) | **PR1**: keep `packages/coding-agent/test/core/hashline.test.ts` as-is (uses shim). Copy upstream `packages/hashline/test/*` corpus verbatim alongside. **Cleanup PR**: re-author or delete `hashline.test.ts` when shim removed. |
| **A7** | PR1 branch | Single branch `parity/upstream-hashline-rewrite`, single PR for hashline package + shim + diff.ts + prompt + plan-mode adapter |
| **A8** | Snapshot store lifecycle | Upstream default (process-scoped `InMemorySnapshotStore`) |
| **A9** | Version bump | Defer to end of Tier C |
| **A10** | Compat flag | None at runtime; `computeFileHash` SHIM is type-deprecated but functional during migration |

## Why shim + adapt-to-shim (rationale)

- **Reviewable size**: PR1 stays bounded (hashline package + 1 consumer + 1 adapter file + 1 prompt update). Reviewer can hold all of it in head.
- **Bisect-friendly**: each consumer migration PR isolates one mechanical rewrite. If something breaks, revert one file.
- **Stability**: shim preserves old-API call sites; tests continue to assert old contract; no big-bang regression
- **Token efficiency**: 6 small executor invocations (one per consumer migration) beat one mega-executor doing all 8+ files
- **Parallelism**: consumer migrations can run in parallel worktrees once shim lands

## Execution outline — PR1 (this lane)

### Stage 1 — Pre-flight
```bash
cd /Users/davidandrews/PycharmProjects/lex-hashline
bun install
bun test packages/hashline > /tmp/tierC-hashline-baseline-pkg.out 2>&1
bun test packages/coding-agent > /tmp/tierC-hashline-baseline-ca.out 2>&1
```
Note baselines (already captured): coding-agent 312 pass / 378 fail (worktree-native-addon errors, NOT hashline). Acceptance: post-change coding-agent fail count ≤ 378.

### Stage 2 — Wholesale replace + shim
```bash
git rm -r packages/hashline
git checkout v15.5.9 -- packages/hashline
```
Then add the shim to `packages/hashline/src/index.ts`:
```typescript
/** @deprecated Use `SnapshotStore.recordContiguous(...).fullText` directly. Shim provided for migration. */
export function computeFileHash(text: string): string {
  const store = new InMemorySnapshotStore();
  const lines = text.split("\n");
  // recordContiguous returns a tag; shim returns the tag string for backwards compat.
  return store.recordContiguous("__shim__", 1, lines, { fullText: text });
}
```
Verify the shim's return type matches what existing callers expect (likely a short hex string usable as anchor tag). If existing call sites pass the hash into hashline anchors, the shim's return value MUST be acceptable to the new parser.

Commit: `feat(hashline)!: replaced hashline grammar with upstream v15.5.9 rewrite + computeFileHash shim`

### Stage 3 — Plan-mode adapter
Verify `packages/coding-agent/src/edit/hashline/filesystem.ts` (`HashlineFilesystem.preflightWrite`) still compiles against new `Filesystem` interface from upstream. Adjust signature if upstream changed it. Test that `enforcePlanModeWrite` integration survives.

Commit: `fix(hashline): retained HashlineFilesystem.preflightWrite plan-mode adapter`

### Stage 4 — diff.ts rewrite
Rewrite `packages/coding-agent/src/edit/hashline/diff.ts` 6 call sites to new API. Other consumers stay on shim.

Commit: `refactor(coding-agent/edit): rewrote hashline diff.ts to upstream v15.5.9 API`

### Stage 5 — Prompt update
Copy upstream hashline grammar examples from `system-prompt.md` (`91d15b2ec` + `7dd00c015`). Do not touch vault section.

Commit: `docs(prompts): updated hashline grammar examples to @@ A..B @@ format`

### Stage 6 — Verification
```bash
bun test packages/hashline       # upstream tests (verbatim) must all pass
bun test packages/coding-agent   # fail count ≤ baseline (378)
bun run check:ts                 # same Biome errors as baseline
```

### Stage 7 — Push + PR
PR title: `parity(upstream): hashline rewrite + shim (15.5.8 group H, PR 1 of N)`
Body explains shim + migration roadmap.

## Follow-up PRs (post-PR1 merge)

Each is its own worktree + branch + PR:
- `parity/hashline-migration-read-ts`
- `parity/hashline-migration-search-ts`
- `parity/hashline-migration-ast-edit`
- `parity/hashline-migration-ast-grep`
- `parity/hashline-migration-file-mentions`
- `parity/hashline-migration-typescript-edit-benchmark`
- `parity/hashline-shim-removal` (final; deletes shim, deletes `hashline.test.ts`, all consumers must have migrated)

Each migration PR: ~20-line edit + per-file regression test pass. Can run in parallel after PR1 lands.

## Handoff to executor (PR1)

Lane: implementation
Owner: executor (opus — architectural rewrite + careful shim design)
Input: this revised architecture.md + discovery.md + executor escalation findings
Branch: `parity/upstream-hashline-rewrite` (worktree at `../lex-hashline`)
Allowed actions: stages 1-7 above
Forbidden actions: rewrite consumers beyond diff.ts; skip shim; skip prompt update; touch vault block in system-prompt.md
Approval gate: G-impl per stage; G-verify (acceptance: coding-agent fail count ≤ 378); G-rev (code-reviewer); G-deslop; G-reverify; G-pr
Required output: PR URL + per-stage commit log + verification deltas
Escalation: any deviation requires user approval first

## Status

- G-disc: ✅ (discovery.md + executor halt report)
- G-arch: ✅ (this revised doc, user-approved best-practice)
- G-impl onward: ready for executor handoff with revised scope
