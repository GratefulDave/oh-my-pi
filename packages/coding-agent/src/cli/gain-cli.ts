import * as path from "node:path";
import { APP_NAME, formatNumber } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import {
	buildMinimizerGainDiagnostic,
	discoverMinimizerGain,
	getMinimizerGainPath,
	type MinimizerGainDiagnostic,
	type MinimizerGainDiscovery,
	type MinimizerGainRecord,
	type MinimizerGainSummary,
	type MinimizerMissedSummary,
	readMinimizerGain,
	resolveMinimizerGainCwd,
	summarizeMinimizerGain,
	summarizeMissedMinimizerGain,
} from "../minimizer-gain";

export interface GainCommandArgs {
	json: boolean;
	days: number;
	cwd?: string;
	all: boolean;
	discover: boolean;
	missed: boolean;
	diag: boolean;
}

type OutputMode = "json" | "missed" | "discover" | "summary" | "diag" | "diag-json";

type GainRow = {
	commands: number;
	savedBytes: number;
	estimatedTokensSaved: number;
	usesEstimatedTokensSaved: boolean;
	tokensSavedRatio: number | null;
	estimatedInputTokens: number;
};

type GainContext = {
	path: string;
	days: number;
	cwd: string | undefined;
	all: boolean;
	records: MinimizerGainRecord[];
	summary: MinimizerGainSummary;
	discovery: MinimizerGainDiscovery;
	missed: MinimizerMissedSummary;
};

export async function runGainCommand(cmd: GainCommandArgs): Promise<void> {
	validateDays(cmd.days);
	const mode = selectOutputMode(cmd);
	if (mode === "diag" || mode === "diag-json") {
		const cwd = await resolveCwdScope(cmd);
		const diagnostic = await buildMinimizerGainDiagnostic({
			cwd,
			days: cmd.days,
		});
		writeDiagnosticOutput(mode, diagnostic);
		exitCodeForDiagnostic(diagnostic);
		return;
	}
	writeGainOutput(mode, await loadGainContext(cmd));
}

function exitCodeForDiagnostic(diag: MinimizerGainDiagnostic): void {
	if (diag.writeErrorCount > 0 || diag.readErrorCount > 0 || !diag.minimizerEnabled || !diag.nativeBindingLoaded) {
		process.exit(1);
	}
}

function writeDiagnosticOutput(mode: "diag" | "diag-json", diagnostic: MinimizerGainDiagnostic): void {
	if (mode === "diag-json") {
		process.stdout.write(`${JSON.stringify(diagnostic, null, 2)}\n`);
		return;
	}
	process.stdout.write(chalk.bold(`\n=== ${APP_NAME} Minimizer Gain — Diagnostic ===\n\n`));
	process.stdout.write(`  Records File: ${diagnostic.recordsFilePath}\n`);
	process.stdout.write(`  Exists: ${diagnostic.exists}\n`);
	process.stdout.write(`  File Size: ${formatNumber(diagnostic.fileSizeBytes)} bytes\n`);
	process.stdout.write(`  mtime: ${diagnostic.mtime ?? "-"}\n`);
	process.stdout.write(`  Record Count (file-wide): ${formatNumber(diagnostic.recordCount)}\n`);
	process.stdout.write(`  Record Count (in scope): ${formatNumber(diagnostic.recordCountInScope)}\n`);
	process.stdout.write(`  Saved Records: ${formatNumber(diagnostic.savedCount)}\n`);
	process.stdout.write(`  Missed Records: ${formatNumber(diagnostic.missedCount)}\n`);
	process.stdout.write(`  Most Recent Timestamp: ${diagnostic.mostRecentTimestamp ?? "-"}\n`);
	process.stdout.write(
		`  Recent Missed Ratio (last 50): ${diagnostic.recentMissedRatio === null ? "-" : diagnostic.recentMissedRatio.toFixed(3)}\n`,
	);
	process.stdout.write(
		`  Recent Hit Ratio (last 50): ${diagnostic.recentHitRatio === null ? "-" : diagnostic.recentHitRatio.toFixed(3)}\n`,
	);
	process.stdout.write(`  Minimizer Appears Inactive: ${diagnostic.minimizerAppearsInactive}\n`);
	process.stdout.write(
		`  Avg Saved Ratio: ${diagnostic.avgSavedRatio === null ? "-" : diagnostic.avgSavedRatio.toFixed(3)}\n`,
	);
	process.stdout.write(`  Load Duration: ${diagnostic.loadDurationMs}ms\n`);
	process.stdout.write(`  Write Errors: ${diagnostic.writeErrorCount}\n`);
	if (diagnostic.lastWriteError) {
		process.stdout.write(`    last: ${diagnostic.lastWriteError.error} @ ${diagnostic.lastWriteError.at}\n`);
	}
	process.stdout.write(`  Read Errors: ${diagnostic.readErrorCount}\n`);
	if (diagnostic.lastReadError) {
		process.stdout.write(`    last: ${diagnostic.lastReadError.error} @ ${diagnostic.lastReadError.at}\n`);
	}
	process.stdout.write(`  Parse Errors: ${diagnostic.parseErrorCount}\n`);
	if (diagnostic.lastParseError) {
		process.stdout.write(
			`    last: ${diagnostic.lastParseError.error} (line ${diagnostic.lastParseError.lineNumber}) @ ${diagnostic.lastParseError.at}\n`,
		);
	}
	process.stdout.write(`  Minimizer Enabled: ${diagnostic.minimizerEnabled}\n`);
	process.stdout.write(`  Native Binding Loaded: ${diagnostic.nativeBindingLoaded}\n`);
	process.stdout.write(`  CWD Filter: ${diagnostic.cwdFilter ?? "(all)"}\n`);
	process.stdout.write(`  Distinct CWDs Seen: ${formatNumber(diagnostic.distinctCwdsCount)}\n`);
	if (diagnostic.distinctCwdsSample.length > 0) {
		process.stdout.write(`  Distinct CWDs Sample:\n`);
		for (const cwd of diagnostic.distinctCwdsSample) {
			process.stdout.write(`    ${cwd}\n`);
		}
	}
}
function validateDays(days: number): void {
	if (Number.isInteger(days) && days >= 1) return;
	process.stderr.write(chalk.red("error: --days must be a positive integer\n"));
	process.exit(1);
}

