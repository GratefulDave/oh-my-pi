//! Brush-based shell execution exported via N-API.

use std::{collections::HashMap, sync::Arc};

use napi::{
	Env, Result,
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, UnknownReturnValue},
};
use napi_derive::napi;
use pi_shell::{
	MinimizerResult as CoreMinimizerResult, Shell as CoreShell,
	ShellExecuteOptions as CoreShellExecuteOptions, ShellOptions as CoreShellOptions,
	ShellRunOptions as CoreShellRunOptions, ShellRunResult as CoreShellRunResult,
	execute_shell as core_execute_shell, minimizer,
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
	/// Source-outline level for `cat <source-file>` minimization. Accepts
	/// `"default"` (current behavior) or `"aggressive"` (strip function bodies).
	pub source_outline_level: Option<String>,
	/// Kill-switch to fall back to the pre-PR (legacy) filter behavior for
	/// grep / find / pytest. When `Some(true)`, filters that opted into the
	/// always-shrink Tier 1 / Tier 2 behavior skip the new code path. When
	/// `None`, defers to the `OMP_MINIMIZER_LEGACY_FILTERS` env var.
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

/// Telemetry for a single minimization.
///
/// Surfaced when the minimizer actually rewrote the command's output. The
/// session layer is expected to persist `original_text` via its
/// `ArtifactManager`, splice the resulting `artifact://<id>` reference
/// into `text`, and replace any previously streamed raw output with the
/// minimized text.
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
	pub minimized:          Option<MinimizerResult>,
	/// Whether the native minimizer captured the command without exceeding its
	/// cap.
	pub minimizer_eligible: Option<bool>,
	/// Shell working directory after command completion.
	pub working_dir:        Option<String>,
}

