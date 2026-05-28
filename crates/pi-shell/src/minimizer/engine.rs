//! Minimizer pipeline: detect, dispatch, and fail-safe filter execution.

use std::{
	panic::{AssertUnwindSafe, catch_unwind},
	sync::{
		LazyLock,
		atomic::{AtomicU64, Ordering},
	},
};

use crate::minimizer::{
	MinimizerConfig, MinimizerCtx, MinimizerOutput, detect, filters,
	pipeline::{self, CompiledPipeline, PipelineRegistry},
	plan,
};
#[cfg(feature = "ai-smart")]
use crate::minimizer::filters::ai_smart;

/// Minimization strategy for a shell command.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MinimizerMode {
	/// Stream output unchanged.
	None,
	/// Capture the whole command and apply one filter to the whole buffer.
	WholeCommand,
	/// Execute a safe `&&` / `;` chain segment-by-segment.
	SegmentedChain,
}

/// Return the minimization mode for a command.
pub fn mode_for(command: &str, config: &MinimizerConfig) -> MinimizerMode {
	match plan::analyze(command) {
		plan::CommandPlan::Single { .. } => {
			let Some(identity) = detect::detect(command) else {
				return MinimizerMode::None;
			};
			if identity_has_filter(&identity, config) {
				MinimizerMode::WholeCommand
			} else {
				MinimizerMode::None
			}
		},
		plan::CommandPlan::Chain { segments } => {
			if chain_has_eligible_segment(&segments, config) {
				MinimizerMode::SegmentedChain
			} else {
				MinimizerMode::None
			}
		},
		plan::CommandPlan::Compound | plan::CommandPlan::Piped | plan::CommandPlan::Unsupported => {
			MinimizerMode::None
		},
	}
}

/// Return true when the command should be captured for minimization.
#[allow(dead_code, reason = "test-only API surface")]
pub fn should_minimize(command: &str, config: &MinimizerConfig) -> bool {
	!matches!(mode_for(command, config), MinimizerMode::None)
}

/// Apply a matching filter to captured output.
///
/// Panics inside filters are caught and converted to pass-through output so
/// minimization can never be the reason a shell command loses output.
///
/// When a filter actually rewrites the text, the returned
/// [`MinimizerOutput`] carries the original buffer in `original_text` so the
/// JS session layer can persist it via its `ArtifactManager` and splice an
/// `artifact://<id>` reference back into the visible text before showing it
/// to the agent. The minimizer itself never formats the reference — ids are
/// assigned by the session store, not content-addressed.
pub fn apply(
	command: &str,
	captured: &str,
	exit_code: i32,
	config: &MinimizerConfig,
) -> MinimizerOutput {
	let input_bytes = captured.len();

	if input_bytes > config.max_capture_bytes as usize {
		return MinimizerOutput::passthrough(captured).labeled("too-large");
	}

	// Structural guard: this whole-buffer path only handles single simple
	// commands. Safe chains are intentionally kept opaque here so the engine
	// can only segment them when the shell executes each piece separately.
	// Pipes can feed downstream parsers (awk, jq, rg, …), so rewriting their
	// combined output is a correctness bug.
	match plan::analyze(command) {
		plan::CommandPlan::Single { .. } => {},
		plan::CommandPlan::Chain { segments } => {
			return apply_chain(command, &segments, captured, exit_code, config);
		},
		plan::CommandPlan::Piped => {
			return MinimizerOutput::passthrough(captured).labeled("piped");
		},
		plan::CommandPlan::Compound => {
			return MinimizerOutput::passthrough(captured).labeled("compound");
		},
		plan::CommandPlan::Unsupported => {
			return MinimizerOutput::passthrough(captured).labeled("parse-error");
		},
	}

	let Some(identity) = detect::detect(command) else {
		record_unknown_command(command);
		return MinimizerOutput::passthrough(captured).labeled("unknown");
	};
	let output = apply_identity(&identity, command, captured, exit_code, config);
	apply_ai_smart_overlay(&identity, command, captured, config, output)
}

