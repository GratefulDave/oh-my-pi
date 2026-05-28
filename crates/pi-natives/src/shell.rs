//! Brush-based shell execution exported via N-API.

use std::{collections::HashMap, sync::Arc};

use napi::{
	Env, Result,
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
	tokio::sync::mpsc,
};
use napi_derive::napi;
use pi_shell::{
	MinimizerResult as CoreMinimizerResult, Shell as CoreShell,
	ShellExecuteOptions as CoreShellExecuteOptions, ShellOptions as CoreShellOptions,
	ShellRunOptions as CoreShellRunOptions, ShellRunResult as CoreShellRunResult,
	execute_shell as core_execute_shell,
	fixup::{BashFixupResult as CoreBashFixupResult, apply_bash_fixups as core_apply_bash_fixups},
	minimizer,
};

use crate::task;

/// N-API opt-in handle for the minimizer.
#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct MinimizerOptions {
	/// Master switch. Absent / false = disabled.
	pub enabled:              Option<bool>,
	/// Optional path to a TOML settings file whose values override
	/// field-level defaults. `~` is expanded.
	pub settings_path:        Option<String>,
	/// Optional xxHash64 digest (hex) of the settings file contents. When
	/// supplied, the engine refuses to honor a settings file whose hash does
	/// not match — a lightweight trust gate for agent-controllable paths.
	pub settings_hash:        Option<String>,
	/// Opt-in allowlist of program names (e.g. `"git"`). When empty or
	/// absent, all built-in filters are active.
	pub only:                 Option<Vec<String>>,
	/// Program names explicitly excluded from minimization.
	pub except:               Option<Vec<String>>,
	/// Maximum captured bytes per command before the engine falls back to
	/// the raw, un-minimized output. Default 4 MiB.
	pub max_capture_bytes:    Option<u32>,
	/// Source-outline aggressiveness for `cat <source-file>` minimization.
	/// Accepts `"default"` (current behavior) or `"aggressive"` (strip
	/// function/method bodies for ts/tsx/js/jsx/py/rs/go).
	pub source_outline_level: Option<String>,
	/// Master switch for the AI-summary filter (W4 / rtk smart). Defaults
	/// to off; only effective when the host crate is built with the
	/// `ai-smart` Cargo feature.
	pub ai_smart_enabled:     Option<bool>,
	/// Provider key for the AI summarizer. Defaults to `"deepseek"`.
	pub ai_smart_provider:    Option<String>,
	/// Kill-switch to fall back to pre-PR legacy behavior for the
	/// always-shrink filters (grep, find, pytest). When unset, defers to
	/// the `OMP_MINIMIZER_LEGACY_FILTERS` env var; default `false`.
	pub legacy_filters:       Option<bool>,
}

impl From<MinimizerOptions> for minimizer::MinimizerOptions {
	fn from(value: MinimizerOptions) -> Self {
		Self {
			enabled:              value.enabled,
			settings_path:        value.settings_path,
			settings_hash:        value.settings_hash,
			only:                 value.only,
			except:               value.except,
			max_capture_bytes:    value.max_capture_bytes,
			source_outline_level: value.source_outline_level,
			ai_smart_enabled:     value.ai_smart_enabled,
			ai_smart_provider:    value.ai_smart_provider,
			legacy_filters:       value.legacy_filters,
		}
	}
}

/// Options for configuring a persistent shell session.
#[napi(object)]
pub struct ShellOptions {
	/// Environment variables to apply once per session.
	pub session_env:   Option<HashMap<String, String>>,
	/// Optional snapshot file to source on session creation.
	pub snapshot_path: Option<String>,
	/// Optional per-command output minimizer configuration.
	pub minimizer:     Option<MinimizerOptions>,
}

impl From<ShellOptions> for CoreShellOptions {
	fn from(value: ShellOptions) -> Self {
		Self {
			session_env:   value.session_env,
			snapshot_path: value.snapshot_path,
			minimizer:     value.minimizer.map(Into::into),
		}
	}
}

/// Options for running a shell command.
#[napi(object)]
pub struct ShellRunOptions<'env> {
	/// Command string to execute in the shell.
	pub command:    String,
	/// Working directory for the command.
	pub cwd:        Option<String>,
	/// Environment variables to apply for this command only.
	pub env:        Option<HashMap<String, String>>,
	/// Timeout in milliseconds before cancelling the command.
	pub timeout_ms: Option<u32>,
	/// Abort signal for cancelling the operation.
	pub signal:     Option<Unknown<'env>>,
}

