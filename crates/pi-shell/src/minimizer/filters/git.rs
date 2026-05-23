//! Git output filters.

use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

pub fn supports(subcommand: Option<&str>) -> bool {
	matches!(
		subcommand,
		Some(
			"status"
				| "diff" | "show"
				| "log" | "add"
				| "commit"
				| "push" | "pull"
				| "branch"
				| "fetch"
				| "stash"
				| "worktree"
				| "merge"
				| "rebase"
				| "checkout"
				| "switch"
				| "restore"
				| "clean"
				| "reset"
				| "tag",
		),
	)
}

pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	if is_show_path_content(ctx.command) || is_stash_patch(ctx.command) {
		return MinimizerOutput::passthrough(input);
	}

	let cleaned = primitives::strip_ansi(input);
	let text = match ctx.subcommand {
		Some("status") => condense_status(&cleaned),
		Some("diff") => condense_diff(&cleaned),
		Some("show") => primitives::head_tail_lines(&cleaned, 80, 40),
		Some("log") => condense_log(&cleaned, 32, 16),
		Some("branch" | "stash" | "tag") => primitives::compact_listing(&cleaned, 40),
		Some("worktree") => cleaned,
		Some("push") => condense_push(&cleaned, exit_code),
		Some(
			"pull" | "fetch" | "merge" | "rebase" | "checkout" | "switch" | "restore" | "clean"
			| "reset" | "add" | "commit",
		) => condense_noisy_output(&cleaned),
		_ => cleaned,
	};
	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

fn is_show_path_content(command: &str) -> bool {
	let mut saw_show = false;
	for part in command.split_whitespace() {
		if saw_show && !part.starts_with('-') && part.contains(':') {
			return true;
		}
		if part == "show" {
			saw_show = true;
		}
	}
	false
}

fn is_stash_patch(command: &str) -> bool {
	has_ordered_tokens(command, "stash", "show")
		&& (has_token(command, "-p") || has_token(command, "--patch"))
}

fn has_ordered_tokens(command: &str, first: &str, second: &str) -> bool {
	let mut saw_first = false;
	for part in command.split_whitespace() {
		if saw_first && part == second {
			return true;
		}
		if part == first {
			saw_first = true;
		}
	}
	false
}

fn has_token(command: &str, token: &str) -> bool {
	command.split_whitespace().any(|part| part == token)
}

#[derive(Default)]
struct StatusSummary {
	branch: Option<String>,
	clean: bool,
	staged: usize,
	unstaged: usize,
	untracked: usize,
	conflicts: usize,
	paths: Vec<String>,
}

fn condense_status(input: &str) -> String {
	let mut summary = StatusSummary::default();
	let mut in_untracked = false;

	for line in input.lines() {
		let line = line.trim_end();
		let trimmed = line.trim();
		if trimmed.is_empty() {
			continue;
		}
		if parse_short_status_line(line, &mut summary) {
			continue;
		}
		if let Some(branch) = trimmed.strip_prefix("On branch ") {
			summary.branch = Some(branch.to_string());
			continue;
		}
		if trimmed.starts_with("nothing to commit") || trimmed == "working tree clean" {
			summary.clean = true;
			continue;
		}
		if trimmed.starts_with("Untracked files:") {
			in_untracked = true;
			continue;
		}
		if parse_long_status_line(trimmed, in_untracked, &mut summary) {
			continue;
		}
		if !trimmed.starts_with('(')
			&& !trimmed.ends_with(':')
			&& !trimmed.starts_with("use ")
			&& !trimmed.starts_with("no changes added")
			&& in_untracked
		{
			summary.untracked += 1;
			push_status_path(&mut summary, "??", trimmed);
		}
	}

	if status_has_no_signal(&summary) {
		return input.to_string();
	}
	format_status_summary(&summary)
}

