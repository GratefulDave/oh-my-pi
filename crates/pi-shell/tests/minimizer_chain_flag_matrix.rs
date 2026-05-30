//! Cross-cutting chain/flag/passthrough/output-purity matrix for the
//! minimizer additions in plan `rtk-md-completion-2026-05-27`.
//!
//! Rows:
//! - W1 aws extractors + flag tolerance (codex)
//! - W2 clang regex extension (codex)
//! - W3 source outline aggressive (claude)
//! - W4 ai-smart, gated behind `--features ai-smart` (claude)

use pi_shell::minimizer::{
	self, MinimizerConfig, apply,
	config::OutlineLevel,
	engine::{MinimizerMode, mode_for},
};

fn cfg() -> MinimizerConfig {
	MinimizerConfig { enabled: true, ..Default::default() }
}

fn aggressive_outline_cfg() -> MinimizerConfig {
	MinimizerConfig {
		enabled: true,
		source_outline_level: OutlineLevel::Aggressive,
		..Default::default()
	}
}

fn assert_pure(text: &str) {
	assert!(!text.contains('\x1b'));
	assert!(!text.contains("&&"));
	assert!(!text.contains(';'));
	assert!(!text.contains('`'));
}

// ---------------------------------------------------------------------------
// W1 — aws extractors + flag tolerance
// ---------------------------------------------------------------------------

#[test]
fn aws_chain_segments_filter_independently() {
	let cfg = cfg();
	assert_eq!(
		mode_for("aws sts get-caller-identity && aws s3 ls", &cfg),
		MinimizerMode::SegmentedChain
	);
	let sts = apply(
		"aws sts get-caller-identity",
		r#"{"UserId":"AIDA","Account":"123456789012","Arn":"arn:aws:iam::123456789012:user/alice"}"#,
		0,
		&cfg,
	);
	let s3 = apply("aws s3 ls", "2026-05-27 01:02:03 builds\n", 0, &cfg);
	assert!(sts.text.contains("account=123456789012"));
	assert!(s3.text.contains("builds\t2026-05-27 01:02:03"));
	assert_pure(&sts.text);
	assert_pure(&s3.text);
}

#[test]
fn aws_flags_preserve_service_dispatch() {
	let cfg = cfg();
	let out = apply(
		"aws --profile=dev --region us-east-1 --no-cli-pager sts get-caller-identity",
		r#"{"UserId":"AIDA","Account":"123456789012","Arn":"arn:aws:iam::123456789012:user/alice"}"#,
		0,
		&cfg,
	);
	assert!(out.text.contains("account=123456789012"));
	assert_pure(&out.text);
}

#[test]
fn aws_pipe_and_compound_passthrough() {
	let cfg = cfg();
	let input = r#"{"UserId":"AIDA","Account":"123456789012","Arn":"arn"}"#;
	let piped = apply("aws sts get-caller-identity | rg 123", input, 0, &cfg);
	let compound = apply("(aws sts get-caller-identity)", input, 0, &cfg);
	assert_eq!(piped.text, input);
	assert_eq!(piped.filter, "piped");
	assert_eq!(compound.text, input);
	assert_eq!(compound.filter, "compound");
}

#[test]
fn aws_malformed_input_passthroughs() {
	let cfg = cfg();
	let input = "{not-json";
	let out = apply("aws lambda list-functions", input, 0, &cfg);
	assert_eq!(out.text, input);
}

// ---------------------------------------------------------------------------
// W2 — clang regex
// ---------------------------------------------------------------------------

#[test]
fn clang_chain_segments_filter_independently() {
	let cfg = cfg();
	assert_eq!(
		mode_for("clang -c foo.c && clang++ -c bar.cpp", &cfg),
		MinimizerMode::SegmentedChain
	);
	let clang = apply(
		"clang -c foo.c",
		"foo.c:3:10: fatal error: 'missing.h' file not found\n#include \"missing.h\"\n         \
		 ^~~~~~~~~~~\n1 error generated.\n",
		1,
		&cfg,
	);
	let clangxx = apply(
		"clang++ -c bar.cpp",
		"bar.cpp:8:5: error: unknown type name 'Widget'\n    Widget w\n    ^\n1 error generated.\n",
		1,
		&cfg,
	);
	assert!(clang.text.contains("foo.c:3:10: fatal error"));
	assert!(!clang.text.contains("1 error generated"));
	assert!(clangxx.text.contains("bar.cpp:8:5: error"));
	assert!(!clangxx.text.contains("1 error generated"));
	assert_pure(&clang.text);
	assert_pure(&clangxx.text);
}

#[test]
fn clang_flags_and_passthrough_cases_are_safe() {
	let cfg = cfg();
	let out = apply(
		"clang -Wall -Wextra -c foo.c",
		"foo.c:1:1: warning: unused function 'f'\nstatic void f() {}\n^\n1 warning generated.\n",
		1,
		&cfg,
	);
	assert!(out.text.contains("foo.c:1:1: warning"));
	assert!(!out.text.contains("1 warning generated"));
	assert_pure(&out.text);

	let piped = apply("clang -c foo.c | cat", "raw\n", 1, &cfg);
	let compound = apply("(clang -c foo.c)", "raw\n", 1, &cfg);
	assert_eq!(piped.text, "raw\n");
	assert_eq!(compound.text, "raw\n");
}

