import * as path from "node:path";
import { APP_NAME, formatNumber } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import {
	discoverMinimizerGain,
	getMinimizerGainPath,
	type MinimizerGainDiscovery,
	type MinimizerGainSummary,
	readMinimizerGain,
	summarizeMinimizerGain,
} from "../minimizer-gain";

export interface GainCommandArgs {
	json: boolean;
	days: number;
	cwd?: string;
	all: boolean;
	discover: boolean;
}

type GainRow = {
	commands: number;
	savedBytes: number;
	estimatedTokensSaved: number;
};

export async function runGainCommand(cmd: GainCommandArgs): Promise<void> {
	validateDays(cmd.days);

	const cwd = resolveCwdScope(cmd);
	const records = await readMinimizerGain({ sinceDays: cmd.days, cwd });
	const summary = summarizeMinimizerGain(records);
	const gainPath = getMinimizerGainPath();

	if (cmd.json) {
		process.stdout.write(`${JSON.stringify(buildGainPayload(gainPath, records, summary, cmd.discover), null, 2)}\n`);
		return;
	}

	if (cmd.discover) {
		printGainDiscovery({
			path: gainPath,
			days: cmd.days,
			cwd,
			all: cmd.all,
			discovery: discoverMinimizerGain(records),
		});
		return;
	}

	printGainSummary({ path: gainPath, days: cmd.days, cwd, all: cmd.all, summary });
}

function validateDays(days: number): void {
	if (Number.isInteger(days) && days >= 1) return;
	process.stderr.write(chalk.red("error: --days must be a positive integer\n"));
	process.exit(1);
}

function resolveCwdScope(cmd: GainCommandArgs): string | undefined {
	if (cmd.all) return undefined;
	return cmd.cwd ? path.resolve(cmd.cwd) : process.cwd();
}

function buildGainPayload(
	path: string,
	records: unknown[],
	summary: MinimizerGainSummary,
	includeDiscovery: boolean,
): object {
	return includeDiscovery
		? {
				path,
				records,
				summary,
				discovery: discoverMinimizerGain(records as Parameters<typeof discoverMinimizerGain>[0]),
			}
		: { path, records, summary };
}

function printGainSummary(input: {
	path: string;
	days: number;
	cwd: string | undefined;
	all: boolean;
	summary: MinimizerGainSummary;
}): void {
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
	process.stdout.write(`\n${chalk.bold("Scope:")} ${formatScope(input)}\n`);
	process.stdout.write(`${chalk.bold("Path:")} ${input.path}\n\n`);
}

function printGainDiscovery(input: {
	path: string;
	days: number;
	cwd: string | undefined;
	all: boolean;
	discovery: MinimizerGainDiscovery;
}): void {
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
	process.stdout.write(`\n${chalk.bold("Scope:")} ${formatScope(input)}\n`);
	process.stdout.write(`${chalk.bold("Path:")} ${input.path}\n\n`);
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
