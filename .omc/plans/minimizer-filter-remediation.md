# Minimizer Filter Remediation — RALPLAN-DR Plan (rev 3)

**Status:** PENDING APPROVAL
**Mode:** DELIBERATE (high-risk: touches hot-path output filters consumed by downstream parsers + FFI)
**Companion plan:** `.omc/plans/gain-slash-remediation.md` (observability/diagnostics surface — already verified pipeline-sound; this plan does NOT block on its T0)
**Target repo:** `/Users/davidandrews/PycharmProjects/lex` (omp fork, branch `feat/library-provider`)

**License posture:**
- pi-shell inherits workspace `license = "MIT"` (verified `crates/pi-shell/Cargo.toml:5` -> workspace `Cargo.toml:9`).
- RTK is MIT.
- **Direct code port is license-compatible** with attribution header + commit-SHA permalink.

**RTK SHA pinned (this revision, M1):** `878af7de99e0ba71da2e8fd996f6b52a1836e06c`
- Source: `rtk-ai/rtk@develop` HEAD as of 2026-05-28T07:00:11Z (commit "docs(readme): add Portuguese translation").
- Permalink template: `https://github.com/rtk-ai/rtk/blob/878af7de99e0ba71da2e8fd996f6b52a1836e06c/src/cmds/python/pytest_cmd.rs`.
- This is the SHA approved alongside this plan revision; any later drift on RTK `develop` is irrelevant to this plan unless a new revision is approved.

**Rev 3 changes vs rev 2:**
- **M1:** RTK SHA pinned inline at plan-approval time (this rev), not "at execute time". Permalink and attribution header template now reference a concrete SHA.
- **M2:** Kill-switch test isolation reworked. Add optional `legacy_filters: Option<bool>` field on `MinimizerOptions`, resolved into `MinimizerConfig::legacy_filters_active: bool` mirroring the existing `ai_smart_enabled` precedent (`config.rs:67,88,131-133`). FFI guardrail nuanced: additive-only optional field is non-breaking. Tests construct `MinimizerOptions { legacy_filters: Some(true), .. }` directly; no `std::env::set_var`.
- **M3:** T1a/T1b acceptance thresholds reframed from aggregate MB to per-fixture `savedRatio`. MB targets moved to §11 Consequences as post-deploy production expectations measurable against future JSONL records.
- **m4:** `normalize_uv_form` signature, token-scan rule, and dispatch contract specified.
- **m5:** T0.1 adds a `tracing::trace!` probe fallback to disambiguate Mode α vs β when code-read alone is inconclusive.
- **m6:** T4a/T4b fixture filenames enumerated explicitly and reconciled with T2c test scenarios.
- **m7:** Operational note added on kill-switch ↔ `/gain --diag` cross-coupling.

---

## 1. Principles (decision-time invariants)

1. **Always-shrink over conditional-shrink.** Threshold-gated passthrough hides savings on the long tail of small-but-frequent invocations. RTK's win comes from unconditional grouping; we adopt that posture.
2. **Port logic, attribute source.** Where RTK has a solved problem (pytest state machine, find/grep grouping), port the algorithm with a header comment containing RTK permalink + commit SHA `878af7de99e0ba71da2e8fd996f6b52a1836e06c`. MIT-MIT compatibility makes the direct port free of legal review.
3. **Script-assertable acceptance.** Every tier ends with a `cargo test` exit code OR a per-fixture `savedRatio` from the replay benchmark against a synthetic fixture corpus. No "looks better" claims; no aggregate-MB claims on synthetic inputs.
4. **Separate authoring from verification.** Writer pass produces edits; a distinct reviewer/verifier pass executes the benchmark replay and compares miss-rate before/after. Never self-approve in the same context.
5. **Downstream parser safety.** Filter output is consumed by napi-rs FFI surface and by callers that may parse the rewritten text. Audit before flipping unconditional behavior on; provide a single broadly-scoped kill-switch (config-resolved with env fallback) for whole-Tier rollback within one release.

## 2. Decision Drivers (top 3, ranked)

1. **Recoverable bytes per work-unit.** The JSONL evidence concentrates value in 4 commands (git 3.4 MB, grep 2.6 MB, find 1.4 MB, uv/pytest 0.78 MB). Effort allocation follows the bytes.
2. **Regression blast radius.** Grep/find/pytest filter changes risk breaking spawn-and-parse callers. Driver biases toward: (a) audit pass before flipping, (b) single broad-scope kill-switch resolvable per-call (not process-global), (c) keeping existing tests green or explicitly migrated, (d) PR split so the mechanical Tier 1 lands independently of the higher-risk Tier 2.
3. **Time-to-first-savings.** Tier 1 (three threshold deletions + tests + small synthetic corpus) ships as PR #1; Tier 2 (port pytest state machine + uv dispatch fix + chain decomposer improvements) ships as PR #2 after blockers resolved.

## 3. Options Considered

### Option A — Threshold drops only (Tier 1)
- **Scope:** `compact_grep_output` + `compact_find_output` early-exits removed; tests updated; small fixture corpus for grep/find.
- **Pros:** Smallest blast radius; biggest single bytes/loc ratio.
- **Cons:** Leaves the git-chain miss and pytest miss entirely on the table.
- **Verdict:** Necessary but insufficient. Subset of B. **Adopted as PR #1 in the split.**

### Option B — Threshold drops + RTK logic port + uv dispatch fix (Tier 1 + Tier 2)
- **Scope:** A, plus port `rtk::cmds::python::pytest_cmd` state machine into `python.rs`, plus extend uv dispatch in `filters/mod.rs` to admit `uv pytest`/`uv -m pytest`/`uv ruff`/`uv mypy` etc., plus improve chain handling in `engine.rs` + `plan.rs` so git-only chains route every segment through the git filter via `SegmentedChain`.
- **Pros:** Addresses all four dominant miss sources. License-clean. Expected total recovery ~7+ MB on observed 7d workload.
- **Cons:** Larger surface to test. Chain change sits upstream of every filter; bug there is high-impact.
- **Verdict:** **CHOSEN.** Aligns with Driver #1 (follows the bytes) and Driver #3 (split into two PRs).

