# Tier C Group V — Vertex Claude rawPredict Architecture Proposal

Generated: 2026-05-28
Source: `.omc/autopilot/tier-c/vertex-claude/discovery.md`
Status: AWAITING USER APPROVAL on C1-C8

## Recommended decisions (architect proposes; user approves/overrides)

| # | Question | Recommendation | Reasoning |
|---|----------|----------------|-----------|
| **C1** | Port strategy | **Option A — Upstream fetch-wrapper architecture** | Discovery showed fork already imports `streamGoogleVertex` dispatch; rawPredict via fetch wrapper is incremental enhancement (~80 LOC), not a redesign. Provider-agnostic — stream.ts remains routing hub. |
| **C2** | rawPredict helpers | **Port verbatim from upstream stream.ts**: `isVertexAnthropicRawPredict`, `readVertexRequestBody`, `transformVertexAnthropicBody` (anthropic_version injection, model field strip) | Pure-function helpers; no fork-specific divergence to handle. |
| **C3** | Existing-helper renames | **Apply upstream renames**: `isGoogleVertexOpenAIModel` → `isGoogleVertexAuthenticatedModel`, `createVertexOpenAIFetch` → `createVertexAuthenticatedFetch`, `resolveVertexOpenAIRequest` → `resolveVertexRequest`. Broaden checks to cover BOTH openai-completions + anthropic-messages on Vertex. | Required by Option A. Names reflect actual scope (auth not openai-specific). |
| **C4** | URL placeholder support | **Add `%7B`/`%7D` URL-encoded placeholder handling** + `:streamRawPredict/v1/messages` → `:streamRawPredict` rewrite | Upstream caught a real bug — some clients URL-encode the braces. Catalog entries may use either form. |
| **C5** | Catalog refresh source | **Copy upstream `models.json` Vertex section verbatim** for v15.5.9 (drop Gemini 1.5 Vertex variants, add MaaS DeepSeek `deepseek-ai/deepseek-v3.2-maas` and any new Vertex Claude entries). Preserve fork-specific NON-Vertex catalog edits. | Discovery confirms fork has only Gemini entries (27 total); upstream refresh is additive on Claude side, removal-only on retired Gemini 1.5. |
| **C6** | Catalog refresh timing | **Same PR as routing fix** | Catalog entries reference rawPredict baseUrl; landing catalog first would expose un-routed entries. Lockstep. |
| **C7** | Provider-models/google.ts update | **Apply upstream delta**: `models.dev` catalog source replaces project-discovery; drop retired Gemini fallbacks. Skip `utils/discovery/vertex.ts` (DELETED upstream — fork never had it) | Cleaner discovery surface; no fork additions to preserve. |
| **C8** | Branch + PR shape | Single branch `parity/upstream-vertex-claude` + single PR. 3 commits inside (catalog refresh, rawPredict helpers, anthropic_version injection) mirroring upstream SHAs. Or single squashed commit if cherry-pick chain hits conflict. | Mirrors upstream history for bisect-friendliness. |

## Branch + PR shape (per C8)

- Branch: `parity/upstream-vertex-claude` (worktree at `../lex-vertex`)
- Commit 1: `3ea4981ee` analog (catalog refresh + provider-models/google.ts delta)
- Commit 2: `e8b510160` analog (rawPredict routing + renames + URL placeholder handling)
- Commit 3: `ac7f6e4d1` analog (anthropic_version body transform helpers)
- Each with `(cherry picked from commit <SHA>)` provenance trailer
- Single PR titled `parity(upstream): vertex claude rawPredict + catalog refresh (15.5.8/9 group V)`

## Files touched (estimate)

| File | Lines |
|------|-------|
| `packages/ai/src/stream.ts` | ~+80/-25 |
| `packages/ai/src/providers/google-vertex.ts` | ~+0/-5 (remove `resolvePublisher`) |
| `packages/ai/src/provider-models/google.ts` | ~+5/-5 |
| `packages/ai/src/models.json` | ~+500/-200 (catalog refresh) |
| `packages/ai/test/google-vertex-discovery.test.ts` | new file (port from upstream) ~+200 |
| `packages/ai/test/stream.test.ts` | ~+30 |

Total estimate: ~+815/-235 LOC.

## Verification (G-verify)

```bash
git checkout main && git pull origin main
git worktree add ../lex-vertex -b parity/upstream-vertex-claude
cd ../lex-vertex && bun install
bun test > /tmp/tierC-vertex-baseline.out 2>&1
```

Per-package acceptance: net fail delta ≤ 0 vs baseline.

Integration tests (after impl):
- Unit test: `transformVertexAnthropicBody` strips `model`, injects `anthropic_version: "vertex-2023-10-16"`
- Unit test: `resolveVertexRequest` rewrites both `{project}` and `%7Bproject%7D` placeholders
- Smoke test (requires GCP creds, optional): `omp` against `claude-opus-4-1@20250805` via Vertex endpoint returns valid response

## Security review (G-sec NOT required)

No credentials, no external mutation surface beyond normal provider routing. Code-reviewer sufficient.

## Risks

| Risk | Mitigation |
|------|-----------|
| Catalog refresh removes Gemini 1.5 entries fork users rely on | Add to migration notes in CHANGELOG; defaulting to Gemini 2.x is upstream-aligned and recommended |
| `transformVertexAnthropicBody` JSON.parse fails on streaming chunks | Upstream try/catch returns original body on parse failure (fail-open). Inherit. |
| New Vertex Claude entries advertise models without verified creds | Default catalog discovery only surfaces models the deployment has access to — upstream behavior. No change. |

## Open questions (if user wants to override)

- C1 alternative: Option B (fold rawPredict into `streamGoogleVertex` provider only)? Smaller diff (~50 LOC) but loses upstream-alignment + future-port debt.
- C5 alternative: defer catalog refresh as separate commit/PR (orthogonal to routing).
- C6 alternative: catalog-only PR first (low risk, builds confidence) → routing fix in follow-up PR.

## Status

- G-disc: ✅
- G-arch: ⏳ awaiting user approval on C1-C8
- G-impl onward: blocked
