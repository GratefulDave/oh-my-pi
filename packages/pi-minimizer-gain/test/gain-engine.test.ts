import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import minimizerGain from "../src/extension";
import {
	buildMinimizerGainDiagnostic,
	exportMinimizerGainJsonl,
	getMinimizerGainPath,
	loadMinimizerGainContext,
	readMinimizerGain,
	resetMinimizerGainStatusForTesting,
} from "../src/gain-engine";

interface AppendBashMinimizerGainRecordInput {
	agentDir: string;
	command: string;
	cwd: string;
	sessionCwd?: string;
	filter: string;
	inputBytes: number;
	outputBytes: number;
	exitCode: number;
	kind?: "saved" | "missed";
}

async function appendBashMinimizerGainRecord(input: AppendBashMinimizerGainRecordInput): Promise<void> {
	const savedBytes = Math.max(0, input.inputBytes - input.outputBytes);
	if (input.kind !== "missed" && savedBytes <= 0) return;
	await fs.promises.mkdir(input.agentDir, { recursive: true });
	await fs.promises.appendFile(
		getMinimizerGainPath(input.agentDir),
		`${JSON.stringify({
			schemaVersion: 2,
			timestamp: new Date().toISOString(),
			cwd: fs.realpathSync(input.cwd),
			...(input.sessionCwd === undefined ? {} : { sessionCwd: fs.realpathSync(input.sessionCwd) }),
			command: input.command,
			filter: input.filter,
			inputBytes: input.inputBytes,
			outputBytes: input.outputBytes,
			savedBytes,
			...(input.kind === "missed" ? {} : { savedTokens: Math.floor(savedBytes / 4) }),
			exitCode: input.exitCode,
			kind: input.kind ?? "saved",
		})}\n`,
	);
}

function inferBashMinimizerMissedFilter(command: string): string {
	if (/[;&|]{1,2}/.test(command)) return "compound";
	const base = path.basename(command.trim().split(/\s+/, 1)[0] ?? "");
	return base || "unknown";
}
interface RegisteredCommand {
	description: string;
	handler: (args: string, ctx: unknown) => Promise<void>;
}

