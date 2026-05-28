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
