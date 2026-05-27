//! Filter dispatch table for built-in minimizer strategies.

use crate::minimizer::{MinimizerCtx, MinimizerOutput};

pub mod ai_smart;
pub mod cloud;
pub mod cpp;

pub mod bun;

pub mod cargo;
pub mod docker;

pub mod dotnet;

pub mod generic;
pub mod gh;

pub mod go;
pub mod gt;

pub mod git;

pub mod js_tools;

pub mod lint;
pub mod listing;
pub mod node_tests;
pub mod pkg;

pub mod python;
pub mod ruby;
pub mod system;

pub fn supports(program: &str, subcommand: Option<&str>) -> bool {
	match program {
		"git" | "yadm" => git::supports(subcommand),
		"gt" => gt::supports(program, subcommand),
		"bun" | "bunx" => bun::supports(program, subcommand),
		"cargo" => cargo::supports(subcommand),
		"go" | "golangci-lint" => go::supports(program, subcommand),
		"cmake" | "ctest" | "ninja" | "gtest" | "gtest-parallel" => {
			cpp::supports(program, subcommand)
		},
		program if cpp::is_gtest_binary_name(program) => cpp::supports(program, subcommand),
		"dotnet" => dotnet::supports(program, subcommand),
		"ls" | "tree" | "find" | "grep" | "rg" | "wc" | "cat" | "read" | "stat" | "du" | "df"
		| "jq" | "json" => true,
		"aws" | "curl" | "wget" | "psql" => cloud::supports(program, subcommand),
		"docker" | "kubectl" | "helm" => docker::supports(subcommand),
		"gh" => gh::supports(subcommand),
		"pytest" | "ruff" | "mypy" | "python" | "python3" | "py" => {
			python::supports(program, subcommand)
		},
		"rspec" | "rake" | "rails" | "rubocop" => ruby::supports(program, subcommand),
		"tsc" | "eslint" | "biome" | "shellcheck" | "markdownlint" | "hadolint" | "yamllint"
		| "oxlint" | "pyright" | "basedpyright" => {
			lint::supports(subcommand) || lint::supports_program(program, subcommand)
		},
		"jest" | "vitest" | "playwright" => true,
		"next" | "prettier" | "prisma" => js_tools::supports(program, subcommand),
		"npx" => {
			matches!(subcommand, Some("tsc" | "eslint" | "biome" | "jest" | "vitest" | "playwright"))
				|| js_tools::supports(program, subcommand)
		},
		"pnpm" if matches!(subcommand, Some("dlx")) => true,
		"uv" if matches!(subcommand, Some("run")) => true,
		"npm" | "pnpm" | "yarn" | "pip" | "pip3" | "bundle" | "brew" | "composer" | "uv"
		| "poetry" => pkg::supports(subcommand),
		"env" | "log" | "deps" | "summary" | "err" | "test" | "diff" | "format" | "pipe" | "ps"
		| "ping" | "ssh" | "sops" => system::supports(program),
		_ => false,
	}
}

fn is_test_script_token(token: &str) -> bool {
	let token = token.trim_matches(|ch| matches!(ch, '\'' | '"' | '`'));
	matches!(token, "test" | "t" | "e2e" | "spec") || token.starts_with("test:")
}

fn command_contains_test_script(command: &str) -> bool {
	command
		.split(|ch: char| ch.is_whitespace() || matches!(ch, ';' | '|' | '&'))
		.any(is_test_script_token)
}

fn is_pkg_test_invocation(ctx: &MinimizerCtx<'_>) -> bool {
	matches!(ctx.subcommand, Some("test" | "t"))
		|| matches!(ctx.subcommand, Some("run")) && command_contains_test_script(ctx.command)
}

fn is_pkg_lint_invocation(ctx: &MinimizerCtx<'_>) -> bool {
	matches!(ctx.subcommand, Some("run"))
		&& (command_contains_lint_script(ctx.command)
			|| command_contains_tool(ctx.command, &["tsc", "eslint", "biome"]))
}

