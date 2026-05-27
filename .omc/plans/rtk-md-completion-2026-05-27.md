# RTK.md Completion Plan

**Status:** pending approval
**Created:** 2026-05-27
**Mode:** ralplan consensus (RALPLAN-DR short)

## Scope Re-Audit

rtk.md (last touched 2026-05-25) is materially stale. Verified against `crates/pi-shell/src/minimizer/` on this branch:

| # | Item | Actual status | Evidence |
|---|---|---|---|
| 1 | git status repo state | DONE | `filters/git.rs:263-268` (cherry-pick/bisect/rebase/merge detection) |
| 3 | git show | DONE | `git.rs:53` `condense_show` |
| 4 | git pull | DONE | `git.rs:60` `condense_pull` |
| 6 | make | DONE | `defs/make.toml` |
| 7 | gcc | DONE | `defs/gcc.toml` |
| 7 | **clang** | **MISSING** | `gcc.toml:7` regex `^(gcc\|g\+\+)$` excludes clang/clang++ |
| 8 | terraform/tofu plan | DONE | `defs/terraform-plan.toml`, `tofu-plan.toml` |
| 9 | git stash | DONE | `git.rs:57` `condense_stash` |
| 10 | git branch | DONE | `git.rs:55` `condense_branch` |
| 11 | git fetch | DONE | `git.rs:61` `condense_fetch` |
| 12 | git log trailers | DONE | `condense_log` strips `Signed-off-by`/`Co-authored-by` (tests `git.rs:1391-1392`) |
| 13/16 | **aws expansion** | **PARTIAL** | `filters/cloud.rs:54-64` only ec2/cloudwatch/dynamodb; missing sts, s3, lambda, iam, logs, ecs, rds, cloudformation, eks, sqs, secretsmanager |
| 15 | err extractor | DONE | `filters/system.rs:34` `compact_err_output` |
| 17 | diff standalone | DONE | `system.rs:36` `compact_diff_output` |
| 18 | test generic | DONE | `system.rs:35` `compact_test_output` |
| 19 | systemctl | DONE | `defs/systemctl-status.toml`, `systemctl.toml` |
| 21 | npm install noise | DONE | `filters/pkg.rs:270-360` |
| 24 | named truncation caps | DONE | `primitives.rs:24` `reduced()` + `named_caps_have_nonzero_reductions` test |
| 25 | normalized log dedup | DONE | per-domain normalizers (`filters/system.rs:216`, `cloud.rs:605`, `listing.rs:263`) |
| 26 | gradle/mvn | DONE | `defs/gradle.toml`, `mvn-build.toml`, `maven.toml` |
| 27 | ansible/gcloud/pre-commit/rsync | DONE | all four TOMLs present |
| 28 | swift/xcodebuild | DONE | `defs/swift-build.toml`, `xcodebuild.toml` |
| 29 | mix | DONE | `defs/mix-compile.toml`, `mix-format.toml`, `mix.toml` |
| 30 | nx/turbo | DONE | `defs/nx.toml`, `turbo.toml` |
| 31 | ollama | DONE | `defs/ollama.toml` |
| 32 | **source outline --level aggressive** | **PARTIAL** | `listing.rs:659` single-level `compact_source_outline`; no level knob |
| 33 | **rtk smart (AI summary)** | **MISSING** | zero AI client deps in `crates/pi-shell/Cargo.toml` |
| — | **aws flag stripping** | **MISSING** | `detect.rs` has no aws-aware flag skipper → `aws --profile X s3 ls` mis-detects `--profile` as subcommand |

**Net actual scope (4 work items):**

- **W1** — AWS: 11 new subcommand extractors + aws global-flag handling in detect.rs
- **W2** — clang: extend gcc.toml or add clang.toml
- **W3** — source outline aggressive level (body stripping behind a config knob)
- **W4** — rtk smart via deepseek-v4-flash (or comparable) — new AI summary filter

