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

	// -------------------------------------------------------------------
	// Missed summary — potentialTokenSavings view and sorting
	// -------------------------------------------------------------------

	it("summarizeMissedMinimizerGain returns both commands and potentialTokenSavings views", () => {
		// cargo test: 3 runs × 8000 bytes each = 24000 bytes → floor(24000/4)=6000 potential tokens
		// git diff:   2 runs × 4000 bytes each =  8000 bytes → floor( 8000/4)=2000 potential tokens
		// commands view sorted by inputBytes desc → cargo test first
		// potentialTokenSavings view sorted by estimatedPotentialTokensSaved desc → cargo test first (same order here)
		const records: import("../src/minimizer-gain").MinimizerGainRecord[] = [
			{
				timestamp: "2026-05-20T00:00:00.000Z",
				cwd: "/repo",
				command: "cargo test",
				filter: "missed",
				inputBytes: 8000,
				outputBytes: 8000,
				savedBytes: 0,
				exitCode: 0,
				kind: "missed",
			},
			{
				timestamp: "2026-05-20T00:01:00.000Z",
				cwd: "/repo",
				command: "cargo test",
				filter: "missed",
				inputBytes: 8000,
				outputBytes: 8000,
				savedBytes: 0,
				exitCode: 1,
				kind: "missed",
			},
			{
				timestamp: "2026-05-20T00:02:00.000Z",
				cwd: "/repo",
				command: "cargo test",
				filter: "missed",
				inputBytes: 8000,
				outputBytes: 8000,
				savedBytes: 0,
				exitCode: 0,
				kind: "missed",
			},
			{
				timestamp: "2026-05-20T00:03:00.000Z",
				cwd: "/repo",
				command: "git diff",
				filter: "missed",
				inputBytes: 4000,
				outputBytes: 4000,
				savedBytes: 0,
				exitCode: 0,
				kind: "missed",
			},
			{
				timestamp: "2026-05-20T00:04:00.000Z",
				cwd: "/repo",
				command: "git diff",
				filter: "missed",
				inputBytes: 4000,
				outputBytes: 4000,
				savedBytes: 0,
				exitCode: 0,
				kind: "missed",
			},
		];

		const summary = summarizeMissedMinimizerGain(records);

		// commands view: sorted by inputBytes desc
		expect(summary.commands[0]!.command).toBe("cargo test");
		expect(summary.commands[0]!.commands).toBe(3);
		expect(summary.commands[0]!.inputBytes).toBe(24000);
		expect(summary.commands[0]!.estimatedPotentialTokensSaved).toBe(6000);
		expect(summary.commands[0]!.avgEstimatedPotentialTokensSaved).toBe(2000);

		expect(summary.commands[1]!.command).toBe("git diff");
		expect(summary.commands[1]!.commands).toBe(2);
		expect(summary.commands[1]!.inputBytes).toBe(8000);
		expect(summary.commands[1]!.estimatedPotentialTokensSaved).toBe(2000);
		expect(summary.commands[1]!.avgEstimatedPotentialTokensSaved).toBe(1000);

		// potentialTokenSavings view: sorted by estimatedPotentialTokensSaved desc — same order
		expect(summary.potentialTokenSavings[0]!.command).toBe("cargo test");
		expect(summary.potentialTokenSavings[0]!.estimatedPotentialTokensSaved).toBe(6000);
		expect(summary.potentialTokenSavings[1]!.command).toBe("git diff");
		expect(summary.potentialTokenSavings[1]!.estimatedPotentialTokensSaved).toBe(2000);
	});

	it("summarizeMissedMinimizerGain potentialTokenSavings sorts by impact not count", () => {
		// high-count low-bytes vs low-count high-bytes
		// many-small: 10 runs × 100 bytes = 1000 bytes → 250 potential tokens
		// few-large:   2 runs × 800 bytes = 1600 bytes → 400 potential tokens
		// potentialTokenSavings must put few-large first
		const records: import("../src/minimizer-gain").MinimizerGainRecord[] = [];
		for (let i = 0; i < 10; i++) {
			records.push({
				timestamp: `2026-05-20T00:${String(i).padStart(2, "0")}:00.000Z`,
				cwd: "/repo",
				command: "many-small",
				filter: "missed",
				inputBytes: 100,
				outputBytes: 100,
				savedBytes: 0,
				exitCode: 0,
				kind: "missed",
			});
		}
		for (let i = 0; i < 2; i++) {
			records.push({
				timestamp: `2026-05-20T00:${String(i + 10).padStart(2, "0")}:00.000Z`,
				cwd: "/repo",
				command: "few-large",
				filter: "missed",
				inputBytes: 800,
				outputBytes: 800,
				savedBytes: 0,
				exitCode: 0,
				kind: "missed",
			});
		}

		const summary = summarizeMissedMinimizerGain(records);

		// commands view: many-small first (1000 > 800 total inputBytes per run × count)
		// Wait: many-small total=1000 bytes, few-large total=1600 bytes
		// commands view (by inputBytes desc): few-large=1600 first
		expect(summary.commands[0]!.command).toBe("few-large");
		// potentialTokenSavings view: few-large 400 > many-small 250
		expect(summary.potentialTokenSavings[0]!.command).toBe("few-large");
		expect(summary.potentialTokenSavings[0]!.estimatedPotentialTokensSaved).toBe(400); // floor(1600/4)
		expect(summary.potentialTokenSavings[1]!.command).toBe("many-small");
		expect(summary.potentialTokenSavings[1]!.estimatedPotentialTokensSaved).toBe(250); // floor(1000/4)
	});

	// -------------------------------------------------------------------
	// Token savings ratio (% tokens saved)
	// -------------------------------------------------------------------

	it("summarizeMinimizerGain computes tokensSavedRatio = estimatedTokensSaved / estimatedInputTokens", () => {
		// 1 record: inputBytes=1000, savedBytes=750, savedTokens=undefined
		// estimatedInputTokens = floor(1000/4) = 250
		// estimatedTokensSaved = floor(750/4) = 187
		// tokensSavedRatio = 187/250 = 0.748
		const records: import("../src/minimizer-gain").MinimizerGainRecord[] = [
			{
				timestamp: "2026-05-20T00:00:00.000Z",
				cwd: "/repo",
				command: "git diff",
				filter: "git",
				inputBytes: 1000,
				outputBytes: 250,
				savedBytes: 750,
				exitCode: 0,
				kind: "saved",
			},
		];
		const summary = summarizeMinimizerGain(records);
		expect(summary.estimatedInputTokens).toBe(250);
		expect(summary.tokensSavedRatio).not.toBeNull();
		expect(summary.tokensSavedRatio!).toBeCloseTo(187 / 250, 5);
	});

	it("summarizeMinimizerGain tokensSavedRatio is null when no savings records", () => {
		const summary = summarizeMinimizerGain([]);
		expect(summary.tokensSavedRatio).toBeNull();
		expect(summary.estimatedInputTokens).toBe(0);
	});

	// -------------------------------------------------------------------
	// Diagnostic — recentHitRatio + timestamp-sorted window
	// -------------------------------------------------------------------

	it("buildMinimizerGainDiagnostic computes recentHitRatio = saved/(saved+missed) over last 50", async () => {
		await withTempAgentDir(async agentDir => {
			resetMinimizerGainStatusForTesting();
			// Write 40 missed then 10 saved — sorted by timestamp last 50 → 10 saved, 40 missed
			for (let i = 0; i < 40; i++) {
				await recordMinimizerGain(
					{
						timestamp: `2026-05-20T00:${String(i).padStart(2, "0")}:00.000Z`,
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
			for (let i = 0; i < 10; i++) {
				await recordMinimizerGain(
					{
						timestamp: `2026-05-20T01:${String(i).padStart(2, "0")}:00.000Z`,
						cwd: "/repo",
						command: "git status",
						filter: "git",
						inputBytes: 100,
						outputBytes: 30,
						savedBytes: 70,
						exitCode: 0,
						kind: "saved",
					},
					{ agentDir },
				);
			}
			const diag = await buildMinimizerGainDiagnostic({ agentDir });
			// window = last 50 records (timestamp-sorted): 40 missed + 10 saved
			expect(diag.recentMissedRatio).toBeCloseTo(0.8, 5); // 40/50
			expect(diag.recentHitRatio).toBeCloseTo(0.2, 5); // 10/50
			expect(diag.recentMissedRatio! + diag.recentHitRatio!).toBeCloseTo(1.0, 5);
		});
	});

	it("buildMinimizerGainDiagnostic recentHitRatio is null when fewer than 50 scoped records", async () => {
		await withTempAgentDir(async agentDir => {
			resetMinimizerGainStatusForTesting();
			await recordMinimizerGain(
				{
					timestamp: "2026-05-20T00:00:00.000Z",
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
			const diag = await buildMinimizerGainDiagnostic({ agentDir });
			expect(diag.recentHitRatio).toBeNull();
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
	});
});
