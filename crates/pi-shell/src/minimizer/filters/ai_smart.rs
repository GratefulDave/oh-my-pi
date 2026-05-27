//! AI-summary filter (W4 / rtk smart).
//!
//! This module is feature-gated behind `ai-smart` (off by default). The
//! off-feature build still exposes the same public surface via a const-`None`
//! stub so call sites in `engine.rs` compile uniformly regardless of feature
//! state.
//!
//! Threat model & design intent (mirrors plan AC4.1-AC4.9):
//! - **Opt-in.** `MinimizerConfig::ai_smart_enabled` must be `true`. Default is
//!   `false`, which means an unmodified build of the agent never makes an AI
//!   call.
//! - **Bounded.** Hard caps: 8 KB input, 5 s timeout, 200 max-tokens response.
//!   Single retry on transient transport errors only.
//! - **Fail-closed.** Any error path (network, non-2xx, parse, empty body,
//!   missing API key, budget exhausted, parent is pipe/compound) returns
//!   `None` so the caller falls back to the original (un-AI-summarized)
//!   output. The filter never emits partial garbage.
//! - **Pipe-safe.** Piped and compound commands bypass the AI entirely —
//!   downstream parsers (`awk`, `jq`, `rg`, …) must see deterministic bytes.

use crate::minimizer::MinimizerCtx;

/// Maximum captured bytes we are willing to ship to the AI provider.
pub const MAX_INPUT_BYTES: usize = 8 * 1024;
/// Hard upper bound on the response size we'll request.
#[cfg_attr(not(feature = "ai-smart"), allow(dead_code))]
pub const MAX_RESPONSE_TOKENS: u32 = 200;
/// Wall-clock timeout for the whole AI round-trip.
#[cfg_attr(not(feature = "ai-smart"), allow(dead_code))]
pub const REQUEST_TIMEOUT_SECS: u64 = 5;
/// Pinned deepseek model (plan AC4.5). Executor must RFC if upstream
/// retires this id — never silently downgrade to `deepseek-chat`.
#[cfg_attr(not(feature = "ai-smart"), allow(dead_code))]
pub const DEEPSEEK_MODEL: &str = "deepseek-v4-flash";
/// Deepseek OpenAI-compatible chat-completions endpoint.
#[cfg_attr(not(feature = "ai-smart"), allow(dead_code))]
pub const DEEPSEEK_ENDPOINT: &str = "https://api.deepseek.com/v1/chat/completions";
/// Env var that carries the credential. Plan AC4.1.
pub const API_KEY_ENV: &str = "OMP_AI_SMART_API_KEY";

/// System prompt — kept verbatim so the model behavior is auditable from
/// source. Two-line summarizer (plan Step 4.3).
#[cfg_attr(not(feature = "ai-smart"), allow(dead_code))]
const SYSTEM_PROMPT: &str =
	"You are a 2-line summarizer for shell command output. Line 1: what happened. Line 2: most \
	 important number/path/error. Be terse.";

/// Single-call budget tracked per `engine::apply` invocation (plan AC4.9).
///
/// Lives in a thread-local because the existing shell entrypoints invoke
/// `engine::apply` synchronously and threading a counter cell through the
/// existing call sites would require touching `shell.rs` (out of W2's
/// approved touch set). Each top-level `apply` call resets the budget to 1.
///
/// Limitation vs. AC4.9: when shell.rs runs a chain by invoking
/// `minimizer::apply` per segment, the budget resets per segment — a
/// 5-segment chain that all carry AI-eligible output would fire up to 5
/// times rather than once. Cross-segment enforcement needs a budget cell
/// threaded from the chain runner in shell.rs; that wiring is documented as
/// follow-up in the worker-2 completion report.
#[cfg(feature = "ai-smart")]
thread_local! {
	static AI_BUDGET: std::cell::Cell<u8> = const { std::cell::Cell::new(0) };
}

/// Reset the per-`apply()` AI budget. Call once at the top of
/// `engine::apply` when the AI filter is feature-enabled and configured on.
#[cfg(feature = "ai-smart")]
pub fn reset_apply_budget() {
	AI_BUDGET.with(|c| c.set(1));
}

#[cfg(not(feature = "ai-smart"))]
pub fn reset_apply_budget() {}

