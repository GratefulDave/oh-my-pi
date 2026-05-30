import { describe, expect, it } from "bun:test";
import { COMMAND_NAME } from "@oh-my-pi/pi-utils";
import type { ObservableSession } from "../src/modes/session-observer-registry";
import {
	buildCmuxObserverArgv,
	buildTmuxObserverArgv,
	type CommandRunner,
	type CommandRunResult,
	openObserverWindow,
	runCmuxWindow,
	runTmuxWindow,
	safeWindowName,
	shellQuote,
} from "../src/modes/session-observer-window";
import type { AgentRunMetadata } from "../src/task/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(
	backend: "tmux" | "cmux" | "core" | undefined,
	id = "test-session-42",
	sessionFile?: string,
): ObservableSession {
	const presentation = backend !== undefined ? { mode: "window" as const, backend } : { mode: "window" as const };
	const runMetadata: AgentRunMetadata = {
		runId: id,
		agent: "task",
		status: "running",
		presentation,
		artifacts: [],
	};
	return {
		id,
		kind: "subagent",
		label: "test session",
		status: "active",
		lastUpdate: Date.now(),
		runMetadata,
		sessionFile,
	};
}

function captureRunner(): { calls: string[][]; runner: CommandRunner } {
	const calls: string[][] = [];
	const runner: CommandRunner = async (argv: string[]): Promise<CommandRunResult> => {
		calls.push(argv);
		return { exitCode: 0, stderr: "" };
	};
	return { calls, runner };
}

function failingRunner(exitCode: number, stderr: string): CommandRunner {
	return async (_argv: string[]): Promise<CommandRunResult> => ({ exitCode, stderr });
}

// ---------------------------------------------------------------------------
// argv shape tests — no real process spawned
// ---------------------------------------------------------------------------

describe("buildTmuxObserverArgv", () => {
	it("produces tmux new-window, not split or new-session", () => {
		const argv = buildTmuxObserverArgv("abc-123");
		expect(argv[0]).toBe("tmux");
		expect(argv).toContain("new-window");
		expect(argv.join(" ")).not.toMatch(/split/);
		expect(argv.join(" ")).not.toMatch(/new-session/);
	});

	it("contains COMMAND_NAME (lex) and not omp/omx/omc", () => {
		const argv = buildTmuxObserverArgv("abc-123");
		const joined = argv.join(" ");
		expect(joined).toContain(COMMAND_NAME);
		expect(COMMAND_NAME).toBe("lex");
		expect(joined).not.toMatch(/\bomp\b/);
		expect(joined).not.toMatch(/\bomx\b/);
		expect(joined).not.toMatch(/\bomc\b/);
	});
});

describe("buildCmuxObserverArgv", () => {
	it("produces cmux new-window, not new-split", () => {
		const argv = buildCmuxObserverArgv("abc-456");
		expect(argv[0]).toBe("cmux");
		expect(argv).toContain("new-window");
		expect(argv.join(" ")).not.toMatch(/new-split/);
	});

	it("contains COMMAND_NAME (lex) and not omp/omx/omc", () => {
		const argv = buildCmuxObserverArgv("abc-456");
		const joined = argv.join(" ");
		expect(joined).toContain(COMMAND_NAME);
		expect(joined).not.toMatch(/\bomp\b/);
		expect(joined).not.toMatch(/\bomx\b/);
		expect(joined).not.toMatch(/\bomc\b/);
	});
});

// ---------------------------------------------------------------------------
// runTmuxWindow — verifies runner receives tmux new-window command
// ---------------------------------------------------------------------------

