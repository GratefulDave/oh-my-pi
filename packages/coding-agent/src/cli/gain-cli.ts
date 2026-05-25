import * as path from "node:path";
import { APP_NAME, formatNumber } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import {
	discoverMinimizerGain,
	getMinimizerGainPath,
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
}

type OutputMode = "json" | "missed" | "discover" | "summary";

type GainRow = {
	commands: number;
	savedBytes: number;
	estimatedTokensSaved: number;
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
	writeGainOutput(selectOutputMode(cmd), await loadGainContext(cmd));
}
function validateDays(days: number): void {
	if (Number.isInteger(days) && days >= 1) return;
	process.stderr.write(chalk.red("error: --days must be a positive integer\n"));
	process.exit(1);
}

function selectOutputMode(cmd: GainCommandArgs): OutputMode {
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
	process.stdout.write(`  Estimated Tokens Saved: ${formatNumber(summary.estimatedTokensSaved)}\n`);

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
			`  ${label(row)}: ${formatNumber(row.commands)} cmds, ${formatNumber(row.savedBytes)} bytes saved, ${formatNumber(row.estimatedTokensSaved)} tokens\n`,
		);
	}
}