### Option C — Full RTK parity (Tiers 1 + 2 + 3, including rustfmt/xxd net-new filters)
- **Scope:** B, plus new `rust_tools.rs` for rustfmt and an `xxd` head+tail filter.
- **Pros:** Eliminates the remaining miss tail.
- **Cons:** rustfmt is 6 invocations / 0.23 MB total; xxd is 1 invocation. **R2 data pass may shift priorities** (vitest/tsc/cargo/go misses might exceed pytest); defer until that data is collected.
- **Verdict:** Deferred to a follow-up plan, gated on R2 data.

### Option D — Status quo + reviewer-only diagnostics
- **Scope:** Do nothing here; rely on companion `gain-slash-remediation.md` for visibility only.
- **Pros:** Zero regression risk.
- **Cons:** Leaves ~7 MB/7d on the table.
- **Verdict:** Rejected.

**Selection rationale:** Option B with a PR split is the inflection point. Tier 1 ships fast and de-risks the program; Tier 2 lands after blockers resolved.

---

## 4. Work Objectives

**Lift overall minimizer saved-ratio from current baseline (84% on records that hit) AND convert miss-rate from ~82% toward ~50%** by:

- Removing all conditional passthroughs in `compact_grep_output` and `compact_find_output`.
- **Fixing the uv dispatch coverage gap** so `uv pytest` and `uv -m pytest` route to the python filter (currently fall through).
- Porting RTK's `pytest_cmd` state machine (at pinned SHA) into pi-shell's python filter.
- Improving chain handling in `engine.rs` + `plan.rs` so multi-segment git chains see per-segment filter application.
- Adding a replay benchmark powered by a **named, deterministic synthetic fixture corpus** (the existing JSONL records lack input text and are unusable for replay without a schema change).

## 5. Guardrails

### Must Have
- **License attribution at pinned SHA `878af7de99e0ba71da2e8fd996f6b52a1836e06c`.** Every ported function carries a header comment matching the template in T0.4. `ATTRIBUTION-RTK.md` lists the SHA + license text + ported regions.
- Baseline test pass: `cargo test -p pi-shell minimizer` must be green before any commit lands; the baseline test count is recorded in T0.
- Replay benchmark exists and runs (Tier 4) against the named synthetic fixture corpus.
- ADR section committed to the plan and to each PR description.
- **Single broadly-scoped kill-switch.** Resolved at `MinimizerConfig::from_options()` time:
  - FFI input: optional `legacy_filters: Option<bool>` field on `MinimizerOptions`.
  - Resolution precedence: explicit `Some(bool)` from caller wins; else read `OMP_MINIMIZER_LEGACY_FILTERS` env var once at construction; default `false`.
  - Stored on resolved `MinimizerConfig.legacy_filters_active: bool`; read per-call via `ctx.config.legacy_filters_active()` (cheap bool deref).
  - Mirrors the existing `ai_smart_enabled` precedent at `crates/pi-shell/src/minimizer/config.rs:67,88,131-133`.
  - Gates Tier 1 grep/find always-group, Tier 2a pytest state machine, Tier 2b chain handling improvements.
- Downstream parser audit (T0.2) completed before flipping unconditional behavior on.

### Must NOT Have
- No copy-paste of RTK code without attribution header.
- No filter-side changes that **break** the FFI surface. **Nuance (M2):** adding an optional `legacy_filters: Option<bool>` field to `MinimizerOptions` is additive-only and follows the existing `ai_smart` field precedent; this is permitted and explicitly does NOT break existing callers (defaults to `None`). `applyShellMinimizer` signature itself is unchanged.
- No removal or rewrite of existing `listing.rs` tests without an explicit migration note.
- No `std::env::set_var` in tests for kill-switch parity — tests pass `Some(true)` via `MinimizerOptions` (M2).
- No edits to source files during the plan phase. This artifact is plan-only.
- No CI gating on the replay benchmark in the first PR (developer tool, not a CI gate).
- No decomposition inside subshells `()` or command substitutions `$()` in this plan series — explicit non-goal; follow-up.
- No changes to `||` chain handling — `plan.rs:16-17` declares it `Compound` (opaque) and that stays.

---

## 6. Task Flow (PR-split adopted per architect recommendation)

```
PR #1 (low-risk mechanical)
  Pre-flight (T0.1, T0.2, T0.3, T0.4 [SHA already pinned], T0.5)
    --> Tier 1: T1a (drop grep early-exit + kill-switch wiring)
        Tier 1: T1b (drop find threshold)
        Tier 1: T1c (tests via MinimizerOptions kill-switch field)
        Config: add `legacy_filters_active` field + resolver (M2)
        Tier 4-lite: T4a (named grep/find fixtures + bench scaffold)

PR #2 (Tier 2 — after blockers resolved + R2 data pass complete)
    --> Tier 2: T2a (RTK pytest port at pinned SHA + uv dispatch fix)
        Tier 2: T2b (chain handling improvements in engine.rs + plan.rs, gated on T0.1 outcome)
        Tier 2: T2c (tests for T2a + T2b + kill-switch parity via MinimizerOptions)
        Tier 4-full: T4b (named pytest + chain fixtures; before/after table)

PR #3 (optional, gated on R2 data; only if vitest/tsc/cargo/go miss > pytest miss, or by explicit request)
  Tier 3 deferred items
```

PR #1 is small, mechanical, low-risk. PR #2 carries the RTK-port surface, the uv dispatch fix, and the chain handling change. PR #3 is conditional.

---

