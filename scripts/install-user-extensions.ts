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
import { discoverManagedExtensionSources, extensionName as extName, readJson } from "./fork-managed-extensions";

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

export interface InstallUserExtensionsOptions {
	repo?: string;
	home?: string;
	dryRun?: boolean;
}

const PROFILE_KEYS = ["modelRoles", "defaultThinkingLevel", "enabledModels", "cycleOrder", "modelProviderOrder"] as const;
const RETIRED_EXTENSION_NAMES = new Set(["antigravity-adapter"]);
const RETIRED_PROVIDER_IDS = new Set(["opencode-antigravity", "google-antigravity"]);
const GOOGLE_ANTIGRAVITY_MODEL_REPLACEMENTS: Record<string, { id: string; thinking?: string }> = {
	"claude-sonnet-4-6": { id: "claude-sonnet-4-6" },
	"claude-opus-4-6-thinking": { id: "claude-opus-4-6-thinking" },
	"gemini-3.1-pro": { id: "gemini-3.1-pro" },
	"gemini-pro-agent": { id: "gemini-3.1-pro" },
	"gemini-3-flash": { id: "gemini-3-flash" },
	"gemini-3-flash-agent": { id: "gemini-3-flash" },
	"gemini-3.5-flash": { id: "gemini-3.5-flash" },
	"gemini-3.5-flash-low": { id: "gemini-3.5-flash", thinking: "low" },
	"gemini-3.5-flash-extra-low": { id: "gemini-3.5-flash", thinking: "low" },
};

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

	const nextProfiles: Record<string, unknown> = isRecord(target.modelProfiles) ? { ...target.modelProfiles } : {};
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

function isManagedExtensionPath(value: string, managedNames: Set<string>, extDir: string): boolean {
	return (
		managedNames.has(extName(value)) ||
		RETIRED_EXTENSION_NAMES.has(extName(value)) ||
		value.startsWith("~/.omp/agent/extensions/") ||
		path.resolve(value).startsWith(`${extDir}${path.sep}`)
	);
}

function replaceGoogleAntigravityModel(value: string): string | undefined {
	const modelWithThinking = value.slice("google-antigravity/".length);
	const separator = modelWithThinking.indexOf(":");
	const modelId = separator >= 0 ? modelWithThinking.slice(0, separator) : modelWithThinking;
	const originalThinking = separator >= 0 ? modelWithThinking.slice(separator + 1) : undefined;
	const replacement = GOOGLE_ANTIGRAVITY_MODEL_REPLACEMENTS[modelId];
	if (!replacement) return undefined;
	const thinking = originalThinking ?? replacement.thinking;
	return `antigravity/${replacement.id}${thinking ? `:${thinking}` : ""}`;
}

