//! Package manager output filters.

use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};
const PACKAGE_TREE_HEAD_LINES: usize = 80;

pub fn supports(subcommand: Option<&str>) -> bool {
	matches!(
		subcommand,
		Some(
			"install"
				| "i" | "ci"
				| "add" | "update"
				| "up" | "upgrade"
				| "remove"
				| "rm" | "uninstall"
				| "list" | "ls"
				| "tree"
				| "pip"
				| "outdated"
				| "sync" | "lock"
				| "run" | "exec"
				| "audit"
				| "check"
				| "show" | "info"
				| "view" | "fund"
				| "explain"
				| "test" | "t"
				| "start"
				| "stop" | "restart"
				| "config"
				| "cache"
				| "prune"
				| "dedupe"
				| "publish"
				| "pack"
				| "link"
				| "why"
				| "export"
		)
	)
}

pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let cleaned = primitives::strip_ansi(input);
	let stripped = strip_package_noise(ctx.program, &cleaned, exit_code);
	let deduped = primitives::dedup_consecutive_lines(&stripped);
	let text = if contains_audit_or_security_summary(&deduped) {
		deduped
	} else if exit_code == 0 && (is_package_tree_command(ctx) || is_package_export_command(ctx)) {
		compact_package_tree_output(&deduped)
	} else {
		primitives::head_tail_lines(&deduped, 120, 80)
	};

	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

fn strip_package_noise(program: &str, input: &str, exit_code: i32) -> String {
	let mut out = String::new();
	let mut previous_blank = false;
	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() {
			if !previous_blank {
				out.push('\n');
			}
			previous_blank = true;
			continue;
		}
		previous_blank = false;

		if is_noise_line(program, trimmed, exit_code) {
			continue;
		}
		out.push_str(line.trim_end());
		out.push('\n');
	}
	out
}

fn is_package_tree_command(ctx: &MinimizerCtx<'_>) -> bool {
	match ctx.program {
		"npm" | "pnpm" | "yarn" => {
			matches!(ctx.subcommand, Some("list" | "ls" | "tree" | "why" | "explain"))
		},
		"bun" => {
			matches!(ctx.subcommand, Some("list" | "ls" | "tree" | "why" | "explain"))
				|| matches!(ctx.subcommand, Some("pm"))
					&& command_contains_any(ctx.command, &["list", "ls", "tree", "why"])
		},
		"uv" => {
			matches!(ctx.subcommand, Some("list" | "ls" | "tree"))
				|| matches!(ctx.subcommand, Some("pip"))
					&& command_contains_any(ctx.command, &["list", "ls", "tree", "freeze"])
		},
		"poetry" => {
			matches!(ctx.subcommand, Some("tree"))
				|| matches!(ctx.subcommand, Some("show")) && command_contains_any(ctx.command, &["--tree"])
		},
		_ => false,
	}
}

fn is_package_export_command(ctx: &MinimizerCtx<'_>) -> bool {
	match ctx.program {
		"uv" | "poetry" => ctx.subcommand == Some("export"),
		_ => false,
	}
}

fn command_contains_any(command: &str, words: &[&str]) -> bool {
	command.split_whitespace().any(|part| words.contains(&part))
}

fn compact_package_tree_output(input: &str) -> String {
	if let Some(summary) = compact_package_tree_json_output(input) {
		return summary;
	}
	let lines: Vec<&str> = input
		.lines()
		.map(str::trim_end)
		.filter(|line| !line.trim().is_empty())
		.collect();
	if lines.len() <= PACKAGE_TREE_HEAD_LINES {
		return input.to_string();
	}

	let mut out = format!("package tree/list: {} entries\n", lines.len());
	for line in lines.iter().take(PACKAGE_TREE_HEAD_LINES) {
		out.push_str(line);
		out.push('\n');
	}
	out.push_str(&format!(
		"… {} package entries omitted …\n",
		lines.len() - PACKAGE_TREE_HEAD_LINES
	));
	out
}

fn compact_package_tree_json_output(input: &str) -> Option<String> {
	let value: serde_json::Value = serde_json::from_str(input).ok()?;
	let mut rows = Vec::new();
	collect_package_tree_json_rows(&value, &mut rows);
	if rows.is_empty() {
		return None;
	}
	let mut out = format!("package tree/list: {} entries\n", rows.len());
	for row in rows.iter().take(PACKAGE_TREE_HEAD_LINES) {
		out.push_str(row);
		out.push('\n');
	}
	if rows.len() > PACKAGE_TREE_HEAD_LINES {
		out.push_str(&format!(
			"… {} package entries omitted …\n",
			rows.len() - PACKAGE_TREE_HEAD_LINES
		));
	}
	Some(out)
}