/// Options for executing a shell command via brush-core.
#[napi(object)]
pub struct ShellExecuteOptions<'env> {
	/// Command string to execute in the shell.
	pub command:       String,
	/// Working directory for the command.
	pub cwd:           Option<String>,
	/// Environment variables to apply for this command only.
	pub env:           Option<HashMap<String, String>>,
	/// Environment variables to apply once per session.
	pub session_env:   Option<HashMap<String, String>>,
	/// Timeout in milliseconds before cancelling the command.
	pub timeout_ms:    Option<u32>,
	/// Optional snapshot file to source on session creation.
	pub snapshot_path: Option<String>,
	/// Optional per-command output minimizer configuration.
	pub minimizer:     Option<MinimizerOptions>,
	/// Abort signal for cancelling the operation.
	pub signal:        Option<Unknown<'env>>,
}

#[napi(object)]
pub struct ShellMinimizerApplyOptions {
	pub command:   String,
	pub captured:  String,
	pub exit_code: Option<i32>,
	pub minimizer: Option<MinimizerOptions>,
}

/// Telemetry for a single minimization.
///
/// Surfaced when the minimizer rewrote output or emitted a reason-only
/// miss label. The session layer should persist `original_text` only for
/// actual rewrites; reason-only records keep `text` unchanged and must not
/// trigger artifact persistence.
#[napi(object)]
pub struct MinimizerResult {
	/// Dispatch label produced by the minimizer (e.g. `"git"`,
	/// `"pipeline:gradle"`, `"pipeline+builtin"`).
	pub filter:        String,
	/// The minimized replacement text. Callers that streamed raw chunks
	/// during execution should clear and replace their accumulated output
	/// with this text.
	pub text:          String,
	/// The full original capture, before minimization.
	pub original_text: String,
	/// Captured byte length before minimization.
	pub input_bytes:   u32,
	/// Byte length of the minimized text the consumer received.
	pub output_bytes:  u32,
}

impl From<CoreMinimizerResult> for MinimizerResult {
	fn from(value: CoreMinimizerResult) -> Self {
		Self {
			filter:        value.filter,
			text:          value.text,
			original_text: value.original_text,
			input_bytes:   value.input_bytes,
			output_bytes:  value.output_bytes,
		}
	}
}

/// Result of running a shell command.
#[napi(object)]
pub struct ShellRunResult {
	/// Exit code when the command completes normally.
	pub exit_code: Option<i32>,
	/// Whether the command was cancelled via abort.
	pub cancelled: bool,
	/// Whether the command timed out before completion.
	pub timed_out: bool,
	/// When the minimizer rewrote the captured output, this carries the
	/// original buffer + telemetry so the session layer can persist it as
	/// an artifact and splice an `artifact://<id>` reference into the
	/// minimized text shown to the agent. `None` when nothing was rewritten.
	pub minimized: Option<MinimizerResult>,
}

impl From<CoreShellRunResult> for ShellRunResult {
	fn from(value: CoreShellRunResult) -> Self {
		Self {
			exit_code: value.exit_code,
			cancelled: value.cancelled,
			timed_out: value.timed_out,
			minimized: value.minimized.map(Into::into),
		}
	}
}

/// Persistent brush-core shell session.
#[napi]
pub struct Shell {
	inner: Arc<CoreShell>,
}

#[napi]
impl Shell {
	/// Create a new shell session from optional configuration.
	///
	/// The options set session-scoped environment variables and a snapshot path.
	#[napi(constructor)]
	pub fn new(options: Option<ShellOptions>) -> Self {
		Self { inner: Arc::new(CoreShell::new(options.map(Into::into))) }
	}

	/// Run a shell command using the provided options.
	///
	/// The `on_chunk` callback receives streamed stdout/stderr output. Returns
	/// the exit code when the command completes, or flags when cancelled or
	/// timed out.
	#[napi]
	pub fn run<'env>(
		&self,
		env: &'env Env,
		options: ShellRunOptions<'env>,
		#[napi(ts_arg_type = "((error: Error | null, chunk: string) => void) | undefined | null")]
		on_chunk: Option<ThreadsafeFunction<String>>,
	) -> Result<PromiseRaw<'env, ShellRunResult>> {
		let cancel_token = task::CancelToken::new(options.timeout_ms, options.signal);
		let inner = Arc::clone(&self.inner);
		let run_options = CoreShellRunOptions {
			command:    options.command,
			cwd:        options.cwd,
			env:        options.env,
			timeout_ms: options.timeout_ms,
		};
		task::future(env, "shell.run", async move {
			let (chunk_tx, drain_handle) = bridge_chunks(on_chunk);
			let result = inner
				.run(run_options, chunk_tx, cancel_token.into_core())
				.await
				.map(Into::into)
				.map_err(|err| Error::from_reason(err.to_string()));
			if let Some(handle) = drain_handle {
				let _ = handle.await;
			}
			result
		})
	}

	/// Abort all running commands for this shell session.
	///
	/// Returns `Ok(())` even when no commands are running.
	#[napi]
	pub async fn abort(&self) -> Result<()> {
		self.inner.abort().await;
		Ok(())
	}
}