impl From<CoreShellRunResult> for ShellRunResult {
	fn from(value: CoreShellRunResult) -> Self {
		Self {
			exit_code:          value.exit_code,
			cancelled:          value.cancelled,
			timed_out:          value.timed_out,
			minimized:          value.minimized.map(Into::into),
			minimizer_eligible: Some(value.minimizer_eligible),
			working_dir:        value.working_dir,
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
		on_chunk: Option<ThreadsafeFunction<String, UnknownReturnValue>>,
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

	/// Count live background jobs (`&`/`nohup` children still running) on this
	/// session. Completed jobs are reaped first. The host uses this to retain a
	/// per-call shell whose background processes are still running instead of
	/// dropping it (which would SIGKILL them via kill-on-drop).
	#[napi]
	pub async fn live_background_job_count(&self) -> u32 {
		self.inner.live_background_job_count().await
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
	on_chunk: Option<ThreadsafeFunction<String, UnknownReturnValue>>,
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

/// Capacity (in chunks) of the queue between the pipe readers and the JS
/// forwarding pump. One queued chunk is at most one pipe read (≤64 KiB), so
/// the Rust side of the bridge holds ~4 MiB worst case before the readers'
/// `send_async` parks — which in turn parks the child on its stdout/stderr
/// pipe (ordinary pipe backpressure) instead of buffering the surplus in
/// process memory (#4078).
const BRIDGE_QUEUE_CHUNKS: usize = 64;

fn bridge_chunks(
	on_chunk: Option<ThreadsafeFunction<String, UnknownReturnValue>>,
) -> (Option<flume::Sender<String>>, Option<napi::tokio::task::JoinHandle<()>>) {
	let Some(on_chunk) = on_chunk else {
		return (None, None);
	};
	let (tx, rx) = flume::bounded::<String>(BRIDGE_QUEUE_CHUNKS);
	let handle = napi::tokio::spawn(pump_chunks(rx, async move |payload: String| {
		// `call_async` resolves only after the JS callback ran, so at most
		// one batch sits in the napi queue at a time and the JS event loop's
		// actual consumption rate backpressures the whole pipeline. An error
		// means the JS side is gone (env teardown) — stop forwarding.
		on_chunk.call_async(Ok(payload)).await.is_ok()
	}));
	(Some(tx), Some(handle))
}

/// Drain `rx`, greedily coalescing queued chunks into ≤64 KiB batches, and
/// feed each batch to `forward`, awaiting its completion before pulling more.
/// Returns when `rx` disconnects (all senders dropped) or `forward` reports
/// the consumer is gone; dropping `rx` then disconnects the channel so
/// parked/future senders fail fast and the pipe readers keep draining the
/// child instead of wedging it.
async fn pump_chunks(rx: flume::Receiver<String>, mut forward: impl AsyncFnMut(String) -> bool) {
	// Hard cap on one coalesced batch so the JS main thread never sees a
	// multi-MB napi callback (a giant single string would stall sanitize +
	// tail-buffer maintenance for the whole copy).
	const MAX_BATCH_BYTES: usize = 64 * 1024;
	// Initial capacity sized for typical bursty pipe output. Re-allocated
	// each batch because `String` ownership is moved into the napi call.
	const INITIAL_BATCH_CAP: usize = 8 * 1024;
	let mut batch = String::with_capacity(INITIAL_BATCH_CAP);
	while let Ok(first) = rx.recv_async().await {
		batch.push_str(&first);
		// Greedily drain everything already queued. Child processes that
		// write byte-at-a-time (printf-style progress, llama-cli token
		// streams) otherwise produce one napi callback per `write(2)`,
		// saturating the JS main thread (~200% CPU observed) and leaving
		// the queue draining long after the child exits.
		while batch.len() < MAX_BATCH_BYTES {
			match rx.try_recv() {
				Ok(more) => batch.push_str(&more),
				Err(_) => break,
			}
		}
		let payload = std::mem::replace(&mut batch, String::with_capacity(INITIAL_BATCH_CAP));
		if !forward(payload).await {
			return;
		}
	}
}

/// Inputs for [`apply_shell_minimizer`]: a captured command's text plus the
/// minimizer configuration to run against it.
#[napi(object)]
pub struct ShellMinimizerApplyOptions {
	/// The command line that produced `captured` (used to select a filter).
	pub command:   String,
	/// The full captured stdout/stderr to minimize.
	pub captured:  String,
	/// The command's exit status; omitted is treated as success (`0`).
	pub exit_code: Option<i32>,
	/// Minimizer configuration; when omitted the call is a no-op (`null`).
	pub minimizer: Option<MinimizerOptions>,
}

/// Run the shell-output minimizer over an already-captured command result,
/// without spawning a shell.
///
/// This is the one-shot counterpart to the minimization that
/// [`execute_shell`] performs inline: callers that captured a command's output
/// elsewhere can pass it here to obtain the same telemetry.
///
/// Returns [`MinimizerResult`] **only** when the minimizer actually rewrote the
/// output (`changed == true`) and retained the original buffer, mirroring the
/// persistent-shell path. Returns `null` for every no-op case: when
/// `minimizer` is omitted, when the config is disabled, or when the filter
/// passes the output through unchanged. A missing `exit_code` is treated as
/// success (`0`).
///
/// Async (returns a Promise): minimization can scan multi-megabyte captured
/// output, so the work runs on a blocking pool to avoid stalling the JS event
/// loop.
#[napi(ts_return_type = "Promise<MinimizerResult | null>")]
pub fn apply_shell_minimizer(
	env: &Env,
	options: ShellMinimizerApplyOptions,
) -> Result<PromiseRaw<'_, Option<MinimizerResult>>> {
	// Returns a Promise rather than a sync value: minimization can run over a
	// multi-megabyte capture buffer, and a sync `#[napi]` fn would do that CPU
	// work on the JS main thread and stall the event loop. Run the whole pass on
	// a blocking pool, mirroring `execute_shell`.
	task::future(env, "shell.minimize", async move {
		napi::tokio::task::spawn_blocking(move || run_shell_minimizer(options))
			.await
			.map_err(|err| Error::from_reason(err.to_string()))
	})
}

/// Pure, blocking core of [`apply_shell_minimizer`], factored out so it can run
/// inside `spawn_blocking` and be unit-tested without an N-API `Env`.
///
/// Mirrors the persistent-shell path (`pi_shell::shell`): surface telemetry
/// only when the minimizer actually rewrote the output and kept the original
/// buffer. The disabled / passthrough cases report `changed: false` with no
/// `original_text`, and yield `None`.
fn run_shell_minimizer(options: ShellMinimizerApplyOptions) -> Option<MinimizerResult> {
	let minimizer = options.minimizer?;
	let minimizer_options: minimizer::MinimizerOptions = minimizer.into();
	let config = minimizer::MinimizerConfig::from_options(&minimizer_options);
	let output = minimizer::apply(
		&options.command,
		&options.captured,
		options.exit_code.unwrap_or(0),
		&config,
	);
	if output.changed
		&& let Some(original_text) = output.original_text
	{
		let output_bytes = u32::try_from(output.text.len()).unwrap_or(u32::MAX);
		return Some(MinimizerResult {
			filter: output.filter.to_string(),
			text: output.text,
			original_text,
			input_bytes: u32::try_from(output.input_bytes).unwrap_or(u32::MAX),
			output_bytes,
		});
	}
	None
}

#[cfg(test)]
mod tests {
	use std::time::Duration;

	use flume;
	use pi_shell::{
		ShellRunOptions as CoreShellRunOptions,
		cancel::{AbortReason, CancelToken},
	};
	use tokio::time;

	use super::{BRIDGE_QUEUE_CHUNKS, CoreShell, pump_chunks};

	/// Regression for #4078: the reader→JS bridge queue must stay bounded when
	/// the JS side (here: a deliberately slow `forward`) cannot keep up with a
	/// fast producer, and backpressure must never drop or reorder chunks. On
	/// the pre-fix bridge (`flume::unbounded` + fire-and-forget
	/// `ThreadsafeFunctionCallMode::NonBlocking`) the same harness accumulates
	/// the producer's entire surplus in the queue (measured: a 32 MiB stream
	/// queued all `33_554_432` bytes while the consumer stalled).
	#[tokio::test(flavor = "multi_thread")]
	async fn bridge_pump_bounds_queue_and_delivers_all_bytes() {
		const CHUNKS: usize = 512;
		const CHUNK_BYTES: usize = 4096;
		let (tx, rx) = flume::bounded::<String>(BRIDGE_QUEUE_CHUNKS);
		let producer = tokio::spawn(async move {
			let mut expected = String::with_capacity(CHUNKS * CHUNK_BYTES);
			let mut max_queued = 0usize;
			for i in 0..CHUNKS {
				let chunk = format!("[{i:06}]{}", "x".repeat(CHUNK_BYTES - 8));
				expected.push_str(&chunk);
				tx.send_async(chunk)
					.await
					.expect("pump should outlive the producer");
				max_queued = max_queued.max(tx.len());
			}
			(expected, max_queued)
		});

		let mut received = String::with_capacity(CHUNKS * CHUNK_BYTES);
		time::timeout(
			Duration::from_secs(30),
			pump_chunks(rx, async |payload: String| {
				received.push_str(&payload);
				// Emulate a busy JS event loop: each napi callback takes a while.
				time::sleep(Duration::from_micros(500)).await;
				true
			}),
		)
		.await
		.expect("pump should finish once the producer hangs up");

		let (expected, max_queued) = producer.await.expect("producer task");
		assert!(
			max_queued <= BRIDGE_QUEUE_CHUNKS,
			"bridge queue grew past its bound: {max_queued} chunks",
		);
		assert_eq!(received.len(), expected.len(), "bytes were dropped or duplicated");
		assert_eq!(received, expected, "chunks must arrive losslessly and in order");
	}

	/// When the JS side dies (`forward` fails: threadsafe function aborted on
	/// env teardown), the pump must drop its receiver so parked and future
	/// sends fail fast — the pipe readers keep draining the child instead of
	/// wedging it on a full bridge queue.
	#[tokio::test(flavor = "multi_thread")]
	async fn bridge_pump_death_disconnects_channel_without_blocking_senders() {
		let (tx, rx) = flume::bounded::<String>(4);
		let pump = tokio::spawn(pump_chunks(rx, async |_payload: String| false));
		let producer = tokio::spawn(async move {
			let mut disconnected = 0usize;
			for _ in 0..64 {
				if tx.send_async("x".repeat(1024)).await.is_err() {
					disconnected += 1;
				}
			}
			disconnected
		});
		let disconnected = time::timeout(Duration::from_secs(5), producer)
			.await
			.expect("sends must not park once the consumer died")
			.expect("producer task");
		assert!(disconnected > 0, "channel should disconnect after the pump stops");
		time::timeout(Duration::from_secs(5), pump)
			.await
			.expect("pump should exit after forward fails")
			.expect("pump task");
	}

	#[test]
	fn apply_shell_minimizer_surfaces_rewrite_with_original() {
		let captured = "diff --git a/file.rs b/file.rs\n@@\n-old\n+new\n";
		let result = super::run_shell_minimizer(super::ShellMinimizerApplyOptions {
			command:   "git diff".to_string(),
			captured:  captured.to_string(),
			exit_code: Some(0),
			minimizer: Some(super::MinimizerOptions { enabled: Some(true), ..Default::default() }),
		})
		.expect("an enabled, supported command should surface a rewrite");
		assert_eq!(result.filter, "git");
		// A genuine rewrite carries the untouched capture in `original_text`
		// and a strictly different minimized `text`.
		assert_eq!(result.original_text, captured);
		assert_ne!(result.text, result.original_text);
		assert_eq!(result.input_bytes as usize, captured.len());
	}

	#[test]
	fn apply_shell_minimizer_returns_none_when_disabled() {
		// `enabled: false` keeps the engine in passthrough — no telemetry.
		assert!(
			super::run_shell_minimizer(super::ShellMinimizerApplyOptions {
				command:   "git diff".to_string(),
				captured:  "diff --git a/file.rs b/file.rs\n@@\n-old\n+new\n".to_string(),
				exit_code: Some(0),
				minimizer: Some(super::MinimizerOptions { enabled: Some(false), ..Default::default() }),
			})
			.is_none()
		);
		// A missing minimizer handle is also a no-op.
		assert!(
			super::run_shell_minimizer(super::ShellMinimizerApplyOptions {
				command:   "git diff".to_string(),
				captured:  "diff --git a/file.rs b/file.rs\n".to_string(),
				exit_code: Some(0),
				minimizer: None,
			})
			.is_none()
		);
	}

	#[test]
	fn apply_shell_minimizer_surfaces_rewrite_with_original() {
		let captured = "diff --git a/file.rs b/file.rs\n@@\n-old\n+new\n";
		let result = super::run_shell_minimizer(super::ShellMinimizerApplyOptions {
			command:   "git diff".to_string(),
			captured:  captured.to_string(),
			exit_code: Some(0),
			minimizer: Some(super::MinimizerOptions { enabled: Some(true), ..Default::default() }),
		})
		.expect("an enabled, supported command should surface a rewrite");
		assert_eq!(result.filter, "git");
		// A genuine rewrite carries the untouched capture in `original_text`
		// and a strictly different minimized `text`.
		assert_eq!(result.original_text, captured);
		assert_ne!(result.text, result.original_text);
		assert_eq!(result.input_bytes as usize, captured.len());
	}

	#[test]
	fn apply_shell_minimizer_returns_none_when_disabled() {
		// `enabled: false` keeps the engine in passthrough — no telemetry.
		assert!(
			super::run_shell_minimizer(super::ShellMinimizerApplyOptions {
				command:   "git diff".to_string(),
				captured:  "diff --git a/file.rs b/file.rs\n@@\n-old\n+new\n".to_string(),
				exit_code: Some(0),
				minimizer: Some(super::MinimizerOptions { enabled: Some(false), ..Default::default() }),
			})
			.is_none()
		);
		// A missing minimizer handle is also a no-op.
		assert!(
			super::run_shell_minimizer(super::ShellMinimizerApplyOptions {
				command:   "git diff".to_string(),
				captured:  "diff --git a/file.rs b/file.rs\n".to_string(),
				exit_code: Some(0),
				minimizer: None,
			})
			.is_none()
		);
	}

	mod child_session_action_tests {
		use pi_shell::{ChildSessionAction, child_session_action};

		#[test]
		fn interactive_with_terminal_stdin_takes_foreground() {
			assert_eq!(child_session_action(true, true, false), ChildSessionAction::TakeForeground);
			assert_eq!(child_session_action(true, true, true), ChildSessionAction::TakeForeground);
		}

		#[test]
		fn non_terminal_stdin_detaches_regardless_of_pipeline() {
			assert_eq!(child_session_action(true, false, false), ChildSessionAction::DetachSession);
			// A leading-new-pgroup stage of a pipeline still detaches: setsid keeps
			// it off the host's controlling tty.
			assert_eq!(child_session_action(true, false, true), ChildSessionAction::DetachSession);
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
		fn pipeline_stage_with_non_terminal_stdin_detaches() {
			// Regression: an interactive child inside a pipeline (`zsh -i | awk`)
			// must not stay in the host session and seize its tty. Pre-fix this
			// returned `None`, leaving the stage attached and able to SIGTTIN the host.
			assert_eq!(child_session_action(false, false, true), ChildSessionAction::DetachSession);
		}
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn embedded_external_command_runs_in_its_own_session() {
		let shell = CoreShell::new(None);
		let (tx, rx) = flume::unbounded::<String>();
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
		let child_pid = time::timeout(Duration::from_secs(5), rx.recv_async())
			.await
			.expect("timed out waiting for child pid")
			.expect("missing child pid chunk")
			.trim()
			.parse::<i32>()
			.expect("child pid parses");
		// SAFETY: `getsid(0)` only queries the current process session; the
		// return value is checked below. Inside a PID namespace (e.g. the
		// containerized CI runner) the host's session leader can live outside
		// the namespace, so `getsid(0)` legitimately reports 0 — only -1 is a
		// real failure. The meaningful invariant is that the child detached
		// into its own session (`child_sid == child_pid`, distinct from host).
		let host_sid = unsafe { libc::getsid(0) };
		assert!(host_sid >= 0, "getsid(0) failed: {}", std::io::Error::last_os_error());
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

	#[tokio::test(flavor = "multi_thread")]
	async fn timeout_drains_pipeline_output_before_stopping_reader() {
		let shell = CoreShell::new(None);
		let (tx, rx) = flume::unbounded::<String>();
		// `tail` runs as an in-process builtin, so cancellation kills only the
		// external `yes`; tail then sees EOF and flushes its final 5 lines into
		// the post-cancel reader grace window. The deadline must be generous
		// enough that `yes` has demonstrably spawned and produced before the
		// timeout fires — a 50ms budget lost that race on cold CI runners and
		// tail flushed an empty ring buffer.
		const TIMEOUT_MS: u32 = 750;
		let result = shell
			.run(
				CoreShellRunOptions {
					command:    "yes x | tail -5".to_string(),
					cwd:        None,
					env:        None,
					timeout_ms: Some(TIMEOUT_MS),
				},
				Some(tx),
				CancelToken::new(Some(TIMEOUT_MS)),
			)
			.await
			.expect("shell run");

		let mut output = String::new();
		while let Ok(chunk) = rx.recv_async().await {
			output.push_str(&chunk);
		}

		assert!(result.timed_out);
		assert_eq!(output.lines().filter(|line| *line == "x").count(), 5);
	}
}
