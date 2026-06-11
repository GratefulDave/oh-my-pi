#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { discoverManagedExtensionSources, readJson } from "./fork-managed-extensions";

interface RootPackageJson {
	packageManager?: string;
	workspaces?: {
		catalog?: Record<string, string>;
	};
}

interface PackageJson {
	name?: string;
	version?: string;
	description?: string;
	type?: string;
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	[key: string]: unknown;
}

interface Args {
	dest: string;
	dryRun: boolean;
	force: boolean;
}

const REPO = path.resolve(import.meta.dir, "..");
const DEFAULT_DEST = path.resolve(REPO, "..", "omp-personal-extensions");
const COPY_ROOTS = ["scripts/fork-managed-extensions.ts", "scripts/rebuild-extensions.ts", "scripts/install-user-extensions.ts"];
const GENERATED_ROOT_PACKAGE = {
	name: "omp-personal-extensions",
	private: true,
	type: "module",
	packageManager: "bun@1.3.14",
	workspaces: ["packages/*"],
	scripts: {
		build: "bun scripts/rebuild-extensions.ts",
		"install:user": "bun scripts/install-user-extensions.ts",
		"install:user:dry-run": "bun scripts/install-user-extensions.ts --dry-run",
		"smoke:stock-omp": "bun scripts/stock-omp-extension-smoke.ts",
	},
	devDependencies: {
		"@biomejs/biome": "^2.4.16",
		"@types/bun": "^1.3.14",
		"@typescript/native-preview": "^7.0.0-dev.20260527.1",
	},
};
const OMIT_DIRS: Record<string, true> = { ".git": true, ".omc": true, node_modules: true, ".turbo": true };
const OH_MY_PI_PREFIX = "@oh-my-pi/";

function parseArgs(argv: readonly string[]): Args {
	let dest = DEFAULT_DEST;
	let dryRun = false;
	let force = false;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--dry-run") {
			dryRun = true;
		} else if (arg === "--force") {
			force = true;
		} else if (arg === "--dest" && argv[index + 1]) {
			dest = path.resolve(argv[++index]);
		} else if (arg.startsWith("--dest=")) {
			dest = path.resolve(arg.slice("--dest=".length));
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return { dest, dryRun, force };
}

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

function normalizeRel(filePath: string): string {
	return path.relative(REPO, filePath).split(path.sep).join("/");
}

function packageNameFromExtensionPath(rel: string): string | null {
	const parts = rel.split("/");
	const packageIndex = parts.indexOf("packages");
	if (packageIndex >= 0 && parts[packageIndex + 1]) return parts[packageIndex + 1];
	return null;
}

function localExtensionRootFromPath(rel: string): string | null {
	const parts = rel.split("/");
	if (parts[0] !== ".omp" || parts[1] !== "extensions" || !parts[2]) return null;
	return [".omp", "extensions", parts[2]].join("/");
}

async function copyFile(src: string, dest: string, dryRun: boolean): Promise<void> {
	console.log(`${dryRun ? "[dry] " : ""}copy ${normalizeRel(src)} -> ${path.relative(process.cwd(), dest)}`);
	if (dryRun) return;
	await Bun.write(dest, Bun.file(src));
}

async function copyDir(src: string, dest: string, dryRun: boolean): Promise<void> {
	const entries = await fs.readdir(src, { withFileTypes: true });
	if (!dryRun) await fs.mkdir(dest, { recursive: true });
	for (const entry of entries) {
		if (OMIT_DIRS[entry.name] || entry.name.endsWith(".tsbuildinfo")) continue;
		const srcPath = path.join(src, entry.name);
		const destPath = path.join(dest, entry.name);
		if (entry.isDirectory()) {
			await copyDir(srcPath, destPath, dryRun);
		} else if (entry.isFile() || entry.isSymbolicLink()) {
			await copyFile(srcPath, destPath, dryRun);
		}
	}
}

function stockDependencyVersion(name: string, version: string, hostVersion: string): string {
	if (!name.startsWith(OH_MY_PI_PREFIX)) return version;
	if (version === "workspace:*" || version.startsWith("workspace:")) return `^${hostVersion}`;
	if (version.includes("-lex")) return version.replace(/-lex\b/g, "");
	return version;
}

function normalizeDependencyMap(
	deps: Record<string, string> | undefined,
	hostVersion: string,
): Record<string, string> | undefined {
	if (!deps) return undefined;
	const normalized: Record<string, string> = {};
	for (const [name, version] of Object.entries(deps)) {
		normalized[name] = stockDependencyVersion(name, version, hostVersion);
	}
	return normalized;
}

async function normalizePackageJson(
	sourcePackagePath: string,
	targetPackagePath: string,
	hostVersion: string,
	dryRun: boolean,
): Promise<void> {
	const packageJson = await readJson<PackageJson>(sourcePackagePath);
	if (!packageJson) throw new Error(`Missing package.json: ${sourcePackagePath}`);
	const files = Array.isArray(packageJson.files)
		? packageJson.files.filter((value): value is string => typeof value === "string")
		: undefined;
	const extensionValues =
		packageJson.omp && typeof packageJson.omp === "object" && !Array.isArray(packageJson.omp)
			? (packageJson.omp as { extensions?: unknown }).extensions
			: undefined;
	const extensionPaths = Array.isArray(extensionValues)
		? extensionValues.filter((value): value is string => typeof value === "string")
		: [];
	if (files && extensionPaths.some(extensionPath => extensionPath.startsWith("./dist/")) && !files.includes("dist")) {
		files.push("dist");
	}
	const normalized: PackageJson = {
		...packageJson,
		version: packageJson.version?.replace(/-lex\b/g, "") ?? packageJson.version,
		dependencies: normalizeDependencyMap(packageJson.dependencies, hostVersion),
		devDependencies: normalizeDependencyMap(packageJson.devDependencies, hostVersion),
		peerDependencies: normalizeDependencyMap(packageJson.peerDependencies, hostVersion),
		optionalDependencies: normalizeDependencyMap(packageJson.optionalDependencies, hostVersion),
		...(files ? { files } : {}),
	};
	if (dryRun) {
		console.log(`[dry] normalize ${path.relative(process.cwd(), targetPackagePath)}`);
		return;
	}
	await Bun.write(targetPackagePath, `${JSON.stringify(normalized, null, "\t")}\n`);
}