fn parse_short_status_line(line: &str, summary: &mut StatusSummary) -> bool {
	let Some(status) = line.get(..2) else {
		return false;
	};
	let Some(path) = line.get(3..) else {
		return false;
	};
	if !is_short_status(status) {
		return false;
	}
	if status == "??" {
		summary.untracked += 1;
	} else if status.contains('U') {
		summary.conflicts += 1;
	} else {
		let bytes = status.as_bytes();
		if bytes[0] != b' ' {
			summary.staged += 1;
		}
		if bytes[1] != b' ' {
			summary.unstaged += 1;
		}
	}
	push_status_path(summary, status.trim(), path.trim());
	true
}

fn is_short_status(status: &str) -> bool {
	status
		.bytes()
		.all(|byte| matches!(byte, b' ' | b'M' | b'A' | b'D' | b'R' | b'C' | b'U' | b'?' | b'!'))
}

fn parse_long_status_line(line: &str, in_untracked: bool, summary: &mut StatusSummary) -> bool {
	for (prefix, label, staged) in [
		("modified:", "M", false),
		("deleted:", "D", false),
		("new file:", "A", true),
		("renamed:", "R", true),
		("both modified:", "UU", false),
	] {
		if let Some(path) = line.strip_prefix(prefix) {
			if label == "UU" {
				summary.conflicts += 1;
			} else if staged {
				summary.staged += 1;
			} else {
				summary.unstaged += 1;
			}
			push_status_path(summary, label, path.trim());
			return true;
		}
	}
	if in_untracked && !line.starts_with('(') && !line.ends_with(':') {
		summary.untracked += 1;
		push_status_path(summary, "??", line);
		return true;
	}
	false
}

fn push_status_path(summary: &mut StatusSummary, label: &str, path: &str) {
	if path.is_empty() {
		return;
	}
	summary
		.paths
		.push(format!("{label} {}", primitives::truncate_line(path, 160)));
}

const fn status_has_no_signal(summary: &StatusSummary) -> bool {
	summary.branch.is_none()
		&& !summary.clean
		&& summary.staged == 0
		&& summary.unstaged == 0
		&& summary.untracked == 0
		&& summary.conflicts == 0
}

fn format_status_summary(summary: &StatusSummary) -> String {
	let mut out = String::new();
	if let Some(branch) = &summary.branch {
		out.push_str("branch ");
		out.push_str(branch);
		out.push('\n');
	}
	if summary.clean && summary.paths.is_empty() {
		out.push_str("clean\n");
		return out;
	}
	out.push_str("staged ");
	out.push_str(&summary.staged.to_string());
	out.push_str(", unstaged ");
	out.push_str(&summary.unstaged.to_string());
	out.push_str(", untracked ");
	out.push_str(&summary.untracked.to_string());
	if summary.conflicts > 0 {
		out.push_str(", conflicts ");
		out.push_str(&summary.conflicts.to_string());
	}
	out.push('\n');
	for path in summary.paths.iter().take(40) {
		out.push_str(path);
		out.push('\n');
	}
	if summary.paths.len() > 40 {
		out.push_str("… ");
		out.push_str(&(summary.paths.len() - 40).to_string());
		out.push_str(" paths omitted\n");
	}
	out
}

fn condense_log(input: &str, head: usize, tail: usize) -> String {
	let entries = parse_log_entries(input);
	if !entries.is_empty() {
		let mut out = String::new();
		if entries.len() <= head + tail {
			for entry in &entries {
				push_log_entry(&mut out, entry);
			}
		} else {
			for entry in entries.iter().take(head) {
				push_log_entry(&mut out, entry);
			}
			out.push_str("… ");
			out.push_str(&(entries.len() - head - tail).to_string());
			out.push_str(" commits omitted …\n");
			for entry in entries.iter().skip(entries.len() - tail) {
				push_log_entry(&mut out, entry);
			}
		}
		return out;
	}

	let mut out = String::new();
	for line in input.lines() {
		if let Some(commit) = line.strip_prefix("commit ") {
			out.push_str("commit ");
			if let Some(short) = commit.get(..12) {
				out.push_str(short);
			} else {
				out.push_str(commit);
			}
			out.push('\n');
		} else if !(line.trim_start().starts_with("Author:")
			|| line.trim_start().starts_with("Date:"))
		{
			out.push_str(line.trim_end());
			out.push('\n');
		}
	}
	primitives::head_tail_lines(&out, head, tail)
}

