import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface ManagedExtensionSource {
	rel: string;
	name: string;
	source: "settings" | "package-manifest" | "local-extension";
}

interface ExtensionManifest {
	omp?: {
		extensions?: unknown;
	};
	pi?: {
		extensions?: unknown;
	};
}

export function extensionName(rel: string): string {
	const normalized = rel.split(path.sep).join("/");
	const parts = normalized.split("/");
	const packagesIdx = parts.indexOf("packages");
	if (packagesIdx >= 0 && parts[packagesIdx + 1]) return parts[packagesIdx + 1];
	const extensionsIdx = parts.indexOf("extensions");
	if (extensionsIdx >= 0 && parts[extensionsIdx + 1]) return parts[extensionsIdx + 1];
	return path.basename(path.dirname(path.dirname(normalized)));
}

export async function readJson<T>(filePath: string): Promise<T | null> {
	try {
		return (await Bun.file(filePath).json()) as T;
	} catch (err) {
		if (err instanceof SyntaxError || (err instanceof Error && "code" in err && err.code === "ENOENT")) return null;
		throw err;
	}
}

function normalizeRelative(repo: string, filePath: string): string {
	return path.relative(repo, filePath).split(path.sep).join("/");
}

function manifestExtensions(manifest: ExtensionManifest | null): string[] {
	const values = [manifest?.omp?.extensions, manifest?.pi?.extensions];
	return values.flatMap(value => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []));
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		const stat = await fs.stat(filePath);
		return stat.isFile();
	} catch (err) {
		if (err instanceof Error && "code" in err && err.code === "ENOENT") return false;
		throw err;
	}
}

function pushIfNew(
	sources: ManagedExtensionSource[],
	seenNames: Set<string>,
	rel: string,
	source: ManagedExtensionSource["source"],
): void {
	const name = extensionName(rel);
	if (seenNames.has(name)) return;
	seenNames.add(name);
	sources.push({ rel, name, source });
}

export async function discoverManagedExtensionSources(repo: string): Promise<ManagedExtensionSource[]> {
	const sources: ManagedExtensionSource[] = [];
	const seenNames = new Set<string>();
	const settings = await readJson<{ extensions?: unknown }>(path.join(repo, ".omp", "settings.json"));
	if (Array.isArray(settings?.extensions)) {
		for (const value of settings.extensions) {
			if (typeof value !== "string") continue;
			pushIfNew(sources, seenNames, value, "settings");
		}
	}

	const packagesDir = path.join(repo, "packages");
	const packageEntries = await fs.readdir(packagesDir, { withFileTypes: true }).catch(() => []);
	for (const entry of packageEntries) {
		if (!entry.isDirectory()) continue;
		const packageDir = path.join(packagesDir, entry.name);
		const manifest = await readJson<ExtensionManifest>(path.join(packageDir, "package.json"));
		for (const extension of manifestExtensions(manifest)) {
			pushIfNew(sources, seenNames, normalizeRelative(repo, path.resolve(packageDir, extension)), "package-manifest");
		}
	}

	const localExtensionsDir = path.join(repo, ".omp", "extensions");
	const localEntries = await fs.readdir(localExtensionsDir, { withFileTypes: true }).catch(() => []);
	for (const entry of localEntries) {
		if (!entry.isDirectory()) continue;
		const extensionDir = path.join(localExtensionsDir, entry.name);
		const manifest = await readJson<ExtensionManifest>(path.join(extensionDir, "package.json"));
		const manifestSources = manifestExtensions(manifest);
		if (manifestSources.length > 0) {
			for (const extension of manifestSources) {
				pushIfNew(sources, seenNames, normalizeRelative(repo, path.resolve(extensionDir, extension)), "local-extension");
			}
			continue;
		}
		if (await fileExists(path.join(extensionDir, "index.ts"))) {
			pushIfNew(sources, seenNames, `.omp/extensions/${entry.name}/dist/index.js`, "local-extension");
		}
	}

	return sources;
}