User-imposed cross-cutting constraints:
- **C1 — chained safety:** every new filter must remain correct when its command sits inside `&&`/`;` chains (segment mode) and pass through cleanly when piped (pipe mode).
- **C2 — flag tolerance:** every new dispatch must survive arbitrary CLI flags (global flags, `--option=value`, short flags, `--` terminators) without losing the subcommand.

---

## RALPLAN-DR Summary

### Principles
1. **Match the existing dispatch shape.** Built-in Rust filters for high-leverage structured output (AWS JSON, source bodies); TOML overlays for regex-shaped text (clang). No new mechanisms.
2. **Chain-safe by construction.** Outputs must be self-contained — no terminal escapes, no positional dependencies, no markers that downstream tools could mistake for data. Verified by Chain mode tests.
3. **Flag-tolerant dispatch.** Subcommand detection must skip global flags before classifying. Reuse the existing `first_non_global_arg` helper (`detect.rs:303`) and add an aws-specific skipper modeled on the per-program skip functions at `detect.rs:93/108/131/144/157/171` (env, sudo, ls, etc.).
4. **AI is opt-in and bounded.** rtk smart must (a) be gated behind config flag, (b) preserve original via artifact, (c) fail closed (passthrough) on API error/timeout, (d) never run for piped commands.
5. **Test parity with existing filters.** Every new code path ships with unit tests in the same file using the existing `ctx()`/`test_ctx()` helpers and the `[[tests.X]]` TOML pattern.

### Decision Drivers
1. **Don't regress chain/pipe correctness** — minimizer is wired into shell capture; mis-classification corrupts agent output.
2. **Minimize blast radius** — touch `filters/cloud.rs`, `defs/clang.toml` (new), `filters/listing.rs`, `detect.rs` (aws block), and one new `filters/ai_smart.rs`. No dispatcher refactor.
3. **AI cost & latency budget** — smart filter must be cheap (deepseek-v4-flash class) and bounded (timeout, max input bytes, opt-in).

### Viable Options

**Option A — TOML-first AWS** (rejected)
Express every AWS subcommand as TOML regex filter (like gcc.toml). Pros: no Rust. Cons: AWS output is JSON, not line-oriented text — regex over JSON is brittle and loses structure. Existing aws handler is Rust-JSON (cloud.rs); breaking the pattern fragments maintenance.
**Invalidation:** structured JSON requires `serde_json::Value` walking. Regex cannot reliably extract nested `Reservations[].Instances[]` shapes. Existing cloud.rs already proves the Rust-JSON path; adding 11 more extractors there is a strict extension, not a new mechanism.

**Option B — Rust extractors for AWS, TOML for clang, Rust for AI** *(chosen)*
- AWS: extend `filters/cloud.rs` with `extract_aws_*` + `compact_aws_*` pairs per subcommand, matching the existing ec2/cloudwatch/dynamodb pattern.
- clang: smallest possible — add `clang|clang\+\+` to `gcc.toml`'s `match_command` regex (single-line change) plus 2 tests, OR ship `clang.toml` as a tiny shim that reuses the same `strip_lines_matching`. Prefer the single-file edit.
- AWS flags: extend `detect.rs` with `skip_aws_global_options(args, index) -> Option<usize>` modeled on the existing per-program skipper signatures at `detect.rs:93,108,131,144,157,171` and wired through `first_non_global_arg` at `detect.rs:303`. (No prior `skip_git_global_options` exists — the git-side handling lives inline in `detect_subcommand`; new aws skipper is a strict addition, not a rename.)
- Source outline level: add `OutlineLevel { Default, Aggressive }` enum, thread through `ShellMinimizerSettings` -> `MinimizerOptions`, gate body stripping in `compact_source_outline`.
- rtk smart: new `filters/ai_smart.rs` calling deepseek-v4-flash via `reqwest`, behind config flag `ai_smart_enabled: bool` + `ai_smart_provider: "deepseek"|"openai"`, with strict bounds (8 KB max input, 5 s timeout, 200 token max response, **passthrough on any failure or pipe context**).

**Option C — Defer rtk smart, ship W1–W3 only**
Pros: zero new deps, zero AI infra. Cons: user explicitly asked for #33 with deepseek-v4-flash. Use only as fallback if Critic flags AI scope as too large for one PR.