/// Execute a brush shell command.
///
/// Creates a fresh session for each call. The `on_chunk` callback receives
/// streamed stdout/stderr output. Returns the exit code when the command
/// completes, or flags when cancelled or timed out.
#[napi]
pub fn execute_shell<'env>(
	env: &'env Env,
	options: ShellExecuteOptions<'env>,
	#[napi(ts_arg_type = "((error: Error | null, chunk: string) => void) | undefined | null")]
	on_chunk: Option<ThreadsafeFunction<String>>,
) -> Result<PromiseRaw<'env, ShellRunResult>> {
	let cancel_token = task::CancelToken::new(options.timeout_ms, options.signal);
	let exec_options = CoreShellExecuteOptions {
		command:       options.command,
		cwd:           options.cwd,
		env:           options.env,
		session_env:   options.session_env,
		timeout_ms:    options.timeout_ms,
		snapshot_path: options.snapshot_path,
		minimizer:     options.minimizer.map(Into::into),
	};
	task::future(env, "shell.execute", async move {
		let (chunk_tx, drain_handle) = bridge_chunks(on_chunk);
		let result = core_execute_shell(exec_options, chunk_tx, cancel_token.into_core())
			.await
			.map(Into::into)
			.map_err(|err| Error::from_reason(err.to_string()));
		if let Some(handle) = drain_handle {
			let _ = handle.await;
		}
		result
	})
}

#[napi]
pub fn apply_shell_minimizer(options: ShellMinimizerApplyOptions) -> Option<MinimizerResult> {
	let minimizer = options.minimizer?;
	let minimizer_options: minimizer::MinimizerOptions = minimizer.into();
	let config = minimizer::MinimizerConfig::from_options(&minimizer_options);
	let output = minimizer::apply(
		&options.command,
		&options.captured,
		options.exit_code.unwrap_or(1),
		&config,
	);
	if output.filter != "passthrough" {
		let original_text = output.original_text.unwrap_or_else(|| output.text.clone());
		let output_bytes = u32::try_from(output.text.len()).unwrap_or(u32::MAX);
		return Some(MinimizerResult {
			filter: output.filter.to_string(),
			text: output.text,
			original_text,
			input_bytes: u32::try_from(output.input_bytes).unwrap_or(u32::MAX),
			output_bytes,
		});
	}
	return None;
}

fn bridge_chunks(
	on_chunk: Option<ThreadsafeFunction<String>>,
) -> (Option<mpsc::UnboundedSender<String>>, Option<napi::tokio::task::JoinHandle<()>>) {
	let Some(on_chunk) = on_chunk else {
		return (None, None);
	};
	let (tx, mut rx) = mpsc::unbounded_channel::<String>();
	let handle = napi::tokio::spawn(async move {
		while let Some(chunk) = rx.recv().await {
			on_chunk.call(Ok(chunk), ThreadsafeFunctionCallMode::NonBlocking);
		}
	});
	(Some(tx), Some(handle))
}

/// Result of [`apply_bash_fixups`]: a possibly-rewritten command plus the
/// substrings that were removed (in source order).
#[napi(object)]
pub struct BashFixupResult {
	/// Possibly-rewritten command. Equal to the input when no fixup fired.
	pub command:  String,
	/// Substrings removed, in source order — suitable for a user-facing notice.
	pub stripped: Vec<String>,
}

impl From<CoreBashFixupResult> for BashFixupResult {
	fn from(value: CoreBashFixupResult) -> Self {
		Self { command: value.command, stripped: value.stripped }
	}
}

/// Apply conservative pre-execution rewrites to a bash command.
///
/// Strips trailing `| head|tail [safe-args]` and redundant trailing `2>&1`
/// from each top-level pipeline. The full rules and bail conditions live in
/// `pi_shell::fixup`. Synchronous and cheap (one parse pass over the input).
#[napi]
pub fn apply_bash_fixups(command: String) -> BashFixupResult {
	core_apply_bash_fixups(&command).into()
}

#[cfg(test)]
mod tests {
	use std::time::Duration;