struct LogEntry {
	hash: String,
	subject: String,
}

fn push_log_entry(out: &mut String, entry: &LogEntry) {
	out.push_str(&entry.hash);
	if !entry.subject.is_empty() {
		out.push(' ');
		out.push_str(&entry.subject);
	}
	out.push('\n');
}

fn parse_log_entries(input: &str) -> Vec<LogEntry> {
	let mut entries = Vec::new();
	let mut current: Option<LogEntry> = None;

	for line in input.lines() {
		if let Some(rest) = line.strip_prefix("commit ") {
			if let Some(entry) = current.take() {
				entries.push(entry);
			}
			let trimmed = rest.trim();
			let (hash, subject) = trimmed
				.split_once(' ')
				.map_or((trimmed, ""), |(hash, subject)| (hash, subject.trim()));
			current = Some(LogEntry { hash: short_hash(hash), subject: subject.to_string() });
			continue;
		}

		let Some(entry) = current.as_mut() else {
			continue;
		};
		if !entry.subject.is_empty() {
			continue;
		}
		let trimmed = line.trim();
		if trimmed.is_empty()
			|| trimmed.starts_with("Author:")
			|| trimmed.starts_with("Date:")
			|| trimmed.starts_with("Merge:")
			|| trimmed.contains('|')
			|| trimmed.contains("files changed")
			|| trimmed.contains("file changed")
		{
			continue;
		}
		entry.subject = trimmed.to_string();
	}

	if let Some(entry) = current {
		entries.push(entry);
	}
	entries
}

fn short_hash(hash: &str) -> String {
	hash.chars().take(7).collect()
}

struct DiffFile {
	path: String,
	added: usize,
	removed: usize,
	hunks: Vec<DiffHunk>,
}

struct DiffHunk {
	header: String,
	lines: Vec<String>,
}

fn condense_diff(input: &str) -> String {
	let files = parse_unified_diff(input);
	if files.is_empty() {
		return input.to_string();
	}

	let total_added: usize = files.iter().map(|file| file.added).sum();
	let total_removed: usize = files.iter().map(|file| file.removed).sum();
	if total_added == 0 && total_removed == 0 {
		return input.to_string();
	}

	let mut out = String::new();
	for file in files.iter().take(20) {
		let changed = file.added + file.removed;
		out.push_str(&file.path);
		out.push_str(" | ");
		out.push_str(&changed.to_string());
		out.push(' ');
		out.push_str(&diff_bar(file.added, file.removed));
		out.push('\n');
	}
	if files.len() > 20 {
		out.push_str("… ");
		out.push_str(&(files.len() - 20).to_string());
		out.push_str(" files omitted from stat\n");
	}
	out.push_str(&format_file_count(files.len()));
	out.push_str(" changed, ");
	out.push_str(&total_added.to_string());
	out.push_str(" insertions(+), ");
	out.push_str(&total_removed.to_string());
	out.push_str(" deletions(-)\n\n--- Changes ---\n");

	for file in files.iter().take(12) {
		out.push('\n');
		out.push_str("File: ");
		out.push_str(&file.path);
		out.push('\n');
		for hunk in file.hunks.iter().take(8) {
			out.push_str("  ");
			out.push_str(&hunk.header);
			out.push('\n');
			for line in hunk.lines.iter().take(6) {
				out.push_str("  ");
				out.push_str(line);
				out.push('\n');
			}
			if hunk.lines.len() > 6 {
				out.push_str("  … ");
				out.push_str(&(hunk.lines.len() - 6).to_string());
				out.push_str(" changed lines omitted\n");
			}
		}
		if file.hunks.len() > 8 {
			out.push_str("  … ");
			out.push_str(&(file.hunks.len() - 8).to_string());
			out.push_str(" hunks omitted\n");
		}
	}
	if files.len() > 12 {
		out.push_str("\n… ");
		out.push_str(&(files.len() - 12).to_string());
		out.push_str(" files omitted from changes\n");
	}
	out
}