/// Optional AI-summary post-step (W4 / rtk smart). Gated by both the Cargo
/// feature `ai-smart` and the runtime `ai_smart_enabled` config flag, and
/// further gated inside [`ai_smart::maybe_summarize`] on input size, parent
/// context (pipe/compound bypass), credential availability, and the per-
/// `apply()` budget. On any gate failure or network error we return the
/// upstream `output` untouched — this filter is fail-closed.
#[cfg_attr(not(feature = "ai-smart"), allow(unused_variables, clippy::needless_pass_by_value))]
fn apply_ai_smart_overlay(
	identity: &detect::CommandIdentity,
	command: &str,
	captured: &str,
	config: &MinimizerConfig,
	output: MinimizerOutput,
) -> MinimizerOutput {
	#[cfg(feature = "ai-smart")]
	{
		if !config.ai_smart_enabled {
			return output;
		}
		ai_smart::reset_apply_budget();
		let subcommand = identity.subcommand.as_deref();
		let ctx = MinimizerCtx { program: &identity.program, subcommand, command, config };
		let candidate = if output.changed { output.text.as_str() } else { captured };
		match ai_smart::maybe_summarize(&ctx, candidate) {
			Some(summary) => {
				let original_text = output
					.original_text
					.clone()
					.unwrap_or_else(|| captured.to_string());
				let input_bytes = output.input_bytes.max(captured.len());
				let summarized = MinimizerOutput::transformed(summary, input_bytes).labeled("ai-smart");
				summarized.with_original(original_text)
			},
			None => output,
		}
	}
	#[cfg(not(feature = "ai-smart"))]
	{
		let _ = (identity, command, captured, config);
		output
	}
}


/// Apply the per-segment dispatch path for a `Chain { segments }` plan.
///
/// The FFI whole-buffer entry point sees the entire chain's captured stdout
/// (interleaved across segments) — we cannot split it per-segment. Instead we
/// recurse into a single filter chosen heuristically (Mode α resolution from
/// T0-OBSERVATION):
///
/// 1. If every segment program is `git`/`yadm`, treat the chain as one big git
///    invocation and route through the git filter. Captures the dominant
///    real-data pattern (`git A && git B && git C` chains).
/// 2. Otherwise route through the first segment's filter when that filter is
///    supported. This recovers bytes when the first segment dominates the
///    captured output.
/// 3. Kill-switch parity (M2): if `legacy_filters_active` is set, return
///    passthrough.labeled("compound") regardless of segment shape so callers
///    can rollback this change without recompile.
fn apply_chain(
	command: &str,
	segments: &[plan::ChainSegment],
	captured: &str,
	exit_code: i32,
	config: &MinimizerConfig,
) -> MinimizerOutput {
	if config.legacy_filters_active() {
		return MinimizerOutput::passthrough(captured).labeled("compound");
	}

	// (d) git-only chain: route through the git filter using the first
	// segment's subcommand as the routing key. The git filter requires
	// a concrete subcommand (status/diff/log/...) so we cannot dispatch
	// with `subcommand=None` here — fall back to chain-first when no
	// dispatchable subcommand is detected.
	if !segments.is_empty()
		&& segments
			.iter()
			.all(|seg| matches!(seg.program.as_str(), "git" | "yadm"))
		&& config.is_program_enabled("git")
		&& let Some(identity) = detect::detect(&segments[0].command)
		&& filters::supports(&identity.program, identity.subcommand.as_deref())
	{
		let subcommand = identity.subcommand.as_deref();
		let ctx = MinimizerCtx { program: &identity.program, subcommand, command, config };
		let out = match catch_unwind(AssertUnwindSafe(|| filters::filter(&ctx, captured, exit_code))) {
			Ok(out) => out,
			Err(_) => MinimizerOutput::passthrough(captured),
		};
		return ensure_success_visible(out.labeled("chain-git"), exit_code).with_original(captured);
	}

	// (b) Mixed chain: recurse into the first segment's filter when supported.
	if let Some(first) = segments.first()
		&& let Some(identity) = detect::detect(&first.command)
	{
		let subcommand = identity.subcommand.as_deref();
		if config.is_program_enabled(&identity.program)
			&& filters::supports(&identity.program, subcommand)
		{
			let ctx = MinimizerCtx {
				program: &identity.program,
				subcommand,
				command,
				config,
			};
			let out = match catch_unwind(AssertUnwindSafe(|| filters::filter(&ctx, captured, exit_code)))
			{
				Ok(out) => out,
				Err(_) => MinimizerOutput::passthrough(captured),
			};
			return ensure_success_visible(out.labeled("chain-first"), exit_code).with_original(captured);
		}
	}

	MinimizerOutput::passthrough(captured).labeled("compound")
}