	use pi_shell::{
		ShellRunOptions as CoreShellRunOptions,
		cancel::{AbortReason, CancelToken},
	};
	use tokio::{sync::mpsc, time};

	use super::CoreShell;

	#[test]
	fn apply_shell_minimizer_exposes_reason_without_rewrite() {
		let result = super::apply_shell_minimizer(super::ShellMinimizerApplyOptions {
			command:   "git diff ; printf done".to_string(),
			captured:  "diff --git a/file.rs b/file.rs\n".to_string(),
			exit_code: Some(0),
			minimizer: Some(super::MinimizerOptions { enabled: Some(true), ..Default::default() }),
		})
		.expect("expected reason-only minimizer result");
		assert_eq!(result.filter, "compound");
		assert_eq!(result.text, result.original_text);
	}

	mod child_session_action_tests {
		use pi_shell::{ChildSessionAction, child_session_action};

		#[test]
		fn interactive_with_terminal_stdin_takes_foreground() {
			assert_eq!(child_session_action(true, true, false), ChildSessionAction::TakeForeground);
			assert_eq!(child_session_action(true, true, true), ChildSessionAction::TakeForeground);
		}

		#[test]
		fn non_terminal_stdin_leading_new_pgroup_detaches_unless_pipeline() {
			assert_eq!(child_session_action(true, false, false), ChildSessionAction::DetachSession);
			assert_eq!(child_session_action(true, false, true), ChildSessionAction::None);
		}

		#[test]
		fn non_interactive_with_terminal_stdin_does_nothing() {
			assert_eq!(child_session_action(false, true, false), ChildSessionAction::None);
		}

		#[test]
		fn non_interactive_terminal_stdin_in_pipeline_does_nothing() {
			assert_eq!(child_session_action(false, true, true), ChildSessionAction::None);
		}

		#[test]
		fn embedded_host_with_non_terminal_stdin_detaches() {
			assert_eq!(child_session_action(false, false, false), ChildSessionAction::DetachSession);
		}

		#[test]
		fn pipeline_stage_does_not_detach() {
			assert_eq!(child_session_action(false, false, true), ChildSessionAction::None);
		}
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn embedded_external_command_runs_in_its_own_session() {
		let shell = CoreShell::new(None);
		let (tx, mut rx) = mpsc::unbounded_channel::<String>();
		let handle = tokio::spawn(async move {
			shell
				.run(
					CoreShellRunOptions {
						command:    "/bin/sh -c 'printf \"%d\\n\" \"$$\"; sleep 0.5'".to_string(),
						cwd:        None,
						env:        None,
						timeout_ms: None,
					},
					Some(tx),
					CancelToken::default(),
				)
				.await
		});
		let child_pid = time::timeout(Duration::from_secs(5), rx.recv())
			.await
			.expect("timed out waiting for child pid")
			.expect("missing child pid chunk")
			.trim()
			.parse::<i32>()
			.expect("child pid parses");
		// SAFETY: `getsid(0)` only queries the current process session; the
		// return value is checked below.
		let host_sid = unsafe { libc::getsid(0) };
		assert!(host_sid > 0, "getsid(0) failed: {}", std::io::Error::last_os_error());
		// SAFETY: `child_pid` is a live positive PID reported by the child; the
		// return value is checked below.
		let child_sid = unsafe { libc::getsid(child_pid) };
		assert!(child_sid > 0, "getsid({child_pid}) failed: {}", std::io::Error::last_os_error());
		let result = handle
			.await
			.expect("shell task panicked")
			.expect("shell run");
		assert_eq!(result.exit_code, Some(0));
		assert_ne!(child_sid, host_sid);
		assert_eq!(child_sid, child_pid);
	}

	#[tokio::test]
	async fn read_output_stops_when_cancelled_before_pipe_eof() {
		let shell = CoreShell::new(None);
		let mut cancel = CancelToken::default();
		let abort = cancel.emplace_abort_token();
		let handle = tokio::spawn(async move {
			shell
				.run(
					CoreShellRunOptions {
						command:    "sh -c 'sleep 30 & wait'".to_string(),
						cwd:        None,
						env:        None,
						timeout_ms: None,
					},
					None,
					cancel,
				)
				.await
		});

		time::sleep(Duration::from_millis(10)).await;
		abort.abort(AbortReason::Signal);
		let result = time::timeout(Duration::from_secs(3), handle)
			.await
			.expect("shell run should stop after cancellation")
			.expect("shell task should not panic")
			.expect("shell run should return");
		assert!(result.cancelled);
	}
}