fn parse_unified_diff(input: &str) -> Vec<DiffFile> {
	let mut files = Vec::new();
	let mut current: Option<DiffFile> = None;
	let mut current_hunk: Option<DiffHunk> = None;

	for line in input.lines() {
		if let Some(path) = parse_diff_git_path(line) {
			flush_hunk(&mut current, &mut current_hunk);
			if let Some(file) = current.take() {
				files.push(file);
			}
			current = Some(DiffFile { path, added: 0, removed: 0, hunks: Vec::new() });
			continue;
		}
		if let Some(path) = line.strip_prefix("+++ b/") {
			if let Some(file) = current.as_mut() {
				file.path = path.to_string();
			}
			continue;
		}
		if line.starts_with("@@") {
			flush_hunk(&mut current, &mut current_hunk);
			current_hunk = Some(DiffHunk { header: line.to_string(), lines: Vec::new() });
			continue;
		}
		if line.starts_with("+++") || line.starts_with("---") {
			continue;
		}
		let Some(file) = current.as_mut() else {
			continue;
		};
		if line.starts_with('+') {
			file.added += 1;
			push_diff_line(&mut current_hunk, line);
		} else if line.starts_with('-') {
			file.removed += 1;
			push_diff_line(&mut current_hunk, line);
		}
	}

	flush_hunk(&mut current, &mut current_hunk);
	if let Some(file) = current {
		files.push(file);
	}
	files
		.into_iter()
		.filter(|file| file.added > 0 || file.removed > 0)
		.collect()
}

fn parse_diff_git_path(line: &str) -> Option<String> {
	let rest = line.strip_prefix("diff --git ")?;
	let mut parts = rest.split_whitespace();
	let _old = parts.next()?;
	let new = parts.next()?;
	Some(new.strip_prefix("b/").map_or(new, |path| path).to_string())
}

fn flush_hunk(file: &mut Option<DiffFile>, hunk: &mut Option<DiffHunk>) {
	let Some(hunk) = hunk.take() else {
		return;
	};
	if let Some(file) = file.as_mut() {
		file.hunks.push(hunk);
	}
}

fn push_diff_line(hunk: &mut Option<DiffHunk>, line: &str) {
	let Some(hunk) = hunk.as_mut() else {
		return;
	};
	hunk.lines.push(primitives::truncate_line(line, 160));
}

fn diff_bar(added: usize, removed: usize) -> String {
	let total = added + removed;
	if total == 0 {
		return String::new();
	}
	let width = total.clamp(1, 24);
	let plus = (added * width).div_ceil(total);
	let minus = width.saturating_sub(plus);
	format!("{}{}", "+".repeat(plus), "-".repeat(minus))
}

fn format_file_count(files: usize) -> String {
	if files == 1 {
		"1 file".to_string()
	} else {
		format!("{files} files")
	}
}

fn condense_noisy_output(input: &str) -> String {
	let deduped = primitives::dedup_consecutive_lines(input);
	primitives::head_tail_lines(&deduped, 80, 40)
}

fn is_push_progress(line: &str) -> bool {
	let t = line.trim_start();
	t.starts_with("Enumerating objects:")
		|| t.starts_with("Counting objects:")
		|| t.starts_with("Delta compression")
		|| t.starts_with("Compressing objects:")
		|| t.starts_with("Writing objects:")
		|| t.starts_with("Total ")
}

