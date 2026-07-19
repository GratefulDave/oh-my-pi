#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";

const DEFAULT_AGENT_MODEL = "openai-codex/gpt-5.6-terra:auto";
const REQUIRED_AGENT_OVERRIDES: Record<string, string> = {
	designer: "openai-codex/gpt-5.6-sol:auto",
	explore: "openai-codex/gpt-5.6-luna:auto",
	librarian: "openai-codex/gpt-5.6-luna:auto",
	plan: "openai-codex/gpt-5.6-terra:auto",
	reviewer: "openai-codex/gpt-5.6-terra:auto",
	scout: "openai-codex/gpt-5.6-luna:auto",
	sonic: "openai-codex/gpt-5.6-luna:auto",
	task: "openai-codex/gpt-5.6-terra:auto",
	tester: "openai-codex/gpt-5.6-terra:auto",
};
const OPENROUTER_FALLBACKS: Record<string, string> = {
	"claude-opus": "openai-codex/gpt-5.6-sol:auto",
	"claude-sonnet": "openai-codex/gpt-5.6-terra:auto",
	"claude-haiku": "openai-codex/gpt-5.6-luna:auto",
};

type SettingsRecord = Record<string, unknown>;

function isRecord(value: unknown): value is SettingsRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function remapOpenRouterSelector(value: unknown): unknown {
	if (typeof value !== "string" || !value.toLowerCase().startsWith("openrouter/")) return value;
	const normalized = value.toLowerCase();
	return (
		Object.entries(OPENROUTER_FALLBACKS).find(([family]) => normalized.includes(family))?.[1] ?? DEFAULT_AGENT_MODEL
	);
}

export function normalizeAgentDefaults(settings: SettingsRecord): boolean {
	const existingTask = settings.task;
	const task = isRecord(existingTask) ? existingTask : {};
	const existingOverrides = task.agentModelOverrides;
	const overrides = isRecord(existingOverrides) ? existingOverrides : {};
	const normalizedOverrides = Object.fromEntries(
		Object.entries(overrides).map(([name, value]) => [name, remapOpenRouterSelector(value)]),
	);
	Object.assign(normalizedOverrides, REQUIRED_AGENT_OVERRIDES);

	const nextTask = {
		...task,
		defaultModel: DEFAULT_AGENT_MODEL,
		agentModelOverrides: normalizedOverrides,
	};
	const changed = YAML.stringify(existingTask, null, 2) !== YAML.stringify(nextTask, null, 2);
	settings.task = nextTask;
	return changed;
}

async function configPaths(homeDir: string): Promise<string[]> {
	const candidates: string[] = [];
	for (const configDirName of [".omp", ".lex"]) {
		const configRoot = path.join(homeDir, configDirName);
		candidates.push(path.join(configRoot, "agent", "config.yml"));
		try {
			const profiles = await fs.readdir(path.join(configRoot, "profiles"), { withFileTypes: true });
			for (const profile of profiles) {
				if (profile.isDirectory())
					candidates.push(path.join(configRoot, "profiles", profile.name, "agent", "config.yml"));
			}
		} catch (error) {
			if (!isRecord(error) || error.code !== "ENOENT") throw error;
		}
	}
	return candidates;
}

export async function normalizeAgentConfigFiles(homeDir: string): Promise<string[]> {
	const changed: string[] = [];
	const seen = new Set<string>();
	for (const configPath of await configPaths(homeDir)) {
		let realPath: string;
		try {
			realPath = await fs.realpath(configPath);
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") continue;
			throw error;
		}
		if (seen.has(realPath)) continue;
		seen.add(realPath);
		const parsed: unknown = YAML.parse(await Bun.file(realPath).text());
		if (!isRecord(parsed) || !normalizeAgentDefaults(parsed)) continue;
		await Bun.write(realPath, YAML.stringify(parsed, null, 2));
		changed.push(realPath);
	}
	return changed;
}

if (import.meta.main) {
	const homeFlag = process.argv.indexOf("--home");
	const homeDir = homeFlag >= 0 ? process.argv[homeFlag + 1] : os.homedir();
	if (!homeDir) throw new Error("--home requires a directory");
	const changed = await normalizeAgentConfigFiles(path.resolve(homeDir));
	process.stdout.write(`Agent Codex defaults applied to ${changed.length} config file(s).\n`);
}
