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

import { homedir } from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

const REPO = path.resolve(import.meta.dir, "..");
const HOME = homedir();
const USER_DIR = path.join(HOME, ".omp", "agent");
const EXT_DIR = path.join(USER_DIR, "extensions");
const USER_SETTINGS = path.join(USER_DIR, "settings.json");
const DRY = process.argv.includes("--dry-run");

// Derive a stable folder name from a source bundle path.
//   packages/pi-observer/dist/observer.bundle.js   -> pi-observer
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


const repoSettings = await readJson<{ extensions?: string[] }>(path.join(REPO, ".omp", "settings.json"));
const sources = repoSettings?.extensions ?? [];
if (sources.length === 0) {
	console.error("No extensions found in repo .omp/settings.json#extensions");
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
		console.warn(`SKIP  ${name}: bundle not built -> ${rel}  (run: just build-exts)`);
		continue;
	}

	console.log(`${DRY ? "[dry] " : ""}link  ${rel}  ->  ${tildePath}`);
	if (!DRY) {
		await fs.mkdir(destDir, { recursive: true });
		await fs.rm(dest, { force: true });
		await fs.symlink(src, dest);
	}
	registered.push(tildePath);
}

// Merge into user settings, preserving any existing keys/extensions.
const existing = (await readJson<Record<string, unknown>>(USER_SETTINGS)) ?? {};
const prev = Array.isArray(existing.extensions) ? (existing.extensions as string[]) : [];
const merged = Array.from(new Set([...prev, ...registered]));
const next = { ...existing, extensions: merged };

console.log(`\n${DRY ? "[dry] " : ""}write ${USER_SETTINGS}`);
console.log(`  extensions (${merged.length}):`);
for (const e of merged) console.log(`    ${e}`);

if (!DRY) {
	await fs.mkdir(USER_DIR, { recursive: true });
	await fs.writeFile(USER_SETTINGS, `${JSON.stringify(next, null, 2)}\n`);
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