fn is_remote_progress(line: &str) -> bool {
	let Some(rest) = line
		.trim()
		.strip_prefix("remote:")
		.or_else(|| line.trim().strip_prefix("remote: "))
	else {
		return false;
	};
	let rest = rest.trim();
	rest.starts_with("Resolving deltas:")
		|| rest.starts_with("Enumerating objects:")
		|| rest.starts_with("Counting objects:")
		|| rest.starts_with("Compressing objects:")
		|| rest.starts_with("Writing objects:")
		|| rest.starts_with("Total ")
}

fn extract_pushed_ref(line: &str) -> Option<&str> {
	let (_before, after_arrow) = line.split_once(" -> ")?;
	after_arrow.split_whitespace().next()
}

fn condense_push(input: &str, exit_code: i32) -> String {
	let cleaned = primitives::strip_ansi(input);
	let stripped = primitives::strip_lines(&cleaned, &[is_push_progress]);

	if exit_code == 0 {
		let mut out = String::new();
		let mut pushed_ref = None;

		for line in stripped.lines() {
			let trimmed = line.trim();
			if trimmed.is_empty() {
				continue;
			}
			if is_remote_progress(trimmed) {
				continue;
			}
			// Keep remote warnings / notes (non-progress remote lines)
			if trimmed.starts_with("remote:") {
				out.push_str(line);
				out.push('\n');
				continue;
			}
			// Keep destination lines
			if trimmed.starts_with("To ") {
				out.push_str(line);
				out.push('\n');
				continue;
			}
			// Keep ref update lines: "* [new ...]", branch setup, or "hash..hash ref -> ref"
			if trimmed.starts_with("* [new")
				|| trimmed.starts_with("Branch ")
				|| trimmed.contains(" -> ")
			{
				if pushed_ref.is_none() {
					pushed_ref = extract_pushed_ref(trimmed);
				}
				out.push_str(line);
				out.push('\n');
				continue;
			}
		}

		if out.is_empty() {
			out.push_str("ok (up-to-date)\n");
		} else if let Some(dest) = pushed_ref {
			out.push_str("ok ");
			out.push_str(dest);
			out.push('\n');
		} else {
			out.push_str("ok\n");
		}
		out
	} else {
		// Failure: keep diagnostics, strip only progress noise
		let mut out = String::new();
		for line in stripped.lines() {
			let trimmed = line.trim();
			if trimmed.is_empty() {
				continue;
			}
			if is_remote_progress(trimmed) {
				continue;
			}
			out.push_str(line);
			out.push('\n');
		}
		out
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::minimizer::MinimizerConfig;

	fn test_ctx<'a>(
		subcommand: Option<&'a str>,
		command: &'a str,
		config: &'a MinimizerConfig,
	) -> MinimizerCtx<'a> {
		MinimizerCtx { program: "git", subcommand, command, config }
	}

	#[test]
	fn status_is_supported() {
		assert!(supports(Some("status")));
	}

	#[test]
	fn short_status_is_compacted() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("status"), "git status --short", &cfg);
		let input = " M src/main.rs\nM  Cargo.toml\n?? scratch.txt\nUU conflicted.rs\n";
		let out = filter(&ctx, input, 0);

		assert!(out.changed);
		assert!(
			out.text
				.contains("staged 1, unstaged 1, untracked 1, conflicts 1")
		);
		assert!(out.text.contains("M src/main.rs"));
		assert!(out.text.contains("M Cargo.toml"));
		assert!(out.text.contains("?? scratch.txt"));
		assert!(out.text.contains("UU conflicted.rs"));
	}

	#[test]
	fn long_status_clean_is_compacted() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("status"), "git status", &cfg);
		let input = "On branch main\nYour branch is up to date with 'origin/main'.\n\nnothing to \
		             commit, working tree clean\n";
		let out = filter(&ctx, input, 0);

		assert!(out.changed);
		assert_eq!(out.text, "branch main\nclean\n");
	}

	#[test]
	fn supports_git_coverage_subcommands() {
		for subcommand in ["show", "branch", "fetch", "stash", "worktree"] {
			assert!(supports(Some(subcommand)), "{subcommand} should be buffered");
		}
	}

	#[test]
	fn branch_listing_is_compacted() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("branch"), "git branch -a", &cfg);
		let mut input = String::new();
		for idx in 0..60 {
			input.push_str("  feature/");
			input.push_str(&idx.to_string());
			input.push('\n');
		}
		let out = filter(&ctx, &input, 0);
		assert!(out.text.starts_with("60 entries\n"));
		assert!(out.text.contains("feature/0"));
		assert!(out.text.contains("feature/59"));
		assert!(out.text.contains("…"));
	}

	#[test]
	fn fetch_output_strips_ansi_and_dedups_progress() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("fetch"), "git fetch", &cfg);
		let out = filter(
			&ctx,
			"\x1b[32mremote: Counting objects: 1\x1b[0m\nremote: Counting objects: 1\nerror: failed\n",
			1,
		);
		assert_eq!(out.text, "remote: Counting objects: 1 (×2)\nerror: failed\n");
	}

	#[test]
	fn show_path_content_is_passthrough() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("show"), "git show HEAD:path/to/file.json", &cfg);
		let input = "{\n  \"items\": [1, 2, 3]\n}\n";

		let out = filter(&ctx, input, 0);

		assert!(!out.changed);
		assert_eq!(out.text, input);
	}

	#[test]
	fn stash_show_patch_preserves_diff() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("stash"), "git stash show -p", &cfg);
		let input = "diff --git a/a.rs b/a.rs\n--- a/a.rs\n+++ b/a.rs\n@@ -1 +1 @@\n-old\n+new\n";

		let out = filter(&ctx, input, 0);

		assert!(!out.changed);
		assert_eq!(out.text, input);
	}

	#[test]
	fn log_is_compacted_to_short_hashes_and_subjects() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("log"), "git log", &cfg);
		let mut input = String::new();
		for idx in 0..70 {
			input.push_str("commit abcdef1234567890");
			input.push_str(&idx.to_string());
			input.push('\n');
			input.push_str("Author: Somebody <s@example.com>\nDate: today\n");
			input.push_str("    message ");
			input.push_str(&idx.to_string());
			input.push('\n');
		}
		let out = filter(&ctx, &input, 0);
		assert!(out.text.contains("… 22 commits omitted …"));
		assert!(out.text.contains("abcdef1 message 0"));
		assert!(!out.text.contains("message 47"));
		assert!(out.text.contains("abcdef1 message 69"));
		assert!(!out.text.contains("Author:"));
		assert!(!out.text.contains("Date:"));
	}

	#[test]
	fn log_supports_subject_on_commit_line() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("log"), "git log --stat -10", &cfg);
		let input = "commit c84fa3c fix: add website URL (rtk-ai.app)\nAuthor: Somebody\nDate: \
		             today\n\n README.md | 8 ++++++++\n 1 file changed, 8 insertions(+)\n";
		let out = filter(&ctx, input, 0);
		assert_eq!(out.text, "c84fa3c fix: add website URL (rtk-ai.app)\n");
	}

	#[test]
	fn diff_condenses_unified_patch_to_stat_and_hunk_samples() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("diff"), "git diff HEAD~1", &cfg);
		let input = "diff --git a/index.html b/index.html\nindex 1b7488b..0ebac4f 100644\n--- \
		             a/index.html\n+++ b/index.html\n@@ -629,7 +629,7 @@\n       width: 100%;\n-      \
		             min-width: 800px;\n+      min-width: 1050px;\n@@ -1051,6 +1051,4 @@\n+    /* \
		             === Share My Gain === */\n+    .share-gain { background: var(--bg); \
		             }\n-old\n+new\n";
		let out = filter(&ctx, input, 0);
		assert!(out.changed);
		assert!(out.text.contains("index.html | 6 "), "{}", out.text);
		assert!(
			out.text
				.contains("1 file changed, 4 insertions(+), 2 deletions(-)")
		);
		assert!(out.text.contains("--- Changes ---"));
		assert!(out.text.contains("@@ -629,7 +629,7 @@"));
		assert!(out.text.contains("-      min-width: 800px;"));
		assert!(out.text.contains("+      min-width: 1050px;"));
	}

	#[test]
	fn legacy_log_fallback_removes_metadata_when_no_commit_records_parse() {
		let input = "commitish output\nAuthor: Somebody <s@example.com>\nDate: today\nmessage 0\n";
		let out = condense_log(input, 32, 16);
		assert!(out.contains("message 0"));
		assert!(!out.contains("Author:"));
		assert!(!out.contains("Date:"));
	}

	#[test]
	fn push_noisy_success_is_compacted() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("push"), "git push", &cfg);
		let input = "\
Enumerating objects: 5, done.
Counting objects: 100% (5/5), done.
Delta compression using up to 8 threads
Compressing objects: 100% (3/3), done.
Writing objects: 100% (3/3), 1.23 KiB | 1.23 MiB/s, done.
Total 3 (delta 2), reused 0 (delta 0), pack-reused 0
remote: Resolving deltas: 100% (2/2), completed with 2 local objects.
To github.com:user/repo.git
   abc1234..def5678  main -> main