fn identity_has_filter(identity: &detect::CommandIdentity, config: &MinimizerConfig) -> bool {
	if !config.is_program_enabled(&identity.program) {
		return false;
	}

	let subcommand = identity.subcommand.as_deref();
	filters::supports(&identity.program, subcommand)
		|| resolve_pipeline(config, &identity.program, subcommand).is_some()
}

fn chain_has_eligible_segment(segments: &[plan::ChainSegment], config: &MinimizerConfig) -> bool {
	segments.iter().any(|segment| {
		detect::detect(&segment.command)
			.is_some_and(|identity| identity_has_filter(&identity, config))
			|| is_common_chain_utility(&segment.program)
	})
}

/// Common shell utilities that on their own would not warrant whole-command
/// minimization, but whose presence in a `&&` / `;` chain alongside other
/// segments is enough to fire the segmented chain runner. Each such segment
/// is captured and passes through `minimizer::apply` which will treat it as
/// `Single` with no matching filter and stream the text unchanged.
fn is_common_chain_utility(program: &str) -> bool {
	matches!(
		program,
		"echo"
			| "printf"
			| "head"
			| "tail"
			| "file"
			| "which"
			| "type"
			| "sed"
			| "awk"
			| "sleep"
			| "seq"
			| "cp" | "mv"
			| "rm" | "mkdir"
			| "rmdir"
			| "touch"
			| "basename"
			| "dirname"
			| "realpath"
			| "readlink"
			| "true"
			| "false"
			| "yes"
			| "tr" | "tee"
			| "sort"
			| "uniq"
			| "cut"
			| "paste"
			| "rev"
			| "split"
			| "comm"
			| "patch"
			| "xargs"
			| "unzip"
			| "zip"
			| "tar"
			| "gzip"
			| "gunzip"
			| "cd" | "pwd"
			| "export"
			| "env"
			| "test"
	)
}

fn apply_identity(
	identity: &detect::CommandIdentity,
	command: &str,
	captured: &str,
	exit_code: i32,
	config: &MinimizerConfig,
) -> MinimizerOutput {
	if !config.is_program_enabled(&identity.program) {
		return MinimizerOutput::passthrough(captured).labeled("disabled");
	}

	let subcommand = identity.subcommand.as_deref();

	if filters::supports(&identity.program, subcommand) {
		let ctx = MinimizerCtx { program: &identity.program, subcommand, command, config };
		let rust_output =
			match catch_unwind(AssertUnwindSafe(|| filters::filter(&ctx, captured, exit_code))) {
				Ok(out) => out,
				Err(_) => MinimizerOutput::passthrough(captured),
			};
		let label = program_label(&identity.program);
		let overlaid = apply_pipeline_overlay(config, &identity.program, rust_output, label);
		return ensure_success_visible(overlaid, exit_code).with_original(captured);
	}

	if let Some(pipeline) = resolve_pipeline(config, &identity.program, subcommand) {
		if pipeline.skipped_by_exit(exit_code) {
			return MinimizerOutput::passthrough(captured).labeled("exit-skip");
		}
		let text = catch_unwind(AssertUnwindSafe(|| pipeline.apply(captured).into_owned()))
			.unwrap_or_else(|_| captured.to_string());
		if text == captured {
			return MinimizerOutput::passthrough(captured).labeled("pipeline-noop");
		}
		return ensure_success_visible(
			MinimizerOutput::transformed(text, captured.len()).labeled("pipeline"),
			exit_code,
		)
		.with_original(captured);
	}

	record_unknown_command(command);
	MinimizerOutput::passthrough(captured).labeled("unsupported")
}

fn ensure_success_visible(output: MinimizerOutput, exit_code: i32) -> MinimizerOutput {
	if exit_code == 0 && output.changed && output.text.trim().is_empty() {
		output.with_text("OK\n".to_string())
	} else {
		output
	}
}