describe("minimizer gain records", () => {
	let tempDir: string;
	let cwd: string;
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		originalAgentDir = Bun.env.OMP_AGENT_DIR;
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-minimizer-gain-"));
		cwd = path.join(tempDir, "repo");
		fs.mkdirSync(cwd, { recursive: true });
		cwd = fs.realpathSync(cwd);
		resetMinimizerGainStatusForTesting();
	});

	afterEach(() => {
		if (originalAgentDir === undefined) delete Bun.env.OMP_AGENT_DIR;
		else Bun.env.OMP_AGENT_DIR = originalAgentDir;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("appends saved records to the extension-owned JSONL file", async () => {
		const agentDir = path.join(tempDir, "agent");
		await appendBashMinimizerGainRecord({
			agentDir,
			command: "bun test noisy.test.ts",
			cwd,
			filter: "bun-test",
			inputBytes: 4000,
			outputBytes: 1000,
			exitCode: 1,
		});

		const records = await readMinimizerGain({ agentDir });
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			command: "bun test noisy.test.ts",
			cwd,
			filter: "bun-test",
			inputBytes: 4000,
			outputBytes: 1000,
			savedBytes: 3000,
			savedTokens: 750,
			exitCode: 1,
			kind: "saved",
		});
	});

	test("current scope includes records from commands run in sibling cwd", async () => {
		const agentDir = path.join(tempDir, "agent");
		const siblingCwd = path.join(tempDir, "sibling");
		fs.mkdirSync(siblingCwd);
		const sessionCwd = cwd;
		await appendBashMinimizerGainRecord({
			agentDir,
			command: "uv run pytest tests/test_vpn_guard.py -q",
			cwd: siblingCwd,
			sessionCwd,
			filter: "uv",
			inputBytes: 1200,
			outputBytes: 200,
			exitCode: 0,
		});

		const records = await readMinimizerGain({ agentDir, cwd: sessionCwd });
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			command: "uv run pytest tests/test_vpn_guard.py -q",
			cwd: fs.realpathSync(siblingCwd),
			sessionCwd,
			savedBytes: 1000,
		});
	});

	test("active session scope only counts commands from the current transcript", async () => {
		const agentDir = path.join(tempDir, "agent");
		const recordsPath = getMinimizerGainPath(agentDir);
		fs.mkdirSync(agentDir, { recursive: true });
		const command = "bun test active.test.ts";
		const now = new Date().toISOString();
		fs.writeFileSync(
			recordsPath,
			[
				JSON.stringify({
					schemaVersion: 2,
					timestamp: now,
					cwd,
					sessionCwd: cwd,
					command,
					filter: "bun-test",
					inputBytes: 1000,
					outputBytes: 400,
					savedBytes: 600,
					exitCode: 0,
					kind: "saved",
				}),
				JSON.stringify({
					schemaVersion: 2,
					timestamp: now,
					cwd,
					sessionCwd: cwd,
					command,
					filter: "bun-test",
					inputBytes: 2000,
					outputBytes: 500,
					savedBytes: 1500,
					exitCode: 0,
					kind: "saved",
				}),
				JSON.stringify({
					schemaVersion: 2,
					timestamp: now,
					cwd,
					sessionCwd: cwd,
					command: "bun test other.test.ts",
					filter: "bun-test",
					inputBytes: 3000,
					outputBytes: 500,
					savedBytes: 2500,
					exitCode: 0,
					kind: "saved",
				}),
			].join("\n"),
		);
		const sessionFile = path.join(agentDir, "sessions", "repo", "active.jsonl");
		fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
		fs.writeFileSync(
			sessionFile,
			[
				JSON.stringify({ type: "session", cwd }),
				JSON.stringify({
					type: "message",
					message: {
						content: [{ type: "toolCall", name: "bash", arguments: { command, cwd } }],
					},
				}),
			].join("\n"),
		);

		const context = await loadMinimizerGainContext({ agentDir, cwd, all: false, activeSessionFile: sessionFile });
		const diagnostic = await buildMinimizerGainDiagnostic({ agentDir, cwd, activeSessionFile: sessionFile });

		expect(context.records).toHaveLength(1);
		expect(context.summary.savedBytes).toBe(1500);
		expect(diagnostic.currentSessionRecordCount).toBe(1);
	});
	test("active session scope survives plugin reload by session start timestamp", async () => {
		const agentDir = path.join(tempDir, "agent");
		const recordsPath = getMinimizerGainPath(agentDir);
		fs.mkdirSync(agentDir, { recursive: true });
		const sessionStartedAt = "2026-06-15T10:00:00.000Z";
		const command = "bun check";
		fs.writeFileSync(
			recordsPath,
			[
				JSON.stringify({
					schemaVersion: 2,
					timestamp: "2026-06-15T09:59:59.000Z",
					cwd,
					sessionCwd: cwd,
					command: "stale command",
					filter: "stale",
					inputBytes: 2000,
					outputBytes: 500,
					savedBytes: 1500,
					exitCode: 0,
					kind: "saved",
				}),
				JSON.stringify({
					schemaVersion: 2,
					timestamp: "2026-06-15T10:00:01.000Z",
					cwd,
					sessionCwd: cwd,
					command,
					filter: "bun",
					inputBytes: 2000,
					outputBytes: 500,
					savedBytes: 1500,
					exitCode: 0,
					kind: "saved",
				}),
			].join("\n"),
		);

		const context = await loadMinimizerGainContext({
			agentDir,
			cwd,
			all: false,
			activeSessionStartedAt: sessionStartedAt,
			activeSessionCommands: [],
		});
		const diagnostic = await buildMinimizerGainDiagnostic({
			agentDir,
			cwd,
			activeSessionStartedAt: sessionStartedAt,
			activeSessionCommands: [],
		});

		expect(context.records.map(record => record.command)).toEqual([command]);
		expect(context.summary.savedBytes).toBe(1500);
		expect(diagnostic.currentSessionRecordCount).toBe(1);
	});
	test("active session scope prefers exact session id over timestamp overlap", async () => {
		const agentDir = path.join(tempDir, "agent");
		const recordsPath = getMinimizerGainPath(agentDir);
		fs.mkdirSync(agentDir, { recursive: true });
		const sessionStartedAt = "2026-06-15T10:00:00.000Z";
		const command = "bun check";
		fs.writeFileSync(
			recordsPath,
			[
				JSON.stringify({
					schemaVersion: 2,
					timestamp: "2026-06-15T10:00:01.000Z",
					cwd,
					sessionCwd: cwd,
					sessionId: "active-session",
					command,
					filter: "bun",
					inputBytes: 2000,
					outputBytes: 500,
					savedBytes: 1500,
					exitCode: 0,
					kind: "saved",
				}),
				JSON.stringify({
					schemaVersion: 2,
					timestamp: "2026-06-15T10:00:02.000Z",
					cwd,
					sessionCwd: cwd,
					sessionId: "other-session",
					command: "bun test other.test.ts",
					filter: "bun",
					inputBytes: 2000,
					outputBytes: 500,
					savedBytes: 1500,
					exitCode: 0,
					kind: "saved",
				}),
				JSON.stringify({
					schemaVersion: 2,
					timestamp: "2026-06-15T10:00:03.000Z",
					cwd,
					sessionCwd: cwd,
					command: "legacy active command",
					filter: "legacy",
					inputBytes: 2000,
					outputBytes: 500,
					savedBytes: 1500,
					exitCode: 0,
					kind: "saved",
				}),
			].join("\n"),
		);

		const context = await loadMinimizerGainContext({
			agentDir,
			cwd,
			all: false,
			activeSessionId: "active-session",
			activeSessionStartedAt: sessionStartedAt,
		});
		const diagnostic = await buildMinimizerGainDiagnostic({
			agentDir,
			cwd,
			activeSessionId: "active-session",
			activeSessionStartedAt: sessionStartedAt,
		});

		expect(context.records.map(record => record.command)).toEqual([command, "legacy active command"]);
		expect(context.summary.savedBytes).toBe(3000);
		expect(diagnostic.currentSessionRecordCount).toBe(2);
	});

	test("active session scope can use live session command entries", async () => {
		const agentDir = path.join(tempDir, "agent");
		const recordsPath = getMinimizerGainPath(agentDir);
		fs.mkdirSync(agentDir, { recursive: true });
		const command = "bun test live-active.test.ts";
		const now = new Date().toISOString();
		fs.writeFileSync(
			recordsPath,
			[
				JSON.stringify({
					schemaVersion: 2,
					timestamp: now,
					cwd,
					sessionCwd: cwd,
					command,
					filter: "bun-test",
					inputBytes: 2000,
					outputBytes: 500,
					savedBytes: 1500,
					exitCode: 0,
					kind: "saved",
				}),
				JSON.stringify({
					schemaVersion: 2,
					timestamp: now,
					cwd,
					sessionCwd: cwd,
					command: "bun test stale-active.test.ts",
					filter: "bun-test",
					inputBytes: 2000,
					outputBytes: 500,
					savedBytes: 1500,
					exitCode: 0,
					kind: "saved",
				}),
			].join("\n"),
		);

		const activeSessionCommands = [{ command, cwd }];
		const context = await loadMinimizerGainContext({ agentDir, cwd, all: false, activeSessionCommands });
		const diagnostic = await buildMinimizerGainDiagnostic({ agentDir, cwd, activeSessionCommands });

		expect(context.records.map(record => record.command)).toEqual([command]);
		expect(context.summary.savedBytes).toBe(1500);
		expect(diagnostic.currentSessionRecordCount).toBe(1);
	});

	test("upstream clone scope falls back to the sibling base repo path", async () => {
		const agentDir = path.join(tempDir, "agent");
		const baseRepo = path.join(tempDir, "lex");
		const upstreamClone = path.join(tempDir, "lex-upstream-15.10.6");
		const nestedCommandCwd = path.join(baseRepo, "packages", "coding-agent");
		fs.mkdirSync(nestedCommandCwd, { recursive: true });
		fs.mkdirSync(upstreamClone, { recursive: true });
		const sessionCwd = fs.realpathSync(upstreamClone);
		await appendBashMinimizerGainRecord({
			agentDir,
			command: "bun --cwd=packages/coding-agent test subagent-provider-inheritance",
			cwd: nestedCommandCwd,
			sessionCwd: fs.realpathSync(baseRepo),
			filter: "bun-test",
			inputBytes: 1600,
			outputBytes: 400,
			exitCode: 0,
		});

		const records = await readMinimizerGain({ agentDir, cwd: sessionCwd });
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			cwd: fs.realpathSync(nestedCommandCwd),
			sessionCwd: fs.realpathSync(baseRepo),
			savedBytes: 1200,
		});
	});

	test("current scope uses the git repo root when cwd is nested", async () => {
		const agentDir = path.join(tempDir, "agent");
		const nestedCwd = path.join(cwd, "packages", "coding-agent");
		fs.mkdirSync(path.join(cwd, ".git"));
		fs.mkdirSync(nestedCwd, { recursive: true });
		await appendBashMinimizerGainRecord({
			agentDir,
			command: "bun test packages/coding-agent/test/bash.test.ts",
			cwd,
			sessionCwd: cwd,
			filter: "bun-test",
			inputBytes: 2_000,
			outputBytes: 500,
			exitCode: 0,
		});

		const context = await loadMinimizerGainContext({ agentDir, cwd: nestedCwd, all: false });

		expect(context.cwd).toBe(cwd);
		expect(context.records).toHaveLength(1);
		expect(context.summary.savedBytes).toBe(1_500);
	});

	test("migrates legacy sibling cwd records from session transcripts", async () => {
		const agentDir = path.join(tempDir, "agent");
		const siblingPath = path.join(tempDir, "sibling");
		fs.mkdirSync(siblingPath, { recursive: true });
		const siblingCwd = fs.realpathSync(siblingPath);
		const command = "uv run pytest tests/test_vpn_guard.py -q";
		const recordsPath = getMinimizerGainPath(agentDir);
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(
			recordsPath,
			`${JSON.stringify({
				timestamp: new Date().toISOString(),
				cwd: siblingCwd,
				command,
				filter: "uv",
				inputBytes: 1200,
				outputBytes: 200,
				savedBytes: 1000,
				exitCode: 0,
			})}\n`,
		);
		const sessionDir = path.join(agentDir, "sessions", "test-project");
		fs.mkdirSync(sessionDir, { recursive: true });
		fs.writeFileSync(
			path.join(sessionDir, "session.jsonl"),
			[
				JSON.stringify({ type: "session", cwd }),
				JSON.stringify({
					type: "message",
					message: {
						content: [
							{
								type: "toolCall",
								name: "bash",
								arguments: { command, cwd: siblingCwd },
							},
						],
					},
				}),
			].join("\n"),
		);

		const context = await loadMinimizerGainContext({ agentDir, cwd, all: false });
		expect(context.records).toHaveLength(1);
		expect(context.records[0]).toMatchObject({
			schemaVersion: 2,
			cwd: siblingCwd,
			sessionCwd: cwd,
			command,
		});

		const diagnostic = await buildMinimizerGainDiagnostic({ agentDir, cwd });
		expect(diagnostic.recordCountInScope).toBe(1);
		expect(diagnostic.sessionCwdRecordCountInScope).toBe(1);
		expect(diagnostic.recordsWithSessionCwd).toBe(1);
		expect(diagnostic.recordsWithoutSessionCwd).toBe(0);
	});

	test("skips saved records with no byte reduction", async () => {
		const agentDir = path.join(tempDir, "agent");
		await appendBashMinimizerGainRecord({
			agentDir,
			command: "echo short",
			cwd,
			filter: "echo",
			inputBytes: 100,
			outputBytes: 100,
			exitCode: 0,
		});

		expect(fs.existsSync(getMinimizerGainPath(agentDir))).toBe(false);
	});

	test("reads missed records written by the bash minimizer gain pipeline", async () => {
		const agentDir = path.join(tempDir, "agent");
		await appendBashMinimizerGainRecord({
			agentDir,
			command: "git status",
			cwd,
			filter: "git",
			inputBytes: Buffer.byteLength("nothing to commit\n"),
			outputBytes: Buffer.byteLength("nothing to commit\n"),
			exitCode: 0,
			kind: "missed",
		});

		const records = await readMinimizerGain({ agentDir });
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			command: "git status",
			filter: "git",
			inputBytes: Buffer.byteLength("nothing to commit\n"),
			outputBytes: Buffer.byteLength("nothing to commit\n"),
			savedBytes: 0,
			exitCode: 0,
			kind: "missed",
		});
		expect(records[0]?.savedTokens).toBeUndefined();
	});

	test("registers the gain overlay command", () => {
		const commands = new Map<string, RegisteredCommand>();
		let label = "";
		minimizerGain({
			setLabel(value: string) {
				label = value;
			},
			registerCommand(name: string, command: RegisteredCommand) {
				commands.set(name, command);
			},
		} as never);

		expect(label).toBe("Minimizer Gain");
		expect(commands.get("gain")?.description).toBe("Show native minimizer savings for current repo");
	});

	test("filters configured ignored commands from missed diagnostics", async () => {
		const agentDir = path.join(tempDir, "agent");
		await appendBashMinimizerGainRecord({
			agentDir,
			command: "echo low value",
			cwd,
			filter: "echo",
			inputBytes: 120,
			outputBytes: 120,
			exitCode: 0,
			kind: "missed",
		});
		await appendBashMinimizerGainRecord({
			agentDir,
			command: "git status",
			cwd,
			filter: "git",
			inputBytes: 240,
			outputBytes: 240,
			exitCode: 0,
			kind: "missed",
		});

		const context = await loadMinimizerGainContext({
			agentDir,
			cwd,
			all: false,
			ignoredMissedCommands: ["echo"],
		});

		expect(context.missed.commands.map(item => item.command)).toEqual(["git status"]);
	});

	test("exports daily and command totals as JSONL", async () => {
		const agentDir = path.join(tempDir, "agent");
		await appendBashMinimizerGainRecord({
			agentDir,
			command: "bun test packages/pi-minimizer-gain/test/gain-engine.test.ts",
			cwd,
			filter: "bun-test",
			inputBytes: 400,
			outputBytes: 100,
			exitCode: 0,
		});

		const context = await loadMinimizerGainContext({ agentDir, cwd, all: false });
		const lines = exportMinimizerGainJsonl(context)
			.trim()
			.split("\n")
			.map(line => JSON.parse(line));

		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatchObject({ kind: "daily-total", commands: 1, savedBytes: 300 });
		expect(lines[1]).toMatchObject({
			kind: "command-total",
			command: "bun test packages/pi-minimizer-gain/test/gain-engine.test.ts",
			commands: 1,
			savedBytes: 300,
		});
	});

	test("summarizes source extension buckets and uses unknown without path signals", async () => {
		const agentDir = path.join(tempDir, "agent");
		const recordsPath = getMinimizerGainPath(agentDir);
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(
			recordsPath,
			[
				JSON.stringify({
					schemaVersion: 2,
					timestamp: new Date().toISOString(),
					cwd,
					command: "bun test",
					filter: "bun-test",
					inputBytes: 800,
					outputBytes: 200,
					savedBytes: 600,
					savedTokens: 150,
					exitCode: 0,
					kind: "saved",
					sourcePaths: ["src/gain-engine.ts"],
				}),
				JSON.stringify({
					schemaVersion: 2,
					timestamp: new Date().toISOString(),
					cwd,
					command: "bun test unknown",
					filter: "bun-test",
					inputBytes: 400,
					outputBytes: 100,
					savedBytes: 300,
					savedTokens: 75,
					exitCode: 0,
					kind: "saved",
				}),
			].join("\n"),
		);

		const context = await loadMinimizerGainContext({ agentDir, cwd, all: false });

		expect(context.summary.bySource).toEqual([
			expect.objectContaining({ source: ".ts", commands: 1, savedBytes: 600 }),
			expect.objectContaining({ source: "unknown", commands: 1, savedBytes: 300 }),
		]);
	});

	test("classifies compound missed commands separately", () => {
		expect(inferBashMinimizerMissedFilter("git status && git log")).toBe("compound");
		expect(inferBashMinimizerMissedFilter("/usr/bin/git status")).toBe("git");
	});
});
