import * as fs from "node:fs/promises";
import * as path from "node:path";

import { isEnoent } from "@oh-my-pi/pi-utils";

import { getSoftwareFactoryManifest, getSoftwareFactoryTemplateFile } from "./template-manifest";

export type FactoryPreset = "minimal" | "standard" | "software-factory";

export interface FactoryInitOptions {
	cwd: string;
	preset: FactoryPreset;
	dryRun: boolean;
	existing: boolean;
	force: boolean;
	enableMemory: boolean;
}

export interface FactoryRepoContext {
	repoName: string;
	repoKind: string;
	guidanceReferences: string[];
	verifySuggestions: string[];
	hasExistingOmp: boolean;
	legacySources: string[];
}

export interface FactoryPlannedFile {
	target: string;
	source: string;
	action: "create" | "overwrite" | "skip";
}

export interface FactoryImportPlan {
	source: string;
	target: string;
	action: "copy" | "skip";
}

export interface FactoryScaffoldPlan {
	preset: FactoryPreset;
	cwd: string;
	repoName: string;
	repoKind: string;
	memoryBackend: string;
	files: FactoryPlannedFile[];
	imports: FactoryImportPlan[];
	warnings: string[];
}

async function exists(targetPath: string): Promise<boolean> {
	try {
		await fs.stat(targetPath);
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

async function loadPackageScripts(cwd: string): Promise<Record<string, string>> {
	const packageJsonPath = path.join(cwd, "package.json");
	if (!(await exists(packageJsonPath))) return {};
	const raw = await Bun.file(packageJsonPath).json();
	const value = raw as { scripts?: Record<string, string> };
	return value.scripts ?? {};
}

async function detectVerifySuggestions(cwd: string): Promise<string[]> {
	const suggestions: string[] = [];
	const packageScripts = await loadPackageScripts(cwd);
	if (packageScripts.test) suggestions.push("bun test");
	if (packageScripts.check) suggestions.push("bun run check");
	if (packageScripts["check:types"]) suggestions.push("bun run check:types");
	if (packageScripts.lint) suggestions.push("bun run lint");
	if (await exists(path.join(cwd, "Cargo.toml"))) suggestions.push("cargo test");
	if (await exists(path.join(cwd, "pyproject.toml"))) suggestions.push("pytest");
	if (await exists(path.join(cwd, "go.mod"))) suggestions.push("go test ./...");
	if (suggestions.length === 0) suggestions.push("# TODO: replace with repo-specific verification commands");
	return suggestions;
}

async function detectGuidanceReferences(cwd: string): Promise<string[]> {
	const candidates = [
		"AGENTS.md",
		"CLAUDE.md",
		"CODEX.md",
		"GEMINI.md",
		"README.md",
		".claude",
		".codex",
		".gemini",
		".pi",
	];
	const references: string[] = [];
	for (const candidate of candidates) {
		if (await exists(path.join(cwd, candidate))) {
			references.push(candidate);
		}
	}
	return references;
}

async function detectRepoKind(cwd: string): Promise<string> {
	const kinds: string[] = [];
	if (await exists(path.join(cwd, "package.json"))) kinds.push("javascript");
	if (await exists(path.join(cwd, "Cargo.toml"))) kinds.push("rust");
	if (await exists(path.join(cwd, "pyproject.toml"))) kinds.push("python");
	if (await exists(path.join(cwd, "go.mod"))) kinds.push("go");
	return kinds.length > 0 ? kinds.join("+") : "generic";
}

async function detectLegacySources(cwd: string): Promise<string[]> {
	const candidates = [".claude", ".codex", ".gemini", ".pi"];
	const found: string[] = [];
	for (const candidate of candidates) {
		const fullPath = path.join(cwd, candidate);
		if (await exists(fullPath)) found.push(fullPath);
	}
	return found;
}

export async function inspectFactoryRepo(cwd: string): Promise<FactoryRepoContext> {
	return {
		repoName: path.basename(cwd),
		repoKind: await detectRepoKind(cwd),
		guidanceReferences: await detectGuidanceReferences(cwd),
		verifySuggestions: await detectVerifySuggestions(cwd),
		hasExistingOmp: await exists(path.join(cwd, ".omp")),
		legacySources: await detectLegacySources(cwd),
	};
}

function verifySuggestionLines(suggestions: string[]): string {
	return suggestions.map(command => `echo "  - ${command.replace(/"/g, '\\"')}"`).join("\n");
}

function guidanceReferenceLines(references: string[]): string {
	if (references.length === 0) return "- No extra repo guidance files detected.";
	return references.map(reference => `- ${reference}`).join("\n");
}


async function renderTemplateContent(source: string, repo: FactoryRepoContext, options: FactoryInitOptions): Promise<string> {
	const rendered = (await getSoftwareFactoryTemplateFile(source))
		.split("__FACTORY_TEMPLATE_VERSION__")
		.join(getSoftwareFactoryManifest().version)
		.split("__FACTORY_PRESET__")
		.join(options.preset)
		.split("__FACTORY_REPO_NAME__")
		.join(repo.repoName)
		.split("__FACTORY_REPO_KIND__")
		.join(repo.repoKind)
		.split("__FACTORY_GUIDANCE_REFERENCES__")
		.join(guidanceReferenceLines(repo.guidanceReferences))
		.split("__FACTORY_VERIFY_COMMANDS__")
		.join(verifySuggestionLines(repo.verifySuggestions))
		.split("__FACTORY_MEMORY_BACKEND__")
		.join(options.enableMemory ? "icm" : "off");
	if (source === ".omp/factory/factory.json") {
		const json = JSON.parse(rendered) as {
			verifier: { enabled: boolean };
			workflow: { enabled: boolean };
		};
		json.verifier.enabled = options.preset !== "minimal";
		json.workflow.enabled = options.preset === "software-factory";
		return `${JSON.stringify(json, null, 2)}\n`;
	}
	return rendered;
}

async function writeRenderedFile(targetPath: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(targetPath), { recursive: true });
	await Bun.write(targetPath, content);
}

async function loadExistingSettings(cwd: string): Promise<Record<string, unknown> | undefined> {
	const settingsPath = path.join(cwd, ".omp", "settings.json");
	if (!(await exists(settingsPath))) return undefined;
	return (await Bun.file(settingsPath).json()) as Record<string, unknown>;
}

function mergeSettings(existing: Record<string, unknown> | undefined, enableMemory: boolean): Record<string, unknown> | undefined {
	if (!enableMemory) return existing;
	const next = { ...(existing ?? {}) };
	const memory = { ...((next.memory as Record<string, unknown> | undefined) ?? {}), backend: "icm" };
	return { ...next, memory };
}

async function copyLegacySource(source: string, target: string): Promise<void> {
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.cp(source, target, { recursive: true, force: false, errorOnExist: false });
}

export async function buildFactoryScaffoldPlan(options: FactoryInitOptions): Promise<FactoryScaffoldPlan> {
	const repo = await inspectFactoryRepo(options.cwd);
	const manifest = getSoftwareFactoryManifest();
	const files: FactoryPlannedFile[] = [];
	for (const entry of manifest.files) {
		if (entry.target === ".omp/settings.json" && !options.enableMemory) continue;
		const target = path.join(options.cwd, entry.target);
		const present = await exists(target);
		files.push({
			target,
			source: entry.source,
			action: present ? (options.force ? "overwrite" : "skip") : "create",
		});
	}
	const imports: FactoryImportPlan[] = [];
	if (options.existing) {
		for (const source of repo.legacySources) {
			const target = path.join(options.cwd, ".omp", "factory", "imported", path.basename(source));
			imports.push({
				source,
				target,
				action: (await exists(target)) && !options.force ? "skip" : "copy",
			});
		}
	}
	const warnings = [];
	if (repo.hasExistingOmp && !options.existing) {
		warnings.push("Existing .omp directory detected. Use --existing to import legacy workspace assets conservatively.");
	}
	if (!options.enableMemory) {
		warnings.push("Memory backend left off. Enable intentionally per repo when ready.");
	}
	return {
		preset: options.preset,
		cwd: options.cwd,
		repoName: repo.repoName,
		repoKind: repo.repoKind,
		memoryBackend: options.enableMemory ? "icm" : "off",
		files,
		imports,
		warnings,
	};
}

export async function applyFactoryScaffold(options: FactoryInitOptions): Promise<FactoryScaffoldPlan> {
	const plan = await buildFactoryScaffoldPlan(options);
	if (options.dryRun) return plan;
	const repo = await inspectFactoryRepo(options.cwd);
	for (const file of plan.files) {
		if (file.action === "skip") continue;
		const content = await renderTemplateContent(file.source, repo, options);
		if (path.basename(file.target) === "settings.json") {
			const merged = mergeSettings(await loadExistingSettings(options.cwd), options.enableMemory);
			if (merged) {
				await writeRenderedFile(file.target, `${JSON.stringify(merged, null, 2)}\n`);
			}
			continue;
		}
		await writeRenderedFile(file.target, content);
	}
	for (const item of plan.imports) {
		if (item.action === "skip") continue;
		await copyLegacySource(item.source, item.target);
	}
	if (plan.imports.length > 0) {
		const importReportPath = path.join(options.cwd, ".omp", "factory", "imported", "import-report.json");
		await writeRenderedFile(
			importReportPath,
			`${JSON.stringify(
				{
					generatedAt: new Date().toISOString(),
					imports: plan.imports,
				},
				null,
				2,
			)}\n`,
		);
	}
	return plan;
}
