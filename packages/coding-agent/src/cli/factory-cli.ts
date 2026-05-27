import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline/promises";

import { COMMAND_NAME, getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";
import chalk from "chalk";

import { runFactoryDoctor } from "../factory/doctor";
import {
	applyFactoryScaffold,
	buildFactoryScaffoldPlan,
	type FactoryPreset,
	inspectFactoryRepo,
} from "../factory/scaffold";
import { getSoftwareFactoryManifest } from "../factory/template-manifest";
import { theme } from "../modes/theme/theme";

export type FactoryAction = "init" | "status" | "doctor";

export interface FactoryCommandArgs {
	action: FactoryAction;
	flags: {
		preset?: FactoryPreset;
		dryRun?: boolean;
		json?: boolean;
		yes?: boolean;
		existing?: boolean;
		force?: boolean;
		enableMemory?: boolean;
	};
}

function writeStdout(line: string): void {
	process.stdout.write(`${line}\n`);
}

async function exists(targetPath: string): Promise<boolean> {
	try {
		await fs.stat(targetPath);
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

async function confirmApply(planSummary: string): Promise<boolean> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await rl.question(`${planSummary}\nProceed? [y/N] `);
		return /^(y|yes)$/i.test(answer.trim());
	} finally {
		rl.close();
	}
}

async function handleInit(flags: FactoryCommandArgs["flags"]): Promise<void> {
	const cwd = process.cwd();
	const plan = await buildFactoryScaffoldPlan({
		cwd,
		preset: flags.preset ?? "standard",
		dryRun: flags.dryRun ?? false,
		existing: flags.existing ?? false,
		force: flags.force ?? false,
		enableMemory: flags.enableMemory ?? false,
	});
	if (flags.json) {
		writeStdout(`${JSON.stringify(plan, null, 2)}`);
		return;
	}
	writeStdout(chalk.bold(`Software factory preset: ${plan.preset}`));
	writeStdout(chalk.dim(`Repo: ${plan.repoName} (${plan.repoKind})`));
	for (const warning of plan.warnings) {
		writeStdout(chalk.yellow(`${theme.status.warning} ${warning}`));
	}
	for (const file of plan.files) {
		const marker = file.action === "skip" ? "=" : file.action === "overwrite" ? "~" : "+";
		writeStdout(chalk.dim(`  ${marker} ${path.relative(cwd, file.target)}`));
	}
	for (const item of plan.imports) {
		const marker = item.action === "skip" ? "=" : "+";
		writeStdout(
			chalk.dim(`  ${marker} import ${path.relative(cwd, item.source)} -> ${path.relative(cwd, item.target)}`),
		);
	}
	if (flags.dryRun) {
		writeStdout(chalk.green(`${theme.status.success} Dry run complete`));
		return;
	}
	if (!flags.yes) {
		const approved = await confirmApply(
			`About to scaffold ${plan.files.filter(file => file.action !== "skip").length} file(s).`,
		);
		if (!approved) {
			writeStdout(chalk.yellow(`${theme.status.warning} Aborted`));
			return;
		}
	}
	const applied = await applyFactoryScaffold({
		cwd,
		preset: flags.preset ?? "standard",
		dryRun: false,
		existing: flags.existing ?? false,
		force: flags.force ?? false,
		enableMemory: flags.enableMemory ?? false,
	});
	writeStdout(chalk.green(`${theme.status.success} Scaffolded software factory into ${applied.cwd}`));
}

async function handleStatus(flags: FactoryCommandArgs["flags"]): Promise<void> {
	const cwd = process.cwd();
	const repo = await inspectFactoryRepo(cwd);
	const manifest = getSoftwareFactoryManifest();
	const presentFiles = await Promise.all(
		manifest.files.map(async entry => ({ entry, present: await exists(path.join(cwd, entry.target)) })),
	);
	const manifestPath = path.join(cwd, ".omp", "factory", "factory.json");
	let installedVersion: string | undefined;
	if (await exists(manifestPath)) {
		const json = (await Bun.file(manifestPath).json()) as { template?: { version?: string } };
		installedVersion = json.template?.version;
	}
	const userShadowPath = path.join(getAgentDir(), "extensions", "software-factory");
	const status = {
		cwd,
		repoName: repo.repoName,
		repoKind: repo.repoKind,
		present: presentFiles.filter(item => item.present).length,
		total: presentFiles.length,
		installedVersion,
		bundledVersion: manifest.version,
		stale: installedVersion !== undefined && installedVersion !== manifest.version,
		globalShadow: await exists(userShadowPath),
	};
	if (flags.json) {
		writeStdout(`${JSON.stringify(status, null, 2)}`);
		return;
	}
	writeStdout(chalk.bold(`Software factory status for ${status.repoName}`));
	writeStdout(chalk.dim(`Files present: ${status.present}/${status.total}`));
	writeStdout(chalk.dim(`Bundled version: ${status.bundledVersion}`));
	writeStdout(chalk.dim(`Installed version: ${status.installedVersion ?? "missing"}`));
	if (status.stale) writeStdout(chalk.yellow(`${theme.status.warning} Installed scaffold is stale`));
	if (status.globalShadow)
		writeStdout(
			chalk.yellow(`${theme.status.warning} User-scoped software-factory extension may shadow project behavior`),
		);
	for (const item of presentFiles) {
		writeStdout(chalk.dim(`  ${item.present ? "✓" : "✗"} ${item.entry.target}`));
	}
	if (repo.legacySources.length > 0) {
		writeStdout(
			chalk.dim(
				`Legacy config roots detected: ${repo.legacySources.map(source => path.basename(source)).join(", ")}`,
			),
		);
	}
}

async function handleDoctor(flags: FactoryCommandArgs["flags"]): Promise<void> {
	const result = await runFactoryDoctor(process.cwd());
	if (flags.json) {
		writeStdout(`${JSON.stringify(result, null, 2)}`);
		return;
	}
	writeStdout(chalk.bold("Factory doctor"));
	for (const check of result.checks) {
		const marker = check.ok ? chalk.green(theme.status.success) : chalk.red(theme.status.error);
		writeStdout(`${marker} [${check.kind}] ${check.message}`);
	}
	if (!result.ok) {
		throw new Error("Factory doctor found issues.");
	}
}

export async function runFactoryCommand(cmd: FactoryCommandArgs): Promise<void> {
	switch (cmd.action) {
		case "init":
			await handleInit(cmd.flags);
			return;
		case "status":
			await handleStatus(cmd.flags);
			return;
		case "doctor":
			await handleDoctor(cmd.flags);
			return;
	}
}

export function printFactoryHelp(): void {
	writeStdout(`${chalk.bold(`${COMMAND_NAME} factory`)} - project-scoped software-factory scaffolds\n`);
	writeStdout(chalk.dim("Guide: docs/software-factory.md"));
	writeStdout("");
	writeStdout(`${chalk.bold("Usage:")}`);
	writeStdout(
		`  ${COMMAND_NAME} factory init [--preset minimal|standard|software-factory] [--dry-run] [--yes] [--existing] [--force] [--enable-memory]`,
	);
	writeStdout(`  ${COMMAND_NAME} factory status [--json]`);
	writeStdout(`  ${COMMAND_NAME} factory doctor [--json]`);
	writeStdout("");
	writeStdout(`${chalk.bold("Examples:")}`);
	writeStdout(`  ${COMMAND_NAME} factory init --dry-run`);
	writeStdout(`  ${COMMAND_NAME} factory init --preset software-factory --existing`);
	writeStdout(`  ${COMMAND_NAME} factory doctor`);
	writeStdout("");
	writeStdout(
		chalk.dim("Docs: read docs/software-factory.md for presets, generated files, onboarding, and troubleshooting."),
	);
}
