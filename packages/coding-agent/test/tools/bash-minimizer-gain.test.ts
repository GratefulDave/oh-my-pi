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
		});

		const file = getBashMinimizerGainPath(path.join(tempDir, "agent"));
		const lines = fs.readFileSync(file, "utf8").trim().split("\n");
		expect(lines).toHaveLength(1);
		const record = JSON.parse(lines[0]!) as {
			command: string;
			cwd: string;
			sessionCwd: string;
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
		expect(record.filter).toBe("bun-test");
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

	test("classifies compound missed commands separately", () => {
		expect(inferBashMinimizerMissedFilter("git status && git log")).toBe("compound");
		expect(inferBashMinimizerMissedFilter("/usr/bin/git status")).toBe("git");
	});
});