---

## Acceptance Criteria

### W1 — AWS expansion
- **AC1.1** `aws sts get-caller-identity` JSON output collapses to single-line `account=<id> arn=<arn> user-id=<id>`.
- **AC1.2** `aws s3 ls` (text output) compresses to `bucket date` rows; `aws s3 ls --output json` compresses similarly via JSON path.
- **AC1.3** Each of {sts, s3, lambda, iam, logs, ecs, rds, cloudformation, eks, sqs, secretsmanager} has at least one extractor + one compactor + one happy-path test + one malformed-JSON passthrough test in `filters/cloud.rs`.
- **AC1.4** `aws --profile foo --region us-east-1 s3 ls` dispatches to the s3 handler (verifies flag stripping). Test in `detect.rs` test block.
- **AC1.5** `aws s3 ls | rg bucket` is detected as `Piped` and passes through unchanged. Test in `plan.rs` or integration test.
- **AC1.6** `aws sts get-caller-identity && aws s3 ls` is detected as `Chain`; each segment is filtered independently. Test asserts both summaries appear separately.
- **AC1.7** Unknown subcommand falls back to `compact_aws_generic` (Step 1.6); when generic walker also returns `None`, falls back to existing text-mode `try_compact_aws_json`; no panic at any layer.
- **AC1.8** `SENSITIVE_AWS_KEYS` denylist test passes: leak-sentinel fixture produces zero matches across every compactor.

### W2 — clang
- **AC2.1** `clang -c foo.c` with errors produces same compact output shape as `gcc -c foo.c`.
- **AC2.2** `clang++ -c foo.cpp` matches.
- **AC2.3** Existing gcc tests still pass; clang regex addition is a strict superset.
- **AC2.4** `clang -c foo.c && clang -c bar.c` chain: both segments filtered.

### W3 — source outline aggressive
- **AC3.1** New enum `OutlineLevel { Default, Aggressive }` in `MinimizerOptions`; default = `Default` (preserves current behavior).
- **AC3.2** Aggressive mode strips function/method bodies for `.ts`/`.tsx`/`.js`/`.jsx`/`.py`/`.rs`/`.go` (the languages `compact_source_outline` already recognizes), keeping signatures + doc comments.
- **AC3.3** TS-side `ShellMinimizerSettings` exposes `sourceOutlineLevel: "default" | "aggressive"`, wired through `buildMinimizerOptions()` in `bash-executor.ts:75`.
- **AC3.4** `cat src/foo.ts && cat src/bar.ts` chain: both files outlined at same level.
- **AC3.5** No regression on `Default` mode — existing `compact_source_outline` test suite passes unchanged.

### W4 — rtk smart
- **AC4.1** New config `ai_smart_enabled: bool` (default `false`) and `ai_smart_provider: String` (default `"deepseek"`); env var `OMP_AI_SMART_API_KEY` reads credential.
- **AC4.2** When disabled (default), no AI call; filter is a no-op passthrough — zero behavioral change.
- **AC4.3** When enabled, runs only for whole-command (single) mode. For piped/compound parents the AI call is bypassed entirely. For chain parents, the per-`apply()` budget cap in AC4.9 governs.
- **AC4.9** Per-`apply()` AI call budget: at most **one** AI call across all chain segments. Counter lives on the `MinimizerCtx` (or a `Cell<u8>` threaded from `engine.rs::apply`); second and subsequent segments in a chain passthrough without invoking the AI client. Test: 5-segment chain triggers exactly one HTTP request to the mocked client.
- **AC4.4** Input cap: 8 KB. Timeout: 5 s. Response cap: 200 tokens. On any breach → passthrough original (with artifact reference if minimizer-side rewrite happened).
- **AC4.5** Deepseek API call uses `deepseek-v4-flash` via OpenAI-compatible `/v1/chat/completions` endpoint at `https://api.deepseek.com`. If `deepseek-v4-flash` is not available at implementation time, executor MUST stop and request an explicit model-selection RFC from the user — no silent downgrade to `deepseek-chat` or other model.
- **AC4.6** Failure modes (network, 4xx/5xx, parse error) all produce passthrough; never returns partial garbage.
- **AC4.7** Unit test mocks the HTTP client to verify: enabled-path success, enabled-path timeout, disabled-path no-op, pipe-context bypass.
- **AC4.8** Integration test: `OMP_AI_SMART_API_KEY` unset → filter never instantiates client.

