import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	adaptSchemaForStrict,
	normalizeSchemaForCCA,
	normalizeSchemaForGoogle,
	type SchemaCompatibilityProvider,
	type SchemaCompatibilityResult,
	toolWireSchema,
	validateSchemaCompatibility,
	validateStrictSchemaEnforcement,
} from "@oh-my-pi/pi-ai/utils/schema";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { createTools, HIDDEN_TOOLS, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

export interface ToolSchemaEntry {
	name: string;
	schema: Record<string, unknown>;
}

export function createToolSchemaTestSession(): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

function asSchemaObject(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

export async function collectBuiltinAndHiddenToolSchemas(): Promise<ToolSchemaEntry[]> {
	const session = createToolSchemaTestSession();
	const byToolName = new Map<string, Record<string, unknown>>();

	for (const tool of await createTools(session)) {
		const schema = toolWireSchema(tool);
		if (!asSchemaObject(schema)) {
			continue;
		}
		byToolName.set(tool.name, schema);
	}

	for (const [name, factory] of Object.entries(HIDDEN_TOOLS)) {
		const tool = await factory(session);
		if (!tool) {
			continue;
		}
		const schema = toolWireSchema(tool);
		if (!asSchemaObject(schema)) {
			continue;
		}
		byToolName.set(name, schema);
	}

	return [...byToolName.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, schema]) => ({ name, schema }));
}

async function readExtensionManifestEntries(dir: string): Promise<string[]> {
	const packageJsonPath = path.join(dir, "package.json");
	try {
		const pkg = (await Bun.file(packageJsonPath).json()) as {
			omp?: { extensions?: string[] };
			pi?: { extensions?: string[] };
		};
		const manifest = pkg.omp ?? pkg.pi;
		if (!manifest?.extensions?.length) {
			return [];
		}
		const entries: string[] = [];
		for (const extensionPath of manifest.extensions) {
			const resolvedPath = path.resolve(dir, extensionPath);
			try {
				await fs.access(resolvedPath);
				entries.push(resolvedPath);
			} catch {}
		}
		return entries;
	} catch {
		return [];
	}
}

async function resolveExtensionEntries(dir: string): Promise<string[]> {
	const manifestEntries = await readExtensionManifestEntries(dir);
	if (manifestEntries.length > 0) {
		return manifestEntries;
	}

	for (const entryName of ["index.ts", "index.js"]) {
		const extensionEntry = path.join(dir, entryName);
		try {
			await fs.access(extensionEntry);
			return [extensionEntry];
		} catch {}
	}

	return [];
}

export async function collectCheckedInExtensionEntryPaths(extensionsRoot: string): Promise<string[]> {
	const dirents = await fs.readdir(extensionsRoot, { withFileTypes: true });
	const extensionEntries: string[] = [];

	for (const dirent of dirents) {
		const entryPath = path.join(extensionsRoot, dirent.name);
		if (
			(dirent.isFile() || dirent.isSymbolicLink()) &&
			(dirent.name.endsWith(".ts") || dirent.name.endsWith(".js"))
		) {
			extensionEntries.push(entryPath);
			continue;
		}
		if (!dirent.isDirectory() && !dirent.isSymbolicLink()) {
			continue;
		}
		extensionEntries.push(...(await resolveExtensionEntries(entryPath)));
	}

	return extensionEntries.sort((left, right) => left.localeCompare(right));
}

export async function collectExtensionToolSchemas(extensionPaths: string[], cwd: string): Promise<ToolSchemaEntry[]> {
	const result = await loadExtensions(extensionPaths, cwd);
	if (result.errors.length > 0) {
		throw new Error(result.errors.map(error => `${error.path}: ${error.error}`).join("\n"));
	}

	return result.extensions
		.flatMap(extension =>
			[...extension.tools.entries()].flatMap(([name, tool]) => {
				const schema = toolWireSchema(tool.definition);
				if (!asSchemaObject(schema)) {
					return [];
				}
				return [{ name: `${path.basename(extension.path)}:${name}`, schema }];
			}),
		)
		.sort((left, right) => left.name.localeCompare(right.name));
}

export function formatCompatibilityIssues(
	toolName: string,
	provider: SchemaCompatibilityProvider,
	result: SchemaCompatibilityResult,
): string {
	if (result.compatible) {
		return "";
	}
	const details = result.violations
		.map(violation => `  - ${violation.rule} at ${violation.path}: ${violation.message}`)
		.join("\n");
	return `${toolName} (${provider}):\n${details}`;
}

export function collectCompatibilityFailures(toolSchemas: ToolSchemaEntry[]): string[] {
	const failures: string[] = [];

	for (const { name, schema } of toolSchemas) {
		const strictResult = adaptSchemaForStrict(schema, true);
		const strictCompatibility = validateStrictSchemaEnforcement(schema, strictResult);
		if (!strictCompatibility.compatible) {
			failures.push(formatCompatibilityIssues(name, "openai-strict", strictCompatibility));
		}

		try {
			const googleSchema = normalizeSchemaForGoogle(schema);
			const googleCompatibility = validateSchemaCompatibility(googleSchema, "google");
			if (!googleCompatibility.compatible) {
				failures.push(formatCompatibilityIssues(name, "google", googleCompatibility));
			}
		} catch (error) {
			failures.push(`${name} (google): normalizeSchemaForGoogle threw: ${String(error)}`);
		}

		const cloudCodeAssistSchema = normalizeSchemaForCCA(schema);
		const cloudCodeAssistCompatibility = validateSchemaCompatibility(
			cloudCodeAssistSchema,
			"cloud-code-assist-claude",
		);
		if (!cloudCodeAssistCompatibility.compatible) {
			failures.push(formatCompatibilityIssues(name, "cloud-code-assist-claude", cloudCodeAssistCompatibility));
		}
	}

	return failures;
}