fn command_contains_lint_script(command: &str) -> bool {
	command
		.split(|ch: char| ch.is_whitespace() || matches!(ch, ';' | '|' | '&'))
		.any(is_lint_script_token)
}

fn is_lint_script_token(token: &str) -> bool {
	let token = token.trim_matches(|ch| matches!(ch, '\'' | '"' | '`'));
	matches!(token, "lint" | "typecheck" | "type-check")
		|| token.starts_with("lint:")
		|| token.starts_with("typecheck:")
		|| token.starts_with("type-check:")
}

fn command_contains_tool(command: &str, tools: &[&str]) -> bool {
	command
		.split(|ch: char| ch.is_whitespace() || matches!(ch, ';' | '|' | '&'))
		.any(|token| tools.contains(&token))
}

/// Apply the matching built-in filter.
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let _ = ctx.command;
	let _ = ctx.config.per_command(ctx.program);
	match ctx.program {
		"git" | "yadm" => git::filter(ctx, input, exit_code),
		"gt" => gt::filter(ctx, input, exit_code),
		"bun" | "bunx" => bun::filter(ctx, input, exit_code),
		"cargo" => cargo::filter(ctx, input, exit_code),
		"go" | "golangci-lint" => go::filter(ctx, input, exit_code),
		"dotnet" => dotnet::filter(ctx, input, exit_code),
		"cmake" | "ctest" | "ninja" | "gtest" | "gtest-parallel" => {
			cpp::filter(ctx, input, exit_code)
		},
		program if cpp::is_gtest_binary_name(program) => cpp::filter(ctx, input, exit_code),
		"ls" | "tree" | "find" | "grep" | "rg" | "wc" | "cat" | "read" | "stat" | "du" | "df"
		| "jq" | "json" => listing::filter(ctx, input, exit_code),
		"aws" | "curl" | "wget" | "psql" => cloud::filter(ctx, input, exit_code),
		"docker" | "kubectl" | "helm" => docker::filter(ctx, input, exit_code),
		"gh" => gh::filter(ctx, input, exit_code),
		"pytest" | "ruff" | "mypy" | "python" | "python3" | "py" => {
			python::filter(ctx, input, exit_code)
		},
		"rspec" | "rake" | "rails" | "rubocop" => ruby::filter(ctx, input, exit_code),
		"tsc" | "eslint" | "biome" | "shellcheck" | "markdownlint" | "hadolint" | "yamllint"
		| "oxlint" | "pyright" | "basedpyright" => lint::filter(ctx, input, exit_code),
		"jest" | "vitest" | "playwright" => node_tests::filter(ctx, input, exit_code),
		"next" | "prettier" | "prisma" => js_tools::filter(ctx, input, exit_code),
		"npx" => filter_js_wrapper(ctx, input, exit_code),
		"pnpm" if matches!(ctx.subcommand, Some("dlx")) => filter_js_wrapper(ctx, input, exit_code),
		"uv" if matches!(ctx.subcommand, Some("run")) => filter_uv_wrapper(ctx, input, exit_code),
		"npm" | "pnpm" | "yarn" => {
			if is_pkg_test_invocation(ctx) {
				node_tests::filter(ctx, input, exit_code)
			} else if is_pkg_lint_invocation(ctx) {
				lint::filter(ctx, input, exit_code)
			} else {
				pkg::filter(ctx, input, exit_code)
			}
		},
		"pip" | "pip3" | "bundle" | "brew" | "composer" | "uv" | "poetry" => {
			pkg::filter(ctx, input, exit_code)
		},
		"env" | "log" | "deps" | "summary" | "err" | "test" | "diff" | "format" | "pipe" | "ps"
		| "ping" | "ssh" | "sops" => system::filter(ctx, input, exit_code),
		_ => generic::filter(ctx, input, exit_code),
	}
}