### Cross-cutting (all four work items)
- **AC-C1 (chain)** For each new filter, add one test using a multi-segment chain command to verify segment-mode invocation produces summaries that concatenate cleanly (no orphan terminal codes, no unbalanced markers).
- **AC-C2 (flags)** For each new dispatcher entry, add one test with a flag-rich invocation (`--profile=X`, `-v`, `--`) that asserts subcommand still resolves correctly.
- **AC-C3 (passthrough)** For each new filter, add one test that simulates malformed input (truncated JSON, ANSI-only, empty) and asserts no panic + sane fallback.
- **AC-C4 (output purity)** For each new compactor (aws extractors, generic walker, ai_smart), output passes `assert!(!out.contains('\x1b') && !out.contains("&&") && !out.contains(";") && !out.contains('`'))`. Rationale: prevents chain transcript corruption when the captured filter output is later concatenated by the engine.

---

## Implementation Steps

### Step 1 — AWS subcommand extractors (`crates/pi-shell/src/minimizer/filters/cloud.rs`)
1. Add `skip_aws_global_options(args, index) -> Option<usize>` in `detect.rs` adjacent to the existing per-program skippers (`detect.rs:93-171`). Wire it through `first_non_global_arg` (`detect.rs:303`). Flag table (value-taking unless noted):
   - Value-taking: `--profile`, `--region`, `--endpoint-url`, `--cli-binary-format`, `--output`, `--cli-read-timeout`, `--cli-connect-timeout`, `--ca-bundle`, `--color`, `--query`, `--cli-input-json`, `--cli-input-yaml`
   - Boolean: `--no-cli-pager`, `--debug`, `--no-verify-ssl`, `--no-paginate`, `--no-sign-request`, `--cli-auto-prompt`, `--no-cli-auto-prompt`
   - Optional value: `--generate-cli-skeleton` (bare OR `=input|=output|=yaml-input`)
   - Each flag also accepts `--flag=value` form (handled uniformly).
   - Treat `--` as terminator.
   Each form covered by unit tests; add a property test that fuzzes `aws [random_globals_subset] <known_service> <known_op>` over 100+ permutations and asserts subcommand is the known service.
2. In `cloud.rs:filter_aws`, after existing dispatch, route on subcommand (extracted via existing path) to new compactors. Pattern per service:
   ```rust
   fn extract_aws_sts_caller(root: &Value) -> Option<&Map<String, Value>> { ... }
   fn compact_aws_sts_caller(map: &Map<String, Value>) -> String { ... }
   ```
3. Mapping table (subcommand → extractor):
   - `sts get-caller-identity` → account/arn/user-id one-liner
   - `s3 ls` → bucket+date table (JSON and text variants)
   - `s3api list-buckets` → JSON variant of above
   - `lambda list-functions` → name/runtime/memory/lastModified table; **strip** `Role`/`Policy`/`Environment.Variables`
   - `iam list-users`/`list-roles` → name/arn/created table; strip `AssumeRolePolicyDocument`
   - `logs get-log-events` / `filter-log-events` → `timestamp level message` rows
   - `ecs list-clusters`/`list-tasks` → arn-only table
   - `rds describe-db-instances` → identifier/engine/status/endpoint table
   - `cloudformation describe-stacks` → name/status/lastUpdated table
   - `eks list-clusters` / `describe-cluster` → name/status/version/endpoint
   - `sqs list-queues` / `get-queue-attributes` → url/visibilityTimeout/messageCount
   - `secretsmanager list-secrets` → name/arn/lastChanged (never the secret value)