describe("runTmuxWindow", () => {
	it("passes argv with tmux and new-window to runner", async () => {
		const { calls, runner } = captureRunner();
		const session = makeSession("tmux", "t-1", "/tmp/t-1.json");
		await runTmuxWindow(session, runner);
		expect(calls).toHaveLength(1);
		const argv = calls[0]!;
		expect(argv[0]).toBe("tmux");
		expect(argv).toContain("new-window");
		expect(argv.join(" ")).not.toMatch(/split/);
		expect(argv.join(" ")).not.toMatch(/new-session/);
	});

	it("command payload contains lex and not omp/omx/omc", async () => {
		const { calls, runner } = captureRunner();
		const session = makeSession("tmux", "t-2", "/tmp/t-2.json");
		await runTmuxWindow(session, runner);
		const joined = calls[0]!.join(" ");
		expect(joined).toContain(COMMAND_NAME);
		expect(joined).not.toMatch(/\bomp\b/);
		expect(joined).not.toMatch(/\bomx\b/);
		expect(joined).not.toMatch(/\bomc\b/);
	});

	it("argv contains --observe-session and the session file path", async () => {
		const { calls, runner } = captureRunner();
		const session = makeSession("tmux", "t-3", "/home/user/.omp/sessions/t-3.json");
		await runTmuxWindow(session, runner);
		const joined = calls[0]!.join(" ");
		expect(joined).toContain("--observe-session");
		expect(joined).toContain("/home/user/.omp/sessions/t-3.json");
	});

	it("returns ok: true when runner exits 0", async () => {
		const { runner } = captureRunner();
		const result = await runTmuxWindow(makeSession("tmux", "t-4", "/tmp/t-4.json"), runner);
		expect(result.ok).toBe(true);
	});

	it("returns ok: false without sessionFile, without calling runner", async () => {
		const { calls, runner } = captureRunner();
		const result = await runTmuxWindow(makeSession("tmux"), runner);
		expect(result.ok).toBe(false);
		expect(calls).toHaveLength(0);
	});

	it("returns ok: false without throwing when runner exits nonzero", async () => {
		const runner = failingRunner(1, "tmux: session not found");
		const result = await runTmuxWindow(makeSession("tmux", "t-5", "/tmp/t-5.json"), runner);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toContain("tmux: session not found");
		}
	});

	it("returns ok: false with fallback message when stderr is empty on nonzero exit", async () => {
		const runner = failingRunner(2, "");
		const result = await runTmuxWindow(makeSession("tmux", "t-6", "/tmp/t-6.json"), runner);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toMatch(/exit/i);
		}
	});
});

// ---------------------------------------------------------------------------
// runCmuxWindow — verifies runner receives cmux new-window command
// ---------------------------------------------------------------------------

describe("runCmuxWindow", () => {
	it("passes argv with cmux and new-window (not new-split) to runner", async () => {
		const { calls, runner } = captureRunner();
		const session = makeSession("cmux", "c-1", "/tmp/c-1.json");
		await runCmuxWindow(session, runner);
		expect(calls).toHaveLength(1);
		const argv = calls[0]!;
		expect(argv[0]).toBe("cmux");
		expect(argv).toContain("new-window");
		expect(argv.join(" ")).not.toMatch(/new-split/);
	});

	it("command payload contains lex and not omp/omx/omc", async () => {
		const { calls, runner } = captureRunner();
		const session = makeSession("cmux", "c-2", "/tmp/c-2.json");
		await runCmuxWindow(session, runner);
		const joined = calls[0]!.join(" ");
		expect(joined).toContain(COMMAND_NAME);
		expect(joined).not.toMatch(/\bomp\b/);
		expect(joined).not.toMatch(/\bomx\b/);
		expect(joined).not.toMatch(/\bomc\b/);
	});

	it("argv contains --observe-session and the session file path", async () => {
		const { calls, runner } = captureRunner();
		const session = makeSession("cmux", "c-3", "/home/user/.omp/sessions/c-3.json");
		await runCmuxWindow(session, runner);
		const joined = calls[0]!.join(" ");
		expect(joined).toContain("--observe-session");
		expect(joined).toContain("/home/user/.omp/sessions/c-3.json");
	});

	it("returns ok: true when runner exits 0", async () => {
		const { runner } = captureRunner();
		const result = await runCmuxWindow(makeSession("cmux", "c-4", "/tmp/c-4.json"), runner);
		expect(result.ok).toBe(true);
	});

	it("returns ok: false without sessionFile, without calling runner", async () => {
		const { calls, runner } = captureRunner();
		const result = await runCmuxWindow(makeSession("cmux"), runner);
		expect(result.ok).toBe(false);
		expect(calls).toHaveLength(0);
	});

	it("returns ok: false without throwing when runner exits nonzero", async () => {
		const runner = failingRunner(1, "cmux: no such window");
		const result = await runCmuxWindow(makeSession("cmux", "c-5", "/tmp/c-5.json"), runner);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toContain("cmux: no such window");
		}
	});

	it("returns ok: false with fallback message when stderr is empty on nonzero exit", async () => {
		const runner = failingRunner(127, "");
		const result = await runCmuxWindow(makeSession("cmux", "c-6", "/tmp/c-6.json"), runner);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toMatch(/exit/i);
		}
	});
});