fn collect_package_tree_json_rows(value: &serde_json::Value, rows: &mut Vec<String>) {
	match value {
		serde_json::Value::Object(map) => {
			if let Some(name) = map.get("name").and_then(serde_json::Value::as_str) {
				let version = map.get("version").and_then(serde_json::Value::as_str).unwrap_or("");
				rows.push(if version.is_empty() {
					name.to_string()
				} else {
					format!("{name} {version}")
				});
			}
			if let Some(dependencies) = map.get("dependencies").and_then(serde_json::Value::as_object) {
				for (name, child) in dependencies {
					push_json_dependency_row(rows, name, child);
					collect_package_tree_json_rows(child, rows);
				}
			}
			if let Some(items) = map.get("packages").and_then(serde_json::Value::as_array) {
				for item in items {
					collect_package_tree_json_rows(item, rows);
				}
			}
		},
		serde_json::Value::Array(items) => {
			for item in items {
				collect_package_tree_json_rows(item, rows);
			}
		},
		_ => {},
	}
}

fn push_json_dependency_row(rows: &mut Vec<String>, name: &str, child: &serde_json::Value) {
	let version = child
		.get("version")
		.and_then(serde_json::Value::as_str)
		.unwrap_or("");
	rows.push(if version.is_empty() {
		name.to_string()
	} else {
		format!("{name} {version}")
	});
}

fn is_noise_line(program: &str, line: &str, exit_code: i32) -> bool {
	if is_audit_or_security_summary(line) {
		return false;
	}
	if exit_code != 0 && is_error_or_summary(line) {
		return false;
	}

	let lower = line.to_ascii_lowercase();
	is_generic_progress(line, &lower)
		|| is_js_package_noise(program, line, &lower)
		|| is_python_package_noise(program, line, &lower)
		|| is_ruby_php_brew_noise(program, line, &lower)
}

fn is_generic_progress(line: &str, lower: &str) -> bool {
	line.starts_with("Progress:")
		|| line.starts_with("Resolving:")
		|| line.starts_with("Downloading:")
		|| line.starts_with("Downloaded")
		|| lower.starts_with("resolving dependencies")
		|| lower.starts_with("installing dependencies")
		|| lower.starts_with("fetching packages")
		|| lower.contains("spinner")
		|| line
			.chars()
			.all(|ch| matches!(ch, '⠁' | '⠂' | '⠄' | '⡀' | '⢀' | '⠠' | '⠐' | '⠈' | ' '))
}

fn is_js_package_noise(program: &str, line: &str, lower: &str) -> bool {
	if !matches!(program, "npm" | "pnpm" | "yarn" | "bun") {
		return false;
	}
	line.starts_with('>') && line.contains('@')
		|| lower.starts_with("npm notice")
		|| lower.starts_with("npm warn deprecated")
		|| lower.starts_with("npm http fetch")
		|| lower.starts_with("pnpm: progress")
		|| lower.starts_with("packages:")
		|| lower.starts_with("resolved ")
		|| lower.starts_with("reused ")
		|| lower.starts_with("added ") && lower.contains("packages")
		|| lower.starts_with("done in ")
		|| lower.contains("already up-to-date")
}

fn is_python_package_noise(program: &str, _line: &str, lower: &str) -> bool {
	if !matches!(program, "pip" | "uv" | "poetry") {
		return false;
	}
	lower.starts_with("collecting ")
		|| lower.starts_with("using cached ")
		|| lower.starts_with("downloading ")
		|| lower.starts_with("preparing metadata")
		|| lower.starts_with("installing build dependencies")
		|| lower.starts_with("resolving dependencies")
		|| lower.starts_with("writing lock file")
		|| lower.starts_with("package operations:")
		|| program == "uv" && is_uv_progress_noise(lower)
}

fn is_uv_progress_noise(lower: &str) -> bool {
	lower.starts_with("resolved ")
		|| lower.starts_with("prepared ")
		|| lower.starts_with("installed ")
		|| lower.starts_with("uninstalled ")
		|| lower.starts_with("updated ")
		|| lower.starts_with("built ")
		|| lower.starts_with("downloaded ")
}

fn is_ruby_php_brew_noise(program: &str, _line: &str, lower: &str) -> bool {
	if !matches!(program, "bundle" | "brew" | "composer") {
		return false;
	}
	lower.starts_with("fetching ")
		|| lower.starts_with("installing ") && !lower.contains("error")
		|| lower.starts_with("using ")
		|| lower.starts_with("bundle complete")
		|| lower.starts_with("==> downloading")
		|| lower.starts_with("==> pouring")
		|| lower.starts_with("loading composer repositories")
		|| lower.starts_with("generating autoload files")
}