function selectOutputMode(cmd: GainCommandArgs): OutputMode {
	if (cmd.diag) return cmd.json ? "diag-json" : "diag";
	if (cmd.json) return "json";
	if (cmd.missed) return "missed";
	if (cmd.discover) return "discover";
	return "summary";
}

function writeGainOutput(mode: OutputMode, context: GainContext): void {
	switch (mode) {
		case "json":
			printJsonPayload(context);
			break;
		case "summary":
			printGainSummary(context);
			break;
		case "discover":
			printGainDiscovery(context);
			break;
		case "missed":
			printMissedSummary(context);
			break;
		case "diag":
		case "diag-json":
			// Handled before writeGainOutput in runGainCommand; this arm
			// exists only to keep the exhaustiveness check happy.
			break;
	}
}

async function loadGainContext(cmd: GainCommandArgs): Promise<GainContext> {
	const cwd = await resolveCwdScope(cmd);
	const records = await readMinimizerGain({ sinceDays: cmd.days, cwd });
	return {
		path: getMinimizerGainPath(),
		days: cmd.days,
		cwd,
		all: cmd.all,
		records,
		summary: summarizeMinimizerGain(records),
		discovery: discoverMinimizerGain(records),
		missed: summarizeMissedMinimizerGain(records),
	};
}
async function resolveCwdScope(cmd: GainCommandArgs): Promise<string | undefined> {
	if (cmd.all) return undefined;
	return resolveMinimizerGainCwd(cmd.cwd ? path.resolve(cmd.cwd) : process.cwd());
}

function printJsonPayload(context: GainContext): void {
	process.stdout.write(
		`${JSON.stringify(
			{
				path: context.path,
				records: context.records,
				summary: context.summary,
				discovery: context.discovery,
				missed: context.missed,
			},
			null,
			2,
		)}\n`,
	);
}

