#!/usr/bin/env bun
// Symlink this repo's compiled extension bundles into ~/.omp/agent/extensions/.
//
// This script MUST NOT write ~/.omp/agent/config.yml or settings.json. Those are
// the user's Lex/OMP runtime configs. Extension discovery already scans
// ~/.omp/agent/extensions directly, so refreshing symlinks is enough to make the
// rebuilt bundles available from every working directory without resetting
// profiles, model roles, disabled providers, MCPs, or skills.
//
//   bun scripts/install-user-extensions.ts            # install (build first!)
//   bun scripts/install-user-extensions.ts --dry-run  # show what would happen
//
// Source list is read from repo .omp/settings.json#extensions plus package.json
// omp.extensions entries.

import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

interface RepoSettings {
	extensions?: unknown;
}

interface PackageJson {
	omp?: {
		extensions?: unknown;
	};
}

const REPO = path.resolve(import.meta.dir, "..");
const HOME = homedir();
const USER_DIR = path.join(HOME, ".omp", "agent");
const EXT_DIR = path.join(USER_DIR, "extensions");
const DRY = process.argv.includes("--dry-run");

function extName(rel: string): string {
	const parts = rel.split("/");
	const packagesIdx = parts.indexOf("packages");
	if (packagesIdx >= 0 && parts[packagesIdx + 1]) return parts[packagesIdx + 1];
	const extensionsIdx = parts.indexOf("extensions");
	if (extensionsIdx >= 0 && parts[extensionsIdx + 1]) return parts[extensionsIdx + 1];
	return path.basename(path.dirname(path.dirname(rel)));
}

function isEnoent(err: unknown): boolean {
	return err instanceof Error && "code" in err && (err as { code?: string }).code === "ENOENT";
}

async function readJson<T>(filePath: string): Promise<T | null> {
	try {
		return (await Bun.file(filePath).json()) as T;
	} catch (err) {
		if (isEnoent(err) || err instanceof SyntaxError) return null;
		throw err;
	}
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		const stat = await fs.stat(filePath);
		return stat.isFile();
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

// Managed extension directories must not retain authoritative discovery files
// from older installs. A stale package.json or source index can override the
// relinked bundle and force the runtime back onto repo source files.
const STALE_MANAGED_DISCOVERY_FILES = new Set(["package.json", "index.ts", "index.js", "index.mjs", "index.cjs"]);

export async function removeStaleManagedDiscoveryFiles(destDir: string, keepFile: string): Promise<void> {
	const entries = await fs.readdir(destDir, { withFileTypes: true }).catch(err => {
		if (isEnoent(err)) return [];
		throw err;
	});
	for (const entry of entries) {
		if (!STALE_MANAGED_DISCOVERY_FILES.has(entry.name) || entry.name === keepFile) continue;
		await fs.rm(path.join(destDir, entry.name), { recursive: true, force: true });
	}
}

async function verifyLink(dest: string, src: string): Promise<string | null> {
	const stat = await fs.lstat(dest).catch(() => null);
	if (!stat) return `missing installed extension: ${dest}`;
	if (!stat.isSymbolicLink()) return `installed extension is not a symlink: ${dest}`;
	const target = await fs.readlink(dest);
	const resolved = path.resolve(path.dirname(dest), target);
	if (resolved !== src) return `wrong symlink target: ${dest} -> ${target} (expected ${src})`;
	if (!(await pathExists(resolved))) return `symlink target missing: ${dest} -> ${resolved}`;
	return null;
}

async function discoverPackageExtensionSources(): Promise<string[]> {
	const packagesDir = path.join(REPO, "packages");
	const entries = await fs.readdir(packagesDir, { withFileTypes: true }).catch(() => []);
	const sources: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const packageDir = path.join(packagesDir, entry.name);
		const manifest = await readJson<PackageJson>(path.join(packageDir, "package.json"));
		const extensions = manifest?.omp?.extensions;
		if (!Array.isArray(extensions)) continue;
		for (const extension of extensions) {
			if (typeof extension !== "string") continue;
			const rel = path.relative(REPO, path.resolve(packageDir, extension)).split(path.sep).join("/");
			sources.push(rel);
		}
	}
	return sources;
}

async function main(): Promise<void> {
	const repoSettings = (await readJson<RepoSettings>(path.join(REPO, ".omp", "settings.json"))) ?? {};
	const configuredSources = Array.isArray(repoSettings.extensions)
		? repoSettings.extensions.filter((value): value is string => typeof value === "string")
		: [];
	const configuredNames = new Set(configuredSources.map(extName));
	const manifestSources = await discoverPackageExtensionSources();
	const sources = [...configuredSources];
	for (const rel of manifestSources) {
		if (configuredNames.has(extName(rel))) continue;
		sources.push(rel);
	}
	if (sources.length === 0) {
		console.error("No extensions found in repo .omp/settings.json#extensions or package manifests");
		process.exit(1);
	}

	const registered: string[] = [];
	const missing: string[] = [];
	for (const rel of sources) {
		const src = path.resolve(REPO, rel);
		const name = extName(rel);
		const file = path.basename(rel);
		const destDir = path.join(EXT_DIR, name);
		const dest = path.join(destDir, file);
		const tildePath = path.join("~/.omp/agent/extensions", name, file);

		if (!(await pathExists(src))) {
			missing.push(rel);
			console.warn(`SKIP  ${name}: bundle not built -> ${rel}  (run: bun scripts/rebuild-extensions.ts)`);
			continue;
		}

		console.log(`${DRY ? "[dry] " : ""}link  ${rel}  ->  ${tildePath}`);
		if (!DRY) {
			await fs.mkdir(destDir, { recursive: true });
			await removeStaleManagedDiscoveryFiles(destDir, file);
			await fs.rm(dest, { force: true });
			await fs.symlink(src, dest);
		}
		registered.push(tildePath);
	}

	const verifyErrors: string[] = [];
	if (!DRY) {
		for (const rel of sources) {
			const src = path.resolve(REPO, rel);
			if (!(await pathExists(src))) continue;
			const name = extName(rel);
			const file = path.basename(rel);
			const dest = path.join(EXT_DIR, name, file);
			const error = await verifyLink(dest, src);
			if (error) verifyErrors.push(error);
		}
	}

	if (missing.length > 0) {
		console.error(`\n${missing.length} required extension bundle(s) not built:`);
		for (const rel of missing) console.error(`  ${rel}`);
		console.error("Build failed bundles, then re-run:");
		console.error("  bun scripts/rebuild-extensions.ts && bun scripts/install-user-extensions.ts");
		process.exit(1);
	}

	if (verifyErrors.length > 0) {
		console.error("\nExtension install verification failed:");
		for (const error of verifyErrors) console.error(`  ${error}`);
		process.exit(1);
	}

	console.log(`\nDone. Refreshed ${registered.length} managed extension symlink(s).`);
	console.log("Left ~/.omp/agent/config.yml and ~/.omp/agent/settings.json unchanged.");
}

if (import.meta.main) {
	await main();
}
