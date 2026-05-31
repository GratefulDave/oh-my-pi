# Factory Run Plan: Tier C — Architecturally Divergent Upstream Ports

Generated: 2026-05-28
Skill: factory-orchestrator
Repo: lex (fork of can1357/oh-my-pi)
Base: `main` (post Tier B merge — commit 53191c231)
Predecessors: PR #5 (Tier A, merged 1e1efeac1) → PR #6 (Tier B, merged 53191c231)

## 1. Goal

- **Requested outcome**: Land the upstream improvements that were deferred from Tier B because they require structural rewrites against fork divergence, not selective cherry-pick.
- **Scope**: 6 groups, ~13 upstream commits (4 Tier B skips + originally-deferred hashline / obsidian / incomplete-recovery).
- **Non-goals**:
  - No single PR. Each group is its own branch + PR with discovery → implementation → review lifecycle.
  - No "best effort" partial ports without architecture sign-off.
  - No version bump to 15.5.8/15.5.9 (still defer until all Tier C groups merge or are explicitly cancelled).
  - No new product features (obsidian/vault is the only feature port; treat as integration not invention).

## 2. Current Evidence

| Item | Status | Provenance |
| ---- | ------ | ---------- |
| Tier A (PR #5) | MERGED `1e1efeac1` 2026-05-28T12:30Z | gh |
| Tier B (PR #6) | MERGED `53191c231` 2026-05-28T12:51Z | gh |
| Tier C source list | 6 groups, ~13 SHAs | Tier B PRD skip log + original deferred map |
| Fork divergence on `auth-storage.ts` | 72 commits | probe |
| Fork divergence on `stream.ts` (ai) | 108 commits | probe |
| Fork divergence on `sdk.ts` | 211 commits | probe |
| Fork divergence on `agent.ts` (agent) | 78 commits | probe |
| Fork hashline divergence | 20+ commits (CRLF, preflight guards, blank payload, separator padding) | `git log -- packages/hashline` |
| Fork Vertex routing | Single `streamGoogleVertex` provider arch — incompatible with upstream openai-compat-on-Vertex | grep stream.ts |
| Codex provider | REMOVED in fork (`cleanup/remove-cursor-provider`) | branch list |

## 3. Tier C Groups

### Group H — Hashline breaking rewrite (4 SHAs)
**SHAs**: `91d15b2ec` `7c6457652` `7fa55750f` `7dd00c015`
**Improvement value**: HIGH (upstream removes `↑`/`↓` sigils, introduces `@@ A..B @@` hunk headers, opaque snapshot anchors). Tracks upstream `@oh-my-pi/hashline` API; fork ports would otherwise drift forever.
**Risk**: VERY HIGH. Fork has 20+ divergent commits on hashline (CRLF handling, preflight guards, blank-payload acceptance, separator padding warning, fuzzy 3-way refusal, hashline package migration).
**Lane**: discovery → implementation (opus) → reviewer (architect) → security (data loss on edit risk)
**Lane order rationale**: Hashline is on the edit-apply hot path. Any regression risks silent corruption. Land FIRST after baseline so QA delta is unambiguous.
**Proposed branch**: `parity/upstream-hashline-rewrite`
**Discovery questions** (factory-discovery owns):
1. Which fork-specific hashline behaviors must survive? Enumerate concrete tests.
2. Does upstream's `@@ A..B @@` syntax preserve fork's CRLF + blank-payload semantics?
3. Are fork's hashline consumers (`coding-agent/src/edit/*`) ready for the breaking API? List call sites.
4. Migration plan: parallel-implement + flag-flip, or one-shot replace?

### Group V — Vertex Claude rawPredict (3 SHAs)
**SHAs**: `3ea4981ee` `e8b510160` `ac7f6e4d1`
**Improvement value**: HIGH (correct Vertex Claude endpoint routing + retired Gemini 1.5 catalog removal + MaaS DeepSeek entries)
**Risk**: HIGH. Fork uses dedicated `streamGoogleVertex` provider; upstream uses fetch-wrapper on openai-compat / anthropic-messages. Different architecture entirely.
**Lane**: discovery → architect (decide port strategy) → implementation (opus)
**Proposed branch**: `parity/upstream-vertex-claude-rawpredict`
**Discovery questions**:
1. Should fork adopt upstream's fetch-wrapper arch or fold upstream's rawPredict logic INTO `streamGoogleVertex`?
2. Catalog refresh: which fork-specific Vertex catalog entries must survive (post v15.5.7 fork additions)?
3. Test plan: do fork's existing Vertex tests cover Claude path or only Gemini path?
4. Is there a Vertex Claude user (creds available) for smoke test?

### Group A — Auth-gateway strict + 429 rotation (2 SHAs)
**SHAs**: `6491fff8f` `b4238b10d`
**Improvement value**: HIGH (no longer invalidates credentials on rate-limit; siblings rotate via `markUsageLimitReached`)
**Risk**: HIGH. `auth-storage.ts` diverged 72 commits; upstream restructures `checkCredentials` to run OAuth refresh upfront. `stream.ts` (108) + `sdk.ts` (211) need parallel branching for 429 path.
**Lane**: discovery → architect → implementation (opus) → security-reviewer (credential rotation = high-value security target)
**Proposed branch**: `parity/upstream-auth-gateway-rotation`
**Discovery questions**:
1. Does fork's `checkCredentials` already do upfront-refresh, or still mid-call?
2. Where in fork is the equivalent of `markUsageLimitReached` (or does it need to be added)?
3. Which fork providers benefit (Codex sub plan, Anthropic, Google) — confirm 429 phrasing inventory.
4. Test plan: hostile-provider integration tests vs unit-only?

### Group K — EventLoopKeepalive (3 SHAs)
**SHAs**: `6fb1983fb` `af2011f5a` `c1fa0e9f5`
**Improvement value**: LOW–MED. Upstream fixes Bun busy-wait on unresolved `session.prompt()` Promise. Fork has different `prompt()` structure with no equivalent surface.
**Risk**: LOW (additive infra).
**Lane**: **factory-discovery FIRST** to determine whether fork experiences any busy-wait at all. If yes → implement; if no → cancel from Tier C entirely.
**Proposed branch**: `parity/upstream-keepalive` (only if discovery confirms need)
**Discovery questions**:
1. Does fork's `Agent.prompt()` → `#runLoop` chain have an await on an unresolved Promise without scheduled IO? Profile under interactive mode idle.
2. CPU samples under `omp` interactive mode while idle (>0.5% sustained CPU = needs fix).
3. Is there a user-reported busy-wait or high-CPU-on-idle bug?

### Group O — Obsidian + vault:// (2 SHAs)
**SHAs**: `1709172bf` `509963bd6`
**Improvement value**: MED (feature, not a fix — adds Obsidian vault editing through `vault://` internal URL)
**Risk**: MED. Fork's `internal-urls/router.ts` + `internal-urls/index.ts` have 16 commits of divergence. Upstream adds new `vault-protocol.ts` + extends system-prompt + plan-mode + read tool. Settings-gated (`vault.enabled` default false).
**Lane**: discovery (is fork-side internal-urls compatible?) → architect → implementation
**Proposed branch**: `parity/upstream-obsidian-vault`
**Discovery questions**:
1. Does fork's `internal-urls/router.ts` have the resolve/write/list extension points upstream needs?
2. Settings system: does fork's settings registry accept the `vault.enabled` boolean cleanly?
3. System-prompt: does fork's prompt template accept the Handlebars `{{#if hasObsidian}}` block?
4. Security: traversal/symlink guards from upstream — port verbatim.

### Group I — Incomplete-stop recovery (1 SHA)
**SHA**: `5053a6a4d`
**Improvement value**: MED (`response.incomplete` triggers context promotion → compaction → handoff; useful on `length` stops from OpenAI Responses / Codex)
**Risk**: BLOCKED until Group O lands (diff tangles with vault-protocol files).
**Lane**: WAIT for Group O. After Group O, the isolated recovery delta becomes cherry-pickable.
**Proposed branch**: `parity/upstream-incomplete-recovery` (post Group O)
**Discovery questions** (after Group O):
1. Does fork's compaction surface accept the new `auto_compaction_start.trigger: "incomplete"` discriminator?
2. Does fork's handoff strategy code path accept the `"incomplete"` reason?

## 4. Recommended Group Order

| # | Group | Why this slot | Approx PR size |
|---|-------|---------------|----------------|
| 1 | H (Hashline) | Hot path — establish baseline before other edits churn editor surface | Large |
| 2 | A (Auth-gateway) | Independent surface; high improvement value; security-reviewable | Large |
| 3 | V (Vertex) | Independent provider; high improvement value | Medium-Large |
| 4 | O (Obsidian/vault) | Independent feature; blocked Group I | Medium |
| 5 | I (Incomplete recovery) | Blocked by O | Small |
| 6 | K (Keepalive) | Lowest priority; cancel if discovery shows no fork busy-wait | Small |

Groups H, A, V are **independent in parallel** if multiple humans / multiple worktrees. Sequential if single-track.

## 5. Lane Sequence (per Group, reusable contract)

| Order | Lane | Owner | Input | Output | Gate |
|-------|------|-------|-------|--------|------|
| 1 | Discovery | factory-discovery | upstream SHAs + group-specific questions | discovery report (1–2 pages) | G-disc |
| 2 | Architecture | architect | discovery report | port strategy decision | G-arch |
| 3 | Branch + baseline | executor (haiku) | strategy + main HEAD | branch + per-package baseline | — |
| 4 | Implementation | executor (opus for H/A/V, sonnet for O/I/K) | strategy | commits | G-impl per commit |
| 5 | Verification | verifier | branch | test delta = 0 regressions | G-verify |
| 6 | Code review | code-reviewer | full diff | APPROVE / REJECT | G-rev |
| 7 | Security review | security-reviewer | A and O specifically | SAFE / NEEDS_HARDENING | G-sec (A, O only) |
| 8 | Deslop | ai-slop-cleaner skill | changed files | clean diff or follow-up edits | G-deslop |
| 9 | Regression re-verify | verifier | post-deslop tree | test delta still 0 | G-reverify |
| 10 | PR open | pr-steward | branch | PR URL | G-pr |
| 11 | User approval + merge | User | PR | merge commit SHA | G-merge |

## 6. Instance Boundary

- **In-context skill**: factory-orchestrator (this plan); per-group `factory-discovery` skill for stage 1.
- **Subagents**: executor (opus/sonnet/haiku), architect, code-reviewer, security-reviewer, verifier.
- **Separate OMP instance**: **NOT justified** for any single group. *Potential* justification if Group H + Group A run in parallel — they touch different surfaces but share auth-gateway-adjacent test infrastructure. Single instance with worktree-per-group is preferable.

## 7. Handoffs

Each group hand-off contract (mandatory):

- **lane name**: discovery / impl / verifier / reviewer / pr-steward
- **input artifact**: pointer to prior lane's output file (e.g. `.omc/autopilot/tier-c/<group>/discovery.md`)
- **allowed actions**: scoped to group's surface only; no cross-group bleed
- **forbidden actions**: NO `git merge upstream/main`; NO version bump; NO touching other group's files
- **approval gate**: see Section 8
- **required output shape**: per stage table above
- **verification evidence**: per-package test delta against group's baseline
- **escalation condition**: unexpected conflict, architectural ambiguity, security finding → halt + report

## 8. Approval Gates

| Gate | Approver | Required Evidence |
| ---- | -------- | ----------------- |
| G-disc | User | discovery report (≤2 pages per group) |
| G-arch | User | architect-decided port strategy |
| G-impl | Executor self-review + touched-package test | per-commit test green |
| G-verify | Verifier | full bun test delta = 0 vs group baseline |
| G-rev | code-reviewer | APPROVE / list of fixes |
| G-sec (A, O only) | security-reviewer | SAFE / NEEDS_HARDENING |
| G-deslop | ai-slop-cleaner skill | clean or follow-up applied |
| G-reverify | Verifier | post-deslop test delta still 0 |
| G-pr | pr-steward | PR URL |
| G-merge | User | PR mergeable + reviewer approval |

## 9. Verification Plan

Per group, before any commit:
```bash
git checkout main && git pull origin main
bun install
bun test > /tmp/tierC-<group>-baseline.out 2>&1
bun run check:ts > /tmp/tierC-<group>-check-baseline.out 2>&1
```

Acceptance: post-implementation fail count ≤ baseline fail count for each touched package.

Integration-level:
- Group H: hashline edit corpus must round-trip on existing fork-specific test fixtures (CRLF, blank payload, padded separator).
- Group A: provider simulator returning `usage_limit_reached` rotates credentials, doesn't invalidate.
- Group V: Vertex Claude smoke test against `claude-opus-4-1@20250805` (or whatever fork advertises) — requires GCP creds.
- Group O: vault traversal denial test; `vault.enabled=false` hides protocol from prompt template.
- Group I: provider injecting `response.incomplete` recovers via context promotion.
- Group K: idle CPU sample stays at 0% (or matches pre-port baseline).

CI: GitHub Actions on each PR.

## 10. Risks / Unknowns / Blockers

**Facts**:
- 4 groups (H, A, V, O) are independent and may run in parallel.
- 1 group (I) blocked by O.
- 1 group (K) gated on discovery evidence — may be cancelled.

**Inferences**:
- Group H is the highest-risk single change. Suggest discovery to enumerate fork-specific hashline guarantees before ANY edit.
- Group A's `markUsageLimitReached` infra is the most subtle behavior change — could silently mask rate-limit conditions if rotated credential is also exhausted.
- Group V might be reduced to "catalog refresh only" if fork architecture can't host the rawPredict fetch wrapper.

**Unknowns**:
- Whether fork has hidden busy-wait surface that Group K would help with.
- Whether fork users actively need Vertex Claude path (or whether Gemini is the only Vertex consumer).
- Whether `vault.enabled` flag default OFF is acceptable for fork users (security-cautious default).

**Blockers**:
- Group I blocked by Group O.
- All else unblocked.

## 11. Next Action

**Recommended next lane**: **Group H discovery** — highest risk, must establish fork hashline contract before any edit.

**Exact handoff prompt for factory-discovery**:
> Read `packages/hashline/src/*` and all 20+ fork commits touching `packages/hashline` since the package migration. Enumerate every fork-specific behavior with a test reference and a one-line "must-preserve" guarantee. Then read upstream commits `91d15b2ec`, `7c6457652`, `7fa55750f`, `7dd00c015` via `git show`. For each fork guarantee, classify upstream impact: PRESERVED / BROKEN / UNCLEAR. Report in ≤2 pages. Do NOT propose code. Output to `.omc/autopilot/tier-c/hashline/discovery.md`.

If user accepts G-disc and architect chooses port strategy at G-arch, hand off to executor (opus) with strategy + branch name `parity/upstream-hashline-rewrite`.

## Artifacts

- `.omc/autopilot/tier-c-plan.md` — this Run Plan
- (to be created per group) `.omc/autopilot/tier-c/<group>/discovery.md`
- (to be created per group) `.omc/autopilot/tier-c/<group>/architecture.md`
- (to be created per group) `.omc/autopilot/tier-c/<group>/progress.txt`

## Quality Bar Self-Check

- [x] Routes through discovery/architecture/implementation/verifier/PR-CI/security/QA/review/librarian lanes
- [x] Explains why no separate OMP instance is needed (worktree-per-group sufficient)
- [x] Does NOT implement code (plan-only)
- [x] Does NOT approve its own risky gate (all G-impl onward require subagent or user)
- [x] No memory writes proposed yet (defer until verified merge per group)
- [x] Each group has self-contained handoff contract with allowed/forbidden actions and escalation condition
- [x] Discovery questions named for the groups (H, V, A, O, I, K) that need them
