# Tier C Group A — Auth-Gateway Strict + 429 Rotation Discovery Report

Generated: 2026-05-28
Owner: cavecrew-investigator
Read-only: yes (no code edits, no memory writes, no PRs)

## Goal

Enumerate every fork-specific auth-gateway behavior that must survive upstream SHAs `6491fff8f` (strict mode + completion-probe) and `b4238b10d` (429 usage-limit rotation), classify each against the upstream changes, and surface architect decision points before any code port.

## Upstream SHAs in scope

| SHA | Subject | Files | Δ LOC |
|-----|---------|-------|-------|
| `6491fff8f` | `feat(ai): added strict auth-gateway mode with completion-probe checks` | 5 | +585/-42 |
| `b4238b10d` | `fix: resolved auth-gateway handling of 429 usage-limit responses` | 9 | +376/-42 |

Combined: 11 files touched, ~961 LOC added. New public types, CLI flag, OAuth refresh flow changes.

## Fork commits (behavioral locks)

| SHA | Subject | Behavior locked |
|-----|---------|-----------------|
| `562bbb58a` | `fix(ai): resolved auth-gateway classification by status-code precedence` | 429/rate_limit_error classification logic |
| `032a09030` | `feat: added auth-gateway usage cache with single-flight 15s ttl` | Session-level usage caching to avoid re-fetch storm |
| `7ab5bc2b7` | `feat(auth): added auth-gateway forward-proxy and broker usage/migration` | Broker integration surface; `sessionId` passthrough |
| `c29e17c3e` | `feat(auth): added auth-broker for remote credential vault` | OAuth refresh indirection via broker |
| `d9fee354a` | `feat(ai): added auth-broker snapshot contract with generation checks` | Snapshot versioning + credential staleness detection |
| `677894663` | `feat(ai): added pi-native auth-gateway transport` | Pi-native format handler + sessionId derivation |
| `3cba2081e` | `fix(ai): addressed stream auth retries by replaying start events` | Mid-stream auth failure recovery (pre-emit only) |
| `2ed0f7bb7` | `fix(ai): corrected stream auth to refresh once and retry pre-start 401` | OAuth refresh-once + pre-start 401 retry semantics |

8 fork commits since v15.5.7 lock auth surface behavior.

## Fork-specific behaviors → upstream verdict

