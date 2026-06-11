#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { discoverManagedExtensionSources, extensionName, readJson } from "./fork-managed-extensions";

interface UserSettings {
	extensions?: unknown;
}

interface Args {
	bin: string;
	listModels: boolean;
}

const REPO = path.resolve(import.meta.dir, "..");
const HOME = homedir();
const USER_SETTINGS = path.join(HOME, ".omp", "agent", "settings.json");
const USER_EXTENSIONS_DIR = path.join(HOME, ".omp", "agent", "extensions");

function parseArgs(argv: readonly string[]): Args {
	let bin = process.env.OMP_BIN || "omp";
	let listModels = false;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--list-models") {
			listModels = true;
		} else if (arg === "--bin" && argv[index + 1]) {
			bin = argv[++index];
		} else if (arg.startsWith("--bin=")) {
			bin = arg.slice("--bin=".length);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return { bin, listModels };
}

function isEnoent(err: unknown): boolean {
	return err instanceof Error && "code" in err && (err as { code?: string }).code === "ENOENT";
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		const stat = await fs.stat(filePath);
		return stat.isFile();
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

async function readLinkTarget(filePath: string): Promise<string | null> {
	try {
		const stat = await fs.lstat(filePath);
		if (!stat.isSymbolicLink()) return null;
		return path.resolve(path.dirname(filePath), await fs.readlink(filePath));
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

async function runCommand(command: string, args: readonly string[]): Promise<void> {
	const proc = Bun.spawn([command, ...args], {
		cwd: REPO,
		stdout: "inherit",
		stderr: "inherit",
		env: { ...process.env },
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${exitCode}`);
}

const args = parseArgs(process.argv.slice(2));
const sources = await discoverManagedExtensionSources(REPO);
const settings = (await readJson<UserSettings>(USER_SETTINGS)) ?? {};
const registered = Array.isArray(settings.extensions)
	? settings.extensions.filter((value): value is string => typeof value === "string")
	: [];

if (sources.length === 0) throw new Error("No managed extension sources discovered in this repo");

const errors: string[] = [];
for (const source of sources) {
	const sourcePath = path.resolve(REPO, source.rel);
	const name = extensionName(source.rel);
	const file = path.basename(source.rel);
	const installedPath = path.join(USER_EXTENSIONS_DIR, name, file);
	const tildePath = path.join("~/.omp/agent/extensions", name, file);
	if (!(await fileExists(sourcePath))) {
		errors.push(`bundle not built: ${source.rel}`);
		continue;
	}
	if (!registered.includes(tildePath)) {
		errors.push(`missing settings registration: ${tildePath}`);
	}
	const target = await readLinkTarget(installedPath);
	if (target !== sourcePath) {
		errors.push(`installed link mismatch: ${installedPath} -> ${target ?? "(not a symlink)"}; expected ${sourcePath}`);
	}
}

if (errors.length > 0) {
	console.error("Stock omp extension smoke failed before launching omp:");
	for (const error of errors) console.error(`  ${error}`);
	process.exit(1);
}

await runCommand(args.bin, ["--version"]);
if (args.listModels) await runCommand(args.bin, ["--list-models"]);

console.log(`Stock omp smoke passed for ${sources.length} managed extension source(s).`);