4. Each compactor must be JSON-parse-failure-safe: return `None` on any structural mismatch → caller falls through to generic walker (Step 1.6).
5. Per-service unit tests in `cloud.rs`'s existing `mod tests` block.
6. **Generic JSON walker fallback** (`compact_aws_generic`). After all specific extractors return `None`, attempt:
   - Recursively prune keys in shared `SENSITIVE_AWS_KEYS` constant: `["Policy", "PolicyDocument", "AssumeRolePolicyDocument", "Environment", "SecretString", "SecretBinary", "Token", "SessionToken", "Credentials", "Password", "PrivateKey", "KeyMaterial", "PlaintextKeyMaterial", "CiphertextBlob", "ResponseMetadata"]`.
   - If root is `{"<Xs>": [{...}]}` shape, table-render with heuristic columns (prefer fields matching `(?i)^(id|name|arn|status|state|created|modified|type|engine|version)`).
   - Else fall back to current `try_compact_aws_json` text path.
7. **Shared secret denylist test:** fixture containing every key in `SENSITIVE_AWS_KEYS` populated with `"LEAK_SENTINEL"`; for every compactor (specific + generic), assert `"LEAK_SENTINEL"` does not appear in output.

### Step 2 — clang support (`crates/pi-shell/src/minimizer/defs/gcc.toml`)
1. Change line 7 from `match_command = "^(gcc|g\\+\\+)$"` to `match_command = "^(gcc|g\\+\\+|clang|clang\\+\\+)$"`.
2. Add two tests under `[[tests.gcc]]` named `clang variant errors`, `clang++ variant errors`.
3. Rename file to `gcc-clang.toml` only if maintainer feedback requests it; otherwise keep filename.

### Step 3 — source outline aggressive level
1. In `crates/pi-shell/src/minimizer/config.rs`, add `pub enum OutlineLevel { Default, Aggressive }` and field on `MinimizerConfig`.
2. In `filters/listing.rs:compact_source_outline`, branch on level: aggressive replaces function bodies with `{ ... }` using the existing language-specific scanners.
3. In `packages/coding-agent/src/exec/bash-executor.ts` `buildMinimizerOptions`, surface `sourceOutlineLevel` from settings and forward to Rust options.
4. Add `SourceOutlineLevel` to `ShellMinimizerSettings` type.
5. Tests: existing default tests pass; new aggressive tests for `.ts`/`.py`/`.rs` confirm body strip + signature retention.

### Step 4 — rtk smart (`crates/pi-shell/src/minimizer/filters/ai_smart.rs`)

**W4 ships behind a Cargo feature flag `ai-smart` (default OFF).** This isolates the new `reqwest` + `rustls` dep, the network egress path, and the secret-handling threat model so W1+W2+W3 can land independently if W4 review takes longer. A reviewer can build/test pi-shell without ever pulling W4's deps via `cargo build -p pi-shell` (no flag). W4 wiring/tests run under `cargo build -p pi-shell --features ai-smart`.

1. Declare `[features] ai-smart = ["dep:reqwest"]` in `crates/pi-shell/Cargo.toml`. Add `reqwest = { version = "*", default-features = false, features = ["rustls-tls", "json", "blocking"], optional = true }`. `serde_json` already vendored.
2. New module `filters/ai_smart.rs` gated `#[cfg(feature = "ai-smart")]`. A stub `pub fn maybe_summarize(...) -> Option<String> { None }` ships for the off-feature build so call sites compile uniformly.
3. Public entry `fn maybe_summarize(ctx: &MinimizerCtx, captured: &str) -> Option<String>`:
   - Return `None` if `!ctx.config.ai_smart_enabled` OR `ctx.parent_is_pipe_or_compound()` OR captured > 8 KB OR `OMP_AI_SMART_API_KEY` unset OR per-`apply()` budget already consumed (AC4.9).
   - Else call deepseek `/v1/chat/completions` with system prompt: `"You are a 2-line summarizer for shell command output. Line 1: what happened. Line 2: most important number/path/error. Be terse."`.
   - Bound: 5 s total timeout, 200 max tokens, single retry on transient.
   - On any error → return `None` (caller keeps existing output).