/// Per-program label for telemetry. Returns one of a fixed static set so the
/// N-API boundary can carry it as `&'static str` without allocation.
fn program_label(program: &str) -> &'static str {
	match program {
		"git" => "git",
		"yadm" => "yadm",
		"gt" => "gt",
		"bun" => "bun",
		"bunx" => "bunx",
		"cargo" => "cargo",
		"go" => "go",
		"cmake" => "cmake",
		"ctest" => "ctest",
		"ninja" => "ninja",
		"gtest" => "gtest",
		"gtest-parallel" => "gtest",
		program if filters::cpp::is_gtest_binary_name(program) => "gtest",
		"golangci-lint" => "golangci-lint",
		"dotnet" => "dotnet",
		"docker" => "docker",
		"kubectl" => "kubectl",
		"helm" => "helm",
		"gh" => "gh",
		"pytest" => "pytest",
		"ruff" => "ruff",
		"mypy" => "mypy",
		"python" => "python",
		"python3" => "python3",
		"rspec" => "rspec",
		"rake" => "rake",
		"rails" => "rails",
		"rubocop" => "rubocop",
		"rustfmt" => "rustfmt",
		"xxd" => "xxd",
		"strings" => "strings",
		"od" => "od",
		"tsc" => "tsc",
		"eslint" => "eslint",
		"biome" => "biome",
		"jest" => "jest",
		"vitest" => "vitest",
		"playwright" => "playwright",
		"npm" => "npm",
		"pnpm" => "pnpm",
		"yarn" => "yarn",
		"pip" => "pip",
		"pip3" => "pip3",
		"bundle" => "bundle",
		"brew" => "brew",
		"composer" => "composer",
		"uv" => "uv",
		"poetry" => "poetry",
		"aws" => "aws",
		"curl" => "curl",
		"wget" => "wget",
		"psql" => "psql",
		"ls" => "ls",
		"tree" => "tree",
		"find" => "find",
		"grep" => "grep",
		"rg" => "rg",
		"wc" => "wc",
		"cat" => "cat",
		"read" => "read",
		"stat" => "stat",
		"du" => "du",
		"df" => "df",
		"jq" => "jq",
		_ => "builtin",
	}
}

/// If a pipeline matches this program, re-apply it as an *overlay* on top of
/// the Rust filter's output. This lets users tune built-in filter results via
/// their settings TOML without replacing the underlying Rust logic.
fn apply_pipeline_overlay(
	config: &MinimizerConfig,
	program: &str,
	inner: MinimizerOutput,
	primary_label: &'static str,
) -> MinimizerOutput {
	let Some(pipeline) = resolve_pipeline(config, program, None) else {
		return inner.labeled(primary_label);
	};
	let text = catch_unwind(AssertUnwindSafe(|| pipeline.apply(&inner.text).into_owned()))
		.unwrap_or_else(|_| inner.text.clone());
	if text == inner.text {
		return inner.labeled(primary_label);
	}
	let output_bytes = text.len();
	MinimizerOutput {
		text,
		changed: true,
		input_bytes: inner.input_bytes,
		output_bytes,
		filter: "pipeline+builtin",
		original_text: inner.original_text,
	}
}

/// Find the first matching pipeline across user-defined + built-in registries.
fn resolve_pipeline<'a>(
	config: &'a MinimizerConfig,
	program: &str,
	subcommand: Option<&str>,
) -> Option<&'a CompiledPipeline> {
	if let Some(user) = config.user_pipelines.as_deref()
		&& let Some(pipeline) = user.find(program, subcommand)
	{
		return Some(pipeline);
	}
	builtin_pipelines().find(program, subcommand)
}

// Atomic counter for commands that reached `apply` without a matching filter.
static UNKNOWN_COMMAND_COUNT: AtomicU64 = AtomicU64::new(0);

fn record_unknown_command(_command: &str) {
	UNKNOWN_COMMAND_COUNT.fetch_add(1, Ordering::Relaxed);
}

/// Total number of commands that fell through `apply` without any matching
/// filter. Useful for a "coverage gap" indicator in telemetry dashboards.
#[allow(dead_code, reason = "test-only API surface")]
pub fn unknown_command_count() -> u64 {
	UNKNOWN_COMMAND_COUNT.load(Ordering::Relaxed)
}

/// Reset the unknown-command counter (intended for tests).
#[doc(hidden)]
#[allow(dead_code, reason = "test-only API surface")]
pub fn reset_unknown_command_count() {
	UNKNOWN_COMMAND_COUNT.store(0, Ordering::Relaxed);
}