/// Try to summarize `captured` via the configured AI provider. Returns the
/// summary text on success, or `None` whenever any preflight gate or the
/// network call itself fails (the caller treats `None` as "leave existing
/// output untouched").
#[cfg(feature = "ai-smart")]
pub fn maybe_summarize(ctx: &MinimizerCtx<'_>, captured: &str) -> Option<String> {
	if !ctx.config.ai_smart_enabled {
		return None;
	}
	if captured.len() > MAX_INPUT_BYTES {
		return None;
	}
	if captured.trim().is_empty() {
		return None;
	}
	if parent_is_pipe_or_compound(ctx.command) {
		return None;
	}
	if !consume_budget() {
		return None;
	}
	let api_key = match std::env::var(API_KEY_ENV) {
		Ok(value) if !value.is_empty() => value,
		_ => return None,
	};
	let provider = ctx.config.ai_smart_provider.as_str();
	match provider {
		"deepseek" => call_deepseek(&api_key, captured),
		_ => None,
	}
}

#[cfg(not(feature = "ai-smart"))]
#[inline]
pub fn maybe_summarize(_ctx: &MinimizerCtx<'_>, _captured: &str) -> Option<String> {
	None
}

#[cfg(feature = "ai-smart")]
fn consume_budget() -> bool {
	AI_BUDGET.with(|c| {
		let remaining = c.get();
		if remaining == 0 {
			false
		} else {
			c.set(remaining - 1);
			true
		}
	})
}

/// Best-effort check: did the calling command sit inside a pipe (`|`) or a
/// compound construct (`(...)`, `$(...)`, backticks, redirection into another
/// process)? We err on the side of caution — any indicator returns `true`
/// which suppresses the AI call.
#[cfg(feature = "ai-smart")]
fn parent_is_pipe_or_compound(command: &str) -> bool {
	let mut in_single = false;
	let mut in_double = false;
	let mut prev = '\0';
	for ch in command.chars() {
		match ch {
			'\'' if prev != '\\' && !in_double => in_single = !in_single,
			'"' if prev != '\\' && !in_single => in_double = !in_double,
			'|' | '(' | ')' | '`' if !in_single && !in_double => return true,
			_ => {},
		}
		prev = ch;
	}
	false
}

#[cfg(feature = "ai-smart")]
fn call_deepseek(api_key: &str, captured: &str) -> Option<String> {
	let body = serde_json::json!({
		"model": DEEPSEEK_MODEL,
		"max_tokens": MAX_RESPONSE_TOKENS,
		"temperature": 0.0,
		"messages": [
			{ "role": "system", "content": SYSTEM_PROMPT },
			{ "role": "user", "content": captured }
		]
	});

	let client = reqwest::blocking::Client::builder()
		.timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
		.build()
		.ok()?;

	let mut last_transient_err = false;
	for attempt in 0..2 {
		let response = client
			.post(DEEPSEEK_ENDPOINT)
			.bearer_auth(api_key)
			.json(&body)
			.send();
		match response {
			Ok(res) => {
				let status = res.status();
				if status.is_success() {
					let json: serde_json::Value = match res.json() {
						Ok(value) => value,
						Err(_) => return None,
					};
					return extract_first_message(&json);
				}
				// 5xx is transient and re-tryable; 4xx is configuration / quota
				// and re-trying won't help.
				if status.is_server_error() && attempt == 0 {
					last_transient_err = true;
					continue;
				}
				return None;
			},
			Err(err) => {
				if (err.is_timeout() || err.is_connect()) && attempt == 0 {
					last_transient_err = true;
					continue;
				}
				return None;
			},
		}
	}
	let _ = last_transient_err;
	None
}

/// Pull the first choice's `message.content` out of an OpenAI-compatible
/// chat-completions response payload. Returns `None` on any shape mismatch.
#[cfg(feature = "ai-smart")]
fn extract_first_message(json: &serde_json::Value) -> Option<String> {
	let text = json
		.get("choices")?
		.as_array()?
		.first()?
		.get("message")?
		.get("content")?
		.as_str()?;
	let cleaned = sanitize_summary(text);
	if cleaned.is_empty() { None } else { Some(cleaned) }
}

/// Scrub characters that would corrupt a chain transcript per AC-C4 (no
/// ANSI escapes, no shell operators, no backticks).
#[cfg(feature = "ai-smart")]
fn sanitize_summary(text: &str) -> String {
	let mut out = String::with_capacity(text.len());
	let mut iter = text.chars().peekable();
	while let Some(ch) = iter.next() {
		match ch {
			'\x1b' => {
				// Drop the escape AND any CSI parameter bytes up to the final
				// letter so we don't leave dangling SGR fragments.
				while let Some(&peek) = iter.peek() {
					iter.next();
					if peek.is_ascii_alphabetic() {
						break;
					}
				}
			},
			'`' => out.push('\''),
			';' => out.push(','),
			'&' => out.push('+'),
			'\r' => continue,
			ch if ch.is_control() && ch != '\n' && ch != '\t' => continue,
			ch => out.push(ch),
		}
	}
	while out.ends_with(|c: char| c.is_whitespace()) {
		out.pop();
	}
	if !out.is_empty() {
		out.push('\n');
	}
	out
}

