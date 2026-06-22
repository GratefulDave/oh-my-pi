#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";

const REPO = path.resolve(import.meta.dir, "..");
const NATIVES_DIR = path.join(REPO, "packages", "natives");
const SETTINGS_PATH = path.join(REPO, ".omp", "settings.json");
const HOST_EXTERNALS = ["@oh-my-pi/pi-coding-agent", "@oh-my-pi/pi-utils", "@oh-my-pi/pi-natives"];

interface RepoSettings {
	extensions?: unknown;
}

interface PackageJson {
	scripts?: Record<string, string>;
	omp?: {
		extensions?: unknown;
	};
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

async function useNightlyCargo(): Promise<void> {
	const proc = Bun.spawn(["rustup", "which", "cargo"], {
		stdout: "pipe",
		stderr: "inherit",
	});
	const output = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`rustup which cargo failed with exit code ${exitCode}`);
	}
	const cargoPath = output.trim();
	if (cargoPath.length === 0) {
		throw new Error("rustup which cargo returned an empty path");
	}
	const cargoDir = path.dirname(cargoPath);
	const nextPath = process.env.PATH ? `${cargoDir}${path.delimiter}${process.env.PATH}` : cargoDir;
	process.env.PATH = nextPath;
	Bun.env.PATH = nextPath;
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

function normalizeRelative(filePath: string): string {
	return path.relative(REPO, filePath).split(path.sep).join("/");
}

async function discoverPackageExtensionSources(): Promise<string[]> {
	const packagesDir = path.join(REPO, "packages");
	const entries = await fs.readdir(packagesDir, { withFileTypes: true }).catch(() => []);
	const sources: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const packageDir = path.join(packagesDir, entry.name);
		const packageJson = await readJson<PackageJson>(path.join(packageDir, "package.json"));
		const extensions = packageJson?.omp?.extensions;
		if (!Array.isArray(extensions)) continue;
		for (const extension of extensions) {
			if (typeof extension !== "string") continue;
			sources.push(path.relative(REPO, path.resolve(packageDir, extension)).split(path.sep).join("/"));
		}
	}
	return sources;
}

async function discoverLocalExtensionSources(): Promise<string[]> {
	const extensionsDir = path.join(REPO, ".omp", "extensions");
	const entries = await fs.readdir(extensionsDir, { withFileTypes: true }).catch(() => []);
	const sources: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const localDir = path.join(extensionsDir, entry.name);
		const localEntrypoint = path.join(localDir, "index.ts");
		const srcEntrypoint = path.join(localDir, "src", "extension.ts");
		const localPackageJson = path.join(localDir, "package.json");
		const localPkg = await readJson<PackageJson>(localPackageJson);
		if (!(await pathExists(localEntrypoint)) && !(await pathExists(srcEntrypoint)) && !localPkg?.scripts?.build) {
			continue;
		}
		const distDir = path.join(localDir, "dist");
		const distEntries = await fs.readdir(distDir, { withFileTypes: true }).catch(() => []);
		for (const distEntry of distEntries) {
			if (!distEntry.isFile() && !distEntry.isSymbolicLink()) continue;
			if (!distEntry.name.endsWith(".js")) continue;
			sources.push(
				normalizeRelative(path.join(distDir, distEntry.name)),
			);
		}
	}
	return sources;
}

function extName(extensionPath: string): string {
	const normalized = extensionPath.split(path.sep).join("/");
	const parts = normalized.split("/");
	const packagesIdx = parts.indexOf("packages");
	if (packagesIdx >= 0 && parts[packagesIdx + 1]) return parts[packagesIdx + 1];
	const extensionsIdx = parts.indexOf("extensions");
	if (extensionsIdx >= 0 && parts[extensionsIdx + 1]) return parts[extensionsIdx + 1];
	return path.basename(path.dirname(path.dirname(normalized)));
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

		// Check local .omp/extensions/<name>/package.json for build script
		const rel = normalizeRelative(extensionPath);
		if (rel.startsWith(".omp/extensions/")) {
			const localExtDir = path.dirname(path.dirname(output));
			const localPackageJson = path.join(localExtDir, "package.json");
			const localPkg = await readJson<PackageJson>(localPackageJson);
			if (localPkg?.scripts?.build) {
				targets.set(`local:${output}`, {
					kind: "package-script",
					name: extName(extensionPath),
					cwd: localExtDir,
					outputs: [output],
				});
				continue;
			}
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
	const proc = Bun.spawn(["/bin/sh", "-lc", "bun run build"], {
		cwd,
		env: { ...process.env },
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
			"const m=await import('@oh-my-pi/pi-natives'); if (typeof m.executeShell !== 'function') throw new Error('executeShell export missing');",
		],
		{
			cwd: REPO,
			env: { ...process.env },
			stdout: "inherit",
			stderr: "inherit",
		},
	);
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`pi-natives verification failed with exit code ${exitCode}`);
	}
}

const settings = await readJson<RepoSettings>(SETTINGS_PATH);
const configuredExtensionPaths = Array.isArray(settings?.extensions)
	? settings.extensions.filter((value): value is string => typeof value === "string")
	: [];
const configuredNames = new Set(configuredExtensionPaths.map(extName));
const extensionPaths = [...configuredExtensionPaths];
for (const extensionPath of await discoverPackageExtensionSources()) {
	if (configuredNames.has(extName(extensionPath))) continue;
	extensionPaths.push(extensionPath);
}
for (const extensionPath of await discoverLocalExtensionSources()) {
	if (configuredNames.has(extName(extensionPath))) continue;
	extensionPaths.push(extensionPath);
}

if (extensionPaths.length === 0) {
	console.error("No extension paths found in .omp/settings.json or .omp/extensions/");
	process.exit(1);
}

const targets = await collectTargets(extensionPaths);
const hasNativePackage = await Bun.file(path.join(NATIVES_DIR, "package.json")).exists();
console.log(
	`Rebuilding ${hasNativePackage ? "pi-natives and " : ""}${targets.length} extension target${targets.length === 1 ? "" : "s"} from .omp/settings.json`,
);

if (hasNativePackage) {
	await useNightlyCargo();
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