4. Wire from `engine.rs::apply` (NOT inside `apply_identity`) as an explicit post-step **after** `apply_identity` returns, gated on `cfg(feature = "ai-smart")` and `ctx.config.ai_smart_enabled`. This keeps `apply_identity` AI-unaware and respects Principle 4 (AI is opt-in and bounded) per architect feedback.
5. Tests (gated `#[cfg(feature = "ai-smart")]`): mock HTTP via `wiremock`; cover enabled/disabled/timeout/pipe-context/missing-key/budget-exhausted/5-segment-chain-fires-once.

### Step 5 — chain + flag verification matrix
For each of W1–W4, add an integration-level test exercising:
- segment mode (`cmd1 && cmd2` where one is the new command)
- pipe mode (`new_cmd | tee`)
- compound mode (`(new_cmd)`)
- flag-rich invocation

Living in `crates/pi-shell/tests/minimizer_chain_flag_matrix.rs` (new file) so cross-cutting coverage stays visible.

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| AWS JSON shape varies across CLI versions | Each extractor returns `Option` on structural mismatch → falls through to existing generic JSON compaction. No assertion on JSON shape. |
| `--output text` vs `--output json` for AWS | Detect format from response shape (JSON parse attempt first, else text-table parser). `s3 ls` ships with both paths. |
| `clang` regex change collides with vendor wrappers (`armclang`, `clang-format`) | Anchor regex with `^…$` (already does). `clang-format` ≠ `clang`. Document & add negative test. |
| Source outline aggressive miscounts braces in TS template literals | Reuse existing language scanners; never invent a new parser. If miscount risk too high, ship Rust + Python + Go first, defer JS/TS to follow-up. |
| AI filter adds latency to common commands | Default `enabled=false`; cargo feature `ai-smart` default OFF (zero binary impact); even when enabled, single-command only, 5 s hard cap; per-`apply()` ≤1 call budget (AC4.9); never blocks pipe/compound. |
| Deepseek API outage / credential leak | Passthrough on failure (AC4.6); credential only via env var, never logged; HTTPS required; denylist test scope extended to ai_smart output. |
| W4 expands blast radius of one PR (new dep, TLS, async-adjacent, secret handling) | Cargo feature flag `ai-smart` (default OFF) lets W4 land + iterate independently of W1-W3; reviewers can ignore W4 paths entirely when reviewing the AWS PR. |
| Chain mode mis-segments new aws commands | Existing `plan.rs` segmentation is command-agnostic; new filters inherit it for free. Verified by AC-C1. |
| Flag stripping table for aws grows over time | Acceptable; add as bug-fix when a new global flag is observed. Start with documented public flags. |
| Cross-platform reqwest TLS | Use `rustls` (no openssl runtime dep) to keep pi-shell portable. |
| Test flake from AI integration | Mock HTTP; never hit real deepseek in CI. |

---

## Verification Steps

1. `cd /Users/davidandrews/PycharmProjects/lex && rtk cargo test -p pi-shell --lib` — all minimizer unit tests pass.
2. `rtk cargo test -p pi-shell --test minimizer_chain_flag_matrix` — chain/flag matrix passes.
3. `cd packages/natives && bun run build` — bindings compile.
4. `cd packages/coding-agent && bun test test/bash-executor.test.ts test/minimizer-gain.test.ts` — TS side unaffected.
5. Manual probe (only on `--features ai-smart` build): with `ai_smart_enabled=true` in minimizer config and `OMP_AI_SMART_API_KEY` exported, run `echo "hello world" | rtk proxy cat` — confirm pipe-parent bypass (no AI call). Then run a single-command capture and confirm one AI call fires. Toggle config off and confirm zero AI calls. (Note: `OMP_AI_SMART_ENABLED` is **not** a recognized env var; enablement is via config field `ai_smart_enabled` per AC4.1.)
6. Token-gain check: `rtk gain` shows new commands tracked under `aws/sts`, `aws/s3`, `clang`, etc.

---

## Out of Scope