fn filter_js_wrapper(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	if wrapper_invokes(ctx, &["tsc", "eslint", "biome"]) {
		lint::filter(ctx, input, exit_code)
	} else if wrapper_invokes(ctx, &["jest", "vitest", "playwright"]) {
		node_tests::filter(ctx, input, exit_code)
	} else if js_tools::supports(ctx.program, ctx.subcommand) {
		js_tools::filter(ctx, input, exit_code)
	} else {
		MinimizerOutput::passthrough(input)
	}
}

fn filter_uv_wrapper(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	match uv_wrapper_tool(ctx) {
		Some("pytest") => {
			let routed = MinimizerCtx {
				program: "pytest",
				subcommand: Some("pytest"),
				command: ctx.command,
				config: ctx.config,
			};
			python::filter(&routed, input, exit_code)
		},
		Some("ruff") => {
			let subcommand = if ctx.command.split_whitespace().any(|part| part == "format") {
				Some("format")
			} else {
				Some("ruff")
			};
			let routed =
				MinimizerCtx { program: "ruff", subcommand, command: ctx.command, config: ctx.config };
			python::filter(&routed, input, exit_code)
		},
		Some("mypy") => {
			let routed = MinimizerCtx {
				program: "mypy",
				subcommand: Some("mypy"),
				command: ctx.command,
				config: ctx.config,
			};
			python::filter(&routed, input, exit_code)
		},
		Some(tool @ ("tsc" | "eslint" | "biome" | "pyright" | "basedpyright" | "oxlint")) => {
			let routed = MinimizerCtx {
				program: tool,
				subcommand: Some(tool),
				command: ctx.command,
				config: ctx.config,
			};
			lint::filter(&routed, input, exit_code)
		},
		Some("jest" | "vitest" | "playwright") => node_tests::filter(ctx, input, exit_code),
		_ => MinimizerOutput::passthrough(input),
	}
}

fn uv_wrapper_tool<'a>(ctx: &'a MinimizerCtx<'_>) -> Option<&'a str> {
	wrapper_invoked_tool(
		ctx,
		&[
			"pytest",
			"ruff",
			"mypy",
			"tsc",
			"eslint",
			"biome",
			"pyright",
			"basedpyright",
			"oxlint",
			"jest",
			"vitest",
			"playwright",
		],
	)
}

fn wrapper_invokes(ctx: &MinimizerCtx<'_>, tools: &[&str]) -> bool {
	wrapper_invoked_tool(ctx, tools).is_some()
}

