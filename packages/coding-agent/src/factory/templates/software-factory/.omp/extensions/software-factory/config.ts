import * as path from "node:path";

import { getFactoryDir, resolveRepoScopedPath } from "./paths";

export type FactoryPreset = "minimal" | "standard" | "software-factory";
export type FactoryPolicyMode = "block" | "ask" | "advise" | "continue";

export interface FactoryConfig {
	template: {
		name: string;
		version: string;
		preset: FactoryPreset;
	};
	repo: {
		name: string;
		kind: string;
	};
	verifier: {
		enabled: boolean;
		trigger: "manual" | "agent_end";
		agent: string;
		systemPrompt: string;
		prompt: string;
		oracle: string;
		maxLoops: number;
		tools: string[];
	};
	safety: {
		enabled: boolean;
		rulesPath: string;
	};
	metaPrompt: {
		enabled: boolean;
		prompt: string;
	};
	workflow: {
		enabled: boolean;
		default: string;
	};
	memory: {
		captureCandidates: boolean;
		recommendedBackend: string;
	};
}

export interface FactorySafetyRule {
	id: string;
	description?: string;
	tool?: string;
	mode: FactoryPolicyMode;
	commandRegex?: string;
	pathGlobs?: string[];
}

export interface FactorySafetyRules {
	version: number;
	defaultMode: FactoryPolicyMode;
	rules: FactorySafetyRule[];
}

export interface FactoryWorkflowStep {
	id: string;
	agent: string;
	prompt: string;
	requires?: string[];
	outputs?: string[];
	onFailure?: string;
}

export interface FactoryWorkflowDefinition {
	name: string;
	description: string;
	enabled?: boolean;
	maxLoops: number;
	steps: FactoryWorkflowStep[];
}

export interface FactoryMemoryCandidate {
	kind: "error" | "decision" | "workflow" | "preference" | "gap";
	summary: string;
	verification?: string;
	keywords: string[];
	storedAt: string;
	backend: string;
}

export interface FactorySettingsSnapshot {
	memoryBackend: string;
}

async function loadOptionalText(filePath: string): Promise<string | undefined> {
	const file = Bun.file(filePath);
	if (!(await file.exists())) {
		return undefined;
	}
	return await file.text();
}

export async function loadOptionalJson<T>(filePath: string): Promise<T | undefined> {
	const text = await loadOptionalText(filePath);
	if (text === undefined) return undefined;
	return JSON.parse(text) as T;
}

export async function loadFactoryConfig(cwd: string): Promise<FactoryConfig | undefined> {
	return await loadOptionalJson<FactoryConfig>(path.join(getFactoryDir(cwd), "factory.json"));
}

export async function loadFactorySafetyRules(
	cwd: string,
	config?: FactoryConfig,
): Promise<FactorySafetyRules | undefined> {
	const rulesPath = config?.safety.rulesPath ?? "safety.rules.json";
	return await loadOptionalJson<FactorySafetyRules>(resolveFactoryPath(cwd, rulesPath));
}

export async function loadFactoryWorkflow(
	cwd: string,
	workflowName: string,
): Promise<FactoryWorkflowDefinition | undefined> {
	return await loadOptionalJson<FactoryWorkflowDefinition>(
		path.join(getFactoryDir(cwd), "workflows", `${workflowName}.json`),
	);
}

export async function loadFactoryPrompt(cwd: string, relativePath: string): Promise<string | undefined> {
	return await loadOptionalText(resolveFactoryPath(cwd, relativePath));
}

export async function loadFactoryAgentPrompt(cwd: string, relativePath: string): Promise<string | undefined> {
	const raw = await loadOptionalText(resolveFactoryPath(cwd, relativePath));
	if (raw === undefined) return undefined;
	return stripFrontmatter(raw);
}

export async function loadFactorySettings(cwd: string): Promise<FactorySettingsSnapshot> {
	const settingsPath = path.join(cwd, ".omp", "settings.json");
	const settings = (await loadOptionalJson<{ memory?: { backend?: string } }>(settingsPath)) ?? {};
	return {
		memoryBackend: settings.memory?.backend ?? "off",
	};
}

export function resolveFactoryPath(cwd: string, relativePath: string): string {
	return resolveRepoScopedPath(getFactoryDir(cwd), relativePath);
}

export function stripFrontmatter(text: string): string {
	if (!text.startsWith("---\n")) return text.trim();
	const end = text.indexOf("\n---\n", 4);
	if (end < 0) return text.trim();
	return text.slice(end + 5).trim();
}

export function renderFactoryTemplate(template: string, replacements: Record<string, string>): string {
	let rendered = template;
	for (const [key, value] of Object.entries(replacements)) {
		rendered = rendered.split(`__${key}__`).join(value);
	}
	return rendered;
}

export function buildFactoryMemoryCandidate(input: {
	kind: FactoryMemoryCandidate["kind"];
	summary: string;
	verification?: string;
	keywords?: string[];
	backend: string;
}): FactoryMemoryCandidate {
	return {
		kind: input.kind,
		summary: input.summary.trim(),
		verification: input.verification?.trim(),
		keywords: (input.keywords ?? []).map(keyword => keyword.trim()).filter(Boolean),
		storedAt: new Date().toISOString(),
		backend: input.backend,
	};
}
