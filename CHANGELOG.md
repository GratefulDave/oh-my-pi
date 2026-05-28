# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Minimizer kill-switch** — `MinimizerOptions.legacy_filters` field (FFI)
  and `OMP_MINIMIZER_LEGACY_FILTERS=1` env var disable all aggressive
  filters introduced in this release. Mirrors `ai_smart_enabled`
  precedent.
- **Aggressive grep/find grouping** — `compact_grep_output` /
  `compact_find_output` always group by file/directory (previous behavior
  used 12-match / 20-path passthrough thresholds). Expected ~4 MB / 7d
  additional savings.
- **Pytest state-machine port** — `compact_pytest_output` ported from
  rtk-ai/rtk@`878af7de99e0ba71da2e8fd996f6b52a1836e06c` (MIT). Covers all
  7 invocation forms (`pytest`, `python -m pytest`, `python3 -m pytest`,
  `uv pytest`, `uv -m pytest`, `uv run pytest`, `uv run python -m
  pytest`). Expected ~0.78 MB / 7d additional savings.
- **uv dispatch fix** — `normalize_uv_form()` in `filters/mod.rs` admits
  `uv pytest` and `uv -m pytest` (previously silently fell through
  `Some("run")` gate).
- **Chain decomposer** — `engine::apply` routes `Chain` plans through
  per-segment dispatch (git-only chains → git filter; mixed chains →
  first-segment filter). Resolves Mode α from T0-OBSERVATION. Expected
  ~3 MB / 7d additional savings.
- **rustfmt filter** — diff-style output grouped by file.
- **xxd/strings/od filter** — head+tail elision for long binary dumps.
- **`/gain --diag` CLI flag + Status tab** — diagnostic surface exposing
  record counts, error counters, native binding state, file path, load
  duration.
- **Shape α error counters** — `writeErrorCount`, `lastWriteError`,
  `readErrorCount`, `lastReadError`, `parseErrorCount`,
  `lastParseError` exported from `minimizer-gain.ts`.
- **RTK attribution** — `crates/pi-shell/ATTRIBUTION-RTK.md` records
  ported regions with pinned SHA.
- **Fixture corpus** — 14 synthetic fixtures under
  `crates/pi-shell/benches/fixtures/` covering grep/find/pytest/chain
  scenarios.

### Changed

- `MinimizerOptions` FFI grows one optional field
  (`legacyFilters?: boolean`). Backwards-compatible.

### Notes

- If `OMP_MINIMIZER_LEGACY_FILTERS=1` or caller sets
  `legacyFilters: true`, `/gain --diag avgSavedRatio` reflects the
  pre-PR baseline. The diagnostic surface does not auto-detect
  kill-switch state — check env var / options first when diagnosing
  low gain.
- Production savings forecast: ~8 MB / 7d (was ~5 MB before Phase 7
  chain decomp landed).

### Deferred

- **cargo subcommand coverage audit (Phase 10)** — Local
  `~/.omp/agent/minimizer-gain.jsonl` corpus contained no cargo misses
  at audit time; the 29 cargo misses cited in the remediation plan rev
  2 were not reproducible against the current corpus. No coverage
  patches landed. Follow-up: re-run the audit against an updated
  corpus once production traffic stabilizes; if cargo subcommands such
  as `cargo metadata` or `cargo audit` reappear in the `unknown`
  bucket, extend `cargo::supports()` accordingly.

## [15.5.10] - 2026-05-28

Selective upstream parity port against `can1357/oh-my-pi` v15.5.7..**v15.5.10**.
All fork-specific divergence preserved — no blind `git merge upstream/main`.
Each cherry-pick carries a `(cherry picked from commit <SHA>)` provenance
trailer. Landed across PRs #5–#24. At parity with upstream v15.5.10; only
non-applicable upstream commits skipped (codex-removed, docs/CHANGELOG, biome
style, merge commits).

### Added