- glab (#20) — user excluded.
- gh CLI expansion beyond current — not requested.
- rtk smart heuristic (non-AI) variant — superseded by AI choice.
- Rewriting existing handlers that audit shows already correct.
- Porting rtk's sqlite telemetry, command lexer, or hook layer (rtk.md "Avoid porting" block).

---

## ADR

**Decision:** Implement four narrow gaps (W1 AWS expansion + generic walker + secret denylist, W2 clang, W3 outline level, W4 AI smart behind Cargo feature flag `ai-smart`) using the existing Rust-filter and TOML-overlay mechanisms. Do **not** treat rtk.md's 34-item list as work to do; the bulk of it is already shipped. W4 is gated so reviewers can evaluate W1-W3 (extractors + regex + flag) separately from W4 (network + TLS + secret handling).

**Drivers:** chain/pipe correctness, flag tolerance, minimal blast radius, user's explicit deepseek-v4-flash requirement for #33.

**Alternatives considered:**
- *TOML-everything for AWS* — rejected: JSON parsing demands Rust; invalidation rationale in Option A above.
- *Defer rtk smart* — rejected as primary path; kept as Option C fallback if Critic flags AI scope.
- *Do all 34 items from rtk.md verbatim* — rejected: audit shows ~27 of 34 already shipped on this branch; re-implementing would be wasted churn.

**Why chosen:** Strict superset of existing patterns, every cross-cutting constraint (chain, flag, passthrough) has explicit ACs and tests, AI feature is opt-in and fail-closed.

**Consequences:**
- `cloud.rs` grows ~700–1000 LOC (11 extractor/compactor pairs + `compact_aws_generic` walker + `SENSITIVE_AWS_KEYS` constant + tests).
- New `filters/ai_smart.rs` + optional `reqwest`/`rustls`/`wiremock` deps gated behind `ai-smart` Cargo feature.
- New TS setting `sourceOutlineLevel`.
- One-line clang regex change in `gcc.toml` (file rename to `gcc-clang.toml` or split into `clang.toml` only if maintainer asks).
- `detect.rs` gains `skip_aws_global_options` (~30 LOC) + property test.
- New integration file `crates/pi-shell/tests/minimizer_chain_flag_matrix.rs` for cross-cutting matrix.

**Follow-ups:**
- Add glab filter if/when GitLab usage shows up in `rtk discover` / `rtk gain`.
- Consider exposing `ai_smart_provider` for openai/anthropic alternatives once deepseek path is proven.
- Update rtk.md to mark audited items DONE so future planners don't repeat this re-audit.

---

## Changelog

- 2026-05-27 initial draft from re-audit (28 of 34 rtk.md items verified already DONE; scope reduced to 4 W-items + 2 cross-cutting constraints).
- 2026-05-27 revisions from RALPLAN-DR consensus loop (architect + critic):
  - Fixed CRITICAL fabricated `skip_git_global_options` reference; cited real `first_non_global_arg` (detect.rs:303) + per-program skipper line range.
  - Added Step 1.6 (`compact_aws_generic` JSON walker) + shared `SENSITIVE_AWS_KEYS` constant + Step 1.7 (denylist leak-sentinel test). New ACs AC1.7/AC1.8.
  - Added missing aws global flags: `--ca-bundle`, `--color`, `--query`, `--cli-input-json`, `--cli-input-yaml`, `--no-sign-request`, `--cli-auto-prompt`, `--no-cli-auto-prompt`, `--generate-cli-skeleton`. Added property fuzz test requirement.
  - Added AC4.9 (per-`apply()` ≤1 AI call budget across chain segments).
  - Added AC-C4 (output-purity: no ANSI/`&&`/`;`/backticks in any new compactor output).
  - W4 gated behind Cargo feature `ai-smart` (default OFF) so W1-W3 can land without dragging reqwest/rustls/wiremock into the AWS PR review surface.
  - Pinned `deepseek-v4-flash` model (no silent downgrade to deepseek-chat; executor must RFC if unavailable).
  - AI wiring moved from `apply_identity` post-step to `apply` post-step so `apply_identity` stays AI-unaware (Principle 4 fidelity).
  - Fixed Step 5 env var inconsistency (removed phantom `OMP_AI_SMART_ENABLED`).