function printGainSummary(input: GainContext): void {
	const { summary } = input;
	process.stdout.write(chalk.bold(`\n=== ${APP_NAME} Minimizer Gain ===\n\n`));

	process.stdout.write(chalk.bold("Summary:\n"));
	process.stdout.write(`  Commands: ${formatNumber(summary.commands)}\n`);
	process.stdout.write(`  Input Bytes: ${formatNumber(summary.inputBytes)}\n`);
	process.stdout.write(`  Output Bytes: ${formatNumber(summary.outputBytes)}\n`);
	process.stdout.write(`  Saved Bytes: ${formatNumber(summary.savedBytes)}\n`);
	process.stdout.write(
		`  ${formatTokensSavedLabel(summary.usesEstimatedTokensSaved)}: ${formatNumber(summary.estimatedTokensSaved)} (${formatTokensSavedPercent(summary.tokensSavedRatio)})\n`,
	);

	printRows("Top Filters", summary.byFilter, row => row.filter);
	printRows("Top Commands", summary.byCommand, row => row.command);
	printRows("Repositories", summary.byCwd, row => row.cwd);
	printScope(input);
}

function printGainDiscovery(input: GainContext): void {
	process.stdout.write(chalk.bold(`\n=== ${APP_NAME} Minimizer Discovery ===\n\n`));
	if (input.discovery.commands.length === 0) {
		process.stdout.write("No native minimizer savings recorded for this scope yet.\n");
	} else {
		process.stdout.write(chalk.bold("Highest observed savings by command:\n"));
		for (const row of input.discovery.commands) {
			process.stdout.write(
				`  ${row.command}: ${formatNumber(row.savedBytes)} bytes saved (${formatNumber(row.avgSavedBytes)} avg), ${formatNumber(row.commands)} cmds, filter=${row.filter}\n`,
			);
		}
	}
	printScope(input);
}

function printMissedSummary(input: GainContext): void {
	process.stdout.write(chalk.bold(`\n=== ${APP_NAME} Minimizer Misses ===\n\n`));
	if (input.missed.commands.length === 0) {
		process.stdout.write("No unminimized shell output recorded for this scope yet.\n");
	} else {
		process.stdout.write(chalk.bold("Largest unminimized command outputs:\n"));
		for (const row of input.missed.commands) {
			process.stdout.write(
				`  ${row.command}: ${formatNumber(row.inputBytes)} bytes total (${formatNumber(row.avgInputBytes)} avg), ${formatNumber(row.commands)} cmds, exit=${formatExitCodes(row.exitCodes)}\n`,
			);
		}
		process.stdout.write(chalk.bold("\nHighest potential token savings:\n"));
		for (const row of input.missed.potentialTokenSavings) {
			process.stdout.write(
				`  ${row.command}: ${formatNumber(row.estimatedPotentialTokensSaved)} tokens total (${formatNumber(row.avgEstimatedPotentialTokensSaved)} avg), ${formatNumber(row.commands)} cmds, exit=${formatExitCodes(row.exitCodes)}\n`,
			);
		}
	}
	printScope(input);
}

function printScope(input: Pick<GainContext, "days" | "cwd" | "all" | "path">): void {
	process.stdout.write(`\n${chalk.bold("Scope:")} ${formatScope(input)}\n`);
	process.stdout.write(`${chalk.bold("Path:")} ${input.path}\n\n`);
}

function formatExitCodes(exitCodes: Array<number | null>): string {
	if (exitCodes.length === 0) return "-";
	return exitCodes.map(code => (code === null ? "null" : String(code))).join(",");
}

function formatTokensSavedLabel(usesEstimatedTokensSaved: boolean): string {
	return usesEstimatedTokensSaved ? "Estimated Tokens Saved" : "Tokens Saved";
}

function formatTokensSavedPercent(ratio: number | null): string {
	if (ratio === null) return "-";
	return `${(ratio * 100).toFixed(1)}%`;
}

function formatScope(input: { days: number; cwd: string | undefined; all: boolean }): string {
	const window = `${formatNumber(input.days)} day${input.days === 1 ? "" : "s"}`;
	if (input.all) return `all working directories, last ${window}`;
	return `${input.cwd ?? process.cwd()}, last ${window}`;
}

function printRows<T extends GainRow>(title: string, rows: T[], label: (row: T) => string): void {
	process.stdout.write(chalk.bold(`\n${title}:\n`));
	if (rows.length === 0) {
		process.stdout.write("  (none)\n");
		return;
	}
	for (const row of rows.slice(0, 10)) {
		process.stdout.write(
			`  ${label(row)}: ${formatNumber(row.commands)} cmds, ${formatNumber(row.savedBytes)} bytes saved, ${formatNumber(row.estimatedTokensSaved)} ${formatTokensSavedLabel(row.usesEstimatedTokensSaved)} (${formatTokensSavedPercent(row.tokensSavedRatio)})\n`,
		);
	}
}
