#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { discoverManagedExtensionSources, extensionName, readJson } from "./fork-managed-extensions";

const REPO = path.resolve(import.meta.dir, "..");
const NATIVES_DIR = path.join(REPO, "packages", "natives");
const HOST_EXTERNALS = ["@oh-my-pi/pi-coding-agent"];

interface PackageJson {
	scripts?: Record<string, string>;
}

type BuildTarget =
	| {
			kind: "package-script";
			name: string;
			cwd: string;
			outputs: string[];
	  }
	| {
			kind: "bundle";
			name: string;
			entrypoint: string;
			output: string;
			target: "bun" | "node";
			external: string[];
	  };


function isEnoent(err: unknown): boolean {
	return err instanceof Error && "code" in err && (err as { code?: string }).code === "ENOENT";
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
async function dirExists(dirPath: string): Promise<boolean> {
	try {
		const stat = await fs.stat(dirPath);
		return stat.isDirectory();
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

function normalizeRelative(filePath: string): string {
	return path.relative(REPO, filePath).split(path.sep).join("/");
}

function extName(extensionPath: string): string {
	return extensionName(extensionPath);
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

async function resolveBundleEntrypoint(output: string): Promise<{ entrypoint: string; target: "bun" | "node" } | null> {
	const rel = normalizeRelative(output);
	const packageDir = getPackageDir(rel);
	if (packageDir) {
		const packageEntrypoint = path.join(packageDir, "src", "extension.ts");
		if (await pathExists(packageEntrypoint)) {
			return { entrypoint: packageEntrypoint, target: "bun" };
		}
	}

	const normalized = rel.split(path.sep).join("/");
	if (normalized.startsWith(".omp/extensions/")) {
		const localDir = path.dirname(path.dirname(output));
		const localEntrypoint = path.join(localDir, "index.ts");
		if (await pathExists(localEntrypoint)) {
			return { entrypoint: localEntrypoint, target: "bun" };
		}
		const srcEntrypoint = path.join(localDir, "src", "extension.ts");
		if (await pathExists(srcEntrypoint)) {
			return { entrypoint: srcEntrypoint, target: "bun" };
		}
	}

	return null;
}

async function collectTargets(extensionPaths: string[]): Promise<BuildTarget[]> {
	const targets = new Map<string, BuildTarget>();
	for (const extensionPath of extensionPaths) {
		const output = path.resolve(REPO, extensionPath);
		const packageDir = getPackageDir(extensionPath);
		if (packageDir && (await hasBuildScript(packageDir))) {
			const key = `package:${packageDir}`;
			const existing = targets.get(key);
			if (existing && existing.kind === "package-script") {
				existing.outputs.push(output);
				continue;
			}
			targets.set(key, {
				kind: "package-script",
				name: path.basename(packageDir),
				cwd: packageDir,
				outputs: [output],
			});
			continue;
		}

		const bundle = await resolveBundleEntrypoint(output);
		if (!bundle) {
			throw new Error(`No build strategy for ${extensionPath}`);
		}
		targets.set(`bundle:${output}`, {
			kind: "bundle",
			name: extName(extensionPath),
			entrypoint: bundle.entrypoint,
			output,
			target: bundle.target,
			external: HOST_EXTERNALS,
		});
	}

	return [...targets.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function runPackageBuild(name: string, cwd: string): Promise<void> {
	console.log(`\n==> ${name}`);
	const proc = Bun.spawn(["bun", "run", "build"], {
		cwd,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`${name} build failed with exit code ${exitCode}`);
	}
}

async function runBundleBuild(target: Extract<BuildTarget, { kind: "bundle" }>): Promise<void> {
	console.log(`\n==> ${target.name}`);
	await fs.mkdir(path.dirname(target.output), { recursive: true });
	const result = await Bun.build({
		entrypoints: [target.entrypoint],
		outdir: path.dirname(target.output),
		naming: path.basename(target.output),
		target: target.target,
		format: "esm",
		external: target.external,
	});
	if (!result.success) {
		const details = result.logs.map(log => `${log.level}: ${log.message}`).join("\n");
		throw new Error(`${target.name} bundle failed\n${details}`);
	}
	console.log(`Built ${normalizeRelative(target.output)}`);
}

async function verifyTargetOutputs(targets: readonly BuildTarget[]): Promise<void> {
	for (const target of targets) {
		const outputs = target.kind === "package-script" ? target.outputs : [target.output];
		for (const output of outputs) {
			if (!(await pathExists(output))) {
				throw new Error(`${target.name} build did not create ${normalizeRelative(output)}`);
			}
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

const sources = await discoverManagedExtensionSources(REPO);
const extensionPaths = sources.map(source => source.rel);

if (extensionPaths.length === 0) {
	console.error("No managed extensions found in .omp/settings.json, package manifests, or .omp/extensions");
	process.exit(1);
}

const targets = await collectTargets(extensionPaths);
const hasNativePackage = await dirExists(NATIVES_DIR);
console.log(
	`Rebuilding ${hasNativePackage ? "pi-natives and " : ""}${targets.length} extension target${targets.length === 1 ? "" : "s"} from managed extension sources`,
);

if (hasNativePackage) {
	await runPackageBuild("pi-natives", NATIVES_DIR);
	await verifyNativeMinimizer();
}

for (const target of targets) {
	if (target.kind === "package-script") {
		await runPackageBuild(target.name, target.cwd);
	} else {
		await runBundleBuild(target);
	}
}

await verifyTargetOutputs(targets);

console.log("\nExtension bundles rebuilt:");
for (const target of targets) {
	const outputs = target.kind === "package-script" ? target.outputs : [target.output];
	for (const output of outputs) {
		console.log(`  ${normalizeRelative(output)}`);
	}
}
