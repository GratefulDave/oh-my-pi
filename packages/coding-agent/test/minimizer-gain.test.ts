import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
	buildMinimizerGainDiagnostic,
	buildMinimizerMissedRecord,
	discoverMinimizerGain,
	getMinimizerGainPath,
	getMinimizerGainStatus,
	loadMinimizerGainContext,
	readMinimizerGain,
	recordMinimizerGain,
	resetMinimizerGainStatusForTesting,
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
			// estimatedInputTokens: only savings records (savedBytes > 0) contribute.
			// Record 1 (git status):       floor(1000/4) = 250
			// Record 2 (cargo test):       floor(2200/4) = 550
			// Record 3 (git status --short): savedBytes=0 → excluded
			// Record 4 (bun test):         floor(1000/4) = 250
			// Total: 1050
			expect(summary.estimatedInputTokens).toBe(1050);
			// tokensSavedRatio = 483 / 1050
			expect(summary.tokensSavedRatio).toBeCloseTo(483 / 1050, 10);
			expect(summary.byFilter.map(row => row.filter)).toEqual(["cargo", "git", "bun"]);
			expect(summary.byCwd.map(row => row.cwd)).toEqual(["/repo", "/other-repo"]);
			expect(summary.byCwd[0]).toMatchObject({ cwd: "/repo", savedBytes: 2750 });
			expect(summary.byCwd[1]).toMatchObject({ cwd: "/other-repo", savedBytes: 600 });
			// git filter: only Record 1 qualifies (Record 3 savedBytes=0 excluded)
			// estimatedInputTokens = floor(1000/4) = 250; estimatedTokensSaved = 111
			const gitFilter = summary.byFilter.find(r => r.filter === "git")!;
			expect(gitFilter.estimatedInputTokens).toBe(250);
			expect(gitFilter.tokensSavedRatio).toBeCloseTo(111 / 250, 10);
			// byCommand "cargo test": estimatedInputTokens = floor(2200/4) = 550; estimatedTokensSaved = 222
			const cargoCmd = summary.byCommand.find(r => r.command === "cargo test")!;
			expect(cargoCmd.estimatedInputTokens).toBe(550);
			expect(cargoCmd.tokensSavedRatio).toBeCloseTo(222 / 550, 10);

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

	// -------------------------------------------------------------------
	// Diagnostic (gain-slash-remediation T3) + Shape α (T2)
	// -------------------------------------------------------------------

	describe("buildMinimizerGainDiagnostic", () => {
		it("returns zeros for missing records file (empty state)", async () => {
			await withTempAgentDir(async agentDir => {
				resetMinimizerGainStatusForTesting();
				const diag = await buildMinimizerGainDiagnostic({ agentDir });
				expect(diag.recordCount).toBe(0);
				expect(diag.recordCountInScope).toBe(0);
				expect(diag.mostRecentTimestamp).toBeNull();
				expect(diag.recentMissedRatio).toBeNull();
				expect(diag.recentHitRatio).toBeNull();
				expect(diag.avgSavedRatio).toBeNull();
				expect(diag.exists).toBe(false);
				expect(diag.minimizerAppearsInactive).toBe(false);
				// ENOENT is not counted as a read error.
				expect(getMinimizerGainStatus().readErrorCount).toBe(0);
			});
		});

		it("counts saved + missed and computes avgSavedRatio in [0,1]", async () => {
			await withTempAgentDir(async agentDir => {
				resetMinimizerGainStatusForTesting();
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
						filter: "missed",
						inputBytes: 2000,
						outputBytes: 2000,
						savedBytes: 0,
						exitCode: 0,
						kind: "missed",
					},
					{ agentDir },
				);
				const diag = await buildMinimizerGainDiagnostic({ agentDir });
				expect(diag.recordCount).toBe(2);
				expect(diag.savedCount).toBe(1);
				expect(diag.missedCount).toBe(1);
				expect(diag.mostRecentTimestamp).toBe("2026-05-20T00:01:00.000Z");
				expect(diag.avgSavedRatio).toBeCloseTo(0.75, 2);
				expect(diag.avgSavedRatio!).toBeGreaterThanOrEqual(0);
				expect(diag.avgSavedRatio!).toBeLessThanOrEqual(1);
				expect(diag.distinctCwdsCount).toBe(1);
			});
		});

		it("marks minimizer inactive when recentMissedRatio crosses threshold", async () => {
			await withTempAgentDir(async agentDir => {
				resetMinimizerGainStatusForTesting();
				for (let i = 0; i < 50; i++) {
					await recordMinimizerGain(
						{
							timestamp: `2026-05-20T00:${i.toString().padStart(2, "0")}:00.000Z`,
							cwd: "/repo",
							command: "x",
							filter: "missed",
							inputBytes: 100,
							outputBytes: 100,
							savedBytes: 0,
							exitCode: 0,
							kind: "missed",
						},
						{ agentDir },
					);
				}
				const diag = await buildMinimizerGainDiagnostic({ agentDir });
				expect(diag.recentMissedRatio).toBe(1);
				expect(diag.minimizerAppearsInactive).toBe(true);
			});
		});

		it("caps distinctCwdsSample at 10", async () => {
			await withTempAgentDir(async agentDir => {
				resetMinimizerGainStatusForTesting();
				for (let i = 0; i < 12; i++) {
					await recordMinimizerGain(
						{
							timestamp: "2026-05-20T00:00:00.000Z",
							cwd: `/repo-${i}`,
							command: "x",
							filter: "x",
							inputBytes: 10,
							outputBytes: 5,
							savedBytes: 5,
							exitCode: 0,
						},
						{ agentDir },
					);
				}
				const diag = await buildMinimizerGainDiagnostic({ agentDir });
				expect(diag.distinctCwdsCount).toBe(12);
				expect(diag.distinctCwdsSample.length).toBe(10);
			});
		});

		it("tolerates legacy records without kind field", async () => {
			await withTempAgentDir(async agentDir => {
				resetMinimizerGainStatusForTesting();
				const filePath = getMinimizerGainPath(agentDir);
				await fs.mkdir(path.dirname(filePath), { recursive: true });
				await fs.writeFile(
					filePath,
					`${JSON.stringify({
						timestamp: "2026-05-20T00:00:00.000Z",
						cwd: "/repo",
						command: "git status",
						filter: "git",
						inputBytes: 1000,
						outputBytes: 250,
						savedBytes: 750,
						exitCode: 0,
					})}\n`,
				);
				const diag = await buildMinimizerGainDiagnostic({ agentDir });
				expect(diag.recordCount).toBe(1);
				expect(diag.savedCount).toBe(1);
				expect(diag.missedCount).toBe(0);
			});
		});

		it("surfaces parse errors via Shape α counters", async () => {
			await withTempAgentDir(async agentDir => {
				resetMinimizerGainStatusForTesting();
				const filePath = getMinimizerGainPath(agentDir);
				await fs.mkdir(path.dirname(filePath), { recursive: true });
				await fs.writeFile(filePath, "not json\n");
				const diag = await buildMinimizerGainDiagnostic({ agentDir });
				expect(diag.parseErrorCount).toBeGreaterThan(0);
				expect(diag.lastParseError).not.toBeNull();
				expect(diag.lastParseError!.lineNumber).toBe(1);
			});
		});

		it("surfaces write errors via Shape α counters", async () => {
			resetMinimizerGainStatusForTesting();
			// Force a write error by providing an unwritable agentDir path
			// (a regular file used as a directory). This triggers fs.mkdir
			// or fs.appendFile to fail.
			const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gain-werr-"));
			const blocker = path.join(tmp, "blocker");
			await fs.writeFile(blocker, "x");
			try {
				await recordMinimizerGain(
					{
						timestamp: "2026-05-20T00:00:00.000Z",
						cwd: "/repo",
						command: "git",
						filter: "git",
						inputBytes: 10,
						outputBytes: 5,
						savedBytes: 5,
						exitCode: 0,
					},
					// Use the blocker file as agentDir — it's a file, not a
					// directory, so mkdir-as-target fails with ENOTDIR.
					{ agentDir: blocker },
				);
				const status = getMinimizerGainStatus();
				expect(status.writeErrorCount).toBeGreaterThan(0);
				expect(status.lastWriteError).not.toBeNull();
			} finally {
				await fs.rm(tmp, { recursive: true, force: true });
			}
		});
		// -------------------------------------------------------------------
		// summarizeMissedMinimizerGain — contract tests (SlashGainMissedSavings)
		// -------------------------------------------------------------------
		it("summarizeMissedMinimizerGain sorts commands by inputBytes desc and potentialTokenSavings by estimatedPotentialTokensSaved desc", () => {
			// Three distinct command/filter groups.
			//
			//   alpha: 1 hit, inputBytes = 4000
			//     → estimatedPotentialTokensSaved = floor(4000 / 4) = 1000
			//     → avgEstimatedPotentialTokensSaved = floor(1000 / 1) = 1000
			//
			//   beta: 2 hits, inputBytes = 800 + 800 = 1600
			//     → estimatedPotentialTokensSaved = floor(1600 / 4) = 400
			//     → avgEstimatedPotentialTokensSaved = floor(400 / 2) = 200
			//
			//   gamma: 3 hits, inputBytes = 500 + 500 + 500 = 1500
			//     → estimatedPotentialTokensSaved = floor(1500 / 4) = 375
			//     → avgEstimatedPotentialTokensSaved = floor(375 / 3) = 125
			//
			// commands order (by total inputBytes desc): alpha(4000), beta(1600), gamma(1500)
			// potentialTokenSavings order (by estimatedPotentialTokensSaved desc): alpha(1000), beta(400), gamma(375)
			// Both orderings are the same here because inputBytes is monotonic with
			// estimatedPotentialTokensSaved; we assert each array and each computed
			// field individually so any future formula or sort change is caught.
			const base = {
				timestamp: "2026-05-20T00:00:00.000Z",
				cwd: "/repo",
				outputBytes: 0,
				savedBytes: 0,
				exitCode: 0,
				kind: "missed" as const,
			};
			const records: Parameters<typeof summarizeMissedMinimizerGain>[0] = [
				// gamma — 3 occurrences
				{ ...base, command: "gamma-cmd", filter: "gamma", inputBytes: 500 },
				{ ...base, command: "gamma-cmd", filter: "gamma", inputBytes: 500 },
				{ ...base, command: "gamma-cmd", filter: "gamma", inputBytes: 500 },
				// beta — 2 occurrences
				{ ...base, command: "beta-cmd", filter: "beta", inputBytes: 800 },
				{ ...base, command: "beta-cmd", filter: "beta", inputBytes: 800 },
				// alpha — 1 occurrence
				{ ...base, command: "alpha-cmd", filter: "alpha", inputBytes: 4000 },
			];
			const missed = summarizeMissedMinimizerGain(records);
			// commands — sorted by total inputBytes descending
			expect(missed.commands.map(c => c.command)).toEqual(["alpha-cmd", "beta-cmd", "gamma-cmd"]);
			// alpha group: exact field values
			const alphaCmd = missed.commands[0];
			expect(alphaCmd.command).toBe("alpha-cmd");
			expect(alphaCmd.filter).toBe("alpha");
			expect(alphaCmd.commands).toBe(1);
			expect(alphaCmd.inputBytes).toBe(4000);
			expect(alphaCmd.estimatedPotentialTokensSaved).toBe(1000); // floor(4000 / 4)
			expect(alphaCmd.avgEstimatedPotentialTokensSaved).toBe(1000); // floor(1000 / 1)
			// beta group
			const betaCmd = missed.commands[1];
			expect(betaCmd.command).toBe("beta-cmd");
			expect(betaCmd.commands).toBe(2);
			expect(betaCmd.inputBytes).toBe(1600);
			expect(betaCmd.estimatedPotentialTokensSaved).toBe(400); // floor(1600 / 4)
			expect(betaCmd.avgEstimatedPotentialTokensSaved).toBe(200); // floor(400 / 2)
			// gamma group
			const gammaCmd = missed.commands[2];
			expect(gammaCmd.command).toBe("gamma-cmd");
			expect(gammaCmd.commands).toBe(3);
			expect(gammaCmd.inputBytes).toBe(1500);
			expect(gammaCmd.estimatedPotentialTokensSaved).toBe(375); // floor(1500 / 4)
			expect(gammaCmd.avgEstimatedPotentialTokensSaved).toBe(125); // floor(375 / 3)
			// potentialTokenSavings — sorted by estimatedPotentialTokensSaved descending
			expect(missed.potentialTokenSavings.map(c => c.command)).toEqual(["alpha-cmd", "beta-cmd", "gamma-cmd"]);
			// Verify the sort key values match expected ordering
			const pts = missed.potentialTokenSavings;
			expect(pts[0].estimatedPotentialTokensSaved).toBe(1000);
			expect(pts[1].estimatedPotentialTokensSaved).toBe(400);
			expect(pts[2].estimatedPotentialTokensSaved).toBe(375);
			// avgEstimatedPotentialTokensSaved in potentialTokenSavings array
			expect(pts[0].avgEstimatedPotentialTokensSaved).toBe(1000);
			expect(pts[1].avgEstimatedPotentialTokensSaved).toBe(200);
			expect(pts[2].avgEstimatedPotentialTokensSaved).toBe(125);
		});
		it("buildMinimizerGainDiagnostic recentHitRatio and recentMissedRatio use timestamp-sorted last-50 window, not file-append order", async () => {
			// Strategy: write 55 records in scope where 5 misses have OLD timestamps
			// and 50 hits have NEWER timestamps, but append the misses to the file LAST
			// so they are at the tail in file/append order.
			//
			// Correct behaviour (sort by timestamp, then slice(-50)):
			//   sorted order = [miss×5 (old timestamps), hit×50 (new timestamps)]
			//   last-50 window = hit×50 → recentHitRatio = 1, recentMissedRatio = 0
			//
			// Wrong behaviour (slice(-50) without sort, i.e. last 50 appended):
			//   last 50 file entries = hit×45 + miss×5 → recentHitRatio = 0.9, recentMissedRatio = 0.1
			//
			// By asserting recentHitRatio === 1 we prove the impl sorts first.
			await withTempAgentDir(async agentDir => {
				resetMinimizerGainStatusForTesting();
				const cwd = "/ts-sort-test-repo";
				// Write 50 hits with timestamps T+1..T+50 (newer)
				for (let i = 1; i <= 50; i++) {
					// Use hours to keep minute in 00-59 range
					const hour = Math.floor(i / 60)
						.toString()
						.padStart(2, "0");
					const min = (i % 60).toString().padStart(2, "0");
					await recordMinimizerGain(
						{
							timestamp: `2026-05-20T${hour}:${min}:01.000Z`,
							cwd,
							command: "hit-cmd",
							filter: "hit",
							inputBytes: 100,
							outputBytes: 50,
							savedBytes: 50,
							exitCode: 0,
						},
						{ agentDir },
					);
				}
				// Append 5 misses with OLD timestamps (T-1..T-5) — these land at the
				// end of the file but belong before all hits in timestamp order.
				for (let i = 1; i <= 5; i++) {
					await recordMinimizerGain(
						{
							timestamp: `2026-05-19T23:5${i}:00.000Z`,
							cwd,
							command: "old-miss-cmd",
							filter: "missed",
							inputBytes: 200,
							outputBytes: 200,
							savedBytes: 0,
							exitCode: 1,
							kind: "missed",
						},
						{ agentDir },
					);
				}
				const diag = await buildMinimizerGainDiagnostic({ agentDir, cwd });
				// 55 total in scope
				expect(diag.recordCountInScope).toBe(55);
				// The window is computed on the last 50 by timestamp.
				// Since the 5 misses have timestamps earlier than all 50 hits,
				// the last-50 by timestamp are the 50 hits exclusively.
				expect(diag.recentHitRatio).toBe(1);
				expect(diag.recentMissedRatio).toBe(0);
				expect(diag.minimizerAppearsInactive).toBe(false);
			});
		});
	});

	// -------------------------------------------------------------------
	// tokensSavedRatio contract tests
	// -------------------------------------------------------------------
	describe("tokensSavedRatio contract", () => {
		it("computes estimatedInputTokens and tokensSavedRatio from savings records only", () => {
			// inputBytes=1000 → estimatedInputTokens=floor(1000/4)=250
			// savedTokens=150 → estimatedTokensSaved=150
			// tokensSavedRatio = 150 / 250 = 0.6
			const records: Parameters<typeof summarizeMinimizerGain>[0] = [
				{
					timestamp: "2026-05-20T00:00:00.000Z",
					cwd: "/repo",
					command: "bash",
					filter: "bash",
					inputBytes: 1000,
					outputBytes: 400,
					savedBytes: 600,
					savedTokens: 150,
					exitCode: 0,
				},
			];
			const summary = summarizeMinimizerGain(records);
			expect(summary.estimatedInputTokens).toBe(250); // floor(1000/4)
			expect(summary.estimatedTokensSaved).toBe(150);
			expect(summary.tokensSavedRatio).toBeCloseTo(150 / 250, 10); // 0.6
		});

		it("tokensSavedRatio = null when estimatedInputTokens is 0 (no savings records)", () => {
			// Only zero-savings records: savedBytes=0 → excluded from estimatedInputTokens
			const records: Parameters<typeof summarizeMinimizerGain>[0] = [
				{
					timestamp: "2026-05-20T00:00:00.000Z",
					cwd: "/repo",
					command: "noop",
					filter: "noop",
					inputBytes: 500,
					outputBytes: 500,
					savedBytes: 0,
					exitCode: 0,
					kind: "saved",
				},
			];
			const summary = summarizeMinimizerGain(records);
			expect(summary.estimatedInputTokens).toBe(0);
			expect(summary.tokensSavedRatio).toBeNull();
		});

		it("tokensSavedRatio = null for empty record set", () => {
			const summary = summarizeMinimizerGain([]);
			expect(summary.estimatedInputTokens).toBe(0);
			expect(summary.tokensSavedRatio).toBeNull();
		});

		it("byCommand and byFilter rows carry correct estimatedInputTokens and tokensSavedRatio", () => {
			// Two commands, two filters.
			// cmd-a: inputBytes=800, savedTokens=100 → estimatedInputTokens=200, ratio=100/200=0.5
			// cmd-b: inputBytes=400, savedTokens=50  → estimatedInputTokens=100, ratio=50/100=0.5
			// filter-x (cmd-a): estimatedInputTokens=200, tokensSavedRatio=100/200=0.5
			// filter-y (cmd-b): estimatedInputTokens=100, tokensSavedRatio=50/100=0.5
			const base = {
				timestamp: "2026-05-20T00:00:00.000Z",
				cwd: "/repo",
				outputBytes: 0,
				exitCode: 0,
			};
			const records: Parameters<typeof summarizeMinimizerGain>[0] = [
				{ ...base, command: "cmd-a", filter: "filter-x", inputBytes: 800, savedBytes: 800, savedTokens: 100 },
				{ ...base, command: "cmd-b", filter: "filter-y", inputBytes: 400, savedBytes: 400, savedTokens: 50 },
			];
			const summary = summarizeMinimizerGain(records);
			// Overall
			expect(summary.estimatedInputTokens).toBe(300); // 200 + 100
			expect(summary.estimatedTokensSaved).toBe(150); // 100 + 50
			expect(summary.tokensSavedRatio).toBeCloseTo(150 / 300, 10); // 0.5
			// byCommand
			const cmdA = summary.byCommand.find(r => r.command === "cmd-a")!;
			expect(cmdA.estimatedInputTokens).toBe(200); // floor(800/4)
			expect(cmdA.tokensSavedRatio).toBeCloseTo(100 / 200, 10); // 0.5
			const cmdB = summary.byCommand.find(r => r.command === "cmd-b")!;
			expect(cmdB.estimatedInputTokens).toBe(100); // floor(400/4)
			expect(cmdB.tokensSavedRatio).toBeCloseTo(50 / 100, 10); // 0.5
			// byFilter
			const filterX = summary.byFilter.find(r => r.filter === "filter-x")!;
			expect(filterX.estimatedInputTokens).toBe(200);
			expect(filterX.tokensSavedRatio).toBeCloseTo(100 / 200, 10);
			const filterY = summary.byFilter.find(r => r.filter === "filter-y")!;
			expect(filterY.estimatedInputTokens).toBe(100);
			expect(filterY.tokensSavedRatio).toBeCloseTo(50 / 100, 10);
		});

		it("tokensSavedRatio uses floor(inputBytes/4) for estimatedInputTokens, not raw division", () => {
			// inputBytes=10 → floor(10/4)=2 (not 2.5)
			// savedTokens=1 → estimatedTokensSaved=1
			// tokensSavedRatio = 1/2 = 0.5
			const records: Parameters<typeof summarizeMinimizerGain>[0] = [
				{
					timestamp: "2026-05-20T00:00:00.000Z",
					cwd: "/repo",
					command: "tiny",
					filter: "tiny",
					inputBytes: 10,
					outputBytes: 8,
					savedBytes: 2,
					savedTokens: 1,
					exitCode: 0,
				},
			];
			const summary = summarizeMinimizerGain(records);
			expect(summary.estimatedInputTokens).toBe(2); // floor(10/4), not 2.5
			expect(summary.tokensSavedRatio).toBeCloseTo(1 / 2, 10);
		});
	});
});