// ---------------------------------------------------------------------------
// openObserverWindow — high-level routing and no-CLI-mode guard
// ---------------------------------------------------------------------------

describe("openObserverWindow", () => {
	it("returns ok: false for unsupported backend without throwing", async () => {
		const result = await openObserverWindow(makeSession("core"), captureRunner().runner);
		expect(result.ok).toBe(false);
	});

	it("returns ok: false when backend is undefined", async () => {
		const result = await openObserverWindow(makeSession(undefined), captureRunner().runner);
		expect(result.ok).toBe(false);
	});

	it("returns ok: false for tmux session without sessionFile", async () => {
		const result = await openObserverWindow(makeSession("tmux"), captureRunner().runner);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toContain("session file");
		}
	});

	it("returns ok: false for cmux session without sessionFile", async () => {
		const result = await openObserverWindow(makeSession("cmux"), captureRunner().runner);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toContain("session file");
		}
	});

	it("opens tmux window and returns ok: true when sessionFile is present and runner succeeds", async () => {
		const { calls, runner } = captureRunner();
		const session = makeSession("tmux", "sess-1", "/tmp/sessions/sess-1.json");
		const result = await openObserverWindow(session, runner);
		expect(result.ok).toBe(true);
		expect(calls).toHaveLength(1);
		const argv = calls[0]!;
		expect(argv[0]).toBe("tmux");
		expect(argv).toContain("new-window");
		expect(argv.join(" ")).toContain("/tmp/sessions/sess-1.json");
		expect(argv.join(" ")).toContain(COMMAND_NAME);
	});

	it("opens cmux window and returns ok: true when sessionFile is present and runner succeeds", async () => {
		const { calls, runner } = captureRunner();
		const session = makeSession("cmux", "sess-2", "/tmp/sessions/sess-2.json");
		const result = await openObserverWindow(session, runner);
		expect(result.ok).toBe(true);
		expect(calls).toHaveLength(1);
		const argv = calls[0]!;
		expect(argv[0]).toBe("cmux");
		expect(argv).toContain("new-window");
		expect(argv.join(" ")).toContain("/tmp/sessions/sess-2.json");
	});

	it("returns ok: false when mux command fails, without throwing", async () => {
		const runner = failingRunner(1, "tmux: session not found");
		const session = makeSession("tmux", "sess-3", "/tmp/sess-3.json");
		const result = await openObserverWindow(session, runner);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toContain("tmux: session not found");
		}
	});
});

// ---------------------------------------------------------------------------
// shellQuote — POSIX single-quote escaping
// ---------------------------------------------------------------------------

describe("shellQuote", () => {
	it("wraps a plain path in single quotes", () => {
		expect(shellQuote("/tmp/session.json")).toBe("'/tmp/session.json'");
	});

	it("escapes embedded single quotes", () => {
		expect(shellQuote("it's")).toBe("'it'\\''s'");
	});

	it("preserves spaces and metacharacters literally inside quotes", () => {
		const quoted = shellQuote("/home/user/my sessions/s 1.json");
		expect(quoted).toBe("'/home/user/my sessions/s 1.json'");
	});
});

// ---------------------------------------------------------------------------
// safeWindowName — bounded, slash-free window names
// ---------------------------------------------------------------------------

describe("safeWindowName", () => {
	it("strips directory prefix and json extension", () => {
		const name = safeWindowName("/home/user/.omp/sessions/my-session-42.json");
		expect(name).toBe("observer:my-session-42");
	});

	it("does not contain slashes", () => {
		const name = safeWindowName("/deep/nested/path/session-1.json");
		expect(name).not.toContain("/");
	});

	it("replaces spaces in basename with dashes", () => {
		const name = safeWindowName("/sessions/my session.json");
		expect(name).not.toContain(" ");
	});

	it("is bounded to 40 chars", () => {
		const longFile = `/sessions/${"a".repeat(200)}.json`;
		expect(safeWindowName(longFile).length).toBeLessThanOrEqual(40);
	});
});

