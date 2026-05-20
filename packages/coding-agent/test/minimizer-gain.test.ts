import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildMinimizerMissedRecord,
	discoverMinimizerGain,
	getMinimizerGainPath,
	readMinimizerGain,
	recordMinimizerGain,
	summarizeMinimizerGain,
	summarizeMissedMinimizerGain,
} from "../src/minimizer-gain";

async function withTempAgentDir<T>(fn: (agentDir: string) => Promise<T>): Promise<T> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-minimizer-gain-"));
	try {
		return await fn(agentDir);
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}

describe("minimizer gain analytics", () => {
	it("records only metadata and summarizes savings", async () => {
		await withTempAgentDir(async agentDir => {
			await recordMinimizerGain(
				{
					timestamp: "2026-05-20T00:00:00.000Z",
					cwd: "/repo",
					command: "git status",
					filter: "git",
					inputBytes: 1000,
					outputBytes: 250,
					savedBytes: 750,
					exitCode: 0,
				},
				{ agentDir },
			);
			await recordMinimizerGain(
				{
					timestamp: "2026-05-20T00:01:00.000Z",
					cwd: "/repo",
					command: "cargo test",
					filter: "cargo",
					inputBytes: 2200,
					outputBytes: 200,
					savedBytes: 2000,
					exitCode: 101,
				},
				{ agentDir },
			);
			await recordMinimizerGain(
				{
					timestamp: "2026-05-20T00:02:00.000Z",
					cwd: "/repo",
					command: "git status --short",
					filter: "git",
					inputBytes: 300,
					outputBytes: 330,
					savedBytes: 0,
					exitCode: 0,
					kind: "saved",
				},
				{ agentDir },
			);
			await recordMinimizerGain(
				{
					timestamp: "2026-05-20T00:03:00.000Z",
					cwd: "/other-repo",
					command: "bun test",
					filter: "bun",
					inputBytes: 1000,
					outputBytes: 400,
					savedBytes: 600,
					exitCode: 0,
				},
				{ agentDir },
			);

			const content = await fs.readFile(getMinimizerGainPath(agentDir), "utf-8");
			expect(content).not.toContain("full raw output");

			const records = await readMinimizerGain({ agentDir });
			expect(records).toHaveLength(4);

			const summary = summarizeMinimizerGain(records);
			expect(summary.commands).toBe(3);
			expect(summary.inputBytes).toBe(4200);
			expect(summary.outputBytes).toBe(850);
			expect(summary.savedBytes).toBe(3350);
			expect(summary.estimatedTokensSaved).toBe(837);
			expect(summary.byFilter.map(row => row.filter)).toEqual(["cargo", "git", "bun"]);
			expect(summary.byCwd.map(row => row.cwd)).toEqual(["/repo", "/other-repo"]);
			expect(summary.byCwd[0]).toMatchObject({ cwd: "/repo", savedBytes: 2750 });
			expect(summary.byCwd[1]).toMatchObject({ cwd: "/other-repo", savedBytes: 600 });

			const discovery = discoverMinimizerGain(records);
			expect(discovery.commands[0]).toMatchObject({
				command: "cargo test",
				filter: "cargo",
				savedBytes: 2000,
				avgSavedBytes: 2000,
			});
			expect(discovery.commands.map(row => row.command)).not.toContain("git status --short");

			await recordMinimizerGain(
				{
					timestamp: "2026-05-20T00:04:00.000Z",
					cwd: "/repo",
					command: "unknown-tool --verbose",
					filter: "missed",
					inputBytes: 5000,
					outputBytes: 5000,
					savedBytes: 0,
					exitCode: 0,
					kind: "missed",
				},
				{ agentDir },
			);
			const mixedRecords = await readMinimizerGain({ agentDir });
			expect(summarizeMinimizerGain(mixedRecords).commands).toBe(3);
			expect(discoverMinimizerGain(mixedRecords).commands).toHaveLength(3);

			const missed = summarizeMissedMinimizerGain(mixedRecords);
			expect(missed.commands[0]).toMatchObject({
				command: "unknown-tool --verbose",
				inputBytes: 5000,
				avgInputBytes: 5000,
				exitCodes: [0],
			});
		});
	});

	it("skips invalid lines and filters old or unrelated records", async () => {
		await withTempAgentDir(async agentDir => {
			const filePath = getMinimizerGainPath(agentDir);
			await fs.writeFile(
				filePath,
				[
					"not json",
					JSON.stringify({
						timestamp: new Date().toISOString(),
						cwd: "/repo",
						command: "git diff",
						filter: "git",
						inputBytes: 400,
						outputBytes: 100,
						savedBytes: 300,
						exitCode: 0,
					}),
					JSON.stringify({
						timestamp: "2000-01-01T00:00:00.000Z",
						cwd: "/repo",
						command: "git log",
						filter: "git",
						inputBytes: 400,
						outputBytes: 100,
						savedBytes: 300,
						exitCode: 0,
					}),
					JSON.stringify({
						timestamp: new Date().toISOString(),
						cwd: "/other",
						command: "git status",
						filter: "git",
						inputBytes: 400,
						outputBytes: 100,
						savedBytes: 300,
						exitCode: 0,
					}),
				].join("\n"),
			);

			const records = await readMinimizerGain({ agentDir, cwd: "/repo", sinceDays: 1 });
			expect(records.map(record => record.command)).toEqual(["git diff"]);
		});
	});

	it("builds missed records without raw output", () => {
		const record = buildMinimizerMissedRecord({
			timestamp: "2026-05-20T00:00:00.000Z",
			cwd: "/repo",
			command: "huge-command",
			totalBytes: 4096,
			exitCode: 0,
		});

		expect(record).toEqual({
			timestamp: "2026-05-20T00:00:00.000Z",
			cwd: "/repo",
			command: "huge-command",
			filter: "missed",
			inputBytes: 4096,
			outputBytes: 4096,
			savedBytes: 0,
			exitCode: 0,
			kind: "missed",
		});
		expect(JSON.stringify(record)).not.toContain("output:");
		expect(
			buildMinimizerMissedRecord({
				timestamp: "2026-05-20T00:00:00.000Z",
				command: "empty",
				totalBytes: 0,
				exitCode: 0,
			}),
		).toBeNull();
	});
});
