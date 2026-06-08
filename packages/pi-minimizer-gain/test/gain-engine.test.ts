import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	appendBashMinimizerGainRecord,
	inferBashMinimizerMissedFilter,
} from "@oh-my-pi/pi-coding-agent/tools/bash-minimizer-gain";
import minimizerGain from "../src/extension";
import {
	buildMinimizerGainDiagnostic,
	getMinimizerGainPath,
	loadMinimizerGainContext,
	readMinimizerGain,
	resetMinimizerGainStatusForTesting,
} from "../src/gain-engine";

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

	test("classifies compound missed commands separately", () => {
		expect(inferBashMinimizerMissedFilter("git status && git log")).toBe("compound");
		expect(inferBashMinimizerMissedFilter("/usr/bin/git status")).toBe("git");
	});
});
