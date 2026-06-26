import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	appendBashMinimizerGainRecord,
	getBashMinimizerGainPath,
	inferBashMinimizerMissedFilter,
} from "@oh-my-pi/pi-coding-agent/tools/bash-minimizer-gain";

describe("bash minimizer gain writer", () => {
	let tempDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-gain-writer-"));
		cwd = path.join(tempDir, "repo");
		fs.mkdirSync(cwd);
		fs.mkdirSync(path.join(tempDir, "session"));
	});

	afterEach(() => {
		if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
	});

	test("appends saved minimizer records to the agent JSONL file", async () => {
		await appendBashMinimizerGainRecord({
			agentDir: path.join(tempDir, "agent"),
			command: "bun test noisy.test.ts",
			cwd,
			sessionCwd: path.join(tempDir, "session"),
			filter: "bun-test",
			inputBytes: 4000,
			outputBytes: 1000,
			exitCode: 1,
			sessionId: "session-test-id",
		});

		const file = getBashMinimizerGainPath(path.join(tempDir, "agent"));
		const lines = fs.readFileSync(file, "utf8").trim().split("\n");
		expect(lines).toHaveLength(1);
		const record = JSON.parse(lines[0]!) as {
			command: string;
			cwd: string;
			sessionCwd: string;
			sessionId: string;
			filter: string;
			inputBytes: number;
			outputBytes: number;
			savedBytes: number;
			savedTokens: number;
			exitCode: number | null;
			kind: string;
		};
		expect(record.command).toBe("bun test noisy.test.ts");
		expect(record.cwd).toBe(fs.realpathSync(cwd));
		expect(record.sessionCwd).toBe(fs.realpathSync(path.join(tempDir, "session")));
		expect(record.sessionId).toBe("session-test-id");
		expect(record.inputBytes).toBe(4000);
		expect(record.outputBytes).toBe(1000);
		expect(record.savedBytes).toBe(3000);
		expect(record.savedTokens).toBe(750);
		expect(record.exitCode).toBe(1);
		expect(record.kind).toBe("saved");
	});

	test("skips saved records that do not save bytes", async () => {
		const agentDir = path.join(tempDir, "agent");
		await appendBashMinimizerGainRecord({
			agentDir,
			command: "echo short",
			cwd,
			filter: "noop",
			inputBytes: 10,
			outputBytes: 10,
			exitCode: 0,
		});

		expect(fs.existsSync(getBashMinimizerGainPath(agentDir))).toBe(false);
	});

	test("appends missed records for unminimized command output", async () => {
		const agentDir = path.join(tempDir, "agent");
		await appendBashMinimizerGainRecord({
			agentDir,
			command: "git status",
			cwd,
			filter: inferBashMinimizerMissedFilter("git status"),
			inputBytes: 200,
			outputBytes: 200,
			exitCode: 0,
			kind: "missed",
		});

		const [line] = fs.readFileSync(getBashMinimizerGainPath(agentDir), "utf8").trim().split("\n");
		const record = JSON.parse(line!) as {
			filter: string;
			inputBytes: number;
			outputBytes: number;
			savedBytes: number;
			savedTokens?: number;
			kind: string;
		};
		expect(record.filter).toBe("git");
		expect(record.inputBytes).toBe(200);
		expect(record.outputBytes).toBe(200);
		expect(record.savedBytes).toBe(0);
		expect(record.savedTokens).toBeUndefined();
		expect(record.kind).toBe("missed");
	});

	test("skips missed records when the command produced no output", async () => {
		const agentDir = path.join(tempDir, "agent");
		await appendBashMinimizerGainRecord({
			agentDir,
			command: "true",
			cwd,
			filter: inferBashMinimizerMissedFilter("true"),
			inputBytes: 0,
			outputBytes: 0,
			exitCode: 0,
			kind: "missed",
		});

		expect(fs.existsSync(getBashMinimizerGainPath(agentDir))).toBe(false);
	});

	test("classifies compound missed commands separately", () => {
		expect(inferBashMinimizerMissedFilter("git status && git log")).toBe("compound");
		expect(inferBashMinimizerMissedFilter("/usr/bin/git status")).toBe("git");
		expect(inferBashMinimizerMissedFilter("CI=1 npm test")).toBe("npm");
		expect(inferBashMinimizerMissedFilter("TOKEN=abc123 pnpm run lint")).toBe("pnpm");
		expect(inferBashMinimizerMissedFilter("FOO=1 BAR=2 node script.js")).toBe("node");
	});

	test("handles quoted env values containing whitespace", () => {
		expect(
			inferBashMinimizerMissedFilter("NODE_OPTIONS='--max-old-space-size=4096 --trace-warnings' pnpm test"),
		).toBe("pnpm");
		expect(inferBashMinimizerMissedFilter('NODE_OPTIONS="--max-old-space-size=4096 --trace-warnings" bun test')).toBe(
			"bun",
		);
		expect(inferBashMinimizerMissedFilter("CI=1 NODE_OPTIONS='--max-old-space-size=512' uv run pytest")).toBe("uv");
		expect(
			inferBashMinimizerMissedFilter("NODE_OPTIONS='--require ./setup.js --max-old-space-size=4096' npm run build"),
		).toBe("npm");
	});
});