function pruneRetiredAntigravityProviders(value: unknown, key = ""): unknown {
	if (Array.isArray(value)) {
		const seen = new Set<string>();
		const pruned: unknown[] = [];
		for (const item of value) {
			const next = key === "disabledProviders" && typeof item === "string" && RETIRED_PROVIDER_IDS.has(item)
				? item
				: pruneRetiredAntigravityProviders(item, key);
			if (next === undefined) continue;
			if (key !== "disabledProviders" && typeof next === "string" && RETIRED_PROVIDER_IDS.has(next.replace(/\/\*$/, ""))) {
				continue;
			}
			if (typeof next === "string") {
				if (seen.has(next)) continue;
				seen.add(next);
			}
			pruned.push(next);
		}
		return pruned;
	}
	if (typeof value === "string") {
		if (key === "disabledProviders" && RETIRED_PROVIDER_IDS.has(value)) return value;
		if (value.startsWith("opencode-antigravity/antigravity-")) {
			return `antigravity/${value.slice("opencode-antigravity/antigravity-".length)}`;
		}
		if (value.startsWith("opencode-antigravity/")) {
			return `antigravity/${value.slice("opencode-antigravity/".length)}`;
		}
		if (value.startsWith("google-antigravity/")) return replaceGoogleAntigravityModel(value);
		return value;
	}
	if (isRecord(value)) {
		const pruned: Record<string, unknown> = {};
		for (const [childKey, childValue] of Object.entries(value)) {
			const next = pruneRetiredAntigravityProviders(childValue, childKey);
			if (next !== undefined) pruned[childKey] = next;
		}
		return pruned;
	}
	return value;
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

export async function installUserExtensions(options: InstallUserExtensionsOptions = {}): Promise<void> {
	const repo = path.resolve(options.repo ?? path.join(import.meta.dir, ".."));
	const home = options.home ?? homedir();
	const dry = options.dryRun ?? process.argv.includes("--dry-run");
	const userDir = path.join(home, ".omp", "agent");
	const extDir = path.join(userDir, "extensions");
	const userConfig = path.join(userDir, "config.yml");
	const userSettings = path.join(userDir, "settings.json");

	const repoSettings = ((await readJson<RepoSettings>(path.join(repo, ".omp", "settings.json"))) ?? {}) as Record<string, unknown>;
	const sources = await discoverManagedExtensionSources(repo);
	const sourceRels = sources.map(source => source.rel);
	if (sourceRels.length === 0) {
		throw new Error("No managed extensions found in .omp/settings.json, package manifests, or .omp/extensions");
	}

	const registered: string[] = [];
	const missing: string[] = [];
	for (const rel of sourceRels) {
		const src = path.resolve(repo, rel);
		const name = extName(rel);
		const file = path.basename(rel);
		const destDir = path.join(extDir, name);
		const dest = path.join(destDir, file);
		const tildePath = path.join("~/.omp/agent/extensions", name, file);

		if (!(await pathExists(src))) {
			missing.push(rel);
			console.warn(`SKIP  ${name}: bundle not built -> ${rel}  (run: bun scripts/rebuild-extensions.ts)`);
			continue;
		}

		console.log(`${dry ? "[dry] " : ""}link  ${rel}  ->  ${tildePath}`);
		if (!dry) {
			await fs.mkdir(destDir, { recursive: true });
			await fs.rm(dest, { force: true });
			await fs.symlink(src, dest);
		}
		registered.push(tildePath);
	}

	const managedNames = new Set(registered.map(extName));
	function mergeExtensionList(previous: unknown): string[] {
		const existing = Array.isArray(previous) ? previous.filter((value): value is string => typeof value === "string") : [];
		const unmanaged = existing.filter(value => !isManagedExtensionPath(value, managedNames, extDir));
		return Array.from(new Set([...unmanaged, ...registered]));
	}

	const settingsJson = ((await readJson<Record<string, unknown>>(userSettings)) ?? {}) as Record<string, unknown>;
	syncManagedSettings(settingsJson, repoSettings);
	settingsJson.extensions = mergeExtensionList(settingsJson.extensions);
	const prunedSettingsJson = pruneRetiredAntigravityProviders(settingsJson) as Record<string, unknown>;
	applyActiveProfile(prunedSettingsJson);

	const configYaml = ((await readYaml(userConfig)) ?? {}) as Record<string, unknown>;
	syncManagedSettings(configYaml, repoSettings);
	configYaml.extensions = mergeExtensionList(configYaml.extensions);
	const prunedConfigYaml = pruneRetiredAntigravityProviders(configYaml) as Record<string, unknown>;
	applyActiveProfile(prunedConfigYaml);

	console.log(`\n${dry ? "[dry] " : ""}write ${userSettings}`);
	console.log(`  activeModelProfile: ${String(prunedSettingsJson.activeModelProfile ?? "(unset)")}`);
	console.log(`  extensions (${(prunedSettingsJson.extensions as string[]).length}):`);
	for (const extension of prunedSettingsJson.extensions as string[]) console.log(`    ${extension}`);
	console.log(`${dry ? "[dry] " : ""}write ${userConfig}`);
	console.log(`  activeModelProfile: ${String(prunedConfigYaml.activeModelProfile ?? "(unset)")}`);
	console.log(`  extensions (${(prunedConfigYaml.extensions as string[]).length}):`);
	for (const extension of prunedConfigYaml.extensions as string[]) console.log(`    ${extension}`);

	if (!dry) {
		await fs.mkdir(userDir, { recursive: true });
		await fs.writeFile(userSettings, `${JSON.stringify(prunedSettingsJson, null, 2)}\n`);
		await fs.writeFile(userConfig, YAML.stringify(prunedConfigYaml, null, 2));
	}

	const verifyErrors: string[] = [];
	if (!dry) {
		for (const rel of sourceRels) {
			const src = path.resolve(repo, rel);
			if (!(await pathExists(src))) continue;
			const name = extName(rel);
			const file = path.basename(rel);
			const dest = path.join(extDir, name, file);
			const error = await verifyLink(dest, src);
			if (error) verifyErrors.push(error);
		}
		for (const retiredName of RETIRED_EXTENSION_NAMES) {
			await fs.rm(path.join(extDir, retiredName), { recursive: true, force: true });
		}
	}

	if (missing.length > 0) {
		console.error(`\n${missing.length} required extension bundle(s) not built:`);
		for (const rel of missing) console.error(`  ${rel}`);
		console.error("Build failed bundles, then re-run:");
		console.error("  bun scripts/rebuild-extensions.ts && bun scripts/install-user-extensions.ts");
		throw new Error(`${missing.length} required extension bundle(s) not built`);
	}

	if (verifyErrors.length > 0) {
		console.error("\nExtension install verification failed:");
		for (const error of verifyErrors) console.error(`  ${error}`);
		throw new Error("Extension install verification failed");
	}

	console.log(`\nDone. omp and lex now load the same ${registered.length} managed extension(s) from any cwd.`);
}

if (import.meta.main) {
	await installUserExtensions();
}