// ---------------------------------------------------------------------------
// Space / metacharacter paths — exact path preserved in shell command token
// ---------------------------------------------------------------------------

describe("buildTmuxObserverArgv — paths with spaces and metacharacters", () => {
	it("preserves exact session file path with spaces in shell command token", () => {
		const sessionFile = "/home/user/my sessions/session 1.json";
		const argv = buildTmuxObserverArgv(sessionFile);
		// Last element is the shell command; it must contain the quoted path.
		const shellCmd = argv[argv.length - 1]!;
		expect(shellCmd).toContain(shellQuote(sessionFile));
		// The unquoted path string is present inside the quoted form.
		expect(shellCmd).toContain(sessionFile);
	});

	it("preserves exact session file path with dollar sign and backtick", () => {
		const sessionFile = "/tmp/$weird`path`.json";
		const argv = buildTmuxObserverArgv(sessionFile);
		const shellCmd = argv[argv.length - 1]!;
		expect(shellCmd).toContain(shellQuote(sessionFile));
		expect(shellCmd).toContain(sessionFile);
	});

	it("argv window name does not contain slashes from full path", () => {
		const sessionFile = "/home/user/my sessions/session 1.json";
		const argv = buildTmuxObserverArgv(sessionFile);
		// -n <windowName> is at index 3
		const windowName = argv[3]!;
		expect(windowName).not.toContain("/");
	});

	it("still contains COMMAND_NAME and new-window", () => {
		const sessionFile = "/tmp/path with spaces/s.json";
		const argv = buildTmuxObserverArgv(sessionFile);
		expect(argv).toContain("new-window");
		expect(argv.join(" ")).toContain(COMMAND_NAME);
	});
});

describe("buildCmuxObserverArgv — paths with spaces and metacharacters", () => {
	it("preserves exact session file path with spaces in shell command token", () => {
		const sessionFile = "/home/user/my sessions/session 2.json";
		const argv = buildCmuxObserverArgv(sessionFile);
		const shellCmd = argv[argv.length - 1]!;
		expect(shellCmd).toContain(shellQuote(sessionFile));
		expect(shellCmd).toContain(sessionFile);
	});

	it("argv window name does not contain slashes from full path", () => {
		const sessionFile = "/home/user/my sessions/session 2.json";
		const argv = buildCmuxObserverArgv(sessionFile);
		const windowName = argv[3]!;
		expect(windowName).not.toContain("/");
	});
});

describe("runTmuxWindow — space-path preserved as observer target", () => {
	it("runner receives argv whose shell command token contains quoted spaced path", async () => {
		const { calls, runner } = captureRunner();
		const sessionFile = "/home/user/my sessions/s 1.json";
		const session = makeSession("tmux", "space-1", sessionFile);
		await runTmuxWindow(session, runner);
		const argv = calls[0]!;
		const shellCmd = argv[argv.length - 1]!;
		expect(shellCmd).toContain(shellQuote(sessionFile));
		expect(shellCmd).toContain("--observe-session");
		expect(shellCmd).toContain(COMMAND_NAME);
	});

	it("runner receives argv with new-window and no split/new-session for spaced path", async () => {
		const { calls, runner } = captureRunner();
		await runTmuxWindow(makeSession("tmux", "space-2", "/a b/c d.json"), runner);
		const joined = calls[0]!.join(" ");
		expect(joined).toContain("new-window");
		expect(joined).not.toMatch(/split/);
		expect(joined).not.toMatch(/new-session/);
	});
});

describe("runCmuxWindow — space-path preserved as observer target", () => {
	it("runner receives argv whose shell command token contains quoted spaced path", async () => {
		const { calls, runner } = captureRunner();
		const sessionFile = "/home/user/my sessions/s 2.json";
		const session = makeSession("cmux", "cspace-1", sessionFile);
		await runCmuxWindow(session, runner);
		const argv = calls[0]!;
		const shellCmd = argv[argv.length - 1]!;
		expect(shellCmd).toContain(shellQuote(sessionFile));
		expect(shellCmd).toContain("--observe-session");
		expect(shellCmd).toContain(COMMAND_NAME);
	});
});
