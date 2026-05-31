# Factory Run Plan: Selective Tier B Cherry-Pick (Upstream Parity 15.5.8 → 15.5.9)

Generated: 2026-05-28
Skill: factory-orchestrator
Repo: lex (fork of can1357/oh-my-pi)
Branch base: `main` (Tier A in PR #5, gated MERGEABLE)

## 1. Goal

- **Requested outcome**: Land the *improvement* subset of the 14 Tier B deferred commits while preserving fork divergence. Tier B = commits that conflicted on plain `git cherry-pick` because fork files diverged.
- **Scope**: only improvements. Skip refactors-without-behavior-delta, skip commits that only land in tandem with deferred features (vault://, obsidian, hashline rewrite).
- **Non-goals**:
  - No hashline rewrite (separate Tier C track)
  - No obsidian / `vault://` integration (separate Tier C)
  - No upstream `style: biome import order` mass-touch
  - No version bump to 15.5.8 or 15.5.9 (defer until everything lands)
  - No `git merge upstream/main` — fork stays in selective-port posture
  - No PR until Tier A (#5) lands first to avoid stacked conflicts

## 2. Current Evidence

| Item | Status | Provenance |
| ---- | ------ | ---------- |
| PR #5 (Tier A) | OPEN, MERGEABLE, no checks yet | `gh pr view 5` |
| Tier B SHAs | 14 | `.omc/autopilot/cherry-tier-a-deferred.log` |
| Conflict surface map | written | `.omc/autopilot/tier-b-conflicts.md` |
| Fork divergence on `stream.ts` | 108 fork commits | probe |
| Fork divergence on `agent.ts` | 78 fork commits | probe |
| Fork divergence on `agent-session.ts` | 317 fork commits | probe |
| Fork divergence on `sdk.ts` | 211 fork commits | probe |
| Files MISSING in fork | `utils/discovery/vertex.ts`, `web/search/providers/codex.ts`, `vault-protocol.ts`, `utils/yield.ts`, several tests | probe |

## 3. Tier B Classification

### Group V — Vertex Claude rawPredict (3 commits)
**SHAs**: `3ea4981ee` `e8b510160` `ac7f6e4d1`
**Port verdict**: REWRITE-PORT
**Why**: stream.ts diverged heavily (108 fork commits). `utils/discovery/vertex.ts` does not exist in fork — must port as net-new file.
**Improvement value**: HIGH (correctness — Vertex Claude was hitting the wrong endpoint).
**Strategy**: extract three logical deltas onto fork's files:
1. `vertex.ts` provider — switch Claude path to `rawPredict` route + add `anthropic_version` to request body.
2. `models.json` + `provider-models/google.ts` — refresh Vertex catalog (drop retired Gemini 1.5, add MaaS DeepSeek).
3. Port `utils/discovery/vertex.ts` as new file; add fork-shape test in `test/google-vertex-discovery.test.ts`.
**Owner lane**: executor (sonnet)
**Verification**: new test + smoke `omp /login google-vertex` if creds available.

### Group K — EventLoopKeepalive chain (3 commits)
**SHAs**: `6fb1983fb` `af2011f5a` `c1fa0e9f5`
**Port verdict**: SQUASH-PORT
**Why**: chain = add → revert → re-add as disposable. Final state = `using` declaration with disposable keepalive in `Agent.prompt()` and in `coding-agent/src/main.ts`. Fork has 78 commits on `agent.ts` and never had `utils/yield.ts`.
**Improvement value**: MED (busy-wait fix on `session.prompt()` — bug from upstream #1464).
**Strategy**: one squashed commit `fix(agent): disposable EventLoopKeepalive in Agent.prompt() + coding-agent main`. Skip intermediate revisions. Port `utils/yield.ts` as new file with only the `EventLoopKeepalive` export needed.
**Owner lane**: executor (sonnet)
**Verification**: regression test that `session.prompt()` does not busy-loop CPU when no scheduled events.

### Group M — MCP HTTP SSE startup (2 commits)
**SHAs**: `c0c9049cc` `2266fdae8`
**Port verdict**: CHERRY-PICK with `-X theirs` on `http.ts` body, manual rebase of fork additions on top.
**Why**: fork has 16 commits on `mcp/transports/http.ts` but test file missing — easy net-new.
**Improvement value**: HIGH (prevents MCP startup hang on broken SSE endpoint; honors `disabled` flag).
**Strategy**:
1. `git show c0c9049cc -- packages/coding-agent/src/mcp/transports/http.ts` → manually apply timeout wrapper to fork's startup path.
2. `git show 2266fdae8` → apply the disabled-shortcircuit.
3. Land test file verbatim.
**Owner lane**: executor (sonnet)
**Verification**: test file + manual smoke against an intentionally-broken SSE endpoint.

### Group A — Auth-gateway robustness (2 commits)
**SHAs**: `6491fff8f` (strict mode + completion-probe), `b4238b10d` (429 usage-limit rotation)
**Port verdict**: SPLIT-PORT
- **`6491fff8f` — APPLY**: additive `--strict` CLI flag + `completion-probe` on `AuthStorage.checkCredentials`. Surface area is bounded: auth-storage.ts (72 commits) + new CLI flags. Conflicts likely on `checkCredentials` signature additions.
- **`b4238b10d` — APPLY CAREFULLY**: 429 handling touches 6 files including high-churn `stream.ts` (108) and `sdk.ts` (211). Pre-req `3c4023037` (heal stream markup) is already in Tier A. Improvement value HIGH (credentials no longer get invalidated on rate-limit; siblings rotate via `markUsageLimitReached`).

**Strategy**:
1. Port `6491fff8f` first as smaller surface.
2. Then port `b4238b10d`. For `stream.ts` and `sdk.ts`: read fork's current 429/401 handling, add `markUsageLimitReached` branch alongside existing `invalidateCredentialMatching` branch, keep both reachable.
3. New tests land verbatim.
**Owner lane**: executor (opus) — needs careful 3-file merge on stream.ts/sdk.ts/server.ts.
**Verification**: tests + smoke against a real provider that returns `usage_limit_reached` (Codex sub plan).

### Group P — Shared Python kernel (1 commit)
**SHA**: `e46ee155a`
**Port verdict**: MANUAL-PORT
**Why**: `agent-session.ts` has 317 fork commits — direct cherry-pick will explode. Improvement is narrow: namespace `executePython()` session IDs so `$ ...` user shortcut shares one Python kernel with the `eval` tool.
**Improvement value**: MED-HIGH (correctness — eval state was previously invisible to user shortcut).
**Strategy**:
1. Locate fork's `AgentSession.executePython()`.
2. Read upstream's session-id derivation (`evalSessionId` for eval, derive same for shortcut).
3. Add namespace + regression test.
**Owner lane**: executor (sonnet)
**Verification**: regression test from upstream commit.

### Group L — Auth-broker logger transport (1 commit)
**SHA**: `3d5f0d886`
**Port verdict**: CHERRY-PICK direct
**Why**: only 6 fork commits on `auth-broker-cli.ts`. Likely clean with `-X theirs`.
**Improvement value**: MED (fixes `omp auth-broker serve` startup crash on some Bun versions where `logger.setTransports` is not exposed via namespace re-export).
**Strategy**: try `git cherry-pick -X theirs 3d5f0d886`. On failure, manual replace of one call site.
**Owner lane**: executor (haiku)
**Verification**: `omp auth-broker serve --help` doesn't crash.

### Group W — Codex gpt-5.5 web search (1 commit)
**SHA**: `674d9b00a`
**Port verdict**: SKIP — NOT APPLICABLE
**Why**: both touched files MISSING in fork. Fork removed the codex provider on `cleanup/remove-cursor-provider` work.
**Strategy**: drop from Tier B scope. Document in deferred log as N/A.
**Owner lane**: none.

### Group I — incomplete-stop recovery (1 commit)
**SHA**: `5053a6a4d`
**Port verdict**: DEFER to Tier C
**Why**: probe shows this commit's diff includes `internal-urls/vault-protocol.ts` and `internal-urls/router.ts` which are vault-feature files (MISSING in fork). Either the commit's named purpose is misleading or upstream squashed the incomplete-recovery fix with the vault feature.
**Decision**: needs `git show 5053a6a4d` byte-level inspection to isolate the recovery delta from the vault delta before deciding whether to port the isolated piece. Block on that read.
**Owner lane**: discovery (before promoting to executor)

## 4. Recommended Port Order

Sequence chosen for risk-monotonicity (smallest blast radius first):

| # | Group | SHAs | Why first/last |
| - | ----- | ---- | -------------- |
| 1 | L (logger fix) | `3d5f0d886` | smallest surface; warms up branch |
| 2 | M (MCP SSE) | `c0c9049cc` `2266fdae8` | isolated to `http.ts`; new tests land verbatim |
| 3 | K (keepalive squash) | `6fb1983fb` `af2011f5a` `c1fa0e9f5` | one squashed commit, one file (`agent.ts`) + new util |
| 4 | P (Python kernel) | `e46ee155a` | one-file delta on agent-session.ts |
| 5 | V (Vertex Claude) | `3ea4981ee` `e8b510160` `ac7f6e4d1` | needs new discovery module; higher effort but bounded |
| 6 | A1 (strict gateway) | `6491fff8f` | additive flag |
| 7 | A2 (429 rotation) | `b4238b10d` | highest-conflict; lands last |
| Skip | W | `674d9b00a` | N/A |
| Defer | I | `5053a6a4d` | tangled with vault; needs discovery read |

## 5. Lane Sequence

| Order | Lane | Owner | Input | Output | Gate |
| ----- | ---- | ----- | ----- | ------ | ---- |
| 1 | Pre-flight | factory-orchestrator | this plan | confirmed Tier A PR #5 status (MERGEABLE) | G0 |
| 2 | Discovery (Group I only) | factory-discovery | `git show 5053a6a4d` | classification: pure-recovery slice exists Y/N | G1 |
| 3 | Branch creation | executor (haiku) | base = `main` after PR #5 merges | branch `parity/upstream-15.5.9-tierB` | — |
| 4 | Port groups 1-4 | executor (sonnet) | per-group instructions | individual commits per group | G2 per group |
| 5 | Port group 5 (Vertex) | executor (sonnet) | upstream commits + plan | 3 commits | G2 |
| 6 | Port group 6 | executor (sonnet) | upstream commit | 1 commit | G2 |
| 7 | Port group 7 (429) | executor (opus) | upstream commit + plan | 1 commit + careful 3-file merge | G2 + reviewer approval |
| 8 | QA | verifier | branch state | full bun test + check:ts + per-package isolation | G3 |
| 9 | Security review | security-reviewer | Group A diffs (auth/credential rotation) | SAFE / NEEDS_HARDENING | G4 |
| 10 | Code review | code-reviewer | full diff | APPROVE / REVERT list | G4 |
| 11 | PR | pr-steward | reviewed branch | PR titled `parity(upstream): 15.5.9 tier-B selective` | G5 |

## 6. Instance Boundary

- **In-context skill**: factory-orchestrator (plan only; no code).
- **Subagents**: executor (haiku → sonnet → opus by group), factory-discovery (Group I), verifier, code-reviewer, security-reviewer.
- **Separate OMP instance**: **NOT justified.** No live credentials, no watchers, no AFK loops. Stays in this session.

## 7. Handoffs

- **Plan → Pre-flight**: confirm Tier A PR #5 merged before branching. If unmerged, halt and report.
- **Pre-flight → Discovery (Group I)**: hand factory-discovery the SHA `5053a6a4d` and the question "is there an isolated incomplete-recovery delta separable from vault-protocol files".
- **Discovery → Implementation**: per-group port instruction (already written above per Group).
- **Implementation → Verifier**: `bun install && bun run check:ts && bun test` baseline = main + Tier A. Verifier compares fail count to that baseline; only NEW failures escalate.
- **Verifier → Reviewers**: parallel code-reviewer + security-reviewer (security gets Group A specifically).
- **Reviewers → PR**: pr-steward opens PR against `main` (post Tier A merge).

## 8. Approval Gates

| Gate | Approver | Required Evidence |
| ---- | -------- | ----------------- |
| G0 — Tier A merged | User | `gh pr view 5 --json mergedAt` non-null |
| G1 — Group I classification | factory-discovery output reviewed by User | discovery report (1 page) |
| G2 — Per-group commit accepted | Executor self-review + automatic test on touched package | per-package test green |
| G3 — Full QA passed | Verifier | `bun test` net failure delta = 0 vs baseline |
| G4 — Reviewers pass | code-reviewer APPROVE + security-reviewer SAFE | reviewer reports |
| G5 — PR open | User | PR URL |

## 9. Verification Plan

- **Unit/TDD owner**: executor lane (each cherry-pick re-runs touched package's `bun test`).
- **Integration owner**: full-repo `bun test` against per-package baselines captured before Tier B begins.
- **CI owner**: GitHub Actions when PR opens.
- **Release smoke owner**: deferred until full version bump (with Tier C).

Required baseline capture **before any Tier B commit**:
```bash
git checkout main
git pull origin main   # post-Tier-A merge
bun install
bun test  > /tmp/baseline-tierB-start.out 2>&1
bun run check:ts > /tmp/baseline-tierB-check.out 2>&1
```

Per-group acceptance: after each port commit, run touched package's test and compare to baseline; net new fails = 0 required.

## 10. Risks / Unknowns / Blockers

**Facts**:
- Tier A PR #5 not yet merged. Tier B blocks on that.
- 7 groups, ~11 commits to land. Highest-conflict commit (`b4238b10d` 429) touches stream.ts + sdk.ts + auth-gateway/server.ts simultaneously.

**Inferences**:
- Vertex Claude port (Group V) likely needs net-new `utils/discovery/vertex.ts` — may be omitted if fork doesn't use the discovery infrastructure (verify before porting).
- `5053a6a4d` is suspicious — name doesn't match diff. Block on discovery.

**Unknowns**:
- Whether fork's `checkCredentials` signature accepts new optional `completionProbe` arg without breaking callers (need byte-level diff).
- Whether fork still has the `EventLoopKeepalive` import path or removed it (Group K assumes a fresh add).
- Whether `cleanup/remove-cursor-provider` branch already merged into main (affects Group W status).

**Blockers**:
- G0 (Tier A merge) — entire Tier B blocked until PR #5 merges.

## 11. Next Action

**Recommended next lane**: G0 confirmation — wait for PR #5 to merge.

**Exact handoff prompt for executor after G0 + G1 pass**:
> Create branch `parity/upstream-15.5.9-tierB` from updated `main`. Capture test baselines per `.omc/autopilot/tier-b-plan.md` section 9. Port Group L (`3d5f0d886`) via `git cherry-pick -X theirs`. On any unexpected conflict, stop and report. Run `bun test packages/coding-agent/test/cli/` (or closest analogue). Report commit SHA + test delta. Do not proceed to Group M without explicit go-ahead.

## Artifacts

- `.omc/autopilot/tier-b-plan.md` — this Factory Run Plan
- `.omc/autopilot/tier-b-probe.sh` — repeatable conflict-surface probe
- `.omc/autopilot/tier-b-conflicts.md` — conflict surface map
- `.omc/autopilot/cherry-tier-a-deferred.log` — source list

## Quality Bar Self-Check (per skill contract)

- [x] Routes across discovery/implementation/verifier/PR-CI/security/QA/review lanes
- [x] Explains why no separate OMP instance is needed
- [x] Does NOT implement code (plan-only)
- [x] Does NOT approve its own risky gate (G2/G4 require reviewers; G0/G5 require user)
- [x] No memory writes proposed yet (defer until verified)
- [x] Each handoff specifies lane name, input, allowed actions (port commits), forbidden actions (no merge, no scope creep), approval gate, required output (per-commit test delta + reviewer reports), escalation condition (unexpected conflict → halt + report)