const BUILTIN_FILTERS_TOML: &str = include_str!(concat!(env!("OUT_DIR"), "/builtin_filters.toml"));

static BUILTIN_PIPELINES: LazyLock<PipelineRegistry> =
	LazyLock::new(|| match pipeline::parse_file(BUILTIN_FILTERS_TOML, "builtin") {
		Ok((pipelines, tests)) => PipelineRegistry { pipelines, tests },
		Err(err) => {
			eprintln!("[pi-natives minimizer] failed to load built-in filters: {err}");
			PipelineRegistry::default()
		},
	});

fn builtin_pipelines() -> &'static PipelineRegistry {
	&BUILTIN_PIPELINES
}

/// Expose the built-in registry's inline tests for the verify CLI surface.
#[allow(dead_code, reason = "test-only API surface")]
pub fn verify_builtin_filters() -> Vec<pipeline::TestOutcome> {
	pipeline::run_tests(builtin_pipelines())
}

#[cfg(test)]
mod tests {
	use std::fs;

	use super::*;
	use crate::minimizer::MinimizerOptions;
	fn config_from_settings(contents: &str) -> MinimizerConfig {
		let path = std::env::temp_dir()
			.join(format!("pi-shell-minimizer-engine-{}.toml", std::process::id()));
		fs::write(&path, contents).expect("write minimizer settings");
		let cfg = MinimizerConfig::from_options(&MinimizerOptions {
			enabled: Some(true),
			settings_path: Some(path.to_string_lossy().into_owned()),
			..Default::default()
		});
		let _ = fs::remove_file(path);
		cfg
	}
	#[test]
	fn disabled_config_does_not_minimize() {
		let cfg = MinimizerConfig::default();
		assert!(!should_minimize("git status", &cfg));
		let out = apply("git status", "## main\n", 0, &cfg);
		assert!(!out.changed);
	}

	#[test]
	fn disabled_minimizer_and_disabled_program_do_not_transform_supported_command() {
		let input = "diff --git a/file.rs b/file.rs\n@@\n-old\n+new\n";

		let disabled = MinimizerConfig::default();
		assert!(!should_minimize("git diff", &disabled));
		let out = apply("git diff", input, 0, &disabled);
		assert!(!out.changed);
		assert_eq!(out.text, input);
		assert_eq!(out.filter, "disabled");

		let except_git = MinimizerConfig {
			enabled: true,
			except: ["git".to_string()].into_iter().collect(),
			..Default::default()
		};
		assert!(!should_minimize("git diff", &except_git));
		let out = apply("git diff", input, 0, &except_git);
		assert!(!out.changed);
		assert_eq!(out.text, input);
		assert_eq!(out.filter, "disabled");
	}

