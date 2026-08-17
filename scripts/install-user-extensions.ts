#!/usr/bin/env bun

// Symlink the repo's compiled extension bundles into ~/.omp/agent/extensions/
// and register them in ~/.omp/agent/settings.json (USER scope) so omp loads
// them from ANY working directory — independent of this repo.
//
//   bun scripts/install-user-extensions.ts            # install (build first!)
//   bun scripts/install-user-extensions.ts --dry-run  # show what would happen
//
// Source list is read from the repo's .omp/settings.json#extensions.
// Paths registered use ~ so they stay portable; the loader expands ~ and keeps
// absolute paths as-is (resolveAgainst in omp-extension-roots.ts).

import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

interface RepoSettings {
	extensions?: string[];
}

const REPO = path.resolve(import.meta.dir, "..");
const HOME = homedir();
const USER_DIR = path.join(HOME, ".omp", "agent");
const EXT_DIR = path.join(USER_DIR, "extensions");
const USER_SETTINGS = path.join(USER_DIR, "settings.json");
const DRY = process.argv.includes("--dry-run");
const PRESERVE_SETTINGS = process.argv.includes("--preserve-settings");
// Profile-manager owns `/pm` model/profile switching. Other fork extensions
// remain disabled and must not be rediscovered from package manifests.
const ENABLED_EXTENSION_NAMES: Record<string, true> = { "profile-manager": true };

// Derive a stable folder name from a source bundle path.
//   packages/<extension>/dist/<bundle>.js   -> <extension>
//   .omp/extensions/profile-manager/dist/index.js  -> profile-manager
function extName(rel: string): string {
	const parts = rel.split("/");
	const pkgsIdx = parts.indexOf("packages");
	if (pkgsIdx >= 0 && parts[pkgsIdx + 1]) return parts[pkgsIdx + 1];
	const ompIdx = parts.indexOf("extensions");
	if (ompIdx >= 0 && parts[ompIdx + 1]) return parts[ompIdx + 1];
	return path.basename(path.dirname(path.dirname(rel))); // fallback: parent of dist/
}

async function readJson<T>(p: string): Promise<T | null> {
	try {
		return JSON.parse(await fs.readFile(p, "utf8")) as T;
	} catch {
		return null;
	}
}

function expandTildePath(value: string): string {
	return value === "~" ? HOME : value.startsWith("~/") ? path.join(HOME, value.slice(2)) : value;
}

async function pointsToThisRepo(value: string): Promise<boolean> {
	const resolved = path.resolve(expandTildePath(value));
	if (!resolved.startsWith(`${EXT_DIR}${path.sep}`)) return false;

	const target = await fs.readlink(resolved).catch(() => null);
	if (!target) return false;

	const targetPath = path.resolve(path.dirname(resolved), target);
	return targetPath === REPO || targetPath.startsWith(`${REPO}${path.sep}`);
}

export async function mergeExtensionList(previous: unknown, registeredExtensions: string[]): Promise<string[]> {
	const existing = Array.isArray(previous)
		? previous.filter((value): value is string => typeof value === "string")
		: [];
	const registeredByName = new Map(registeredExtensions.map(extension => [extName(extension), extension]));
	const handledNames = new Set<string>();
	const merged: string[] = [];

	for (const value of existing) {
		const name = extName(value);
		const registered = registeredByName.get(name);
		if (registered) {
			merged.push(registered);
			handledNames.add(name);
			continue;
		}

		if (!(await pointsToThisRepo(value))) merged.push(value);
	}

	for (const extension of registeredExtensions) {
		if (!handledNames.has(extName(extension))) merged.push(extension);
	}

	return Array.from(new Set(merged));
}

async function pathExists(p: string): Promise<boolean> {
	return fs.stat(p).then(
		stat => stat.isFile(),
		() => false,
	);
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

export async function removeStaleManagedDiscoveryFiles(destDir: string, entryFile: string): Promise<void> {
	const stale = ["package.json", "index.ts"].filter(file => file !== entryFile);
	await Promise.all(stale.map(file => fs.rm(path.join(destDir, file), { force: true })));
}

async function main(): Promise<void> {
	const repoSettings = await readJson<RepoSettings>(path.join(REPO, ".omp", "settings.json"));
	const sources = (repoSettings?.extensions ?? []).filter(extensionPath =>
		Boolean(ENABLED_EXTENSION_NAMES[extName(extensionPath)]),
	);
	if (sources.length === 0) {
		console.log("No fork-managed extensions enabled.");
		return;
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
			console.warn(`SKIP  ${name}: bundle not built -> ${rel}  (run: just build-exts)`);
			continue;
		}

		console.log(`${DRY ? "[dry] " : ""}link  ${rel}  ->  ${tildePath}`);
		if (!DRY) {
			await fs.mkdir(destDir, { recursive: true });
			await fs.rm(dest, { force: true });
			await fs.symlink(src, dest);
			await removeStaleManagedDiscoveryFiles(destDir, file);
		}
		registered.push(tildePath);
	}

	// Merge into user settings.json, preserving external extension paths but making
	// every repo-managed extension authoritative. Never rewrite config.yml here:
	// profiles, model defaults, disabled capabilities, and symlink targets must persist.
	if (PRESERVE_SETTINGS) {
		console.log(`\nPreserve ${USER_SETTINGS}`);
	} else {
		const settingsJson = (await readJson<Record<string, unknown>>(USER_SETTINGS)) ?? {};
		const settingsJsonExtensions = await mergeExtensionList(settingsJson.extensions, registered);
		settingsJson.extensions = settingsJsonExtensions;

		console.log(`\n${DRY ? "[dry] " : ""}write ${USER_SETTINGS}`);
		console.log(`  extensions (${settingsJsonExtensions.length}):`);
		for (const extension of settingsJsonExtensions) console.log(`    ${extension}`);

		if (!DRY) {
			await fs.mkdir(USER_DIR, { recursive: true });
			await fs.writeFile(USER_SETTINGS, `${JSON.stringify(settingsJson, null, 2)}\n`);
		}
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
		console.error("  just build-exts && just install-user");
		process.exit(1);
	}

	if (verifyErrors.length > 0) {
		console.error("\nExtension install verification failed:");
		for (const error of verifyErrors) console.error(`  ${error}`);
		process.exit(1);
	}

	console.log(`\nDone. omp now loads these from any cwd. Verified ${registered.length} extension symlink(s).`);
}

if (import.meta.main) {
	await main();
}
