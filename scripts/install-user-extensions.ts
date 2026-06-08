#!/usr/bin/env bun
// Symlink the repo's compiled extension bundles into ~/.omp/agent/extensions/
// and register them in ~/.omp/agent/config.yml + settings.json (USER scope) so
// omp loads them from ANY working directory — independent of this repo.
//
//   bun scripts/install-user-extensions.ts            # install (build first!)
//   bun scripts/install-user-extensions.ts --dry-run  # show what would happen
//
// Source list is read from the repo's .omp/settings.json#extensions.
// Paths registered use ~ so they stay portable; the loader expands ~ and keeps
// absolute paths as-is (resolveAgainst in omp-extension-roots.ts).

import { YAML } from "bun";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

interface RepoSettings {
	extensions?: string[];
	activeModelProfile?: unknown;
	cycleOrder?: unknown;
	defaultThinkingLevel?: unknown;
	disabledProviders?: unknown;
	enabledModels?: unknown;
	modelProfiles?: unknown;
	modelProviderOrder?: unknown;
	modelRoles?: unknown;
}

interface PackageJson {
	omp?: {
		extensions?: unknown;
	};
}

const PROFILE_KEYS = ["modelRoles", "defaultThinkingLevel", "enabledModels", "cycleOrder", "modelProviderOrder"] as const;

const REPO = path.resolve(import.meta.dir, "..");
const HOME = homedir();
const USER_DIR = path.join(HOME, ".omp", "agent");
const EXT_DIR = path.join(USER_DIR, "extensions");
const USER_CONFIG = path.join(USER_DIR, "config.yml");
const USER_SETTINGS = path.join(USER_DIR, "settings.json");
const DRY = process.argv.includes("--dry-run");

function extName(rel: string): string {
	const parts = rel.split("/");
	const packagesIdx = parts.indexOf("packages");
	if (packagesIdx >= 0 && parts[packagesIdx + 1]) return parts[packagesIdx + 1];
	const extensionsIdx = parts.indexOf("extensions");
	if (extensionsIdx >= 0 && parts[extensionsIdx + 1]) return parts[extensionsIdx + 1];
	return path.basename(path.dirname(path.dirname(rel)));
}

async function readJson<T>(filePath: string): Promise<T | null> {
	try {
		return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
	} catch {
		return null;
	}
}