fn wrapper_invoked_tool<'a>(ctx: &'a MinimizerCtx<'_>, tools: &[&'a str]) -> Option<&'a str> {
	ctx.subcommand
		.and_then(|subcommand| tools.iter().copied().find(|tool| *tool == subcommand))
		.or_else(|| {
			ctx.command
				.split(|ch: char| ch.is_whitespace() || matches!(ch, ';' | '|' | '&'))
				.find(|token| tools.contains(token))
		})
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::minimizer::MinimizerConfig;

	fn ctx<'a>(
		program: &'a str,
		subcommand: Option<&'a str>,
		command: &'a str,
		config: &'a MinimizerConfig,
	) -> MinimizerCtx<'a> {
		MinimizerCtx { program, subcommand, command, config }
	}

	#[test]
	fn npx_test_tools_route_to_node_test_filter() {
		let config = MinimizerConfig::default();
		let context = ctx("npx", Some("vitest"), "npx vitest", &config);
		let input = "✓ passes\nFAIL src/example.test.ts\nAssertionError: expected true\nTests: 1 \
		             failed, 1 passed\n";
		let out = filter(&context, input, 1).text;
		assert!(!out.contains("✓ passes"));
		assert!(out.contains("FAIL src/example.test.ts"));
		assert!(out.contains("AssertionError"));
	}

	#[test]
	fn pnpm_dlx_unknown_tool_is_passthrough() {
		let config = MinimizerConfig::default();
		let context = ctx("pnpm", Some("dlx"), "pnpm dlx unknown-tool", &config);
		let input = "line 1\nline 2\n";
		let out = filter(&context, input, 0);
		assert_eq!(out.text, input);
		assert!(!out.changed);
	}

	#[test]
	fn uv_run_pytest_routes_to_python_filter() {
		let config = MinimizerConfig::default();
		let context = ctx("uv", Some("run"), "uv run pytest", &config);
		let input = "============================= test session starts \
		             ==============================\ncollected 2 items\n\na.py .\nb.py \
		             F\n\n=================================== FAILURES \
		             ===================================\nFAILED b.py::test_fail - AssertionError: \
		             expected 2 == 1\n=========================== short test summary info \
		             ============================\nFAILED b.py::test_fail - AssertionError: \
		             expected 2 == 1\n========================= 1 failed, 1 passed in 0.12s \
		             =========================\n";
		let out = filter(&context, input, 1).text;
		assert!(out.contains("FAILED b.py::test_fail"));
		assert!(!out.contains("collected 2 items"));
		assert!(out.contains("pytest: 1 failed, 1 passed"));
	}

	#[test]
	fn uv_run_ruff_routes_to_python_filter() {
		let config = MinimizerConfig::default();
		let context = ctx("uv", Some("run"), "uv run ruff check .", &config);
		let input = "src/app.py:1:1: F401 imported but unused\nFound 1 error.\n";
		let out = filter(&context, input, 1).text;
		assert!(out.contains("F401"));
	}

	#[test]
	fn uv_run_python_module_pytest_routes_to_python_filter() {
		let config = MinimizerConfig::default();
		let context = ctx("uv", Some("run"), "uv run python -m pytest", &config);
		let input = "============================= test session starts \
		             ==============================\ncollected 1 item\n\na.py \
		             F\n\n=================================== FAILURES \
		             ===================================\nFAILED a.py::test_fail - \
		             AssertionError\n========================= 1 failed in 0.03s \
		             =========================\n";
		let out = filter(&context, input, 1).text;
		assert!(out.contains("FAILED a.py::test_fail"));
		assert!(!out.contains("collected 1 item"));
	}

	#[test]
	fn uv_run_pyright_routes_to_lint_filter() {
		let config = MinimizerConfig::default();
		let context = ctx("uv", Some("run"), "uv run pyright", &config);
		let input = "0 errors, 0 warnings, 0 informations\nsrc/app.ts:4:7 - error TS2322: Type \
		             'string' is not assignable to type 'number'.\n";
		let out = filter(&context, input, 1).text;
		assert!(out.contains("TS2322"));
	}

	#[test]
	fn uv_run_basedpyright_routes_to_lint_filter() {
		let config = MinimizerConfig::default();
		let context = ctx("uv", Some("run"), "uv run basedpyright", &config);
		let input = "0 errors, 0 warnings, 0 notes\nsrc/app.ts:4:7 - error TS2322: Type 'string' is \
		             not assignable to type 'number'.\n";
		let out = filter(&context, input, 1).text;
		assert!(out.contains("TS2322"));
	}

	#[test]
	fn uv_run_unknown_tool_is_passthrough() {
		let config = MinimizerConfig::default();
		let context = ctx("uv", Some("run"), "uv run custom-tool", &config);
		let input = "line 1\nline 2\n";
		let out = filter(&context, input, 0);
		assert_eq!(out.text, input);
		assert!(!out.changed);
	}

	#[test]
	fn npm_test_routes_to_node_tests() {
		let config = MinimizerConfig::default();
		let context = ctx("npm", Some("test"), "npm test", &config);
		let out = filter(&context, "✓ ok\nFAIL app.test.ts\nTests 1 failed\n", 1).text;
		assert!(!out.contains("✓ ok"));
		assert!(out.contains("FAIL app.test.ts"));
	}

	#[test]
	fn npm_run_test_routes_to_node_tests() {
		let config = MinimizerConfig::default();
		let context = ctx("npm", Some("run"), "npm run test", &config);
		let out = filter(&context, "✓ ok\nFAIL app.test.ts\nTests 1 failed\n", 1).text;
		assert!(!out.contains("✓ ok"));
		assert!(out.contains("FAIL app.test.ts"));
	}

	#[test]
	fn npm_run_quoted_test_routes_to_node_tests() {
		let config = MinimizerConfig::default();
		let context = ctx("npm", Some("run"), "npm run \"test\"", &config);
		let out = filter(&context, "✓ ok\nFAIL app.test.ts\nTests 1 failed\n", 1).text;
		assert!(!out.contains("✓ ok"));
		assert!(out.contains("FAIL app.test.ts"));
	}

	#[test]
	fn pnpm_test_routes_to_node_tests() {
		let config = MinimizerConfig::default();
		let context = ctx("pnpm", Some("test"), "pnpm test", &config);
		let out = filter(&context, "✓ ok\nFAIL app.test.ts\nTests 1 failed\n", 1).text;
		assert!(!out.contains("✓ ok"));
		assert!(out.contains("FAIL app.test.ts"));
	}

	#[test]
	fn pnpm_run_test_routes_to_node_tests() {
		let config = MinimizerConfig::default();
		let context = ctx("pnpm", Some("run"), "pnpm run test", &config);
		let out = filter(&context, "✓ ok\nFAIL app.test.ts\nTests 1 failed\n", 1).text;
		assert!(!out.contains("✓ ok"));
		assert!(out.contains("FAIL app.test.ts"));
	}

	#[test]
	fn yarn_test_routes_to_node_tests() {
		let config = MinimizerConfig::default();
		let context = ctx("yarn", Some("test"), "yarn test", &config);
		let out = filter(&context, "✓ ok\nFAIL app.test.ts\nTests 1 failed\n", 1).text;
		assert!(!out.contains("✓ ok"));
		assert!(out.contains("FAIL app.test.ts"));
	}

	#[test]
	fn yarn_run_test_routes_to_node_tests() {
		let config = MinimizerConfig::default();
		let context = ctx("yarn", Some("run"), "yarn run test", &config);
		let out = filter(&context, "✓ ok\nFAIL app.test.ts\nTests 1 failed\n", 1).text;
		assert!(!out.contains("✓ ok"));
		assert!(out.contains("FAIL app.test.ts"));
	}

	#[test]
	fn npm_run_build_still_uses_pkg_filter() {
		let config = MinimizerConfig::default();
		let context = ctx("npm", Some("run"), "npm run build", &config);
		let out = filter(&context, "Resolving dependencies\nDownloaded foo\nerror: failed\n", 1).text;
		assert!(!out.contains("Resolving dependencies"));
		assert!(out.contains("error: failed"));
	}

	#[test]
	fn package_manager_lint_scripts_route_to_lint_filter() {
		let config = MinimizerConfig::default();
		let input = concat!(
			"src/app.ts:1:1: error TS2322: Type 'string' is not assignable to type 'number'.\n",
			"src/app.ts:2:1: error TS7006: Parameter 'x' implicitly has an 'any' type.\n",
		);

		for (program, command) in [
			("npm", "npm run lint"),
			("npm", "npm run typecheck"),
			("pnpm", "pnpm run lint:ci"),
			("yarn", "yarn run typecheck:ci"),
		] {
			let context = ctx(program, Some("run"), command, &config);
			let routed = filter(&context, input, 1).text;
			let expected = lint::filter(&context, input, 1).text;
			assert_eq!(routed, expected, "{command} should use lint filter");
			assert!(
				routed.contains("2 diagnostics in 1 files"),
				"{command} should condense lint output"
			);
		}
	}

	#[test]
	fn npm_t_routes_to_node_tests() {
		let config = MinimizerConfig::default();
		let context = ctx("npm", Some("t"), "npm t", &config);
		let out = filter(&context, "✓ ok\nFAIL app.test.ts\nTests 1 failed\n", 1).text;
		assert!(!out.contains("✓ ok"));
		assert!(out.contains("FAIL app.test.ts"));
	}

	#[test]
	fn pi_cli_names_are_not_supported() {
		assert!(!supports("rtk", None));
		assert!(!supports("pi", None));
	}
}
