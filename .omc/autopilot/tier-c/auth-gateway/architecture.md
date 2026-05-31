# Tier C Group A — Auth-Gateway Architecture Proposal

Generated: 2026-05-28
Source: `.omc/autopilot/tier-c/auth-gateway/discovery.md`
Status: AWAITING USER APPROVAL on B1-B10

## Recommended decisions (architect proposes; user approves/overrides)

| # | Question | Recommendation | Reasoning |
|---|----------|----------------|-----------|
| **B1** | Port shape | **Sequential SHA-by-SHA in same branch** (`6491fff8f` first, then `b4238b10d`) | They interact; 6491fff8f's `CompletionProbe` types unblock b4238b10d's expanded refreshGatewayApiKeyAfterAuthError signature. Single PR but bisect-friendly. |
| **B2** | CLI surface for `--strict` | **Match upstream verbatim**: `omp auth-gateway check --strict` + `--json` flag, output adds `[strict]` text-mode marker + top-level `strict: true` JSON field | Fork lacks the `check` subcommand entirely; copying upstream surface keeps tooling consistency with upstream docs/UX. |
| **B3** | CompletionProbe implementation | **Plumb through, no built-in probe shipped** — caller (CLI) supplies a probe fn that hits each provider's cheapest bundled chat model with 15s timeout + 4-fallthrough on "model not found" | Upstream design treats `CompletionProbe` as injectable; built-in would tie auth-storage to provider catalog. Match upstream. |
| **B4** | `checkCredentials` method | **Add method** matching upstream signature: `checkCredentials(options?: CheckCredentialsOptions): Promise<CredentialHealthResult[]>`. Refresh-on-expiry runs FIRST, then usage probe, then optional completion probe | Required by 6491fff8f. Fork has no equivalent; cannot half-port. |
| **B5** | Refresh-on-expiry lifecycle | **Move refresh upfront** in checkCredentials per upstream design. Rows without `UsageProvider` still get completion probe; refresh failure skips completion probe (sets `completion: {ok: null, reason: "refresh_failed"}`) | Avoids stale-bearer false-positives where usage endpoint 200s but chat endpoint 401s. |
| **B6** | `classifyGatewayError` extension | **Reuse pi-utils `isUsageLimitError`** from upstream's central heuristic. Add 429 branch for `usage_limit_reached` / `resource_exhausted` / Codex `Try again in ~X min` phrasing | Fork's current regex-only classifier misses Codex/Anthropic/Google usage_limit verbiage. Centralize. |
| **B7** | `refreshGatewayApiKeyAfterAuthError` signature change | **Add `sessionId` parameter** (3rd position after model) per upstream. Split callback into 429 vs 401 branches. 429 → `markUsageLimitReached(provider, sessionId, {retryAfterMs, baseUrl, signal})`. 401 → existing `invalidateCredentialMatching` path | Required for session stickiness. |
| **B8** | `streamSimple` onAuthError sessionId | **Thread `sessionId` from `prompt_cache_key` (or hash of model+system+tools+first-message)** through to `getApiKey(provider, sessionId, …)`. Same identity used for credential-stickiness AND prefix-cache routing | Fork passes `undefined` — round-robins back to blocked credentials. Match upstream. |
| **B9** | `extractRetryHint` parsing | **Extend** to accept Codex `Try again in ~N min/minutes/mins/h/hr/hour/hours` in addition to existing `ms/s/sec`. Allow leading `~` + embedded whitespace | Required for accurate retryAfterMs on Codex sub-plan usage limits. |
| **B10** | `markUsageLimitReached` semantics verification | **Audit fork's existing impl** at `auth-storage.ts:2161` before porting b4238b10d. If signature mismatches upstream (`provider, sessionId, {retryAfterMs, baseUrl, signal}`), align it FIRST as preparatory commit. | Risk: usage-limit loop if rotation re-picks blocked credential. Verify before relying on it. |

## Branch + PR shape (per B1)

- Branch: `parity/upstream-auth-gateway-rotation` (worktree at `../lex-auth`)
- Commit 1 (prep): align `markUsageLimitReached` signature if needed (per B10 audit)
- Commit 2: port 6491fff8f (CompletionProbe types + checkCredentials lifecycle + --strict CLI)
- Commit 3: port b4238b10d (429 classification + sessionId stickiness + extractRetryHint expansion)
- Single PR titled `parity(upstream): auth-gateway strict + 429 rotation (15.5.8 group A)`

## Files touched (estimate)

| File | Lines |
|------|-------|
| `packages/ai/src/auth-storage.ts` | ~+250/-30 |
| `packages/ai/src/auth-gateway/server.ts` | ~+80/-20 |
| `packages/ai/src/stream.ts` | ~+40/-15 |
| `packages/coding-agent/src/sdk.ts` | ~+30/-10 |
| `packages/coding-agent/src/cli/auth-gateway-cli.ts` | ~+50/-5 |
| `packages/coding-agent/src/commands/auth-gateway.ts` | ~+150/-20 (new `check` subcommand) |
| `packages/utils/src/fetch-retry.ts` | ~+15/-3 |
| New tests | ~+800 |

Total estimate: ~+1400/-100 LOC, ~700 LOC new tests.

## Verification (G-verify)

```bash
git checkout main && git pull origin main
git worktree add ../lex-auth -b parity/upstream-auth-gateway-rotation
cd ../lex-auth && bun install
bun test > /tmp/tierC-auth-baseline.out 2>&1
```

Per-package acceptance: net fail delta ≤ 0 vs baseline.

Integration tests (after impl):
- Mock provider returning `usage_limit_reached` → expects classifyGatewayError → 429 → markUsageLimitReached (NOT invalidate)
- Same sessionId retries → gets DIFFERENT credential (sibling rotation)
- `omp auth-gateway check --strict` against bundled providers → reports `[chat: ok|FAIL|skip]` per credential

## Security review (G-sec REQUIRED)

Auth + credential rotation = high-value target. Security-reviewer focus:
- Credential leakage in error paths
- Replay attack via sessionId reuse
- Race conditions between refresh-on-expiry and concurrent probes
- `CompletionProbe` timeout enforcement (15s default; no infinite wait)

## Risks

| Risk | Mitigation |
|------|-----------|
| `markUsageLimitReached` signature mismatch causes silent no-op | B10 audit before port |
| Strict-mode probe hits real chat endpoints → cost + rate-limit risk on probe itself | Probe uses cheapest bundled chat model + 15s timeout + opt-in flag (`--strict`); default OFF |
| sessionId stickiness misroutes after long idle (session expired upstream) | Fall through to round-robin on stickiness miss (upstream behavior) |

## Open questions (if user wants to override)

- B2 alternative: ship as separate command (`omp auth-doctor`) instead of `auth-gateway check`?
- B3 alternative: ship built-in probe for top 5 providers (avoids caller plumbing)?
- B10 alternative: skip audit, accept potential signature drift risk?

## Status

- G-disc: ✅
- G-arch: ⏳ awaiting user approval on B1-B10
- G-impl onward: blocked