// ---------------------------------------------------------------------------
// W3 — source outline aggressive
// ---------------------------------------------------------------------------

/// AC-C2 (flag tolerance): aggressive outliner dispatches even when `cat`
/// carries flags between program and path argument.
#[test]
fn w3_aggressive_outline_handles_flag_rich_cat_invocation() {
	let cfg = aggressive_outline_cfg();
	let body = "pub fn main() {\n    println!(\"x\");\n}\n";
	let out = minimizer::apply("cat -n src/foo.rs", body, 0, &cfg);
	assert!(out.changed, "aggressive must rewrite small source files");
	assert!(out.text.contains("pub fn main() { ... }"));
	assert!(!out.text.contains("println!"));
}

/// AC-C1 (chain mode): `cat foo.rs && cat bar.rs` is segmented.
#[test]
fn w3_aggressive_outline_chain_mode_is_segmented() {
	let cfg = aggressive_outline_cfg();
	assert_eq!(mode_for("cat src/foo.rs && cat src/bar.rs", &cfg), MinimizerMode::SegmentedChain);
}

/// AC-C3 (passthrough): malformed source must not panic.
#[test]
fn w3_aggressive_outline_truncated_input_does_not_panic() {
	let cfg = aggressive_outline_cfg();
	let truncated = "pub fn foo() {\n    let x = 1;\n";
	let out = minimizer::apply("cat src/foo.rs", truncated, 0, &cfg);
	assert!(!out.text.contains('\x1b'));
	assert!(!out.text.contains('`'));
}

/// AC-C4 (output purity): aggressive outliner output must not contain
/// shell-control characters.
#[test]
fn w3_aggressive_outline_output_purity() {
	let cfg = aggressive_outline_cfg();
	let body = "pub fn run() {\n    let s = \"a && b ; c `d`\";\n    println!(\"{s}\");\n}\n";
	let out = minimizer::apply("cat src/foo.rs", body, 0, &cfg);
	assert!(out.changed);
	assert!(!out.text.contains("&&"));
	assert!(!out.text.contains(";"));
	assert!(!out.text.contains('`'));
	assert!(!out.text.contains('\x1b'));
}

/// AC3.5: default level is unaffected — a small source file with default
/// outline level passes through unchanged.
#[test]
fn w3_default_level_passes_small_source_files_through() {
	let cfg = cfg();
	let body = "pub fn foo() { let x = 1; }\n";
	let out = minimizer::apply("cat src/foo.rs", body, 0, &cfg);
	assert!(!out.changed);
}

// ---------------------------------------------------------------------------
// W4 — ai-smart (feature gated)
// ---------------------------------------------------------------------------

/// AC4.2: when runtime flag is OFF, AI filter is a strict no-op.
#[test]
fn w4_disabled_runtime_flag_is_passthrough() {
	let cfg = MinimizerConfig { enabled: true, ai_smart_enabled: false, ..Default::default() };
	let out = minimizer::apply("echo hi", "hi\n", 0, &cfg);
	assert_eq!(out.text, "hi\n");
	assert!(!out.changed);
}

/// AC4.3 / AC-C1: piped parent never invokes the AI filter.
#[test]
fn w4_pipe_parent_skips_minimization() {
	let cfg = MinimizerConfig { enabled: true, ai_smart_enabled: true, ..Default::default() };
	assert_eq!(mode_for("echo hi | cat", &cfg), MinimizerMode::None);
}

/// AC4.5: pinned model id is exactly `deepseek-v4-flash`.
#[cfg(feature = "ai-smart")]
#[test]
fn w4_deepseek_model_id_pinned() {
	use pi_shell::minimizer::filters::ai_smart;
	assert_eq!(ai_smart::DEEPSEEK_MODEL, "deepseek-v4-flash");
	assert_eq!(ai_smart::DEEPSEEK_ENDPOINT, "https://api.deepseek.com/v1/chat/completions");
}

/// AC4.4: input cap is 8 KB.
#[cfg(feature = "ai-smart")]
#[test]
fn w4_input_cap_is_8kb() {
	use pi_shell::minimizer::filters::ai_smart;
	assert_eq!(ai_smart::MAX_INPUT_BYTES, 8 * 1024);
}

/// AC4.1: API-key env var is `OMP_AI_SMART_API_KEY`.
#[cfg(feature = "ai-smart")]
#[test]
fn w4_api_key_env_var_is_omp_ai_smart_api_key() {
	use pi_shell::minimizer::filters::ai_smart;
	assert_eq!(ai_smart::API_KEY_ENV, "OMP_AI_SMART_API_KEY");
}
