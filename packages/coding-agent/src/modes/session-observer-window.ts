import { basename } from "node:path";
import { COMMAND_NAME } from "@oh-my-pi/pi-utils";
import type { ObservableSession } from "./session-observer-registry";

/** Result of attempting to open an observer window. */
export type ObserverWindowResult = { ok: true } | { ok: false; message: string };

/** Minimal result from a spawned command. */
export interface CommandRunResult {
	exitCode: number | null;
	stderr: string;
}

/** Callback that executes an argv array and returns a CommandRunResult. */
export type CommandRunner = (argv: string[]) => Promise<CommandRunResult>;

// ---------------------------------------------------------------------------
// Shell-quoting helpers
// ---------------------------------------------------------------------------

/**
 * Single-quote a string for POSIX shell expansion.
 *
 * Replaces each `'` with `'\''` so the result is safe to embed in a
 * single-quoted shell word.  The returned string includes the surrounding
 * quotes.
 */
export function shellQuote(s: string): string {
	return `'${s.replaceAll("'", "'\\''")}'`;
}

/**
 * Derive a safe, bounded mux window name from a session file path or id.
 *
 * Uses only the basename (last path component without extension) so that
 * slashes and deep directory segments don't leak into the window name.
 * Strips non-alphanumeric-or-dash characters and caps at 40 chars.
 */
export function safeWindowName(sessionFile: string): string {
	const base = basename(sessionFile).replace(/\.json$/i, "");
	// Keep alphanumeric, dash, underscore, dot; replace everything else with "-"
	const sanitized = base.replace(/[^a-zA-Z0-9._-]/g, "-");
	const name = `observer:${sanitized}`;
	// Bound to 40 chars; tmux window names have no hard limit but long names
	// are unusable in the status bar.
	return name.length <= 40 ? name : name.slice(0, 40);
}

// ---------------------------------------------------------------------------
// argv builders — exported so tests can assert command shape without spawning
// ---------------------------------------------------------------------------

/**
 * Build the tmux argv for opening an observer window.
 *
 * Uses `tmux new-window`, never `new-session` or `split-window`.
 *
 * The last argv token is a shell command string passed verbatim to the shell
 * by tmux; the session file is single-quoted so paths with spaces or shell
 * metacharacters are preserved exactly.
 */
export function buildTmuxObserverArgv(sessionFile: string): string[] {
	const windowName = safeWindowName(sessionFile);
	const lexCmd = `${COMMAND_NAME} --observe-session ${shellQuote(sessionFile)}`;
	return ["tmux", "new-window", "-n", windowName, lexCmd];
}

/**
 * Build the cmux argv for opening an observer window.
 *
 * Uses `cmux new-window`, never `new-split`.
 *
 * The last argv token is a shell command string; the session file is
 * single-quoted for the same reason as the tmux variant.
 */
export function buildCmuxObserverArgv(sessionFile: string): string[] {
	const windowName = safeWindowName(sessionFile);
	const lexCmd = `${COMMAND_NAME} --observe-session ${shellQuote(sessionFile)}`;
	return ["cmux", "new-window", "-n", windowName, lexCmd];
}

// ---------------------------------------------------------------------------
// Execution helpers — exported so tests can exercise the runner path directly
// ---------------------------------------------------------------------------

/**
 * Execute `tmux new-window` via the supplied runner and return a typed result.
 *
 * Exported for testing. Production callers should use `openObserverWindow`.
 */
export async function runTmuxWindow(session: ObservableSession, runner: CommandRunner): Promise<ObserverWindowResult> {
	const sessionFile = session.sessionFile;
	if (!sessionFile) {
		return { ok: false, message: "tmux observer window requires a session file path" };
	}
	const argv = buildTmuxObserverArgv(sessionFile);
	const result = await runner(argv);
	if (result.exitCode !== 0) {
		return {
			ok: false,
			message: result.stderr.trim() || `tmux new-window exited with code ${result.exitCode ?? "null"}`,
		};
	}
	return { ok: true };
}

/**
 * Execute `cmux new-window` via the supplied runner and return a typed result.
 *
 * Exported for testing. Production callers should use `openObserverWindow`.
 */
export async function runCmuxWindow(session: ObservableSession, runner: CommandRunner): Promise<ObserverWindowResult> {
	const sessionFile = session.sessionFile;
	if (!sessionFile) {
		return { ok: false, message: "cmux observer window requires a session file path" };
	}
	const argv = buildCmuxObserverArgv(sessionFile);
	const result = await runner(argv);
	if (result.exitCode !== 0) {
		return {
			ok: false,
			message: result.stderr.trim() || `cmux new-window exited with code ${result.exitCode ?? "null"}`,
		};
	}
	return { ok: true };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Attempt to open a mux observer window for the given observable session.
 *
 * Routes to `runTmuxWindow` or `runCmuxWindow` based on the session backend.
 * Requires `session.sessionFile` to be set; returns `ok: false` with a
 * descriptive message when it is absent.
 *
 * Returns `ok: false` without throwing for:
 * - Unsupported backend (not `tmux` / `cmux`).
 * - Missing `sessionFile` on the session.
 * - Nonzero exit from the mux command.
 *
 * @param session  Observable session whose `runMetadata.presentation.backend`
 *                 must be `tmux` or `cmux`.
 * @param runner   Optional injectable runner; defaults to `defaultRunner`.
 */
export async function openObserverWindow(
	session: ObservableSession,
	runner?: CommandRunner,
): Promise<ObserverWindowResult> {
	const effectiveRunner = runner ?? defaultRunner;

	const backend = session.runMetadata?.presentation.backend;
	if (backend !== "tmux" && backend !== "cmux") {
		return {
			ok: false,
			message: `openObserverWindow requires backend 'tmux' or 'cmux', got: ${backend ?? "(none)"}`,
		};
	}

	if (!session.sessionFile) {
		return {
			ok: false,
			message: `No session file available for observer window (session: ${session.id})`,
		};
	}

	if (backend === "tmux") {
		return runTmuxWindow(session, effectiveRunner);
	}
	return runCmuxWindow(session, effectiveRunner);
}

// ---------------------------------------------------------------------------
// Default Bun runner — used by runTmuxWindow / runCmuxWindow in production
// ---------------------------------------------------------------------------

/**
 * Spawn `argv[0]` with `argv.slice(1)` directly via `Bun.spawn` so that no
 * shell interprets the arguments.  Stderr is collected from the pipe; stdout
 * is discarded (tmux/cmux write their status to stderr, not stdout).
 */
export async function defaultRunner(argv: string[]): Promise<CommandRunResult> {
	const [cmd, ...args] = argv;
	if (!cmd) return { exitCode: 1, stderr: "Missing command" };
	try {
		const proc = Bun.spawn([cmd, ...args], {
			stdout: "ignore",
			stderr: "pipe",
		});
		const stderrChunks: Uint8Array[] = [];
		for await (const chunk of proc.stderr) {
			stderrChunks.push(chunk);
		}
		const exitCode = await proc.exited;
		const stderr = Buffer.concat(stderrChunks).toString("utf8");
		return { exitCode, stderr };
	} catch (err: unknown) {
		const exitCode = err instanceof Error && "exitCode" in err ? (err as { exitCode: number }).exitCode : 1;
		const stderr = err instanceof Error ? err.message : String(err);
		return { exitCode, stderr };
	}
}
