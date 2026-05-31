# Tier C Group O — Obsidian + vault:// Architecture Proposal

Generated: 2026-05-28
Source: `.omc/autopilot/tier-c/vault/discovery.md`
Status: AWAITING USER APPROVAL on D1-D9

## Recommended decisions (architect proposes; user approves/overrides)

| # | Question | Recommendation | Reasoning |
|---|----------|----------------|-----------|
| **D1** | Port shape | **Single atomic PR** combining both SHAs (`1709172bf` + `509963bd6`). | The two are co-changes — `509963bd6` adds `vault.enabled` gate on top of the obsidian integration. Splitting would mean an intermediate "feature-on-no-gate" landing. |
| **D2** | Replace strategy | **Hybrid: 2 verbatim copies + 8 manual merges per discovery table** | Discovery confirms fork architecture matches; security-critical files port byte-identical, the rest are 1-7 line additions. |
| **D3** | Default `vault.enabled` value | **`false`** (matches upstream) | Security-cautious default. Vault path is a powerful read+write surface; opt-in only. Users enable via Settings → Tools → "Obsidian Vault". |
| **D4** | Security functions port mode | **VERBATIM, no fork edits**: `resolveVaultUrlToPath`, `isVaultEnabled`, `hasObsidian` | Security boundary code. Any fork "improvement" risks regression on traversal/symlink defenses. Test suite locks behavior. |
| **D5** | Settings schema integration | **Add `vault.enabled` to fork's "Tools → Obsidian Vault" section** of `settings-schema.ts`, matching upstream pattern (boolean, default false, tab `"tools"`) | One-line addition; conflict-low because fork's schema is structurally identical. |
| **D6** | System-prompt template integration | **Inject `hasObsidian()` boolean into Handlebars context** in `system-prompt.ts` (+2 lines); add upstream's `{{#if hasObsidian}}...vault://...{{/if}}` block to `prompts/system/system-prompt.md` verbatim | Gated visibility — users without Obsidian see nothing about vault://. |
| **D7** | Plan-mode-guard integration | **Verify fork's `resolveRawPath` already routes through `InternalUrlRouter`** (likely yes per discovery). If yes, no explicit vault code needed in plan-mode-guard. If no, add `resolveVaultUrlToPath` call site per upstream pattern | Implicit routing is cleaner; only add explicit handling if needed. |
| **D8** | `INTERNAL_SCHEMES_WITH_SELECTORS` | **Add `vault: true` constant entry in `path-utils.ts`** | Enables `vault://...:line-range` selectors. Required for read tool support. |
| **D9** | Branch + PR shape | Single branch `parity/upstream-obsidian-vault` + single PR titled `parity(upstream): obsidian + vault:// (15.5.8 group O)` | Matches D1 atomic decision. |

## Branch + PR shape (per D9)

- Branch: `parity/upstream-obsidian-vault` (worktree at `../lex-vault`)
- Commit 1: copy verbatim files (`vault-protocol.ts`, `vault-protocol.test.ts`) + router register + index.ts export
- Commit 2: settings-schema + system-prompt + read.md + path-utils + plan-mode-guard manual merges
- Commit 3: `509963bd6` gating delta (vault.enabled guard + CLI error parsing + active-vault caching tests)
- Single PR

## Files touched

**New (verbatim from upstream)**:
- `packages/coding-agent/src/internal-urls/vault-protocol.ts` — 859 LOC
- `packages/coding-agent/test/internal-urls/vault-protocol.test.ts` — 417 LOC

**Modified (manual merge per discovery table)**:
- `packages/coding-agent/src/internal-urls/router.ts` — +1 line (register handler)
- `packages/coding-agent/src/internal-urls/index.ts` — +1 line (re-export)
- `packages/coding-agent/src/config/settings-schema.ts` — +11 lines (vault.enabled)
- `packages/coding-agent/src/system-prompt.ts` — +2 lines (hasObsidian context)
- `packages/coding-agent/src/prompts/system/system-prompt.md` — +3 lines (gated docs)
- `packages/coding-agent/src/prompts/tools/read.md` — +4 lines (vault:// selectors)
- `packages/coding-agent/src/tools/path-utils.ts` — +2 lines (vault scheme)
- `packages/coding-agent/src/tools/plan-mode-guard.ts` — 0 or +7 lines per D7 audit

Total estimate: ~+1300/-0 LOC.

## Verification (G-verify)

```bash
git checkout main && git pull origin main
git worktree add ../lex-vault -b parity/upstream-obsidian-vault
cd ../lex-vault && bun install
bun test > /tmp/tierC-vault-baseline.out 2>&1
```

Per-package acceptance: net fail delta ≤ 0 vs baseline.

Integration tests:
- `vault.enabled = false` (default): vault:// URLs return error, system-prompt does NOT mention vault://
- `vault.enabled = true` + no Obsidian binary: vault:// returns error mentioning installation
- `vault.enabled = true` + Obsidian present: vault:// resolves; read tool accepts `vault://Vault Name/file.md:10-20`
- Traversal denial: `vault://Vault/../../../etc/passwd` rejected
- Symlink escape denial: symlink inside vault pointing outside vault root → resolve rejects

## Security review (G-sec REQUIRED)

Vault protocol = file-read + file-write surface beyond cwd. Security-reviewer focus:
- Path traversal (verified by upstream tests; re-verify in fork context)
- Symlink escape (`fs.lstat` + `realpath` validation in `ensureWithinRoot`)
- TOCTOU between resolve and write
- Vault root validation (no `vault://AbsoluteVault/...` accepted; must be CLI-listed vault name)
- Obsidian binary detection (`hasObsidian`) cannot be tricked into running attacker-supplied binary

## Risks

| Risk | Mitigation |
|------|-----------|
| Obsidian binary not on PATH on user's machine | `hasObsidian()` returns false → vault:// gated off; user sees clear error |
| `vault.enabled = true` but vault not configured in Obsidian | Active-vault cache returns null → error message points to Obsidian setup |
| Settings UI doesn't yet show "Tools" tab | Verify fork's settings UI surfaces the tab (likely yes; tabs are conventional) |
| New file overlaps with Group H test reorganization | Discovery confirms NO overlap. Run in parallel safe. |

## Open questions (if user wants to override)

- D3 alternative: default `vault.enabled = true` (less friction; security looser)?
- D5 alternative: ship vault.enabled under different tab (`"experimental"`)?
- D6 alternative: skip gating in system-prompt → vault:// docs always visible (confusing for non-Obsidian users)
- D7 alternative: explicit plan-mode-guard call regardless of router routing (more defensive)
- Block on Group H (avoid concurrent system-prompt edits) instead of parallel?

## Status

- G-disc: ✅
- G-arch: ⏳ awaiting user approval on D1-D9
- G-impl onward: blocked
