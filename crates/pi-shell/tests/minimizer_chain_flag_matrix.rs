use pi_shell::minimizer::{
	MinimizerConfig, apply,
	engine::{MinimizerMode, mode_for},
};

fn cfg() -> MinimizerConfig {
	MinimizerConfig { enabled: true, ..Default::default() }
}

fn assert_pure(text: &str) {
	assert!(!text.contains('\x1b'));
	assert!(!text.contains("&&"));
	assert!(!text.contains(';'));
	assert!(!text.contains('`'));
}

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

#[test]
fn clang_chain_segments_filter_independently() {
	let cfg = cfg();
	assert_eq!(
		mode_for("clang -c foo.c && clang++ -c bar.cpp", &cfg),
		MinimizerMode::SegmentedChain
	);
	let clang = apply(
		"clang -c foo.c",
		"foo.c:3:10: fatal error: 'missing.h' file not found\n#include \"missing.h\"\n         ^~~~~~~~~~~\n1 error generated.\n",
		1,
		&cfg,
	);
	let clangxx = apply(
		"clang++ -c bar.cpp",
		"bar.cpp:8:5: error: unknown type name 'Widget'\n    Widget w;\n    ^\n1 error generated.\n",
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