| Behavior | Lock evidence | Upstream verdict | Impact |
|----------|---------------|------------------|--------|
| **CompletionProbe** (end-to-end bearer check) | NOT PRESENT in fork | ADDED by 6491fff8f — new optional arg `checkCredentials(options?.completionProbe?)` | MISSING: fork has no `CompletionProbe` type, no `CredentialCompletionResult` type |
| **CheckCredentialsOptions.completionProbe** | NOT PRESENT | ADDED by 6491fff8f — caller supplies optional prober fn | MISSING: fork's `checkCredentials` signature unchanged |
| **CredentialHealthResult.completion** field | NOT PRESENT | ADDED by 6491fff8f — result includes `completion?: CredentialCompletionResult` | MISSING: fork's health result lacks completion datum |
| **--strict CLI flag** | NOT PRESENT in fork's CLI | ADDED by 6491fff8f — propagates to `checkCredentials(completionProbe?)` | MISSING: fork's `AuthGatewayCommandArgs.flags` has no `strict` field |
| **`checkCredentials` method** | NOT PRESENT in fork | ADDED by 6491fff8f in `AuthStorage` | MISSING: no fork method that calls completion-probe |
| **markUsageLimitReached()** | PRESENT at line 2161 `packages/ai/src/auth-storage.ts` | EXTENDED by b4238b10d — adds `sessionId` parameter for sticky credential tracking | PARTIALLY ALIGNED: fork has method, but signature may differ on sessionId semantics |
| **classifyGatewayError() usage-limit branch** | MISSING — uses only rate_limit regex | EXTENDED by b4238b10d — adds `isUsageLimitError(message)` check + 429 classification | BROKEN: fork's classifier won't catch Codex/Anthropic/Google usage_limit phrasing |
| **extractRetryHint** parsing | PRESENT at line 29 `packages/utils/src/fetch-retry.ts` | EXTENDED by b4238b10d — now parses `~`, `sec`, `ms`, minute/hour units from usage-limit messages | PARTIALLY ALIGNED: fork has extractor but may lack full unit suite |
| **refreshGatewayApiKeyAfterAuthError** hook | PRESENT (line 266 in fork's auth-gateway/server.ts) | CHANGED by b4238b10d — adds `sessionId` param, splits 429 vs 401 handling branches, calls `markUsageLimitReached` for 429 | DIVERGED: fork's hook signature & logic differ |
| **streamSimple onAuthError callback** | PRESENT | EXTENDED by b4238b10d — upstream pass `sessionId` to hook; calls `getApiKey(provider, sessionId, …)` for sticky replay | DIVERGED: fork calls `getApiKey(provider, undefined, …)` (no session stickiness) |
| **Session derivation (deriveSessionId)** | PRESENT in fork (line ~415 in auth-gateway/server.ts) | USED by b4238b10d — drives `getApiKey(provider, sessionId, …)` lookups for credential stickiness | PRESENT: fork has `deriveSessionId(modelId, context)` |
| **OAuth refresh-on-expiry in checkCredentials** | NOT DIRECTLY TESTED | CHANGED by 6491fff8f — refresh happens BEFORE completion-probe, result lands on health result | MISSING: fork has no pre-check refresh lifecycle |

## Fork consumers (call sites)

| File | Refs | Functions/types |
|------|------|-----------------|
| `packages/ai/src/auth-gateway/server.ts` | 40+ | `classifyGatewayError`, `refreshGatewayApiKeyAfterAuthError`, `streamSimple`, `getApiKey` |
| `packages/coding-agent/src/sdk.ts` | 15+ | `AuthStorage`, `getApiKey`, `markUsageLimitReached`, stream auth retry hooks |
| `packages/ai/src/stream.ts` | 8+ | `streamSimple` (onAuthError callback), bearer refresh logic |
| `packages/coding-agent/src/cli/auth-gateway-cli.ts` | 2 | `AuthStorage`, (no CLI check command in fork) |
| `packages/utils/src/fetch-retry.ts` | 3 | `extractRetryHint` (called from retry loop) |

No fork code calls `checkCredentials()` with a completion-probe (method doesn't exist in fork).

## Critical incompatibilities for architect

1. **Strict mode (--strict flag)** — MISSING ENTIRELY. Upstream adds optional `--strict` to `omp auth-gateway check` command that exercises credentials against live chat endpoints. Fork has NO `check` action, NO `--strict` flag, and NO `CompletionProbe` type chain.

2. **CompletionProbe contract** — MISSING TYPES. Upstream defines `CompletionProbe`, `CompletionProbeInput`, `CompletionProbeCredential`, `CredentialCompletionResult`. Fork's `CheckCredentialsOptions` interface is unchanged; no completion-probe arg. Cannot receive probe from CLI.

3. **checkCredentials lifecycle** — MISSING METHOD EXPANSION. Upstream's `checkCredentials(options?: CheckCredentialsOptions)` returns `CredentialHealthResult[]` with optional `.completion` field. Fork's version (if it exists) does not. OAuth refresh-on-expiry BEFORE probe is not in fork's flow.

4. **429 usage-limit classification** — DIVERGED. Fork's `classifyGatewayError()` uses only regex pattern `/rate[- _]?limit.../` and does not call `isUsageLimitError(message)` from pi-utils. Codex's usage_limit_reached, Anthropic's usage_limit_reached, Google's resource_exhausted with usage phrasing will NOT match and fall through to 502/upstream_error.

5. **refreshGatewayApiKeyAfterAuthError callback** — DIVERGED SIGNATURE. Fork passes `(storage, model, provider, oldKey, error, signal, format, peer)`. Upstream adds `sessionId` as 3rd param (after model), changes callback to distinguish 429 vs 401, and calls `markUsageLimitReached(provider, sessionId, {retryAfterMs, baseUrl, signal})` instead of only `invalidateCredentialMatching()`.

6. **Session stickiness in retry** — DIVERGED. Upstream's `getApiKey(provider, sessionId, {…})` call in auth-error retry uses sticky sessionId; fork calls `getApiKey(provider, undefined, {…})` which re-roundrobins. Usage-limit rotating across the same session will re-pick the just-blocked credential until it expires.

7. **markUsageLimitReached signature** — POTENTIALLY DIVERGED. Fork has the method at line 2161, but parameter names/semantics around `sessionId`, `retryAfterMs`, and `baseUrl` must be verified against upstream's call site expectations.

## Open architect questions

1. **Adoption strategy**: port both 6491fff8f + b4238b10d atomically, or in sequence? They have interdependent auth-error and credential-rotation semantics.

2. **Strict mode surface**: does fork intend to expose `omp auth-gateway check --strict` in same CLI shape, or different command structure?

3. **CompletionProbe implementation**: upstream expects caller to provide the probe (e.g., a real chat-completion round-trip). Does fork need a built-in probe, or is the contract just plumbed through for external callers?

4. **Usage-limit source data**: upstream's `extractRetryHint()` parsing now handles multiple unit formats (`~`, `sec`, `ms`, minute, hour). Does fork's retry-after logic need this expanded parsing?

5. **Session lifecycle across agent restarts**: fork's `deriveSessionId()` is stable within a conversation. Does broker's credential caching align with upstream's expectation that same sessionId → same picked credential until usage-limit block?

6. **Pre-check oauth refresh**: upstream's `checkCredentials` now refreshes OAuth tokens before probing. Does fork's health-check path use the same pre-refresh strategy, or does it assume fresh tokens are already held?

## Recommendation to architect

**DO NOT cherry-pick.** Both SHAs redefine the auth-error callback chain and credential-rotation semantics. Upstream SHAs interact:

- 6491fff8f adds CompletionProbe types and optional checkCredentials arg.
- b4238b10d uses new sessionId parameter in refreshGatewayApiKeyAfterAuthError, which REQUIRES the callback signature change.

**PREFER structured port**: 
1. Port 6491fff8f first (add types, expand CheckCredentialsOptions, add checkCredentials body logic).
2. Port b4238b10d second (update refreshGatewayApiKeyAfterAuthError signature, split 429 vs 401 branches, update stream.ts onAuthError call site).
3. Verify fork's `markUsageLimitReached` method matches upstream expectations on sessionId semantics.
4. Test: ensure 429 usage-limit responses from all providers (Codex, Anthropic, Google) trigger classifyGatewayError 429 classification.

**RISK**: If fork's markUsageLimitReached or session-credential stickiness differs from upstream model, credential rotation will replay stale accounts in a loop (usage-limit → rotate → pick same account → usage-limit again).

## Next gate

G-arch — architect confirms:
- [ ] Port both SHAs or split into intermediate gates?
- [ ] CLI surface for strict mode (new command? new flag on existing command?)?
- [ ] CompletionProbe implementation strategy (built-in vs externally provided)?
- [ ] Verify fork's markUsageLimitReached sessionId parameter semantics match upstream.

Required artifact: `.omc/autopilot/tier-c/auth-gateway/architecture.md`.

## Quality bar self-check

- [x] No code edited
- [x] No memory written
- [x] No PR opened
- [x] Evidence grounded (SHA, line, method name, types)
- [x] Fork-specific behaviors enumerated against upstream changes
- [x] Call-site mapping provided
- [x] Incompatibilities classified (missing/diverged/preserved)
- [x] Open questions for architect (not pre-answered)
- [x] Risk separated from facts
