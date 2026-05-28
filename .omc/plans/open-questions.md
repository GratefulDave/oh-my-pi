# Open Questions

## gain-slash-remediation - 2026-05-28 (rev 3)

Open:
- [ ] T0 reproduction outcome — Gates branch decision (regression-fix branch vs T1–T7 as written). Time-boxed: if bisect exceeds 2 hours over the `338908863..HEAD` candidates, defer regression and resume hardening against current HEAD (G3)
- [ ] Whether `avgSavedRatio` (MN2) becomes a hard threshold later — Needs field data first; surfaced as a metric in T3, not enforced

## minimizer-filter-remediation - 2026-05-28 (rev 2)

Open:
- [ ] T0.1 outcome: Mode α (FFI gap on chains) vs Mode β (`plan.rs::analyze` mis-classifies git chains) — Gates whether T2b ships in PR #2 or is escalated to a separate FFI-extension plan as PR #4
- [ ] T0.5 R2 data pass: per-command miss bytes for vitest/tsc/eslint/biome/oxlint/cargo/go/golangci-lint/jest/playwright — If any exceeds pytest's 0.78 MB, escalate from Tier 3 to Tier 2 scope
- [ ] T0.4 RTK commit SHA — Pinned at PR-execute time from `rtk-ai/rtk@develop` HEAD; recorded in `ATTRIBUTION-RTK.md` and per-file headers
- [ ] T0.2 downstream grep-parser audit — Needed before flipping unconditional grouping on; env kill-switch is the fallback if a caller is missed
- [ ] Subshell + command-substitution decomposition (`S=$(git ...) && echo "$S"`, 164KB-avg outlier) — Explicitly deferred from T2b; track as follow-up
- [ ] `||` chain decomposition — Explicit non-goal in rev 2; `plan.rs` declares it `Compound` and that stays; follow-up only

Resolved (rev 2):
- B1 — uv dispatch coverage gap: `uv pytest` and `uv -m pytest` currently fall through (`mod.rs:67` + `mod.rs:148` admit only `Some("run")`); T2a extends both with `normalize_uv_form` helper + dispatch arm
- B2 — JSONL replay infeasibility: synthetic fixture corpus chosen (architect option a) over text-sidecar (option b); JSONL `MinimizerGainRecord` carries no input text (`minimizer-gain.ts:7-18`)
- B3 — Chain file references: chain code lives in `engine.rs` (lines 30-54, 73-112) + `plan.rs` (lines 35-80); `pipeline.rs` is the TOML pipeline compiler, unrelated; `detect.rs` is program-identity detection, not chain analysis
- R1 — RTK SHA pinning: captured in T0.4; `ATTRIBUTION-RTK.md` lists pinned SHA + license + ported regions; per-file header format `// Adapted from rtk-ai/rtk@<SHA>:src/cmds/python/pytest_cmd.rs — MIT, see ATTRIBUTION-RTK.md`
- R2 — Per-command miss data pass: T0.5 added as PR #2 prep; aggregation one-liner captured in plan
- R3 — Kill-switch scope and name: renamed to `OMP_MINIMIZER_LEGACY_FILTERS=1` (was `_THRESHOLDS`); single helper `config::legacy_filters_active()` consulted from listing.rs, python.rs, engine.rs
- PR split adopted: PR #1 (Tier 1 mechanical) ships independently of PR #2 (Tier 2 RTK port + uv dispatch + chain)
- Bench-vs-script: `criterion` bench chosen over shell script (architect-recommended for reproducibility)
- Pytest-xdist parallel output coverage: explicit T2c test case for `[gwN]` prefixes
- License compatibility: pi-shell inherits workspace `license = "MIT"` (`Cargo.toml:9`); RTK is MIT
- FFI surface: invariant in nominal path; Mode α (T0.1) would require escalation
- Test runner: `cargo test -p pi-shell minimizer::filters` (Rust)
- Tier 3 (rustfmt, xxd): deferred to PR #3, gated on R2 data
- Coordination with `gain-slash-remediation.md`: T4b surfaces metrics into `/gain --diag`; no blocking dependency

Resolved (rev 3):
- Test runner: `bun:test` (`packages/coding-agent/package.json:39`)
- Test layout: `packages/coding-agent/test/<name>.test.ts`; overlay tests under `test/modes/components/`
- Error counter shape: **Shape α** locked (M3) — module-level counters in `minimizer-gain.ts`. Shape β rejected because `brokenShellSessions` precedent is itself a module-level singleton; α has smaller blast radius (1 file vs 2 + 8 call sites)
- Native binding probe: `typeof applyShellMinimizer === "function"`
- CI exit-code contract: 0 healthy / 1 I/O failure or feature-off / 2 flag misuse (`--diag` with `--discover`/`--missed`/`--all`)
- `omp gain --json` regression risk: flag matrix preserves existing `{records, summary, discovery, missed}` payload unchanged (M2)
- Existing test counts in success criteria: removed; assertions are count-free to survive unrelated test additions (M1; actuals confirmed 11 in `minimizer-gain.test.ts`, 3 in `minimizer-gain-overlay.test.ts`)
- `recentMissedRatio` threshold proposal: 0.98; tune later once real-world data is available