";
		let out = filter(&ctx, input, 0);

		assert!(out.changed);
		assert!(out.text.contains("To github.com:user/repo.git"));
		assert!(out.text.contains("main -> main"));
		assert!(out.text.contains("ok main\n"));
		assert!(!out.text.contains("Enumerating objects"));
		assert!(!out.text.contains("Counting objects"));
		assert!(!out.text.contains("Delta compression"));
		assert!(!out.text.contains("Compressing objects"));
		assert!(!out.text.contains("Writing objects"));
		assert!(!out.text.contains("Total "));
		assert!(!out.text.contains("remote: Resolving deltas"));
	}

	#[test]
	fn push_up_to_date_is_compacted() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("push"), "git push", &cfg);
		let input = "Everything up-to-date\n";
		let out = filter(&ctx, input, 0);

		assert!(out.changed);
		assert_eq!(out.text, "ok (up-to-date)\n");
	}

	#[test]
	fn push_remote_warning_is_kept() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("push"), "git push", &cfg);
		let input = "\
Enumerating objects: 3, done.
Counting objects: 100% (3/3), done.
Writing objects: 100% (3/3), done.
Total 3 (delta 0), reused 0 (delta 0), pack-reused 0
remote: warning: Large object detected, consider using Git LFS
To github.com:user/repo.git
   def5678..abc1234  main -> main
";
		let out = filter(&ctx, input, 0);

		assert!(out.changed);
		assert!(out.text.contains("remote: warning: Large object detected"));
		assert!(out.text.contains("ok main\n"));
		assert!(!out.text.contains("Enumerating objects"));
	}

	#[test]
	fn push_rejected_failure_keeps_diagnostics() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("push"), "git push", &cfg);
		let input = "\
To github.com:user/repo.git
 ! [rejected]        main -> main (non-fast-forward)
error: failed to push some refs to 'github.com:user/repo.git'
hint: Updates were rejected because the tip of your current branch is behind
hint: its remote counterpart. Integrate the remote changes (e.g.
hint: 'git pull ...') before pushing again.
hint: See the 'Note about fast-forwards' in 'git push --help' for details.
";
		let out = filter(&ctx, input, 1);

		assert!(!out.text.contains("ok\n"));
		assert!(!out.text.contains("ok (up-to-date)"));
		assert!(out.text.contains("rejected"));
		assert!(out.text.contains("error: failed to push"));
		assert!(out.text.contains("hint:"));
	}
}