fn contains_audit_or_security_summary(input: &str) -> bool {
	input.lines().any(is_audit_or_security_summary)
}

fn is_audit_or_security_summary(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	lower.contains("audit")
		|| lower.contains("audited")
		|| lower.contains("vulnerab")
		|| lower.contains("security")
		|| lower.contains("funding")
}

fn is_error_or_summary(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	lower.contains("error")
		|| lower.contains("failed")
		|| lower.contains("warning")
		|| lower.contains("vulnerab")
		|| lower.contains("audited")
		|| lower.contains("found ")
		|| lower.contains("success")
		|| lower.contains("complete")
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::minimizer::MinimizerConfig;

	#[test]
	fn strips_progress_but_keeps_package_errors() {
		let input = "Resolving: total 10\nDownloading: left-pad\nERROR failed to install \
		             left-pad\nfound 1 vulnerability\n";
		let out = strip_package_noise("npm", input, 1);
		assert!(!out.contains("Resolving:"));
		assert!(!out.contains("Downloading:"));
		assert!(out.contains("ERROR failed"));
		assert!(out.contains("found 1 vulnerability"));
	}

	#[test]
	fn preserves_successful_install_audit_and_security_summaries() {
		let input = "Resolving: total 10\nadded 3 packages, and audited 4 packages in 1s\n2 \
		             packages are looking for funding\nfound 0 vulnerabilities\n";
		let out = strip_package_noise("npm", input, 0);
		assert!(!out.contains("Resolving:"));
		assert!(out.contains("added 3 packages, and audited 4 packages in 1s"));
		assert!(out.contains("2 packages are looking for funding"));
		assert!(out.contains("found 0 vulnerabilities"));
	}

	#[test]
	fn supports_common_package_subcommands_for_future_dispatch() {
		for subcommand in [
			"ci", "add", "outdated", "sync", "audit", "why", "tree", "pip", "view", "fund",
			"explain", "test", "t", "start", "stop", "restart", "config", "cache", "prune",
			"dedupe", "publish", "pack", "link",
		] {
			assert!(supports(Some(subcommand)), "{subcommand} should be supported");
		}
	}

	#[test]
	fn bun_install_noise_uses_js_package_rules() {
		let input = "Resolving dependencies\nDownloaded foo\nerror: failed\n";
		let out = strip_package_noise("bun", input, 1);
		assert!(!out.contains("Resolving dependencies"));
		assert!(!out.contains("Downloaded foo"));
		assert!(out.contains("error: failed"));
	}

	fn ctx<'a>(
		program: &'a str,
		subcommand: Option<&'a str>,
		command: &'a str,
		config: &'a MinimizerConfig,
	) -> MinimizerCtx<'a> {
		MinimizerCtx { program, subcommand, command, config }
	}

	#[test]
	fn compacts_large_js_package_tree() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("npm", Some("list"), "npm list --all", &cfg);
		let mut input = String::from("app@1.0.0\n");
		for idx in 0..90 {
			input.push_str(&format!("├── dep{idx:03}@1.0.0\n"));
		}

		let out = filter(&context, &input, 0);
		assert!(out.text.starts_with("package tree/list: 91 entries\n"));
		assert!(out.text.contains("├── dep000@1.0.0"));
		assert!(out.text.contains("├── dep078@1.0.0"));
		assert!(!out.text.contains("├── dep089@1.0.0"));
		assert!(out.text.contains("… 11 package entries omitted …"));
	}

	#[test]
	fn compacts_depth_limited_package_tree_commands() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("npm", Some("ls"), "npm ls --depth=0", &cfg);
		let mut input = String::from("app@1.0.0\n");
		for idx in 0..90 {
			input.push_str(&format!("├── dep{idx:03}@1.0.0\n"));
		}

		let out = filter(&context, &input, 0);
		assert!(out.text.starts_with("package tree/list: 91 entries\n"));
		assert!(out.text.contains("dep000"));
		assert!(out.text.contains("… 11 package entries omitted …"));
	}

	#[test]
	fn compacts_pnpm_why_style_output() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("pnpm", Some("why"), "pnpm why react", &cfg);
		let mut input = String::from("Legend: production dependency, optional only, dev only\nreact 19.0.0\n");
		for idx in 0..90 {
			input.push_str(&format!("└─ dependent{idx:03}\n"));
		}

		let out = filter(&context, &input, 0);
		assert!(out.text.starts_with("package tree/list: 92 entries\n"));
		assert!(out.text.contains("react 19.0.0"));
		assert!(out.text.contains("└─ dependent000"));
		assert!(out.text.contains("… 12 package entries omitted …"));
	}

	#[test]
	fn compacts_npm_json_dependency_tree() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("npm", Some("ls"), "npm ls --json", &cfg);
		let input =
			r#"{"name":"app","version":"1.0.0","dependencies":{"react":{"version":"19.0.0","dependencies":{"scheduler":{"version":"0.25.0"}}},"zod":{"version":"4.0.0"}}}"#;
		let out = filter(&context, input, 0);
		assert!(out.text.starts_with("package tree/list: 4 entries\n"));
		assert!(out.text.contains("app 1.0.0"));
		assert!(out.text.contains("react 19.0.0"));
		assert!(out.text.contains("scheduler 0.25.0"));
	}


	#[test]
	fn compacts_uv_pip_list_and_strips_progress_noise() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("uv", Some("pip"), "uv pip list", &cfg);
		let mut input =
			String::from("Resolved 91 packages in 12ms\nPrepared 2 packages in 3ms\nPackage Version\n");
		for idx in 0..90 {
			input.push_str(&format!("pkg{idx:03} 1.0.{idx}\n"));
		}

		let out = filter(&context, &input, 0);
		assert!(!out.text.contains("Resolved 91 packages"));
		assert!(!out.text.contains("Prepared 2 packages"));
		assert!(out.text.starts_with("package tree/list: 91 entries\n"));
		assert!(out.text.contains("Package Version"));
		assert!(out.text.contains("pkg000 1.0.0"));
		assert!(out.text.contains("pkg078 1.0.78"));
		assert!(!out.text.contains("pkg089 1.0.89"));
		assert!(out.text.contains("… 11 package entries omitted …"));
	}

	#[test]
	fn compacts_uv_tree_output() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("uv", Some("tree"), "uv tree", &cfg);
		let mut input = String::from("project v1.0.0\n");
		for idx in 0..90 {
			input.push_str(&format!("├── pkg{idx:03} v1.0.{idx}\n"));
		}

		let out = filter(&context, &input, 0);
		assert!(out.text.starts_with("package tree/list: 91 entries\n"));
		assert!(out.text.contains("project v1.0.0"));
		assert!(out.text.contains("pkg000"));
		assert!(out.text.contains("… 11 package entries omitted …"));
	}

	#[test]
	fn compacts_poetry_show_tree_output() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("poetry", Some("show"), "poetry show --tree", &cfg);
		let mut input = String::from("requests 2.32.0 Python HTTP for Humans.\n");
		for idx in 0..90 {
			input.push_str(&format!("├── dep{idx:03} 1.0.{idx}\n"));
		}

		let out = filter(&context, &input, 0);
		assert!(out.text.starts_with("package tree/list: 91 entries\n"));
		assert!(out.text.contains("requests 2.32.0"));
		assert!(out.text.contains("… 11 package entries omitted …"));
	}

	#[test]
	fn compacts_uv_pip_freeze_output() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("uv", Some("pip"), "uv pip freeze", &cfg);
		let mut input = String::new();
		for idx in 0..90 {
			input.push_str(&format!("pkg{idx:03}==1.0.{idx}\n"));
		}

		let out = filter(&context, &input, 0);
		assert!(out.text.starts_with("package tree/list: 90 entries\n"));
		assert!(out.text.contains("pkg000==1.0.0"));
		assert!(out.text.contains("… 10 package entries omitted …"));
	}

	#[test]
	fn compacts_uv_export_output() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("uv", Some("export"), "uv export -f requirements-txt", &cfg);
		let mut input = String::from("# generated by uv\n");
		for idx in 0..90 {
			input.push_str(&format!("pkg{idx:03}==1.0.{idx}\n"));
		}

		let out = filter(&context, &input, 0);
		assert!(out.text.starts_with("package tree/list: 91 entries\n"));
		assert!(out.text.contains("pkg000==1.0.0"));
		assert!(out.text.contains("… 11 package entries omitted …"));
	}

	#[test]
	fn compacts_poetry_export_output() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("poetry", Some("export"), "poetry export -f requirements.txt", &cfg);
		let mut input = String::from("# generated by poetry\n");
		for idx in 0..90 {
			input.push_str(&format!("dep{idx:03}==2.0.{idx}\n"));
		}

		let out = filter(&context, &input, 0);
		assert!(out.text.starts_with("package tree/list: 91 entries\n"));
		assert!(out.text.contains("dep000==2.0.0"));
		assert!(out.text.contains("… 11 package entries omitted …"));
	}
}