## 7. Detailed TODOs

### T0 — Pre-flight (PR #1 only)

- **T0.1 — Map chain handling.** Read `crates/pi-shell/src/minimizer/engine.rs` (lines 30-54 `mode_for`, 73-112 `apply`) and `plan.rs` (lines 35-80 `ChainSegment`, `CommandPlan`, `analyze`). Document in PR description:
  - How `mode_for` returns `MinimizerMode::{None, WholeCommand, SegmentedChain}`.
  - That `apply()` returns `passthrough(captured).labeled("compound")` for `CommandPlan::Chain` whole-buffer captures (intentional — the segmented runner is the chain path, not `apply`).
  - Whether the JS side actually invokes the segmented runner per chain segment, or whether it only ever calls the whole-buffer `apply` (this determines whether the 658 git-chain misses come from `apply` labeling them "compound" or from segmented dispatch never firing).
  - **m5 trace-probe fallback.** If code-read of `applyShellMinimizer` napi-rs surface + JS caller is ambiguous, add a temporary `tracing::trace!("segmented chain dispatch", segments = segments.len())` at `engine.rs:43-49` (inside the `SegmentedChain` arm of `mode_for`, or at the segmented-runner entry point if it lives elsewhere). Build, run `git status && git log -1` via the live binary with `RUST_LOG=trace`. Trace fires -> Mode β (decoder bug, fix in `plan.rs::analyze`). Trace absent -> Mode α (FFI never invokes segmented runner; escalate per Scenario 2). Remove the trace before commit.
- **T0.2 — Downstream grep-parser audit.** Search the omp codebase for spawn-and-parse callers of grep output: `Command::new("grep")`, `\.arg("grep"`, `spawn.*grep`, plus napi-rs callers that re-parse text from `applyShellMinimizer`. Document each hit. If any caller depends on raw grep `path:line:content` format, route them around the filter via the kill-switch.
- **T0.3 — Baseline test pass.** Run `cargo test -p pi-shell minimizer` and record pass count. Regression floor.
- **T0.4 — RTK attribution (SHA already pinned at plan-approval; this task is mechanical).** SHA = `878af7de99e0ba71da2e8fd996f6b52a1836e06c`. Tasks:
  - Create `crates/pi-shell/ATTRIBUTION-RTK.md` with: pinned SHA, MIT license text (copied from `rtk-ai/rtk/LICENSE` at this SHA), list of ported regions (per-file `(rtk_path, omp_path, lines_ported, function_names)` tuples).
  - Per-file header template (apply to every file containing ported code):
    ```rust
    // Adapted from rtk-ai/rtk@878af7de99e0ba71da2e8fd996f6b52a1836e06c
    // Source: src/cmds/python/pytest_cmd.rs (or equivalent path)
    // License: MIT — see crates/pi-shell/ATTRIBUTION-RTK.md
    // Permalink: https://github.com/rtk-ai/rtk/blob/878af7de99e0ba71da2e8fd996f6b52a1836e06c/src/cmds/python/pytest_cmd.rs
    ```
  - If the SHA needs to change between now and merge (e.g. RTK fixes a bug we want), revise the plan first; do not silently drift.