async function readYaml(filePath: string): Promise<Record<string, unknown> | null> {
	try {
		const parsed = YAML.parse(await fs.readFile(filePath, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function cloneValue<T>(value: T): T {
	if (Array.isArray(value)) {
		return value.map(item => cloneValue(item)) as T;
	}
	if (value && typeof value === "object") {
		const cloned: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value)) {
			cloned[key] = cloneValue(child);
		}
		return cloned as T;
	}
	return value;
}

function normalizeAntigravityConfig(value: unknown, key = ""): unknown {
	if (typeof value === "string") {
		return value.startsWith("antigravity/") ? `google-antigravity/${value.slice("antigravity/".length)}` : value;
	}
	if (Array.isArray(value)) {
		const normalized = value.map(item => normalizeAntigravityConfig(item, key));
		if (key === "disabledProviders") {
			return normalized.filter(item => item !== "google-antigravity");
		}
		return normalized.filter(item => item !== "antigravity" && item !== "antigravity/*");
	}
	if (value && typeof value === "object") {
		const normalized: Record<string, unknown> = {};
		for (const [childKey, childValue] of Object.entries(value)) {
			normalized[childKey] = normalizeAntigravityConfig(childValue, childKey);
		}
		return normalized;
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function applyActiveProfile(settings: Record<string, unknown>): void {
	const active = settings.activeModelProfile;
	const profiles = settings.modelProfiles;
	if (typeof active !== "string" || !isRecord(profiles) || !isRecord(profiles[active])) return;
	const profile = profiles[active];
	for (const key of PROFILE_KEYS) {
		const value = profile[key];
		if (Array.isArray(value)) {
			settings[key] = [...value];
		} else if (isRecord(value)) {
			settings[key] = { ...value };
		} else if (typeof value === "string") {
			settings[key] = value;
		}
	}
}

function buildActiveProfileSnapshot(repoSettings: Record<string, unknown>): Record<string, unknown> {
	const snapshot: Record<string, unknown> = {};
	for (const key of PROFILE_KEYS) {
		const value = repoSettings[key];
		if (value !== undefined) {
			snapshot[key] = cloneValue(value);
		}
	}
	return snapshot;
}

function syncManagedSettings(target: Record<string, unknown>, repoSettings: Record<string, unknown>): void {
	const activeProfile = repoSettings.activeModelProfile;
	if (typeof activeProfile === "string") {
		target.activeModelProfile = activeProfile;
	}
	if (repoSettings.disabledProviders !== undefined) {
		target.disabledProviders = cloneValue(repoSettings.disabledProviders);
	}
	for (const key of PROFILE_KEYS) {
		const value = repoSettings[key];
		if (value !== undefined) {
			target[key] = cloneValue(value);
		}
	}

	const nextProfiles: Record<string, unknown> = isRecord(target.modelProfiles)
		? { ...target.modelProfiles }
		: {};
	if (isRecord(repoSettings.modelProfiles)) {
		for (const [name, value] of Object.entries(repoSettings.modelProfiles)) {
			nextProfiles[name] = cloneValue(value);
		}
	}
	if (typeof activeProfile === "string") {
		nextProfiles[activeProfile] = {
			...(isRecord(nextProfiles[activeProfile]) ? nextProfiles[activeProfile] : {}),
			...buildActiveProfileSnapshot(repoSettings),
		};
	}
	if (Object.keys(nextProfiles).length > 0) {
		target.modelProfiles = nextProfiles;
	}
}

function isManagedExtensionPath(value: string, managedNames: Set<string>): boolean {
	return (
		managedNames.has(extName(value)) ||
		value.startsWith("~/.omp/agent/extensions/") ||
		path.resolve(value).startsWith(`${EXT_DIR}${path.sep}`)
	);
}

async function pathExists(filePath: string): Promise<boolean> {
	return fs.stat(filePath).then(
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

const repoSettings = normalizeAntigravityConfig(
	(await readJson<RepoSettings>(path.join(REPO, ".omp", "settings.json"))) ?? {},
) as Record<string, unknown>;
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
		await fs.rm(dest, { force: true });
		await fs.symlink(src, dest);
	}
	registered.push(tildePath);
}

const managedNames = new Set(registered.map(extName));
function mergeExtensionList(previous: unknown): string[] {
	const existing = Array.isArray(previous) ? previous.filter((value): value is string => typeof value === "string") : [];
	const unmanaged = existing.filter(value => !isManagedExtensionPath(value, managedNames));
	return Array.from(new Set([...unmanaged, ...registered]));
}

const settingsJson = normalizeAntigravityConfig((await readJson<Record<string, unknown>>(USER_SETTINGS)) ?? {}) as Record<
	string,
	unknown
>;
syncManagedSettings(settingsJson, repoSettings);
settingsJson.extensions = mergeExtensionList(settingsJson.extensions);
applyActiveProfile(settingsJson);

const configYaml = normalizeAntigravityConfig((await readYaml(USER_CONFIG)) ?? {}) as Record<string, unknown>;
syncManagedSettings(configYaml, repoSettings);
configYaml.extensions = mergeExtensionList(configYaml.extensions);
applyActiveProfile(configYaml);

console.log(`\n${DRY ? "[dry] " : ""}write ${USER_SETTINGS}`);
console.log(`  activeModelProfile: ${String(settingsJson.activeModelProfile ?? "(unset)")}`);
console.log(`  extensions (${(settingsJson.extensions as string[]).length}):`);
for (const extension of settingsJson.extensions as string[]) console.log(`    ${extension}`);
console.log(`${DRY ? "[dry] " : ""}write ${USER_CONFIG}`);
console.log(`  activeModelProfile: ${String(configYaml.activeModelProfile ?? "(unset)")}`);
console.log(`  extensions (${(configYaml.extensions as string[]).length}):`);
for (const extension of configYaml.extensions as string[]) console.log(`    ${extension}`);

if (!DRY) {
	await fs.mkdir(USER_DIR, { recursive: true });
	await fs.writeFile(USER_SETTINGS, `${JSON.stringify(settingsJson, null, 2)}\n`);
	await fs.writeFile(USER_CONFIG, YAML.stringify(configYaml, null, 2));
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

console.log(`\nDone. omp and lex now load the same ${registered.length} managed extension(s) from any cwd.`);
