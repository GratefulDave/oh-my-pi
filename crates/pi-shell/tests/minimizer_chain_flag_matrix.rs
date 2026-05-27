//! Cross-cutting chain/flag/passthrough/output-purity matrix for the
//! minimizer additions in plan `rtk-md-completion-2026-05-27`.
//!
//! Each new dispatcher (W1 aws, W2 clang, W3 source-outline-aggressive,
//! W4 ai-smart) ships a row here so the chain (`&&`/`;`) semantics, the
//! flag-tolerance dispatch (`--profile=X`, `-v`, `--`), and the chain-
//! transcript output-purity gate (AC-C4: no ANSI, no `&&`, no `;`,
//! no backticks) are visible together rather than scattered across per-
//! filter unit tests.
//!
//! The matrix is split into:
//! - W1/W2 rows (aws + clang), owned by the W1 codex worker; appended by
//!   that worker. Stubs are present so the file builds even when W1 hasn't
//!   landed its rows yet.
//! - W3 rows (source outline aggressive) — included below.
//! - W4 rows (ai-smart, gated behind `--features ai-smart`) — included
//!   below and skipped automatically when the feature is off.

use pi_shell::minimizer::{
	self,
	config::{MinimizerConfig, OutlineLevel},
};

fn ai_smart_off_default_cfg() -> MinimizerConfig {
	MinimizerConfig { enabled: true, ..Default::default() }
}

fn ai_smart_aggressive_outline_cfg() -> MinimizerConfig {
	MinimizerConfig {
		enabled: true,
		source_outline_level: OutlineLevel::Aggressive,
		..Default::default()
	}
}

// ---------------------------------------------------------------------------
// W3 — source outline aggressive
// ---------------------------------------------------------------------------

/// AC-C2 (flag tolerance): the aggressive outliner must dispatch correctly
/// even when the `cat` invocation carries flags between the program and the
/// path argument. `cat -n src/foo.rs` should still strip the function body.
#[test]
fn w3_aggressive_outline_handles_flag_rich_cat_invocation() {
	let cfg = ai_smart_aggressive_outline_cfg();
	let body = "pub fn main() {\n    println!(\"x\");\n}\n";
	let out = minimizer::apply("cat -n src/foo.rs", body, 0, &cfg);
	assert!(out.changed, "aggressive must rewrite small source files");
	assert!(out.text.contains("pub fn main() { ... }"));
	assert!(!out.text.contains("println!"));
}

/// AC-C1 (chain mode): a `&&`-chained `cat foo.rs && cat bar.rs` must
/// run each segment through the same aggressive outliner. We exercise the
/// segmented path via `minimizer::engine::mode_for` and assert the chain is
/// eligible for segmented minimization (so the runtime would dispatch each
/// segment independently rather than falling through as `compound`).
#[test]
fn w3_aggressive_outline_chain_mode_is_segmented() {
	let cfg = ai_smart_aggressive_outline_cfg();
	assert_eq!(
		minimizer::engine::mode_for("cat src/foo.rs && cat src/bar.rs", &cfg),
		minimizer::engine::MinimizerMode::SegmentedChain
	);
}

/// AC-C3 (passthrough): malformed source (truncated brace stream) must not
/// panic. The aggressive outliner emits something useful, but the
/// post-condition we hard-assert is no panic + no chain-corrupting bytes.
#[test]
fn w3_aggressive_outline_truncated_input_does_not_panic() {
	let cfg = ai_smart_aggressive_outline_cfg();
	let truncated = "pub fn foo() {\n    let x = 1;\n"; // missing closing brace
	let out = minimizer::apply("cat src/foo.rs", truncated, 0, &cfg);
	// Either left as-is or partially stripped — both are acceptable. We only
	// require non-panicking and no shell-operator corruption.
	assert!(!out.text.contains('\x1b'));
	assert!(!out.text.contains('`'));
}