	#[test]
	fn enabled_known_filter_minimizes() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		assert!(should_minimize("git diff", &cfg));
		let out = apply("git diff", "diff --git a/file.rs b/file.rs\n@@\n-old\n+new\n", 0, &cfg);
		assert!(out.changed);
		assert!(out.text.contains("file changed"));
	}

	#[test]
	fn enabled_config_minimizes_git_status() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		assert!(should_minimize("git status", &cfg));
		let input = "## main\n M file.rs\n";
		let out = apply("git status", input, 0, &cfg);
		assert!(out.changed);
		assert!(out.text.contains("unstaged 1"));
		assert_eq!(out.filter, "git");
	}

	#[test]
	fn successful_minimization_keeps_visible_ok_when_filter_removes_all_lines() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let out = apply(
			"cargo build",
			"   Compiling app v0.1.0\n    Finished `dev` profile [unoptimized + debuginfo] target(s) \
			 in 1.23s\n",
			0,
			&cfg,
		);

		assert!(out.changed);
		assert_eq!(out.text, "OK\n");
		assert_eq!(out.output_bytes, out.text.len());
		assert!(out.original_text.is_some());
	}

	#[test]
	fn successful_user_pipeline_empty_output_returns_visible_ok() {
		let cfg = config_from_settings(
			r#"
schema_version = 1
[filters.empty_ok]
match_command = "^printf$"
strip_lines_matching = [".*"]
"#,
		);

		assert!(should_minimize("printf done", &cfg));
		let out = apply("printf done", "drop me\n", 0, &cfg);

		assert!(out.changed);
		assert_eq!(out.text, "OK\n");
		assert_eq!(out.filter, "pipeline");
		assert_eq!(out.output_bytes, out.text.len());
		assert_eq!(out.original_text.as_deref(), Some("drop me\n"));
	}

	#[test]
	fn failed_minimization_does_not_invent_ok_for_empty_output() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let out = apply("cargo build", "   Compiling app v0.1.0\n", 1, &cfg);

		assert!(out.changed);
		assert_eq!(out.text, "");
		assert!(out.original_text.is_some());
	}

	#[test]
	fn unknown_command_is_passthrough() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		assert!(!should_minimize("echo hello", &cfg));
		let out = apply("echo hello", "hello\n", 0, &cfg);
		assert_eq!(out.text, "hello\n");
		assert!(!out.changed);
	}

	#[test]
	fn segmented_chain_mode_is_only_for_eligible_safe_chains() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		assert_eq!(
			mode_for("git diff --stat && git diff --name-only", &cfg),
			MinimizerMode::SegmentedChain
		);
		assert_eq!(mode_for("git diff ; printf done", &cfg), MinimizerMode::SegmentedChain);
		// Common shell utilities make a chain eligible for the segmented runner
		// even when no segment has a dedicated filter — segments stream through
		// per-segment passthrough so the chain itself is captured for telemetry.
		assert_eq!(mode_for("false && echo no ; echo yes", &cfg), MinimizerMode::SegmentedChain);
		assert_eq!(mode_for("foo || bar", &cfg), MinimizerMode::None);
		assert_eq!(mode_for("git status | cat", &cfg), MinimizerMode::None);
		assert_eq!(mode_for("sleep 1 &", &cfg), MinimizerMode::None);
		assert_eq!(mode_for("(cd foo && make)", &cfg), MinimizerMode::None);
	}

	#[test]
	fn segmented_chain_supported_command_does_not_record_unknown() {
		// Phase 7 (Mode α resolution): supported chains route through
		// filters::dispatch via the chain decomposer instead of falling
		// back to passthrough. The unknown-command counter must remain
		// stable — the chain entry point is structurally known.
		reset_unknown_command_count();
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let input = "diff --git a/file.rs b/file.rs\n@@\n-old\n+new\n";
		let before = unknown_command_count();

		assert_eq!(mode_for("git diff ; printf done", &cfg), MinimizerMode::SegmentedChain);
		let out = apply("git diff ; printf done", input, 0, &cfg);

		// First segment is `git diff`, second is `printf`. Not all-git, so
		// route via chain-first (git filter on the captured diff).
		assert!(out.changed, "git-led chain should be rewritten by chain-first dispatch");
		assert_eq!(out.filter, "chain-first");
		assert_eq!(unknown_command_count(), before);
	}

	#[test]
	fn cpp_tools_minimize_through_dispatch() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		assert!(should_minimize("ctest --output-on-failure", &cfg));
		assert!(should_minimize("./build/foo_test --gtest_filter=Foo.*", &cfg));

		let ctest = apply(
			"ctest --output-on-failure",
			"Test project /tmp/build\n1/2 Test #1: ok ........   Passed    0.01 sec\n2/2 Test #2: \
			 bad .......***Failed    0.02 sec\nThe following tests FAILED:\n",
			8,
			&cfg,
		);
		assert!(ctest.changed);
		assert_eq!(ctest.filter, "ctest");
		assert!(!ctest.text.contains("Test #1"));
		assert!(ctest.text.contains("Test #2: bad"));

		let gtest = apply(
			"./build/foo_test",
			"[ RUN      ] Foo.Pass\n[       OK ] Foo.Pass (0 ms)\nfoo_test.cc:42: Failure\nExpected: \
			 1\n[  FAILED  ] Foo.Fails\n",
			1,
			&cfg,
		);
		assert!(gtest.changed);
		assert_eq!(gtest.filter, "gtest");
		assert!(!gtest.text.contains("Foo.Pass"));
		assert!(gtest.text.contains("foo_test.cc:42: Failure"));
	}

	#[test]
	fn git_only_chain_routes_through_git_filter() {
		// Phase 7 (Mode α resolution): `git A && git B` chains route through
		// the git filter on the whole captured buffer.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let command = "git status && git log -1";
		let input = "## main\n M file.rs\n";
		let out = apply(command, input, 0, &cfg);
		assert!(out.changed, "git-only chain should be rewritten by the git filter");
		assert_eq!(out.filter, "chain-git");
		assert!(
			out.text.contains("unstaged 1") || out.text.contains("OK"),
			"chain-git output should resemble git filter output: {:?}",
			out.text
		);
	}

	#[test]
	fn mixed_chain_routes_through_first_program() {
		// Phase 7: a chain whose first segment is git routes through the git
		// filter even when later segments are unrelated. The captured buffer
		// is interleaved, but routing via the dominant first segment still
		// recovers bytes most of the time.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let command = "git status && ls -la";
		let input = "## main\n M file.rs\n";
		let out = apply(command, input, 0, &cfg);
		assert!(out.changed);
		assert_eq!(out.filter, "chain-first");
	}

	#[test]
	fn unsupported_first_segment_chain_is_passthrough() {
		// Phase 7: chains whose first segment has no filter fall back to
		// passthrough labeled "compound" (preserves legacy behavior).
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let out = apply("zzzobscure && zzznever", "noise\n", 0, &cfg);
		assert!(!out.changed);
		assert_eq!(out.filter, "compound");
	}

	#[test]
	fn chain_legacy_filters_active_passes_through() {
		// Phase 7 kill-switch parity (M2): legacy_filters_active=true returns
		// passthrough.labeled("compound") regardless of segment shape.
		let mut cfg = MinimizerConfig::default();
		cfg.enabled = true;
		cfg.legacy_filters_active = true;
		let input = "## main\n M file.rs\n";
		let out = apply("git status && git log -1", input, 0, &cfg);
		assert!(!out.changed);
		assert_eq!(out.filter, "compound");
	}
}

