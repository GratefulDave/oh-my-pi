import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { makeMinimizedSaveHandler } from "@oh-my-pi/pi-coding-agent/tools/bash";
import {
	appendBashMinimizerGainRecord,
	getBashMinimizerGainPath,
} from "@oh-my-pi/pi-coding-agent/tools/bash-minimizer-gain";

interface GainRecord {
	timestamp: string;
	cwd?: string;
	sessionCwd?: string;
	sessionId?: string;
	filter: string;
	inputBytes: number;
	outputBytes: number;
	savedBytes: number;
	savedTokens?: number;
	exitCode: number | null;
	kind: "saved" | "missed";
}

describe("bash minimizer gain writer", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gain-writer-"));
		agentDir = path.join(tempDir, "agent");
		cwd = path.join(tempDir, "repo");
		await fs.mkdir(cwd);
		await fs.mkdir(path.join(tempDir, "session"));
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	async function records(): Promise<GainRecord[]> {
		const text = await Bun.file(getBashMinimizerGainPath(agentDir)).text();
		return text
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as GainRecord);
	}

	test("writes a saved record with the completed command outcome", async () => {
		await appendBashMinimizerGainRecord({
			agentDir,
			command: "bun test noisy.test.ts",
			cwd,
			sessionCwd: path.join(tempDir, "session"),
			sessionId: "session-test-id",
			filter: "bun-test",
			inputBytes: 4000,
			outputBytes: 1000,
			exitCode: 1,
		});

		const [record] = await records();
		expect(record).toEqual(
			expect.objectContaining({
				command: "bun test noisy.test.ts",
				cwd: await fs.realpath(cwd),
				sessionCwd: await fs.realpath(path.join(tempDir, "session")),
				sessionId: "session-test-id",
				filter: "bun-test",
				inputBytes: 4000,
				outputBytes: 1000,
				savedBytes: 3000,
				savedTokens: 750,
				exitCode: 1,
				kind: "saved",
			}),
		);
		expect(Number.isFinite(Date.parse(record!.timestamp))).toBe(true);
	});

	test("skips non-saving and empty missed records", async () => {
		await appendBashMinimizerGainRecord({
			agentDir,
			command: "echo short",
			cwd,
			filter: "noop",
			inputBytes: 10,
			outputBytes: 10,
			exitCode: 0,
		});
		await appendBashMinimizerGainRecord({
			agentDir,
			command: "true",
			cwd,
			filter: "missed",
			inputBytes: 0,
			outputBytes: 0,
			exitCode: 0,
			kind: "missed",
		});

		expect(await Bun.file(getBashMinimizerGainPath(agentDir)).exists()).toBe(false);
	});

	test("writes eligible unchanged output as a missed record", async () => {
		await appendBashMinimizerGainRecord({
			agentDir,
			command: "git status",
			cwd,
			filter: "missed",
			inputBytes: 200,
			outputBytes: 200,
			exitCode: 0,
			kind: "missed",
		});

		const [record] = await records();
		expect(record).toEqual(
			expect.objectContaining({
				filter: "missed",
				inputBytes: 200,
				outputBytes: 200,
				savedBytes: 0,
				kind: "missed",
			}),
		);
		expect(record!.savedTokens).toBeUndefined();
	});
});

describe("makeMinimizedSaveHandler", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gain-handler-"));
		agentDir = path.join(tempDir, "agent");
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	function mockSession(gainTelemetry: boolean, prefix?: string) {
		return {
			cwd: tempDir,
			hasUI: false,
			getSessionId: () => "test-session",
			getSessionFile: () => null,
			settings: {
				get: (key: string) => (key === "shellMinimizer.gainTelemetry" ? gainTelemetry : undefined),
				getAgentDir: () => agentDir,
				getShellConfig: () => ({ prefix }),
			},
		} as Parameters<typeof makeMinimizedSaveHandler>[0];
	}

	test("flushes saved telemetry after the real exit code is available", async () => {
		const handler = makeMinimizedSaveHandler(mockSession(true), "bun test noisy.test.ts", tempDir);
		await handler.onMinimizedSave("original output", { filter: "bun-test", inputBytes: 4000, outputBytes: 1000 });
		await handler.flushSaved(1);

		const [line] = (await Bun.file(getBashMinimizerGainPath(agentDir)).text()).trim().split("\n");
		const record = JSON.parse(line!) as GainRecord;
		expect(handler.didSave()).toBe(true);
		expect(record).toEqual(expect.objectContaining({ kind: "saved", filter: "bun-test", exitCode: 1 }));
	});

	test("suppresses saved telemetry when disabled or prefixed", async () => {
		for (const session of [mockSession(false), mockSession(true, "time")]) {
			const handler = makeMinimizedSaveHandler(session, "git status", tempDir);
			await handler.onMinimizedSave("status output", { filter: "git", inputBytes: 2000, outputBytes: 500 });
			await handler.flushSaved(0);
		}

		expect(await Bun.file(getBashMinimizerGainPath(agentDir)).exists()).toBe(false);
	});
});