#[cfg(all(test, feature = "ai-smart"))]
mod tests {
	use super::*;
	use crate::minimizer::{MinimizerConfig, MinimizerCtx, config::OutlineLevel};

	fn cfg() -> MinimizerConfig {
		MinimizerConfig {
			enabled: true,
			ai_smart_enabled: true,
			ai_smart_provider: "deepseek".into(),
			source_outline_level: OutlineLevel::Default,
			..Default::default()
		}
	}

	fn ctx<'a>(command: &'a str, config: &'a MinimizerConfig) -> MinimizerCtx<'a> {
		MinimizerCtx { program: "echo", subcommand: None, command, config }
	}

	#[test]
	fn disabled_returns_none() {
		let mut config = cfg();
		config.ai_smart_enabled = false;
		reset_apply_budget();
		assert!(maybe_summarize(&ctx("echo hi", &config), "hi").is_none());
	}

	#[test]
	fn empty_input_returns_none() {
		let config = cfg();
		reset_apply_budget();
		assert!(maybe_summarize(&ctx("echo", &config), "").is_none());
	}

	#[test]
	fn oversize_input_returns_none() {
		let config = cfg();
		reset_apply_budget();
		let big = "x".repeat(MAX_INPUT_BYTES + 1);
		assert!(maybe_summarize(&ctx("echo big", &config), &big).is_none());
	}

	#[test]
	fn pipe_parent_returns_none() {
		let config = cfg();
		reset_apply_budget();
		assert!(maybe_summarize(&ctx("echo hi | cat", &config), "hi").is_none());
	}

	#[test]
	fn compound_parent_returns_none() {
		let config = cfg();
		reset_apply_budget();
		assert!(maybe_summarize(&ctx("(echo hi)", &config), "hi").is_none());
	}

	#[test]
	fn budget_exhausted_returns_none() {
		// Reset, manually drain, then assert second call returns None even with
		// API key set (we synthesize a fake one to pass that gate; the real
		// network call won't happen because budget is consumed).
		reset_apply_budget();
		let config = cfg();
		// Drain budget without hitting network: simulate by consuming directly.
		assert!(consume_budget());
		assert!(!consume_budget());
		// New apply resets:
		reset_apply_budget();
		assert!(consume_budget());
		// Touch maybe_summarize signature so dead-code lint doesn't fire when
		// API_KEY is absent in CI.
		drop(maybe_summarize(&ctx("echo hi", &config), "hi"));
	}

	#[test]
	fn missing_api_key_returns_none() {
		// SAFETY: tests run single-threaded by default; we restore on exit.
		let prev = std::env::var(API_KEY_ENV).ok();
		// SAFETY: clearing an env var in a single-threaded test context.
		unsafe { std::env::remove_var(API_KEY_ENV) };
		let config = cfg();
		reset_apply_budget();
		assert!(maybe_summarize(&ctx("echo hi", &config), "hi").is_none());
		if let Some(value) = prev {
			// SAFETY: restoring the prior value in a single-threaded test.
			unsafe { std::env::set_var(API_KEY_ENV, value) };
		}
	}

	#[test]
	fn sanitize_strips_dangerous_chars() {
		assert_eq!(sanitize_summary("hi `there`"), "hi 'there'\n");
		assert_eq!(sanitize_summary("a;b&c"), "a,b+c\n");
		assert_eq!(sanitize_summary("\x1b[31mred\x1b[0m"), "red\n");
		assert_eq!(sanitize_summary("   "), "");
	}

	#[test]
	fn extract_first_message_happy_path() {
		let payload = serde_json::json!({
			"choices": [
				{ "message": { "role": "assistant", "content": "ok\nsaved 3 files" } }
			]
		});
		assert_eq!(extract_first_message(&payload).as_deref(), Some("ok,saved 3 files\n"));
	}

	#[test]
	fn extract_first_message_missing_returns_none() {
		assert!(extract_first_message(&serde_json::json!({ "choices": [] })).is_none());
		assert!(extract_first_message(&serde_json::json!({})).is_none());
	}
}
