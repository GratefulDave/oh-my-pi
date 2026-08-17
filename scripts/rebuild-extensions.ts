#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";

const REPO = path.resolve(import.meta.dir, "..");
const NATIVES_DIR = path.join(REPO, "packages", "natives");
const SETTINGS_PATH = path.join(REPO, ".omp", "settings.json");
const ENABLED_EXTENSION_NAMES: Record<string, true> = {};

interface RepoSettings {
	extensions?: unknown;
}

interface PackageJson {
	scripts?: Record<string, string>;
}

interface BuildTarget {
	name: string;
	packageDir: string;
	outputs: string[];
}

async function readJson<T>(filePath: string): Promise<T | null> {
	try {
		return (await Bun.file(filePath).json()) as T;
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

function isEnoent(err: unknown): boolean {
	return err instanceof Error && "code" in err && (err as { code?: string }).code === "ENOENT";
}

function getPackageDir(extensionPath: string): string | null {
	const normalized = extensionPath.split(path.sep).join("/");
	const parts = normalized.split("/");
	if (parts[0] !== "packages" || !parts[1]) return null;
	return path.join(REPO, "packages", parts[1]);
}

async function hasBuildScript(packageDir: string): Promise<boolean> {
	const packageJson = await readJson<PackageJson>(path.join(packageDir, "package.json"));
	return typeof packageJson?.scripts?.build === "string";
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.stat(filePath);
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

function groupTargets(extensionPaths: string[]): BuildTarget[] {
	const targets = new Map<string, BuildTarget>();
	for (const extensionPath of extensionPaths) {
		const packageDir = getPackageDir(extensionPath);
		if (!packageDir) continue;
		const existing = targets.get(packageDir);
		const name = path.basename(packageDir);
		const output = path.resolve(REPO, extensionPath);
		if (existing) {
			existing.outputs.push(output);
		} else {
			targets.set(packageDir, { name, packageDir, outputs: [output] });
		}
	}
	return [...targets.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function runPackageBuild(name: string, packageDir: string): Promise<void> {
	console.log(`\n==> ${name}`);
	const proc = Bun.spawn(["bun", "run", "build"], {
		cwd: packageDir,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`${name} build failed with exit code ${exitCode}`);
	}
}

async function runBuild(target: BuildTarget): Promise<void> {
	await runPackageBuild(target.name, target.packageDir);
	for (const output of target.outputs) {
		if (!(await pathExists(output))) {
			throw new Error(`${target.name} build did not create ${path.relative(REPO, output)}`);
		}
	}
}

async function verifyNativeMinimizer(): Promise<void> {
	const proc = Bun.spawn(
		[
			"bun",
			"-e",
			"const m=await import('@oh-my-pi/pi-natives'); if (typeof m.applyShellMinimizer !== 'function') throw new Error('applyShellMinimizer export missing');",
		],
		{
			cwd: REPO,
			stdout: "inherit",
			stderr: "inherit",
		},
	);
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`pi-natives minimizer verification failed with exit code ${exitCode}`);
	}
}

const settings = await readJson<RepoSettings>(SETTINGS_PATH);
const extensionPaths = Array.isArray(settings?.extensions)
	? settings.extensions.filter(
			(value): value is string =>
				typeof value === "string" &&
				Boolean(ENABLED_EXTENSION_NAMES[path.basename(path.dirname(path.dirname(value)))]),
		)
	: [];

if (extensionPaths.length === 0) {
	console.log("No fork-managed extensions enabled.");
	process.exit(0);
}

const allTargets = groupTargets(extensionPaths);
const targets: BuildTarget[] = [];
const skipped: string[] = [];

for (const target of allTargets) {
	if (await hasBuildScript(target.packageDir)) {
		targets.push(target);
	} else {
		skipped.push(target.name);
	}
}

if (targets.length === 0) {
	console.error("No package extension build scripts found from .omp/settings.json#extensions");
	process.exit(1);
}

console.log(
	`Rebuilding native minimizer support and ${targets.length} extension package${targets.length === 1 ? "" : "s"} from .omp/settings.json`,
);
if (skipped.length > 0) {
	console.log(`Skipping packages without build script: ${skipped.join(", ")}`);
}

await runPackageBuild("pi-natives", NATIVES_DIR);
await verifyNativeMinimizer();

for (const target of targets) {
	await runBuild(target);
}

console.log("\nExtension bundles rebuilt:");
for (const target of targets) {
	for (const output of target.outputs) {
		console.log(`  ${path.relative(REPO, output)}`);
	}
}