describe("makeMinimizedSaveHandler + didSave gate contract", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-gain-gate-"));
		agentDir = path.join(tempDir, "agent");
	});

	afterEach(() => {
		if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
	});

	function mockSession(gainTelemetry: boolean, dir: string) {
		return {
			cwd: tempDir,
			hasUI: false,
			getSessionId: () => "test-session",
			getSessionFile: () => null,
			settings: {
				get: (key: string) => {
					if (key === "shellMinimizer.gainTelemetry") return gainTelemetry;
					return undefined;
				},
				getAgentDir: () => dir,
			},
		};
	}

	test("minimized run emits exactly one saved record and no missed record", async () => {
		const { makeMinimizedSaveHandler } = await import("@oh-my-pi/pi-coding-agent/tools/bash");
		const session = mockSession(true, agentDir) as Parameters<typeof makeMinimizedSaveHandler>[0];

		const handler = makeMinimizedSaveHandler(session, "bun test noisy.test.ts", tempDir);
		await handler.onMinimizedSave("original output text here", {
			filter: "bun-test",
			inputBytes: 4000,
			outputBytes: 1000,
		});

		expect(handler.didSave()).toBe(true);

		const lines = fs.readFileSync(getBashMinimizerGainPath(agentDir), "utf8").trim().split("\n").filter(Boolean);
		expect(lines).toHaveLength(1);
		const record = JSON.parse(lines[0]!) as { kind: string; filter: string };
		expect(record.kind).toBe("saved");
		expect(record.filter).toBe("bun-test");
	});

	test("unminimized run emits exactly one missed record when caller uses guard", async () => {
		const { makeMinimizedSaveHandler } = await import("@oh-my-pi/pi-coding-agent/tools/bash");
		const session = mockSession(true, agentDir) as Parameters<typeof makeMinimizedSaveHandler>[0];

		const handler = makeMinimizedSaveHandler(session, "git log --oneline", tempDir);
		// onMinimizedSave NOT called — no minimization
		expect(handler.didSave()).toBe(false);

		// Caller writes missed only when !didSave()
		if (!handler.didSave()) {
			await appendBashMinimizerGainRecord({
				command: "git log --oneline",
				cwd: tempDir,
				sessionId: "test-session",
				filter: inferBashMinimizerMissedFilter("git log --oneline"),
				inputBytes: 500,
				outputBytes: 500,
				exitCode: 0,
				kind: "missed",
				agentDir,
			});
		}

		const lines = fs.readFileSync(getBashMinimizerGainPath(agentDir), "utf8").trim().split("\n").filter(Boolean);
		expect(lines).toHaveLength(1);
		const record = JSON.parse(lines[0]!) as { kind: string; filter: string };
		expect(record.kind).toBe("missed");
		expect(record.filter).toBe("git");
	});

	test("didSave guard prevents spurious missed record on minimized run", async () => {
		const { makeMinimizedSaveHandler } = await import("@oh-my-pi/pi-coding-agent/tools/bash");
		const session = mockSession(true, agentDir) as Parameters<typeof makeMinimizedSaveHandler>[0];

		const handler = makeMinimizedSaveHandler(session, "cargo build", tempDir);
		await handler.onMinimizedSave("build output...", { filter: "cargo", inputBytes: 8000, outputBytes: 500 });

		// Guard: caller skips the missed write when didSave() is true
		if (!handler.didSave()) {
			await appendBashMinimizerGainRecord({
				command: "cargo build",
				agentDir,
				filter: "cargo",
				inputBytes: 8000,
				outputBytes: 8000,
				exitCode: 0,
				kind: "missed",
			});
		}

		const lines = fs.readFileSync(getBashMinimizerGainPath(agentDir), "utf8").trim().split("\n").filter(Boolean);
		// Only the saved record — no spurious missed
		expect(lines).toHaveLength(1);
		expect((JSON.parse(lines[0]!) as { kind: string }).kind).toBe("saved");
	});

	test("telemetry suppressed when shellMinimizer.gainTelemetry is false (default)", async () => {
		const { makeMinimizedSaveHandler } = await import("@oh-my-pi/pi-coding-agent/tools/bash");
		const session = mockSession(false, agentDir) as Parameters<typeof makeMinimizedSaveHandler>[0];

		const handler = makeMinimizedSaveHandler(session, "npm install", tempDir);
		await handler.onMinimizedSave("install output", { filter: "npm", inputBytes: 2000, outputBytes: 500 });

		// No JSONL written — telemetry is off by default
		expect(fs.existsSync(getBashMinimizerGainPath(agentDir))).toBe(false);
	});
});