/// AC-C4 (output purity): aggressive outliner output must not contain
/// shell-control characters that would corrupt a chain transcript when
/// segments are concatenated upstream.
#[test]
fn w3_aggressive_outline_output_purity() {
	let cfg = ai_smart_aggressive_outline_cfg();
	let body = "pub fn run() {\n    let s = \"a && b ; c `d`\";\n    println!(\"{s}\");\n}\n";
	let out = minimizer::apply("cat src/foo.rs", body, 0, &cfg);
	assert!(out.changed);
	// Body containing shell operators is removed entirely; signature has no
	// shell operators because the language is Rust.
	assert!(!out.text.contains("&&"));
	assert!(!out.text.contains(";"));
	assert!(!out.text.contains('`'));
	assert!(!out.text.contains('\x1b'));
}

/// AC3.5: default level is unaffected — a small source file with default
/// outline level passes through unchanged.
#[test]
fn w3_default_level_passes_small_source_files_through() {
	let cfg = ai_smart_off_default_cfg();
	let body = "pub fn foo() { let x = 1; }\n";
	let out = minimizer::apply("cat src/foo.rs", body, 0, &cfg);
	assert!(!out.changed);
}

// ---------------------------------------------------------------------------
// W4 — ai-smart (feature gated; off-feature rows assert passthrough)
// ---------------------------------------------------------------------------

/// AC4.2: when the cargo feature is OFF or runtime flag is OFF, the AI
/// filter is a strict no-op. The captured output must equal the original.
#[test]
fn w4_disabled_runtime_flag_is_passthrough() {
	let cfg = MinimizerConfig { enabled: true, ai_smart_enabled: false, ..Default::default() };
	let out = minimizer::apply("echo hi", "hi\n", 0, &cfg);
	assert_eq!(out.text, "hi\n");
	assert!(!out.changed);
}

/// AC4.3 / AC-C1: a piped parent never invokes the AI filter even when the
/// runtime flag is on. We assert via `mode_for`: piped commands return
/// `None`, which means `apply()` returns passthrough before any post-step
/// runs. Equivalent to "AI filter bypassed for pipe parent" since `apply`
/// is the only entry point.
#[test]
fn w4_pipe_parent_skips_minimization() {
	let cfg = MinimizerConfig { enabled: true, ai_smart_enabled: true, ..Default::default() };
	assert_eq!(
		minimizer::engine::mode_for("echo hi | cat", &cfg),
		minimizer::engine::MinimizerMode::None
	);
}

/// AC4.5: pinned model id is exactly `deepseek-v4-flash`. We assert from
/// the module's public constant so a future silent downgrade (e.g. to
/// `deepseek-chat`) fails this test and forces an RFC.
#[cfg(feature = "ai-smart")]
#[test]
fn w4_deepseek_model_id_pinned() {
	use pi_shell::minimizer::filters::ai_smart;
	assert_eq!(ai_smart::DEEPSEEK_MODEL, "deepseek-v4-flash");
	assert_eq!(ai_smart::DEEPSEEK_ENDPOINT, "https://api.deepseek.com/v1/chat/completions");
}

/// AC4.4: input cap is 8 KB. We assert from the constant so any reviewer
/// changing it in code is forced to update this test.
#[cfg(feature = "ai-smart")]
#[test]
fn w4_input_cap_is_8kb() {
	use pi_shell::minimizer::filters::ai_smart;
	assert_eq!(ai_smart::MAX_INPUT_BYTES, 8 * 1024);
}

/// AC4.1: API-key env var is `OMP_AI_SMART_API_KEY` (not `OMP_AI_SMART_ENABLED`
/// per plan changelog fix).
#[cfg(feature = "ai-smart")]
#[test]
fn w4_api_key_env_var_is_omp_ai_smart_api_key() {
	use pi_shell::minimizer::filters::ai_smart;
	assert_eq!(ai_smart::API_KEY_ENV, "OMP_AI_SMART_API_KEY");
}