async function writeRootPackage(dest: string, hostVersion: string, packageManager: string, dryRun: boolean): Promise<void> {
	const packageJson = {
		...GENERATED_ROOT_PACKAGE,
		packageManager,
		dependencies: {
			"@oh-my-pi/pi-ai": `^${hostVersion}`,
			"@oh-my-pi/pi-coding-agent": `^${hostVersion}`,
			"@babel/parser": "^7.29.7",
			"@oh-my-pi/pi-tui": `^${hostVersion}`,
			"@oh-my-pi/pi-utils": `^${hostVersion}`,
			yaml: "^2.9.0",
		},
	};
	const target = path.join(dest, "package.json");
	console.log(`${dryRun ? "[dry] " : ""}write ${path.relative(process.cwd(), target)}`);
	if (!dryRun) await Bun.write(target, `${JSON.stringify(packageJson, null, "\t")}\n`);
}

async function writeReadme(dest: string, dryRun: boolean): Promise<void> {
	const target = path.join(dest, "README.md");
	const content = `# OMP personal extensions\n\nGenerated from the Lex fork by \`bun scripts/export-personal-extensions.ts\`.\n\n## Use\n\n\`\`\`bash\nbun install\nbun run build\nbun run install:user\nbun run smoke:stock-omp\n\`\`\`\n\nThe installer symlinks built bundles into \`~/.omp/agent/extensions/\` and merges extension/profile settings into \`~/.omp/agent/settings.json\` and \`~/.omp/agent/config.yml\`.\n\nKeep this repo private unless Antigravity credentials/provider behavior are intentionally public.\n`;
	console.log(`${dryRun ? "[dry] " : ""}write ${path.relative(process.cwd(), target)}`);
	if (!dryRun) await Bun.write(target, content);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const rootPackage = await readJson<RootPackageJson>(path.join(REPO, "package.json"));
	const hostVersion = rootPackage?.workspaces?.catalog?.["@oh-my-pi/pi-coding-agent"] ?? "15.10.11";
	const packageManager = rootPackage?.packageManager ?? "bun@1.3.14";
	const sources = await discoverManagedExtensionSources(REPO);
	const packageNames = Array.from(new Set(sources.map(source => packageNameFromExtensionPath(source.rel)).filter((name): name is string => Boolean(name)))).sort();
	const localExtensionRoots = Array.from(new Set(sources.map(source => localExtensionRootFromPath(source.rel)).filter((rel): rel is string => Boolean(rel)))).sort();

	if (sources.length === 0) throw new Error("No managed extensions discovered");
	if (path.resolve(args.dest) === REPO) throw new Error("Destination must not be the Lex repo root");
	if ((await pathExists(args.dest)) && !args.force && !args.dryRun) {
		throw new Error(`Destination already exists: ${args.dest}\nPass --force to refresh it in place.`);
	}

	console.log(`Exporting ${sources.length} managed extension source(s) to ${args.dest}`);
	console.log(`Host stock dependency version: ${hostVersion}`);
	if (!args.dryRun) {
		await fs.mkdir(args.dest, { recursive: true });
		await fs.mkdir(path.join(args.dest, "scripts"), { recursive: true });
		await fs.mkdir(path.join(args.dest, ".omp"), { recursive: true });
	}

	for (const root of COPY_ROOTS) {
		await copyFile(path.join(REPO, root), path.join(args.dest, root), args.dryRun);
	}
	const smokeScript = path.join(REPO, "scripts", "stock-omp-extension-smoke.ts");
	if (await pathExists(smokeScript)) {
		await copyFile(smokeScript, path.join(args.dest, "scripts", "stock-omp-extension-smoke.ts"), args.dryRun);
	}
	await copyFile(path.join(REPO, ".omp", "settings.json"), path.join(args.dest, ".omp", "settings.json"), args.dryRun);

	for (const packageName of packageNames) {
		const src = path.join(REPO, "packages", packageName);
		const dest = path.join(args.dest, "packages", packageName);
		await copyDir(src, dest, args.dryRun);
		await normalizePackageJson(path.join(src, "package.json"), path.join(dest, "package.json"), hostVersion, args.dryRun);
	}

	for (const rel of localExtensionRoots) {
		await copyDir(path.join(REPO, rel), path.join(args.dest, rel), args.dryRun);
	}

	await writeRootPackage(args.dest, hostVersion, packageManager, args.dryRun);
	await writeReadme(args.dest, args.dryRun);

	const displayDest = args.dest.replace(homedir(), "~");
	console.log(`\nDone. Next in ${displayDest}:`);
	console.log("  bun install");
	console.log("  bun run build");
	console.log("  bun run install:user");
	console.log("  bun run smoke:stock-omp");
}

await main();
