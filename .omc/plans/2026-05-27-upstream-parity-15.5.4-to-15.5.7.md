# Upstream Parity Port: oh-my-pi v15.5.4 → v15.5.7

**Status:** pending approval
**Date:** 2026-05-27
**Goal:** Improve fork performance and features by selectively porting upstream improvements.
**Fork:** GratefulDave/oh-my-pi (branch `main`, currently at v15.5.3)
**Upstream:** can1357/oh-my-pi (latest v15.5.7)
**Strategy:** Per-release tag cherry-pick — curated subset selected for perf + features

---

## Selected Subset (goal: perf + features)

User confirmed goal is fork performance + features. The following units are **selected** for port. Tables below retain the full unit catalog for reference; selected units are also listed here for quick scanning.

### Performance & Stability
- **4.5** Hashline LSP diagnostics deferred until final section (perf)
- **6.1** `PI_CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS` env var to bound idle Codex WS reuse
- **6.2** Drop and rehandshake reused Codex WS that went silent
- **6.3** Clear stale response frames left in WS queue from completed turn
- **6.4** WS dead-socket detection on runtimes that don't emit pong events
- **7.10** Isolate `read` URL reader-mode fallback chain from remote stalls (Jina/Parallel 10s sub-budget) (#1442/#1449)
- **7.12** Pin streaming diff preview to tail of the diff (`1dbd2a065`)

### Features
- **7.1** OpenRouter provider in `/login` (paste-key flow validated against `openrouter.ai/api/v1/auth/key`) — **primary user ask**
- **7.2** xAI Grok OAuth (SuperGrok) in `/login` (PKCE loopback on `127.0.0.1:56121`)
- **7.3** `XAI_OAUTH_TOKEN` env var headless fallback for xAI Grok OAuth
- **7.4** `SimpleStreamOptions.openrouterVariant` plumbing (`:nitro`/`:floor`/`:online`/`:exacto`)
- **7.5** `providers.openrouterVariant` setting (Settings → Providers → "OpenRouter Routing")
- **7.6** `OpenAIResponsesOptions` adapter fields (`includeEncryptedReasoning`, `filterReasoningHistory`, `headers`, `extraBody`)
- **4.3** `read.summarize.minTotalLines` setting (default 100) + read returns verbatim for short files
- **4.4** `search` `<file>:<lines>` constraint (file-scoped range filters)
- **6.5** URL multi-range line selectors (`:5-10,20-30`)
- **6.6** `:raw` mode combined with line ranges (`:raw:1-120`)
- **6.7** Directory listing line selectors (`:30-40`)
- **6.9** URL selector parser supports multiple trailing tokens (left-to-right) — required for 6.5/6.6

### Bugfixes (carry along)
- **4.1** Scope `getPackageDir()` so `omp` never reads host project's `CHANGELOG.md` (#1424)
- **4.2** Keep hidden `resolve` tool in plan mode when only read-only tools are active (#1430)
- **4.6** Hashline rejects duplicate canonical targets + preflights write guards pre-commit
- **4.7** Export `HashlineCursorKind` / `HashlineEditKind` / `HashlineTokenKind`
- **6.8** Clear error when line offset is beyond end of directory listing
- **6.10** Fix `:raw` ignored for JSON/feed URLs
- **6.11** Fix directory listing line selectors silently dropping offset
- **7.7** Fix OpenRouter DeepSeek V4 tool-call follow-up — emit `reasoning_content` (#1445)
- **7.8** Reopen approved plan on plan-mode re-entry (don't open fresh `local://PLAN.md`) (#1448)
- **7.9** Stabilize xAI Grok OAuth (#1446) — required pair with 7.2
- **7.11** Fix compaction reasoning handling
- **7.13** Fix broken native export headers (`6fac33f09`) — likely required for build

### Explicitly Skipped
- **4.8** `unfoldUntilLines` / `unfoldLimitLines` — niche
- **4.9** Breaking removal of root `hashline` export — breaking, no perf/feature gain
- **7.14** Grok TTS — opt-in, defer unless user requests it
- **5.0** v15.5.5 untagged commits — review only if user-visible commits surface during execution

**Total selected: 32 units** (7 perf + 13 feature + 12 bugfix).

---

## Requirements Summary

Bring fork to parity with `can1357/oh-my-pi` from v15.5.4 through v15.5.7, while preserving the fork's divergent work:

- W1: AWS expansion in `crates/pi-shell/src/minimizer/filter*`
- W2: clang minimizer work
- W3: source-outline-aggressive
- W4: `ai_smart` (location TBD; likely under `packages/ai` or `packages/coding-agent`)
- Factory docs: software-factory guide surfaced in help (`b0df19ea7`)

User has elected **cherry-pick per-release tag** strategy and **curated subset** scope: this plan enumerates every portable unit with a conflict-risk estimate so the user can check off what to apply.

---

## Pre-Flight (run before any cherry-picks)

1. `git fetch upstream --tags` (already done; v15.5.4, v15.5.5, v15.5.6, v15.5.7 fetched).
2. Create integration branch from fork `main`:
   ```bash
   git checkout -b parity/upstream-15.5.7 main
   ```
3. Identify fork-modified files in `packages/ai` and `packages/coding-agent` so conflict surface is known up front:
   ```bash
   git diff --name-only v15.5.3..HEAD -- packages/ai packages/coding-agent
   ```
4. Ensure `bun install && bun run check:ts` is green on the fork **before** porting, so any post-port red is from the port.

Each port unit below names the upstream PR. The recommended cherry-pick is `git cherry-pick -x <upstream-commit>` (use `-x` so the message records the source SHA). If the unit names a PR with multiple commits, prefer cherry-picking the squash-merge commit on `upstream/main`; fall back to the PR's commit range if upstream squash is unavailable.

---

## v15.5.4 — Port Units (released 2026-05-26T17:25:18Z, compare v15.5.3...v15.5.4)

| # | Unit | Files (expected) | Conflict risk | Recommend |
|---|---|---|---|---|
| 4.1 | **PR #1424 — Scope `getPackageDir()` lookup so omp never reads the host project's `CHANGELOG.md` (#1423)** | `packages/coding-agent/src/**` (package-dir resolver); CHANGELOG | Low | Yes — silent data corruption bug; trivially correct |
| 4.2 | **PR #1430 — Keep hidden `resolve` tool in plan mode (#1428)** | `packages/coding-agent/src/core/agent-session.ts` (or `createAgentSession`); plan-mode tool registry | Low | Yes — plan mode is currently broken when all active tools are read-only |
| 4.3 | **`read.summarize.minTotalLines` setting (default 100)** + **read returns verbatim for short files** | `packages/coding-agent/src/tools/read.ts`, settings schema, `docs/` | Low–Medium (touches read tool; check W3 `source-outline-aggressive` overlap) | Yes — backward-compatible setting |
| 4.4 | **`search` `paths` `<file>:<lines>` support (`:N-M`, `:N+K`, ranges) + range-scoped match/context filtering** | `packages/coding-agent/src/tools/search.ts` | Low–Medium (check W3 overlap on search/outline) | Optional — pure ergonomics, no bugfix |
| 4.5 | **Hashline LSP diagnostics deferred until final section** | `packages/coding-agent/src/tools/hashline*`, LSP client | Medium (hashline edit executor) | Yes — perf/UX win, but verify against fork's W1/W2 if either touched hashline |
| 4.6 | **Hashline rejects duplicate canonical targets, preflights write guards before any section commits** | hashline executor | Medium | Yes — correctness fix |
| 4.7 | **Hashline `HashlineCursorKind`, `HashlineEditKind`, `HashlineTokenKind` exports** | hashline public API | Low | Yes — additive exports |
| 4.8 | **`unfoldUntilLines` / `unfoldLimitLines` in `SummaryOptions`** | summary module | Low | Optional |
| 4.9 | **Breaking: remove top-level `hashline` export from package root** | `packages/coding-agent/src/index.ts` | Low (only affects external consumers) | Decide based on whether any fork code imports `hashline` from root — grep first |

**v15.5.4 fixed-only entries also included in any cherry-pick** (no separate flag needed; included in the same PR commits):
- Multi-section hashline: reject duplicate canonical targets pre-write (4.6 above).
- Nested replace parsing: `N:` rows inside pending `A-B:` replacement trigger overlap detection.
- `crash`/UX fixes referenced in release notes (carried with the relevant PR commit).

---

## v15.5.5 — Untagged Internal Release

`v15.5.5` tag exists upstream but no release page was published. Action: read `git log v15.5.4..v15.5.5 --oneline` upstream, fold any user-visible commits into the v15.5.6 cherry-pick set; skip purely internal/test commits.

| # | Unit | Action |
|---|---|---|
| 5.0 | Inspect `git log v15.5.4..v15.5.5` upstream | Decide per commit; default skip if message is `chore:`/`test:` only |

---

## v15.5.6 — Port Units (released 2026-05-27T13:13:29Z, compare v15.5.5...v15.5.6)

| # | Unit | Files (expected) | Conflict risk | Recommend |
|---|---|---|---|---|
| 6.1 | **`PI_CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS` env var to control idle Codex WS reuse (0 disables)** | `packages/ai/src/providers/codex*` | Low | Yes — bugfix safety valve |
| 6.2 | **Fix reused Codex WS that went silent — drop and rehandshake after idle threshold** | Codex WS provider | Low | Yes — addresses real stalled-request bug |
| 6.3 | **Fix stale response frames left in WS queue from completed turn** | Codex WS provider | Low | Yes |
| 6.4 | **Fix WS dead-socket detection on runtimes that don't emit pong events** | Codex WS provider | Low | Yes |
| 6.5 | **URL multi-range line selectors (`:5-10,20-30`)** | URL reader / `read` tool URL path | Low | Optional |
| 6.6 | **`:raw` mode + line-range selectors combined (`:raw:1-120` or `:1-120:raw`)** | URL reader | Low | Optional |
| 6.7 | **Directory listing line selectors (`:30-40`)** | dir listing renderer | Low | Optional |
| 6.8 | **Clear error when line offset is beyond end of directory listing** | dir listing | Low | Yes — UX fix |
| 6.9 | **URL selector parser supports multiple trailing tokens (left-to-right)** | URL reader selector parser | Low | Yes — fixes 6.5/6.6 |
| 6.10 | **Fix `:raw` ignored for JSON/feed URLs** | URL reader | Low | Yes — correctness |
| 6.11 | **Fix directory listing line selectors silently dropping offset (only applying limit)** | dir listing | Low | Yes — correctness |

---

## v15.5.7 — Port Units (released 2026-05-27T17:13:24Z, compare v15.5.6...v15.5.7)

### Auth & Provider (user's primary motivation)

| # | Unit | Files (expected) | Conflict risk | Recommend |
|---|---|---|---|---|
| 7.1 | **OpenRouter provider in `/login`** — API-key paste flow validated against `https://openrouter.ai/api/v1/auth/key`; key stored under existing `openrouter` provider id used by `OPENROUTER_API_KEY` | `packages/coding-agent/src/cli/login*`, provider registry, `docs/environment-variables.md` | Low–Medium (check W4 `ai_smart` overlap on provider registry) | **Yes — explicit user ask** |
| 7.2 | **xAI Grok OAuth (SuperGrok Subscription) provider in `/login`** — Loopback PKCE flow on `127.0.0.1:56121`, unlocks Grok-4.x chat (ported from NousResearch/hermes-agent MIT) | `/login` flow, new OAuth client, port binding | Medium (new dependency for PKCE/loopback; check port-conflict rule) | Yes — pairs with 7.1 |
| 7.3 | **`XAI_OAUTH_TOKEN` env var as headless fallback for xAI Grok OAuth** | env-api-keys, provider resolution | Low | Yes — required for CI/headless |
| 7.4 | **`SimpleStreamOptions.openrouterVariant` (`nitro`/`floor`/`online`/`exacto`/…)** — appends `:<variant>` to OpenRouter model IDs at request time | `packages/ai/src/providers/openai-completions.ts`, pi-native gateway forwarder, `types.d.ts` | Low | Yes — opt-in routing |
| 7.5 | **`providers.openrouterVariant` setting (Settings → Providers → "OpenRouter Routing")** — default OpenRouter requests to a routing-variant suffix | `packages/coding-agent` settings schema + UI | Low | Yes — UX surface for 7.4 |
| 7.6 | **`OpenAIResponsesOptions` adapter fields**: `includeEncryptedReasoning` (default `true`), `filterReasoningHistory` (default `false`), `headers` (merged onto client defaults), `extraBody` (merged into request payload) | `packages/ai/src/providers/openai-responses*` | Low | Yes — provider-agnostic, additive |
| 7.7 | **Fix OpenRouter DeepSeek V4 tool-call follow-up — emit `reasoning_content` not normalized `reasoning` (#1445)** | OpenRouter provider transport | Low | Yes — fixes HTTP 400 in thinking mode |

### Plan Mode & Read

| # | Unit | Files (expected) | Conflict risk | Recommend |
|---|---|---|---|---|
| 7.8 | **PR #1448 — Reopen approved plan on plan-mode reentry (don't open fresh `local://PLAN.md`)** | plan-mode entry, plan artifact resolver | Low–Medium | Yes — prevents duplicate plan content + approval failures |
| 7.9 | **PR #1446 — Stabilize xAI Grok OAuth (related to 7.2)** | xAI OAuth flow | Low (apply with 7.2) | Yes (only meaningful when 7.2 is in) |
| 7.10 | **PR #1442 (#1449) — Isolate `read` URL reader-mode fallback chain from remote stalls** — Jina (and Parallel extract) get per-attempt 10s sub-budget; catch handler honors only real user cancellation; in-process native renderer always attempted on already-loaded HTML | `packages/coding-agent/src/tools/read.ts` URL path, Jina client, lynx/trafilatura fallback | Medium (read tool — check W3 overlap) | Yes — fixes hang risk |
| 7.11 | **Compaction reasoning-related fix (referenced in 15.5.7 "What's Changed" snippet)** | agent compaction | Low | Yes — bugfix |
| 7.12 | **Streaming diff preview pinned to tail of diff (`1dbd2a065`)** | diff renderer | Low | Yes — UX fix |
| 7.13 | **`chore: fix broken native export headers` (`6fac33f09`)** | natives | Low (but check vs W1/W2 in `crates/pi-shell` / `packages/natives`) | Yes — likely required to build |

### Optional (TTS — opt-in, off by default)

| # | Unit | Files (expected) | Conflict risk | Recommend |
|---|---|---|---|---|
| 7.14 | **Grok TTS behind disabled-by-default `tts.enabled` setting** (voices `ara`/`eve`/`leo`/`rex`/`sal`, custom IDs OK; codec from `output_path` suffix; up to 15,000 chars/req) | new TTS module + settings schema | Low (gated by setting) | Optional — only if TTS is in scope |

---

## Execution Steps (after user selects subset)

1. **For each selected unit**, identify the upstream merge/squash commit. Lookup template:
   ```bash
   git log v15.5.3..v15.5.7 --oneline --grep '<keyword-from-unit>' upstream/main
   gh pr view <PR#> --repo can1357/oh-my-pi --json mergeCommit,commits
   ```
2. **Cherry-pick in chronological order** (older release units first, then newer) so dependent fixes apply cleanly:
   ```bash
   git cherry-pick -x <sha>
   ```
3. **On conflict**: do not auto-resolve. Stop, read both sides, prefer the side that preserves the fork's W1–W4 invariants, and document the resolution in the commit body.
4. **After each unit**: run `bun run check:ts` (and `bun run test:ts` if the unit touches a tested module). Commit lint/format fixups separately from the cherry-pick.
5. **Update CHANGELOG.md**: add a `## [15.5.7-fork.1] - 2026-05-27` (or similar) section listing only the ported units. Group by upstream release tag for traceability.
6. **Bump versions** in `packages/*/package.json` from `15.5.3` to a fork-suffixed version (recommend `15.5.7-fork.0` or `15.5.7`) once all selected units land. Decision deferred to user; do not bump until last unit lands.
7. **Open PR** to fork `main` titled `parity(upstream): port v15.5.4–v15.5.7 selected units`.

---

## Acceptance Criteria

- [ ] Every selected unit applied as a separate cherry-pick commit with `-x` source SHA in the message.
- [ ] `bun install && bun run check:ts` is green on the integration branch.
- [ ] `bun run test:ts` is green (or any newly red tests are explicitly justified as upstream-introduced).
- [ ] `crates/pi-shell/src/minimizer/filter*` (W1), clang work (W2), source-outline (W3), and `ai_smart` (W4) untouched OR conflicts resolved in favor of fork semantics with a note in the commit body.
- [ ] `omp /login` shows OpenRouter as a paste-key option AND xAI Grok OAuth as a PKCE option (if 7.1/7.2 selected). Verified by running `bun --cwd=packages/coding-agent src/cli.ts login` interactively.
- [ ] `OPENROUTER_API_KEY` and `XAI_OAUTH_TOKEN` env vars still function as before (regression check).
- [ ] Plan mode submits and applies a plan when only read-only tools (`read`, `search`, `find`, `web_search`) are active (if 4.2 selected).
- [ ] `omp` startup does NOT clobber `lastChangelogVersion` from the host project's `CHANGELOG.md` (if 4.1 selected).
- [ ] Codex WS reuse is bounded by `PI_CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS` (if 6.1 selected).
- [ ] CHANGELOG.md updated with one section per ported upstream tag.
- [ ] Version bump applied only after every selected unit lands.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Cherry-pick conflicts on hashline (4.5–4.7) if W1/W2 touched hashline | Medium | Re-implement against fork; tests may need updates | Run `git log v15.5.3..HEAD -- packages/coding-agent/src/tools/hashline*` first; if non-empty, expect manual port |
| `read` tool conflicts with W3 source-outline-aggressive | Medium | Read-tool regressions | Diff `git log v15.5.3..HEAD -- packages/coding-agent/src/tools/read*` before 4.3/7.10 |
| Provider registry conflict between W4 `ai_smart` and 7.1/7.2/7.5 | Medium | OpenRouter/xAI login non-functional | Locate `ai_smart` in repo first; coordinate registration order |
| xAI OAuth port 56121 collides with another local service | Low | OAuth callback fails | Document port in README; allow override via env var if upstream supports it (verify in PR #1446) |
| Pre-flight check is skipped → conflicts attributed to upstream when caused by uncommitted fork state | Medium | Wasted debugging | Enforce `bun run check:ts` green before first `cherry-pick` |
| Auto-commit worker noise from `rtk-md-completion` branch makes upstream merge harder later | Low | Future merges noisier | Squash auto-commit history on a separate housekeeping branch before next parity port |
| Native export header fix (7.13) hides a real fork-side native regression | Low | Build breaks post-port | Run `bun run build:native` after 7.13 in isolation |

---

## Verification Steps

1. **Static**: `bun run check:ts && bun run test:ts` green on integration branch.
2. **Native**: `bun run build:native` green (catches 7.13 issues).
3. **Login flow** (if 7.1/7.2 selected): launch agent interactively → `/login` → confirm OpenRouter paste flow validates against `https://openrouter.ai/api/v1/auth/key`; xAI Grok OAuth opens browser to PKCE flow on `127.0.0.1:56121`.
4. **Env fallback**: with `OPENROUTER_API_KEY=<key>` and `XAI_OAUTH_TOKEN=<token>` set, headless runs use those keys without prompting.
5. **OpenRouter routing**: set `providers.openrouterVariant = "nitro"`, send a request, verify the model id sent to OpenRouter carries `:nitro` suffix (capture via wire log or `OPENROUTER_API_KEY` debug).
6. **Plan mode regression** (if 4.2 + 7.8 selected): enter plan mode with only read-only tools → produce a plan → approve → re-enter plan mode → verify the approved plan reopens (not a fresh `local://PLAN.md`).
7. **Read URL fallback** (if 7.10 selected): point read tool at a slow/stalling URL → confirm Jina aborts at 10s and falls back to trafilatura/lynx/native without aborting the whole call.
8. **Smoke**: `bun run ci:test:smoke` passes.

---

## Open Questions for User

1. **Which units to apply?** Mark up the per-unit tables above (e.g., "yes 7.1, 7.2, 7.3, 7.4, 7.5; skip 7.14; defer 4.5–4.7").
2. **Version policy** after porting: stay on `15.5.3` until a fork release? Bump to `15.5.7-fork.0`? Match upstream `15.5.7`?
3. **W4 `ai_smart` location** — needed to gauge real conflict surface for 7.1/7.2/7.5. If user can point to the directory or commit, conflict-risk column can be tightened from "Medium" to either "Low" or "High".
4. **Branch target**: cherry-pick onto `main` directly via PR, or stage on `rtk-md-completion` first?

---

## Notes

- Fork is `git@github.com:GratefulDave/oh-my-pi.git` with `upstream` configured (push DISABLED — good).
- `upstream/main` is 30+ commits ahead of fork `main` since v15.5.3; some of those commits are in v15.5.4/v15.5.5/v15.5.6/v15.5.7 release ranges, others are post-v15.5.7. **This plan ports only v15.5.4–v15.5.7 release-tagged work.** Post-v15.5.7 `upstream/main` commits are out of scope.
- Plan deliberately avoids running any `cherry-pick`, `merge`, or file edit before user approval; the planning module is read-only until explicit execution opt-in.
