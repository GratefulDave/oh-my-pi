import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import minimizerGain from "../src/extension";
import {
	appendMinimizerGainRecord,
	getMinimizerGainPath,
	inferMinimizerGainMissedFilter,
	readMinimizerGain,
	resetMinimizerGainStatusForTesting,
} from "../src/gain-engine";

interface CapturedToolResultEvent {
	type: "tool_result";
	toolName: string;
	input: Record<string, unknown>;
	content: Array<{ type: "text"; text: string }>;
	details:
		| { exitCode?: number; async?: { state: "running" | "completed" | "failed"; jobId: string; type: "bash" } }
		| undefined;
	isError?: boolean;
}

interface CapturedExtensionContext {
	agentDir?: string;
	cwd: string;
	sessionManager: {
		getArtifactPath(id: string): Promise<string | null>;
	};
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
		await appendMinimizerGainRecord({
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

	test("skips saved records with no byte reduction", async () => {
		const agentDir = path.join(tempDir, "agent");
		await appendMinimizerGainRecord({
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

	test("appends missed records for unminimized bash results from the extension hook", async () => {
		const agentDir = path.join(tempDir, "agent");
		const handler = captureToolResultHandler(agentDir);

		await handler(
			{
				type: "tool_result",
				toolName: "bash",
				input: { command: "git status", cwd },
				content: [{ type: "text", text: "nothing to commit\n" }],
				details: {},
			},
			contextFor(cwd, agentDir),
		);

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

	test("appends saved records from raw-output artifacts in the extension hook", async () => {
		const agentDir = path.join(tempDir, "agent");
		const artifactPath = path.join(tempDir, "0.bash-original.log");
		const original = "full output line 1\nfull output line 2\n";
		fs.writeFileSync(artifactPath, original, "utf-8");
		const handler = captureToolResultHandler(agentDir);

		await handler(
			{
				type: "tool_result",
				toolName: "bash",
				input: { command: "bun test", cwd },
				content: [{ type: "text", text: "summary\n[raw output: artifact://0]\n" }],
				details: { exitCode: 1 },
				isError: true,
			},
			contextFor(cwd, agentDir, artifactPath),
		);

		const records = await readMinimizerGain({ agentDir });
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			command: "bun test",
			filter: "bun",
			inputBytes: Buffer.byteLength(original),
			outputBytes: Buffer.byteLength("summary"),
			savedBytes: Buffer.byteLength(original) - Buffer.byteLength("summary"),
			exitCode: 1,
			kind: "saved",
		});
	});

	test("classifies compound missed commands separately", () => {
		expect(inferMinimizerGainMissedFilter("git status && git log")).toBe("compound");
		expect(inferMinimizerGainMissedFilter("/usr/bin/git status")).toBe("git");
	});
});

function captureToolResultHandler(agentDir: string) {
	let captured: ((event: CapturedToolResultEvent, ctx: CapturedExtensionContext) => Promise<void> | void) | undefined;
	minimizerGain({
		setLabel() {},
		on(event, handler) {
			if (event === "tool_result") captured = handler;
		},
		registerCommand() {},
		logger: { warn() {} },
	} as Parameters<typeof minimizerGain>[0]);
	if (!captured) throw new Error("tool_result handler not registered");
	return async (event: CapturedToolResultEvent, ctx: CapturedExtensionContext) => {
		Bun.env.OMP_AGENT_DIR = agentDir;
		await captured(event, ctx);
	};
}

function contextFor(cwd: string, agentDir: string, artifactPath?: string): CapturedExtensionContext {
	return {
		agentDir,
		cwd,
		sessionManager: {
			async getArtifactPath() {
				return artifactPath ?? null;
			},
		},
	};
}
