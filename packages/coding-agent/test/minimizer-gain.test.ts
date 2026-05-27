import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
	buildMinimizerMissedRecord,
	discoverMinimizerGain,
	getMinimizerGainPath,
	loadMinimizerGainContext,
	readMinimizerGain,
	recordMinimizerGain,
	resolveMinimizerGainCwd,
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
					savedTokens: 111,
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
					savedTokens: 222,
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
			expect(records[0].savedTokens).toBe(111);
			expect(records[1].savedTokens).toBe(222);
			expect(records[3].savedTokens).toBeUndefined();

			const summary = summarizeMinimizerGain(records);
			expect(summary.commands).toBe(3);
			expect(summary.inputBytes).toBe(4200);
			expect(summary.outputBytes).toBe(850);
			expect(summary.savedBytes).toBe(3350);
			expect(summary.estimatedTokensSaved).toBe(483);
			expect(summary.usesEstimatedTokensSaved).toBe(true);
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
				usesEstimatedTokensSaved: false,
			});
			expect(discovery.commands.find(row => row.command === "bun test")).toMatchObject({
				usesEstimatedTokensSaved: true,
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

	it("loads a gain context with summaries and path", async () => {
		await withTempAgentDir(async agentDir => {
			await recordMinimizerGain(
				{
					timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
					cwd: "/repo",
					command: "git status",
					filter: "git",
					inputBytes: 1000,
					outputBytes: 250,
					savedBytes: 750,
					savedTokens: 111,
					exitCode: 0,
				},
				{ agentDir },
			);
			await recordMinimizerGain(
				{
					timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
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

			const context = await loadMinimizerGainContext({ cwd: "/repo", all: false, days: 7, agentDir });
			expect(context.path).toBe(getMinimizerGainPath(agentDir));
			expect(context.cwd).toBe("/repo");
			expect(context.all).toBe(false);
			expect(context.summary.commands).toBe(1);
			expect(context.missed.commands).toHaveLength(1);
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
			const summary = summarizeMinimizerGain(records);
			expect(summary.estimatedTokensSaved).toBe(75);
			expect(summary.usesEstimatedTokensSaved).toBe(true);
			expect(records.map(record => record.command)).toEqual(["git diff"]);
		});
	});

	it("finds records after canonicalizing a raw cwd symlink", async () => {
		if (process.platform === "win32") {
			return;
		}

		await withTempAgentDir(async agentDir => {
			const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-minimizer-gain-cwd-"));
			try {
				const canonicalCwd = path.join(workspaceDir, "real");
				const rawCwd = path.join(workspaceDir, "raw");
				await fs.mkdir(canonicalCwd, { recursive: true });
				await fs.symlink(canonicalCwd, rawCwd, "dir");

				const canonicalizedRawCwd = await resolveMinimizerGainCwd(rawCwd);
				expect(canonicalizedRawCwd).toBe(await fs.realpath(rawCwd));

				await recordMinimizerGain(
					{
						timestamp: "2026-05-20T00:04:00.000Z",
						cwd: canonicalizedRawCwd,
						command: "git status",
						filter: "git",
						inputBytes: 200,
						outputBytes: 80,
						savedBytes: 120,
						exitCode: 0,
						kind: "saved",
					},
					{ agentDir },
				);

				const records = await readMinimizerGain({ agentDir, cwd: canonicalizedRawCwd });
				expect(records).toHaveLength(1);
				expect(records[0]).toMatchObject({
					cwd: canonicalizedRawCwd,
					command: "git status",
					savedBytes: 120,
					kind: "saved",
				});
			} finally {
				await fs.rm(workspaceDir, { recursive: true, force: true });
			}
		});
	});

	it("matchesCwd prefix-matches subdirectories without false sibling matches", async () => {
		await withTempAgentDir(async agentDir => {
			const records = [
				{ command: "git status", cwd: "/repo", savedBytes: 100 },
				{ command: "git diff", cwd: "/repo/sub", savedBytes: 200 },
				{ command: "git log", cwd: "/repo/sub/deep", savedBytes: 50 },
				{ command: "git fetch", cwd: "/repo-sibling", savedBytes: 999 },
				{ command: "git pull", cwd: "/other", savedBytes: 999 },
			];
			for (const r of records) {
				await recordMinimizerGain(
					{
						timestamp: new Date().toISOString(),
						cwd: r.cwd,
						command: r.command,
						filter: "git",
						inputBytes: r.savedBytes + 50,
						outputBytes: 50,
						savedBytes: r.savedBytes,
						exitCode: 0,
						kind: "saved",
					},
					{ agentDir },
				);
			}
			const filtered = await readMinimizerGain({ agentDir, cwd: "/repo" });
			const cmds = filtered.map(r => r.command).sort();
			expect(cmds).toEqual(["git diff", "git log", "git status"]);
			expect(cmds).not.toContain("git fetch");
			expect(cmds).not.toContain("git pull");
			const summary = summarizeMinimizerGain(filtered);
			expect(summary.savedBytes).toBe(350);
		});
	});

	it("matchesCwd handles trailing separator on scope without doubling it", async () => {
		await withTempAgentDir(async agentDir => {
			await recordMinimizerGain(
				{
					timestamp: new Date().toISOString(),
					cwd: "/repo/sub",
					command: "cargo build",
					filter: "cargo",
					inputBytes: 500,
					outputBytes: 100,
					savedBytes: 400,
					exitCode: 0,
					kind: "saved",
				},
				{ agentDir },
			);
			const withSlash = await readMinimizerGain({ agentDir, cwd: "/repo/" });
			const noSlash = await readMinimizerGain({ agentDir, cwd: "/repo" });
			expect(withSlash).toHaveLength(1);
			expect(noSlash).toHaveLength(1);
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
	it("excludes kind=saved records with savedBytes=0 from summary totals", async () => {
		await withTempAgentDir(async agentDir => {
			await recordMinimizerGain(
				{
					timestamp: new Date().toISOString(),
					cwd: "/repo",
					command: "noop-rewrite",
					filter: "rewrite",
					inputBytes: 500,
					outputBytes: 500,
					savedBytes: 0,
					exitCode: 0,
					kind: "saved",
				},
				{ agentDir },
			);
			await recordMinimizerGain(
				{
					timestamp: new Date().toISOString(),
					cwd: "/repo",
					command: "real-saver",
					filter: "git",
					inputBytes: 1000,
					outputBytes: 200,
					savedBytes: 800,
					savedTokens: 150,
					exitCode: 0,
					kind: "saved",
				},
				{ agentDir },
			);
			const records = await readMinimizerGain({ agentDir });
			const summary = summarizeMinimizerGain(records);
			expect(summary.commands).toBe(1);
			expect(summary.savedBytes).toBe(800);
			expect(summary.byCommand.map(row => row.command)).toEqual(["real-saver"]);
		});
	});

	it("includes legacy records (kind=undefined, savedBytes>0) in summary totals", async () => {
		await withTempAgentDir(async agentDir => {
			await recordMinimizerGain(
				{
					timestamp: new Date().toISOString(),
					cwd: "/repo",
					command: "legacy-tool",
					filter: "legacy",
					inputBytes: 900,
					outputBytes: 300,
					savedBytes: 600,
					exitCode: 0,
				},
				{ agentDir },
			);
			const records = await readMinimizerGain({ agentDir });
			expect(records[0].kind).toBeUndefined();
			const summary = summarizeMinimizerGain(records);
			expect(summary.commands).toBe(1);
			expect(summary.savedBytes).toBe(600);
			expect(summary.usesEstimatedTokensSaved).toBe(true);
		});
	});

	it("loadMinimizerGainContext honors days at the readMinimizerGain boundary", async () => {
		await withTempAgentDir(async agentDir => {
			const now = Date.now();
			const fresh = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
			const stale = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
			await recordMinimizerGain(
				{
					timestamp: fresh,
					cwd: "/repo",
					command: "fresh",
					filter: "git",
					inputBytes: 400,
					outputBytes: 100,
					savedBytes: 300,
					exitCode: 0,
					kind: "saved",
				},
				{ agentDir },
			);
			await recordMinimizerGain(
				{
					timestamp: stale,
					cwd: "/repo",
					command: "stale",
					filter: "git",
					inputBytes: 4000,
					outputBytes: 1000,
					savedBytes: 3000,
					exitCode: 0,
					kind: "saved",
				},
				{ agentDir },
			);
			const ctx = await loadMinimizerGainContext({ cwd: "/repo", all: false, days: 7, agentDir });
			expect(ctx.days).toBe(7);
			expect(ctx.records.map(r => r.command)).toEqual(["fresh"]);
			expect(ctx.summary.savedBytes).toBe(300);
		});
	});

	it("builds missed records with explicit filter reasons", () => {
		const record = buildMinimizerMissedRecord({
			timestamp: "2026-05-20T00:00:00.000Z",
			command: "git diff ; printf done",
			totalBytes: 128,
			exitCode: 0,
			filter: "compound",
		});

		expect(record).toMatchObject({
			filter: "compound",
			kind: "missed",
			inputBytes: 128,
			outputBytes: 128,
		});
	});
});