- **Tier A** (PR #5) — natives addon tarball packaging; Wafer Pass / Serverless
  providers; auth-gateway status-precedence; DSML stream healing; Anthropic
  ≥20-image downscale; `#emit` listener isolation; shebang auto-chmod.
- **Tier B** (PR #6) — auth-broker logger `setTransports` fix; MCP HTTP/SSE
  bounded startup; shared Python kernel `eval` ↔ shortcut.
- **Tier C / Obsidian** (PR #7) — Obsidian integration + `vault://` protocol
  (`vault.enabled` defaults to `false`; vault security fns ported verbatim).
- **Tier C / Vertex** (PR #8) — Vertex Claude `rawPredict` + model-catalog
  refresh on a fetch-wrapper architecture (fork non-Vertex catalog preserved).
- **Tier C / Keepalive** (PR #9) — `EventLoopKeepalive` busy-wait fix +
  idle-CPU regression test.
- **Tier C / Recovery** (PR #10) — incomplete-stop recovery (surgical manual
  port of upstream `5053a6a4d`).
- **Tier C / Auth-gateway** (PR #11) — strict-mode + completion-probe; 429
  usage-limit rotation (`markUsageLimitReached`).
- **v15.5.10 / `/drop-images`** (PR #24, `5bed80785`) — slash command that strips
  every `ImageContent` block from the current session branch (user/developer/
  custom/hookMessage/toolResult content + `toolResult.details.images` +
  `fileMention.files[].image`), rewrites the session JSONL, rebuilds the
  in-memory message list, tears down Codex Responses provider sessions, rebuilds
  the TUI chat container, and inserts an `[image removed]` placeholder where
  stripping would empty a content array. ACP returns `"Dropped N images …"`.

### Fixed

- **v15.5.10 / compaction auth fallback** (PR #24, `c4f93eca2`) — compaction
  summarizers route `stopReason === "error"` throws through
  `createSummarizationError`, copying the provider's `errorStatus` onto the
  thrown `Error.status`; `AgentSession.#isCompactionAuthFailure` now branches on
  `error.status === 401 || 403` (not just the `auth_unavailable` regex), so real
  provider auth failures retry an authenticated fallback model instead of
  surfacing the raw HTTP envelope.
- **v15.5.10 / shell pipe CPU** (PR #23, `3327d51b4`) — `pi-natives` coalesces
  queued shell-output chunks into a single batched `ThreadsafeFunction` call
  (64 KiB cap) instead of one napi dispatch per `read(2)`, fixing ~200%
  main-thread CPU pinning on chatty bash jobs (printf progress, token streams).
- **v15.5.10 / release tags** (PR #22, `1191fdedc`) — release git wrapper sets
  `fetch.pruneTags=false` and uses an atomic push-with-retry to defend against
  `git maintenance` pruning newly created tags.

### Changed

- **Tier C / Hashline** (PRs #12–#20) — rewrote `@oh-my-pi/hashline` to the
  upstream v15.5.9 `SnapshotStore` API (atomic replace). PR #12 landed the
  rewrite behind a temporary `computeFileHash` backward-compat shim; PRs
  #13–#18 migrated all six fork consumers (`read`, `search`, `ast-edit`,
  `ast-grep`, `file-mentions`, `typescript-edit-benchmark` runner) to direct
  `SnapshotStore.recordContiguous`/`recordSparse` calls — tool consumers use
  the session-scoped shared store so emitted hashline tags resolve at patch
  time; display-only/synthetic sites use an ephemeral store. PR #20 removed the
  shim and re-authored `hashline.test.ts` + `edit-diff.test.ts` against the
  capture-the-returned-tag pattern (ring tags are no longer content-addressed).
  PR #19 updated the edit/read/search tool docs accordingly.

### Notes

- Snapshot tags are now opaque ring-permutation slot tags, not content hashes;
  the patcher resolves a tag to its recorded snapshot and verifies content
  against the live file before applying edits.
- `@oh-my-pi/hashline` realigned from 15.5.9 to 15.5.10 with the rest of the
  workspace; the removed `computeFileHash` export was added and removed within
  this cycle and never shipped in a published release.

### Deferred

- `file-mentions` hashline tags remain display-only (not patch-resolvable):
  `generateFileMentionMessages` has no reachable `ToolSession`. Making them
  resolvable requires threading the session-shared store through
  `agent-session.ts` — tracked as a separate follow-up.
- Pre-existing `hashline.test.ts` baseline failures (~75) from the upstream
  parser-grammar migration (legacy `2-2:`/bare-`N:`/`EOF↓` fixtures rejected by
  the new section parser) are independent of the shim removal (0 regressions
  confirmed via stash round-trip) and tracked separately.
