//! Container and cloud command output filters.

use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

pub fn supports(subcommand: Option<&str>) -> bool {
	matches!(
		subcommand,
		Some(
			"ps"
				| "images"
				| "logs" | "compose"
				| "build"
				| "pull" | "push"
				| "get" | "describe"
				| "status"
				| "list" | "ls"
				| "install"
				| "upgrade"
				| "template"
				| "lint"
		)
	)
}

pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let cleaned = primitives::strip_ansi(input);
	let text = match ctx.program {
		"docker" => filter_docker(ctx, &cleaned, exit_code),
		"kubectl" => filter_kubectl(ctx, &cleaned, exit_code),
		"helm" => filter_helm(ctx, &cleaned, exit_code),
		_ => head_tail_dedup(&cleaned),
	};

	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

fn filter_docker(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> String {
	if is_log_command(ctx) {
		return filter_docker_logs(input);
	}
	if exit_code != 0 {
		return input.to_string();
	}
	if is_table_command(ctx) {
		return compact_table(input, 12);
	}
	compact_build_or_progress(input)
}

fn filter_kubectl(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> String {
	if exit_code != 0 && ctx.subcommand != Some("logs") {
		return input.to_string();
	}
	match ctx.subcommand {
		Some("logs") => filter_logs(input),
		Some("get") => compact_table(input, 20),
		Some("describe") => {
			primitives::head_tail_lines(&primitives::dedup_consecutive_lines(input), 120, 80)
		},
		_ => compact_build_or_progress(input),
	}
}

fn filter_helm(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> String {
	if exit_code != 0 {
		return input.to_string();
	}
	match ctx.subcommand {
		Some("list" | "ls" | "status") => compact_table(input, 20),
		Some("install" | "upgrade" | "template" | "lint") => compact_build_or_progress(input),
		_ => head_tail_dedup(input),
	}
}

fn is_log_command(ctx: &MinimizerCtx<'_>) -> bool {
	ctx.subcommand == Some("logs") || ctx.command.split_whitespace().any(|part| part == "logs")
}

fn is_table_command(ctx: &MinimizerCtx<'_>) -> bool {
	matches!(ctx.subcommand, Some("ps" | "images"))
		|| ctx
			.command
			.split_whitespace()
			.any(|part| matches!(part, "ps" | "images"))
}

fn filter_logs(input: &str) -> String {
	let without_empty_runs = drop_repeated_blank_lines(input);
	let deduped = primitives::dedup_consecutive_lines(&without_empty_runs);
	primitives::head_tail_lines(&deduped, 120, 80)
}

fn filter_docker_logs(input: &str) -> String {
	let without_empty_runs = drop_repeated_blank_lines(input);
	let deduped = dedup_consecutive_log_lines(&without_empty_runs);
	let priority = collect_priority_log_lines(&deduped);
	if priority.is_empty() {
		primitives::head_tail_lines(&deduped, 120, 80)
	} else {
		primitives::head_tail_lines(&priority, 120, 80)
	}
}

fn dedup_consecutive_log_lines(input: &str) -> String {
	let mut out = String::new();
	let mut previous: Option<&str> = None;
	let mut previous_key: Option<&str> = None;
	let mut count = 0usize;

	for line in input.lines() {
		let key = log_dedup_key(line);
		if previous_key == Some(key) {
			count += 1;
			continue;
		}
		flush_repeated_log_line(&mut out, previous, count);
		previous = Some(line);
		previous_key = Some(key);
		count = 1;
	}
	flush_repeated_log_line(&mut out, previous, count);
	out
}

fn flush_repeated_log_line(out: &mut String, line: Option<&str>, count: usize) {
	let Some(line) = line else {
		return;
	};
	out.push_str(line);
	if count > 1 {
		out.push_str(" (×");
		out.push_str(&count.to_string());
		out.push(')');
	}
	out.push('\n');
}

fn log_dedup_key(line: &str) -> &str {
	if let Some((service, message)) = line.split_once('|') {
		let service = service.trim();
		if is_compose_log_service(service) {
			return message.trim_start();
		}
	}
	line
}

fn is_compose_log_service(value: &str) -> bool {
	!value.is_empty()
		&& !matches!(
			value,
			"debug" | "error" | "fatal" | "info" | "trace" | "warn" | "warning"
		)
		&& value.bytes().any(|byte| byte.is_ascii_lowercase())
		&& value.bytes().all(|byte| {
			byte.is_ascii_lowercase()
				|| byte.is_ascii_digit()
				|| matches!(byte, b'-' | b'_' | b'.')
		})
}

fn collect_priority_log_lines(input: &str) -> String {
	let mut out = String::new();
	for line in input.lines() {
		if is_priority_log_line(line) {
			out.push_str(line);
			out.push('\n');
		}
	}
	out
}

fn is_priority_log_line(line: &str) -> bool {
	let line = line.to_ascii_lowercase();
	line.contains("error") || line.contains("fail") || line.contains("warn")
}

fn compact_table(input: &str, visible_rows: usize) -> String {
	let lines: Vec<&str> = input
		.lines()
		.filter(|line| !line.trim().is_empty())
		.collect();
	if lines.len() <= visible_rows + 1 {
		return input.to_string();
	}

	let mut out = String::new();
	if let Some(header) = lines.first() {
		out.push_str(header.trim_end());
		out.push('\n');
	}
	out.push_str(&(lines.len() - 1).to_string());
	out.push_str(" rows\n");
	for line in lines.iter().skip(1).take(visible_rows) {
		out.push_str(line.trim_end());
		out.push('\n');
	}
	out.push_str("… ");
	out.push_str(&(lines.len() - 1 - visible_rows).to_string());
	out.push_str(" more rows\n");
	out
}

fn compact_build_or_progress(input: &str) -> String {
	let mut out = String::new();
	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() || is_progress_line(trimmed) {
			continue;
		}
		out.push_str(line.trim_end());
		out.push('\n');
	}
	head_tail_dedup(&out)
}

fn is_progress_line(line: &str) -> bool {
	line.starts_with("=> ")
		|| line.starts_with('#') && line.contains("DONE")
		|| line.contains("Pulling fs layer")
		|| line.contains("Download complete")
		|| line.contains("Extracting")
		|| line.contains("Waiting")
		|| line.contains("Verifying Checksum")
}

fn drop_repeated_blank_lines(input: &str) -> String {
	let mut out = String::new();
	let mut saw_blank = false;
	for line in input.lines() {
		if line.trim().is_empty() {
			if !saw_blank {
				out.push('\n');
			}
			saw_blank = true;
			continue;
		}
		saw_blank = false;
		out.push_str(line);
		out.push('\n');
	}
	out
}

fn head_tail_dedup(input: &str) -> String {
	primitives::head_tail_lines(&primitives::dedup_consecutive_lines(input), 120, 80)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::minimizer::MinimizerConfig;

	#[test]
	fn dedups_repeated_log_lines_before_truncation() {
		let input = "api | ready\napi | ready\napi | ready\napi | done\n";
		let out = filter_docker_logs(input);
		assert!(out.contains("api | ready (×3)"));
		assert!(out.contains("api | done"));
	}

	#[test]
	fn dedups_compose_service_prefixed_log_messages() {
		let input = "api-1  | ready\napi-2  | ready\napi | ready\nworker | busy\n";
		let out = filter_docker_logs(input);
		assert!(out.contains("api-1  | ready (×3)"));
		assert!(out.contains("worker | busy"));
	}

	#[test]
	fn docker_compose_logs_uses_log_filter() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let compose_ctx = MinimizerCtx {
			program: "docker",
			subcommand: Some("compose"),
			command: "docker compose logs api",
			config: &cfg,
		};
		let input = "api-1  | ready\napi-2  | ready\napi | ready\n";
		let out = filter(&compose_ctx, input, 0).text;
		assert!(out.contains("api-1  | ready (×3)"));
	}

	#[test]
	fn prioritizes_error_lines_for_large_log_windows() {
		let mut input = String::new();
		for i in 0..260 {
			input.push_str("api-1  | request ");
			input.push_str(&i.to_string());
			input.push_str(" complete\n");
		}
		input.push_str("api-1  | WARN cache miss\n");
		input.push_str("worker | failed to process job\n");

		let out = filter_docker_logs(&input);
		assert!(out.contains("api-1  | WARN cache miss"));
		assert!(out.contains("worker | failed to process job"));
		assert!(!out.contains("api-1  | request 0 complete"));
	}

	#[test]
	fn compacts_large_table_with_header_and_omission_count() {
		let mut input = String::from("ID IMAGE STATUS\n");
		for i in 0..25 {
			input.push_str(&i.to_string());
			input.push_str(" img running\n");
		}
		let out = compact_table(&input, 10);
		assert!(out.contains("25 rows"));
		assert!(out.contains("… 15 more rows"));
	}

	fn ctx<'a>(
		program: &'a str,
		subcommand: Option<&'a str>,
		cfg: &'a MinimizerConfig,
	) -> MinimizerCtx<'a> {
		MinimizerCtx { program, subcommand, command: program, config: cfg }
	}

	#[test]
	fn failing_table_commands_preserve_full_diagnostics() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let docker_ctx = ctx("docker", Some("ps"), &cfg);
		let kubectl_ctx = ctx("kubectl", Some("get"), &cfg);
		let helm_ctx = ctx("helm", Some("list"), &cfg);
		let mut input = String::from("NAME STATUS\n");
		for idx in 0..30 {
			input.push_str("resource-with-a-very-long-diagnostic-name-");
			input.push_str(&idx.to_string());
			input.push_str(" failed because the apiserver returned a detailed validation error\n");
		}
		assert_eq!(filter(&docker_ctx, &input, 1).text, input);
		assert_eq!(filter(&kubectl_ctx, &input, 1).text, input);
		assert_eq!(filter(&helm_ctx, &input, 1).text, input);
	}
}