#[cfg(test)]
mod pipeline_integration_tests {
	use super::*;
	use crate::minimizer::MinimizerOptions;

	#[test]
	fn builtin_filters_parse_and_pass_inline_tests() {
		let outcomes = verify_builtin_filters();
		let failures: Vec<_> = outcomes.iter().filter(|o| !o.passed).collect();
		assert!(
			failures.is_empty(),
			"{} built-in inline tests failed:\n{}",
			failures.len(),
			failures
				.iter()
				.map(|f| format!(
					" - [{}/{}] expected {:?}, got {:?}",
					f.filter_name, f.test_name, f.expected, f.actual
				))
				.collect::<Vec<_>>()
				.join("\n")
		);
		assert!(!outcomes.is_empty(), "expected built-in inline tests");
	}

	#[test]
	fn pipeline_matches_gradle_via_apply() {
		let cfg = MinimizerConfig::from_options(&MinimizerOptions {
			enabled: Some(true),
			..Default::default()
		});
		let out = apply(
			"gradle build",
			"> Task :app:compileJava UP-TO-DATE\n> Task :app:test\nBUILD SUCCESSFUL in 8s\n",
			0,
			&cfg,
		);
		assert!(out.changed, "gradle pipeline should transform");
		assert!(!out.text.contains("UP-TO-DATE"));
		assert!(out.text.contains("BUILD SUCCESSFUL"));
		assert_eq!(out.filter, "pipeline");
		assert!(out.bytes_saved() > 0);
	}

	#[test]
	fn too_large_input_is_passthrough() {
		let cfg = MinimizerConfig::from_options(&MinimizerOptions {
			enabled: Some(true),
			max_capture_bytes: Some(1024),
			..Default::default()
		});
		let big = "x".repeat(2048);
		let out = apply("git status", &big, 0, &cfg);
		assert!(!out.changed);
		assert_eq!(out.filter, "too-large");
	}

	#[test]
	fn unknown_command_counter_increments() {
		reset_unknown_command_count();
		let cfg = MinimizerConfig::from_options(&MinimizerOptions {
			enabled: Some(true),
			..Default::default()
		});
		let before = unknown_command_count();
		let _ = apply("zzzobscurecmd foo", "hi\n", 0, &cfg);
		let after = unknown_command_count();
		assert!(after > before, "counter should advance for unknown commands");
	}
}