- **T0.5 — R2 data pass (PR #2 prep, can run before PR #1 ships).** Aggregate misses by `program` for vitest/tsc/eslint/biome/oxlint/cargo/go/golangci-lint/jest/playwright from `~/.omp/agent/minimizer-gain.jsonl`. Suggested one-liner (run via `node` or `bun`):
  ```bash
  node -e 'const fs=require("fs"); const lines=fs.readFileSync(process.env.HOME+"/.omp/agent/minimizer-gain.jsonl","utf8").split("\n"); const m=new Map(); for(const l of lines){let r; try{r=JSON.parse(l)}catch{continue} if(r.kind!=="missed")continue; const c=(r.command||"").trim().split(/\s+/)[0]; if(["vitest","tsc","eslint","biome","oxlint","cargo","go","golangci-lint","jest","playwright"].includes(c)){const e=m.get(c)||{n:0,b:0}; e.n++; e.b+=r.inputBytes; m.set(c,e)}} for(const [k,v] of [...m.entries()].sort((a,b)=>b[1].b-a[1].b)) console.log(`${k}: ${v.n} cmds, ${v.b} bytes`)'
  ```
  Append table to PR #2 description. **If any program exceeds pytest's 0.78 MB**, escalate it from Tier 3 to Tier 2 scope.
- **T0.6 — Kill-switch config wiring (PR #1, before T1a).** Per M2:
  - Add field `legacy_filters: Option<bool>` to `MinimizerOptions` (FFI-facing). Default `None`. Tag `#[napi(ts_type = "boolean | undefined")]` or equivalent following the existing optional-field convention in that struct.
  - Add field `legacy_filters_active: bool` to `MinimizerConfig` (parsed/resolved).
  - In `MinimizerConfig::from_options`, resolve:
    ```rust
    let legacy_filters_active = options.legacy_filters
        .unwrap_or_else(|| std::env::var_os("OMP_MINIMIZER_LEGACY_FILTERS")
            .map(|v| v == "1" || v == "true")
            .unwrap_or(false));
    ```
  - Add accessor `impl MinimizerConfig { pub fn legacy_filters_active(&self) -> bool { self.legacy_filters_active } }`.
  - One unit test in `config.rs` covers: `None` + env unset = false; `None` + env "1" = true; `Some(true)` + env unset = true; `Some(false)` + env "1" = false.
- **Acceptance (T0):** Six items documented in the PR #1 description before any code change lands. Baseline test count recorded. `ATTRIBUTION-RTK.md` exists with pinned SHA. Kill-switch config wiring + unit test merged.

### T1a — Drop `compact_grep_output` early-exit (PR #1)
- **File:** `crates/pi-shell/src/minimizer/filters/listing.rs`
- **Change:** Remove `if grouped.is_empty() || match_count <= 12 && grouped.len() <= 3 { return input.to_string(); }`. Always group; retain the 12 matches/file × 12 files caps. At the top of `compact_grep_output`, check `if ctx.config.legacy_filters_active() { return input.to_string(); }` for kill-switch parity (M2: per-call, via config, not env).
- **Acceptance (M3, per-fixture savedRatio):**
  - Average savedRatio across grep fixtures `grep_small_1m1f.txt`, `grep_medium_3m1f.txt`, `grep_large_100m10f.txt` >= 0.50.
  - Large-fixture (`grep_large_100m10f.txt`) savedRatio >= 0.70.
  - `cargo test -p pi-shell minimizer::filters::listing` passes with updated tests from T1c.

### T1b — Drop `compact_find_output` threshold (PR #1)
- **File:** `crates/pi-shell/src/minimizer/filters/listing.rs`
- **Change:** Remove `if paths.len() <= 20 { return input.to_string(); }`. Always group by directory. Same kill-switch parity guard as T1a (via `ctx.config.legacy_filters_active()`).
- **Acceptance (M3, per-fixture savedRatio):**
  - Average savedRatio across find fixtures `find_shallow_5p1d.txt`, `find_deep_50p8d.txt`, `find_wide_200p1d.txt` >= 0.40.
  - Deep-fixture (`find_deep_50p8d.txt`) savedRatio >= 0.60.
  - Tests pass.

### T1c — Update listing.rs tests + kill-switch parity (PR #1, M2)
- **File:** `crates/pi-shell/src/minimizer/filters/listing.rs` (test module at lines 1033-1268)
- **Change:** Add cases for: (a) 1 match in 1 file, (b) 3 matches in 1 file, (c) 5 paths in 1 dir for find, (d) mix of root + nested paths. Existing tests that asserted passthrough are migrated with comment `// migrated for always-group: see T1a/T1b`.
- **Kill-switch parity tests (M2 — no env mutation):** Construct two `MinimizerOptions`:
  - `MinimizerOptions { legacy_filters: Some(true), .. }` -> resolved `MinimizerConfig.legacy_filters_active == true` -> grep/find output matches pre-PR byte-for-byte.
  - `MinimizerOptions { legacy_filters: Some(false), .. }` (or `None` with env unset) -> resolved `false` -> new always-group output.
- No `#[serial]` annotation required; tests are parallel-safe.
- **Acceptance:** All new tests green. Migration list captured in PR description.

### T2a — Port RTK pytest state machine + fix uv dispatch coverage gap (PR #2)
- **Files:** `crates/pi-shell/src/minimizer/filters/python.rs` (new function `compact_pytest_output`), `crates/pi-shell/src/minimizer/filters/mod.rs` (uv dispatch fix).
- **B1 fix — uv dispatch.** Coverage matrix verified against `mod.rs:67`, `mod.rs:148`, `mod.rs:244-252`:

  | Form | Pre-fix routes? | Post-fix routes? |
  |---|---|---|
  | `pytest <args>` | YES | YES |
  | `python -m pytest …` | YES | YES |
  | `python3 -m pytest …` | YES | YES |
  | `uv run pytest …` | YES | YES |
  | `uv run python -m pytest …` | YES | YES |
  | `uv pytest <args>` | **NO** | **YES** (fix) |
  | `uv -m pytest <args>` | **NO** | **YES** (fix) |

- **m4 — `normalize_uv_form` spec:**
  ```rust
  /// Given a uv invocation, return the normalized (program, subcommand)
  /// tuple if a known wrapped tool is detected. Returns None to pass-through.
  ///
  /// Resolution order:
  ///   1. If `subcommand` is itself a known tool name (pytest/ruff/mypy),
  ///      return Some(("python", subcommand_clone)) for python tools, or
  ///      Some((tool, tool)) for lint/test tools (preserves filter routing).
  ///   2. Else if `subcommand` is "-m", scan `command` for the first non-flag
  ///      token following "-m" matching the python-tool allowlist
  ///      {pytest, ruff, mypy}; return Some(("python", tool.to_string())).
  ///   3. Else if `subcommand` is "run", fall through to the existing
  ///      `wrapper_invoked_tool` path (no change in behavior).
  ///   4. Else return None.
  fn normalize_uv_form(
      program: &str,
      subcommand: Option<&str>,
      command: &str,
  ) -> Option<(String, String)>
  ```
  - Output `subcommand` is the **resolved tool name** (e.g. `"pytest"`), never `"-m"` or `"run"`.
  - Allowlist for `-m` token scan (PR #2 scope): `pytest`, `ruff`, `mypy`. Lint/test wrappers (`tsc`, `eslint`, etc.) under `uv -m` are out of PR #2 scope; if encountered, return `None` and pass through.
- **Implementation:**
  - Extend `mod.rs:67` `supports()` arm for `uv` to admit subcommand in {`run`, `pytest`, `ruff`, `mypy`, `-m`, `tsc`, `eslint`, `biome`, `pyright`, `basedpyright`, `oxlint`, `jest`, `vitest`, `playwright`}.
  - Extend `mod.rs:148` `filter()` dispatch arm for `uv` likewise — call `filter_uv_wrapper` when subcommand is in that set.
  - `filter_uv_wrapper` calls `normalize_uv_form` first; if `Some((program, subcommand))`, construct a new `MinimizerCtx` and route through the matching filter (per existing `mod.rs:179-221` dispatch table); if `None`, fall through to the existing `wrapper_invoked_tool`-based path for backwards compatibility.
- **RTK port — pytest state machine at SHA `878af7de99e0ba71da2e8fd996f6b52a1836e06c`.** Port `ParseState::{Header, TestProgress, …}` and `build_pytest_summary(summary, test_files, failures, xfail_lines)` from `rtk::src::cmds::python::pytest_cmd` at the pinned SHA. Keep failures + xfail + final summary; strip PASSED. Unknown-state lines fall through to passthrough (preserve RTK's defensive behavior so xdist `[gwN]` or custom-reporter output never causes data loss).
- **Attribution header:** Per T0.4 template, exact SHA `878af7de99e0ba71da2e8fd996f6b52a1836e06c`.
- **Kill-switch parity:** `compact_pytest_output` checks `ctx.config.legacy_filters_active()` at the top and returns input unchanged when active (M2 pattern, no env access).
- **Acceptance:**
  - Unit tests (T2c) demonstrate `compact_pytest_output` savedRatio >= 0.60 on `pytest_10pass_1fail.txt` and `pytest_5pass_1xfail_1skip.txt` fixtures.
  - Four new uv-dispatch tests pass (2 new for `uv pytest` / `uv -m pytest`, 2 regression-guard for `uv run pytest` / `uv run python -m pytest`).

### T2b — Improve chain handling in `engine.rs` + `plan.rs` (PR #2)
- **B3 fix — file references corrected.** Chain code lives in `crates/pi-shell/src/minimizer/engine.rs` (lines 30-54 `mode_for`, 73-112 `apply`) and `crates/pi-shell/src/minimizer/plan.rs` (lines 35-80 `ChainSegment`, `CommandPlan`, `analyze`). **Not** `detect.rs` or `pipeline.rs` (`pipeline.rs:1-21` doc identifies it as the TOML pipeline compiler, unrelated).
- **Investigation gate (T0.1 determines which mode, including m5 trace fallback):**
  - **Mode α — JS side never invokes segmented runner.** If `applyShellMinimizer` only exposes the whole-buffer `apply()` path, then `CommandPlan::Chain` invocations land at `engine.rs:92-94` and get labeled `"compound"`. Fix would require an FFI extension. **STOP and escalate per Scenario 2.**
  - **Mode β — Segmented runner fires but `plan.rs::analyze` mis-classifies `git X && git Y` as `Compound`/`Unsupported`.** Fix in `plan.rs::analyze` so the AST walk reliably returns `CommandPlan::Chain { segments }`.
- **Change (gated on T0.1 outcome):**
  - If Mode α: escalate; this task moves to PR #4 (separate FFI plan).
  - If Mode β: improve `plan.rs::analyze` per the failing AST shape uncovered in T0.1. Confirm `engine.rs::mode_for` returns `SegmentedChain` for `git A && git B && git C`.
- **Explicit non-goals:** `||` chains stay `Compound`. Subshells `()` and command substitution `$()` stay `Unsupported`/`Compound`. Assignment-prefixed segments `S=$(git ...) && echo "$S"` documented as follow-up.
- **Kill-switch parity (M2):** Read `config.legacy_filters_active()` at the chain-decode site; when `true`, fall back to pre-fix behavior (whole-buffer passthrough labeled `compound`).
- **Acceptance:** Chain decomposition produces per-segment filter output for >= 50% of `chain_git_3segments.txt` and `chain_mixed_segments.txt` fixture runs (per-fixture, not aggregate-MB). Unit tests in T2c cover this directly.

### T2c — Tests for T2a + T2b (PR #2, M2 — no env mutation)
- **File:** new test modules under `python.rs`, `mod.rs` (for uv dispatch), and the chosen engine/plan file.
- **Coverage:**
  - **pytest:** `pytest_10pass_1fail`, `pytest_5pass_1xfail_1skip`, `pytest_all_passed` (must compact to summary line), `pytest_zero_tests` (passthrough), `pytest_xdist` (`[gw0]`/`[gw1]` prefixes, per Scenario 3 mitigation), `pytest_malformed`.
  - **uv dispatch (B1, m4):** `uv pytest tests/` -> python filter (NEW); `uv -m pytest tests/` -> python filter (NEW); `uv run pytest tests/` -> python filter (regression guard); `uv run python -m pytest tests/` -> python filter (regression guard).
  - **chain:** `git A && git B`; `git A && git B && git C`; `git A; git B`; mixed `git A && cargo build` (git -> git filter, cargo -> cargo filter); negative `git A || git B` (Compound passthrough); negative `git A | grep foo` (Piped passthrough); assignment `S=$(git ...) && echo "$S"` (follow-up passthrough).
  - **kill-switch (M2):** Construct `MinimizerOptions { legacy_filters: Some(true), .. }` and assert byte-for-byte parity for grep, find, pytest, chain (4 assertions). Construct `Some(false)` and assert new behavior fires (4 assertions). No `std::env::set_var` anywhere.
- **Acceptance:** `cargo test -p pi-shell minimizer` passes; new test counts recorded in PR description.

### T3 — Deferred (PR #3 only if R2 data justifies)
- **T3a** rustfmt filter in `rust_tools.rs` — group by file, summarize counts.
- **T3b** xxd head+tail filter.
- **T3c** Anything R2 (T0.5) surfaces as exceeding pytest's 0.78 MB miss footprint. Plan triggered only if data warrants.

### T4a — Synthetic fixture corpus + bench scaffold (PR #1, grep+find only — m6)
- **Files:**
  - New `crates/pi-shell/benches/fixtures/` directory.
  - New `crates/pi-shell/benches/minimizer_workload.rs` using `criterion`.
- **Tier 1 fixture filenames (m6):**
  - `grep_small_1m1f.txt` — 1 match in 1 file (was passthrough pre-PR).
  - `grep_medium_3m1f.txt` — 3 matches in 1 file (was passthrough pre-PR; gates T1a's "below 12" win).
  - `grep_large_100m10f.txt` — 100 matches across 10 files (already grouped pre-PR; regression guard).
  - `find_shallow_5p1d.txt` — 5 paths in 1 dir (was passthrough pre-PR).
  - `find_deep_50p8d.txt` — 50 paths across 8 nested dirs (key T1b win).
  - `find_wide_200p1d.txt` — 200 paths in 1 dir (already grouped pre-PR; regression guard).
- Each fixture >= 2 KB raw text; deterministic content (no timestamps/PIDs).
- **Bench behavior:** iterate fixtures, invoke `filters::dispatch` (or `engine::apply` per T0.1 finding), emit before/after table per fixture: `fixture | inputBytes | outputBytes | savedRatio`. Committed as `crates/pi-shell/benches/baseline-results.md`.
- **Not on CI.** Local-developer tool.
- **Acceptance:** Bench runs to completion; baseline-results.md committed; T1a/T1b per-fixture thresholds (§7 above) are met.

### T4b — Extend corpus + bench for pytest + chains (PR #2 — m6)
- **Pytest fixture filenames (m6, reconciled with T2c):**
  - `pytest_10pass_1fail.txt`
  - `pytest_5pass_1xfail_1skip.txt`
  - `pytest_all_passed.txt`
  - `pytest_zero_tests.txt`
  - `pytest_xdist.txt` (parallel `[gwN]` prefixes)
  - `pytest_malformed.txt`
- **Chain fixture filenames (m6):**
  - `chain_git_3segments.txt` — `git status --short && git branch --show-current && git describe`-style synthetic input.
  - `chain_mixed_segments.txt` — `git status && cargo build && git push`-style.
- Each fixture >= 2 KB raw text.
- Re-run bench, update `baseline-results.md` with PR #2 numbers.
- **Companion coordination:** Surface `avgSavedRatio` improvement in `/gain --diag` output added by `.omc/plans/gain-slash-remediation.md`. No FFI changes — the diag command reads the same JSONL.

---

## 8. Pre-mortem (DELIBERATE mode — 3 distinct failure scenarios)

### Scenario 1 — Downstream parser breakage on grep
**Story:** An omp internal tool or a user's shell script pipes `grep -rn pattern src/` and parses the output line-by-line expecting `path:line:content` format. After T1a lands, output starts with a `"N matches in M files"` header and is grouped by file. The parser breaks. CI may miss this because the parser lives in a downstream NPM consumer or in the napi-rs FFI test surface, not in `cargo test`.
**Probability:** Medium. T0.2 audit reduces but does not eliminate.
**Mitigation:** Kill-switch shipped in the same PR (M2 pattern: callers set `MinimizerOptions.legacy_filters = Some(true)`, or end-users set env `OMP_MINIMIZER_LEGACY_FILTERS=1`). Documented in PR body + minimizer README. Note: per `plan.rs:10-13` and `engine.rs:95-97`, any grep that is piped (`grep foo | jq`) already passes through unchanged — the filter only fires on bare `grep`. This caps real-world blast radius.
**Detection signal:** User-reported parse errors within 48h; kill-switch flip is the immediate rollback.

### Scenario 2 — Chain handling change exposes Mode α (FFI gap)
**Story:** T0.1 (including the m5 trace probe) discovers that `applyShellMinimizer` only invokes the whole-buffer `apply()` path. `CommandPlan::Chain` therefore always lands at the `passthrough(captured).labeled("compound")` branch (`engine.rs:92-94`). The "fix" requires an FFI extension, which violates the no-breaking-FFI guardrail.
**Probability:** Medium. JS bindings appear minimal; segmented dispatch may not be exposed.
**Mitigation:** T0.1 must determine which mode. If Mode α: STOP, escalate, scope a follow-up plan for the FFI extension; PR #2 ships only T2a (pytest + uv dispatch) without T2b. PR #2 still delivers the pytest gains (~0.78 MB) and the uv-dispatch coverage fix; the chain gains move to PR #4. **The plan must not silently widen the FFI surface beyond the M2 additive optional field.**
**Detection signal:** T0.1 reading + m5 trace probe; no runtime detection needed.

### Scenario 3 — RTK pytest port (SHA `878af7de`…) misses a real-workload edge case
**Story:** Our `uv run pytest` invocations include flags or output patterns RTK has not seen — `pytest-xdist` parallel output with `[gwN]` prefixes, custom reporters, or `pytest --verbose -s` with intermixed captured stdout. The state machine drops into the wrong state and either (a) strips a real failure, (b) leaves a 40KB output untouched, or (c) panics on an unexpected line.
**Probability:** Medium. RTK is battle-tested but not against our exact uv-wrapped invocations.
**Mitigation:** Port preserves RTK's "unknown state -> fall through to passthrough for that line" behavior. T2c includes an explicit `pytest_xdist.txt` test case. Kill-switch covers this too: `MinimizerOptions.legacy_filters = Some(true)` (or env) disables `compact_pytest_output` and the uv wrapper falls back to its pre-fix passthrough.
**Detection signal:** Synthetic fixture replay shows zero or negative delta on pytest fixtures, OR `cargo test` failure on the xdist case during T2c, OR user reports of test-failure output being stripped.

---

## 9. Expanded Test Plan (DELIBERATE mode)

### Unit
- `compact_grep_output`: 1-match-1-file, 3-matches-1-file, 13-matches-1-file (above old cap), grouped-multi-file, empty input, kill-switch parity via `MinimizerOptions`.
- `compact_find_output`: 1-path, 5-paths-1-dir, 21-paths (above old threshold), mixed root+nested, empty input, kill-switch parity.
- `compact_pytest_output`: all-passed, mixed pass/fail, xfail+skipped, xdist parallel output, zero-tests, malformed/truncated, kill-switch parity.
- uv dispatch (`normalize_uv_form`): all 7 forms in the §7 T2a coverage matrix, plus a None-returning case (unknown subcommand).
- Chain: 2-segment git, 3-segment git, `;`-separated, mixed git+cargo, `||` negative, pipe negative, assignment-capture negative, kill-switch parity.
- `MinimizerConfig` resolver (M2): explicit `Some(true)` / `Some(false)` / `None`+env / `None`+no-env -> 4 cases.

### Integration
- End-to-end through `engine::apply` (whole-buffer path) and the segmented runner for representative inputs.
- Kill-switch integration: with `MinimizerOptions { legacy_filters: Some(true), .. }`, output for grep/find/pytest/chain matches the pre-PR baseline byte-for-byte.

### E2E (synthetic fixture replay, T4)
- Run bench against `crates/pi-shell/benches/fixtures/`. Confirm per-fixture savedRatio meets acceptance thresholds in T1a/T1b/T2a/T2b. Save before/after table as `crates/pi-shell/benches/baseline-results.md`.

### Observability
- Companion plan's `/gain --diag` surfaces post-PR `avgSavedRatio` and per-command hit/miss counts.
- Add a `trace!` event in `filters::dispatch` (or `engine::apply`) emitting filter routing decisions for future regression tracing.

---

## 10. Open Items Resolution

**Resolved this rev (rev 3):**
1. **License compatibility** — RESOLVED (rev 1). Workspace MIT × RTK MIT = direct port with attribution.
2. **Test runner** — `cargo test -p pi-shell minimizer`. T0.3 baseline.
3. **Regression risk on grep** — T0.2 audit + single broad-scope kill-switch.
4. **FFI surface stability** — Confirmed `applyShellMinimizer` signature invariant in normal path. **Additive `legacy_filters: Option<bool>` field on `MinimizerOptions` is permitted per `ai_smart` precedent (M2)** and explicitly does not break existing callers. Mode α (T0.1 outcome) for chains would require a separate breaking FFI plan.
5. **Existing tests in listing.rs** — T1c migration plan.
6. **Pre-mortem** — Three scenarios documented in §8.
7. **Acceptance criteria** — Script-assertable; reframed to per-fixture savedRatio (M3).
8. **ADR** — §11.
9. **Coordination with `gain-slash-remediation`** — T4b surfaces metrics into `/gain --diag`. No blocking dependency. **m7 cross-coupling note:** kill-switch state is not auto-detected by diag; see §11 Operational.
10. **B1 — uv dispatch coverage gap** — RESOLVED in T2a + `normalize_uv_form` spec (m4).
11. **B2 — JSONL replay infeasibility** — RESOLVED. Named synthetic fixture corpus (m6 filenames).
12. **B3 — chain file references** — RESOLVED. Chain code is in `engine.rs` + `plan.rs`.
13. **M1 — RTK SHA pinned NOW.** SHA = `878af7de99e0ba71da2e8fd996f6b52a1836e06c` recorded in §1, §T0.4, and the per-file header template.
14. **M2 — Kill-switch test isolation.** Resolved via `MinimizerOptions.legacy_filters: Option<bool>` field mirroring `ai_smart` precedent; tests construct `MinimizerOptions` directly; no `std::env::set_var`.
15. **M3 — Acceptance thresholds reframed.** Per-fixture savedRatio in T1a/T1b/T2a/T2b; aggregate MB targets moved to §11 Consequences as post-deploy production expectations.
16. **m4 — `normalize_uv_form` spec.** Signature, allowlist for `-m` scan, output contract documented in T2a.
17. **m5 — T0.1 trace probe fallback.** Added to T0.1 body for Mode α/β disambiguation when code-read alone is inconclusive.
18. **m6 — Fixture filename enumeration.** T4a/T4b list deterministic filenames reconciled with T2c scenarios.
19. **m7 — Kill-switch / diag cross-coupling note.** Added to §11 Operational.

**Still open (tracked in `.omc/plans/open-questions.md`):**
- T0.1 outcome: Mode α vs Mode β for chain handling. Gates whether T2b ships in PR #2 or moves to PR #4.
- T0.5 R2 data: per-command miss numbers for vitest/tsc/cargo/go. May reshape Tier 3 priority.

---

## 11. ADR

### Decision
Adopt **Option B with a PR split**: drop the threshold passthroughs in `compact_grep_output` and `compact_find_output` (PR #1), port RTK's `pytest_cmd` state machine at pinned SHA `878af7de99e0ba71da2e8fd996f6b52a1836e06c` into `python.rs`, fix the uv dispatch coverage gap for `uv pytest` / `uv -m pytest`, and improve chain handling in `engine.rs`+`plan.rs` (PR #2). Ship behind a kill-switch resolved via `MinimizerOptions.legacy_filters: Option<bool>` with env fallback `OMP_MINIMIZER_LEGACY_FILTERS=1`. Defer rustfmt/xxd to PR #3, gated on R2 data.

### Drivers
1. **Recoverable bytes per work-unit** — concentrates effort on the 4 commands accounting for ~98% of recoverable bytes.
2. **Regression blast radius** — kill-switch + downstream audit + PR split + reviewer separation.
3. **Time-to-first-savings** — PR #1 lands fast and mechanically; PR #2 lands after blockers resolved.

### Alternatives Considered
- **Option A (Tier 1 only):** Insufficient. Adopted as the PR #1 scope within Option B.
- **Option C (full Tier 1+2+3):** Tier 3 ROI per LOC very low. Deferred. **R2 data may shift this** — if vitest/tsc/cargo/go miss exceeds pytest, T3c reactivates.
- **Option D (do nothing):** Rejected.
- **Unified single PR:** Rejected. Tier 1 is mechanical and ships independently; bundling delays the safe wins behind the riskier changes.
- **Env-only kill-switch (rev 2 design):** Rejected. Process-global env breaks `cargo test` parallel test isolation. Resolved via `MinimizerOptions` field per `ai_smart` precedent (M2).
- **Aggregate-MB acceptance thresholds (rev 2 design):** Rejected. 6-fixture synthetic corpus cannot deliver 7-day production aggregates; per-fixture savedRatio is the correct oracle (M3). Aggregate MB targets retained as post-deploy production expectations.

### Why Chosen
Option B is the inflection point on the effort-vs-recovery curve. PR split lets Tier 1 (~3.2 MB / 7d production expectation, 10 lines of deletion + tests) land independently of Tier 2 (~4 MB / 7d production expectation, bounded RTK port + dispatch fix + chain change). License compatibility is verified. RTK SHA is pinned at this revision. Architect-identified blockers M1/M2/M3 are now resolved in plan.

### Consequences
- **Positive:** Saved-ratio lifts meaningfully on dominant miss sources. Named synthetic fixture corpus is a reusable baseline for future regressions. Kill-switch is one config field, one helper, one rollback path; works under parallel `cargo test` without `#[serial]`.
- **Negative — explicit:**
  - `||` chains, subshells `()`, and command substitutions `$()` continue to escape decomposition. Tracked as follow-ups.
  - Downstream callers that spawn-and-parse grep output may break; kill-switch is the rollback path.
  - **If T0.1 reveals Mode α (FFI gap on chains)**, T2b moves to a follow-up plan and PR #2 ships only pytest + uv-dispatch. The plan explicitly does not silently widen the FFI surface beyond the M2 additive optional field.
  - Adding RTK attribution headers introduces a new pattern; documented in `ATTRIBUTION-RTK.md`.
  - **FFI surface gains one optional field** (`MinimizerOptions.legacy_filters: Option<bool>`). Additive-only, defaults to `None`, follows `ai_smart` precedent.
- **Production expectations (post-deploy, NOT per-task acceptance — M3):**
  - Tier 1 expected to recover ~3.2 MB across next 7d of grep+find miss records vs current baseline. Measure from JSONL after merge.
  - Tier 2 expected to recover an additional ~4 MB across pytest + git-chain misses.
  - Both subject to actual workload drift; not gated on synthetic fixture corpus.
- **Operational (m7):**
  - If user flips `OMP_MINIMIZER_LEGACY_FILTERS=1` (or callers pass `Some(true)`), `/gain --diag` `avgSavedRatio` reflects pre-PR baseline values. Diagnostic surface does NOT auto-detect kill-switch state. Operators investigating low gain should check env var / caller-side option first.
  - Optional follow-up (not in this plan's scope): companion `.omc/plans/gain-slash-remediation.md` Status tab could surface `legacy_filters_active` (bool) as a diagnostic field.
  - Replay benchmark is local-only, not CI-gated; relies on developer discipline.

### Follow-ups
1. PR #3: rustfmt + xxd filters (and anything R2 elevates).
2. Subshell / command-substitution / `||` decomposition (assignment-capture, `(cd sub && git log)`, `a || b`).
3. CI integration of replay benchmark once a stable baseline lands.
4. Audit `cloud.rs` (39.7K) and `docker.rs` (21.7K) for similar threshold-gated passthroughs.
5. If T0.1 finds Mode α: scope a separate plan for FFI segmented dispatch.
6. If T0.5 finds significant miss bytes outside currently-routed programs, scope a Tier 3 plan accordingly.
7. Surface `legacy_filters_active` in `/gain --diag` (m7 follow-up, companion plan scope).

---

## 12. Plan Summary

**Plan saved to:** `.omc/plans/minimizer-filter-remediation.md`

**Scope:**
- PR #1 files touched: `listing.rs`, `config.rs` (kill-switch resolver + `MinimizerOptions.legacy_filters` field), `benches/minimizer_workload.rs` (new), `benches/fixtures/` (new), `ATTRIBUTION-RTK.md` (new).
- PR #2 files touched: `python.rs`, `mod.rs` (uv dispatch fix + `normalize_uv_form`), `engine.rs` + `plan.rs` (chain handling — gated on T0.1 outcome), bench fixtures extended.
- FFI: additive-only optional `legacy_filters: Option<bool>` field on `MinimizerOptions`, following `ai_smart` precedent. Non-breaking. **FFI extension for segmented chain dispatch considered only if T0.1 reveals Mode α** — escalate before proceeding.
- Estimated complexity: **MEDIUM** (mechanical Tier 1 + bounded port Tier 2 + benchmark scaffold).

**Key Deliverables:**
1. Unconditional grouping in grep/find filters (Tier 1).
2. RTK-port pytest state machine at pinned SHA `878af7de99e0ba71da2e8fd996f6b52a1836e06c` with attribution (Tier 2a).
3. uv dispatch coverage extension for `uv pytest` / `uv -m pytest` via `normalize_uv_form` (Tier 2a, B1 fix, m4).
4. Chain handling improvements in `engine.rs` + `plan.rs` (Tier 2b, T0.1-gated).
5. Named synthetic fixture corpus + criterion bench + baseline-results.md (Tier 4, m6).
6. Kill-switch via `MinimizerOptions.legacy_filters` + `MinimizerConfig::legacy_filters_active` + env fallback (M2).
7. ADR + pre-mortem captured in plan and each PR.

**Consensus mode artifacts:**
- RALPLAN-DR: 5 Principles, top-3 Drivers, 4 Options (B chosen with PR-split; A/C/D explicit invalidation, plus rev 2 design alternatives invalidated).
- ADR: Decision, Drivers, Alternatives, Why chosen, Consequences (positive + negative + production-expectations + operational), Follow-ups.
- Pre-mortem: 3 distinct scenarios with mitigation + detection signal.
- Expanded test plan: unit / integration / e2e (replay) / observability.

**Does this plan capture your intent?**
- `proceed` — Hand off to executor / `/oh-my-claudecode:start-work minimizer-filter-remediation`.
- `adjust [section]` — Return to interview to modify a specific section.
- `restart` — Discard and start fresh.

**STATUS: PENDING APPROVAL — NO EXECUTION**
