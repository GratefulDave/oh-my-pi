import { type Effort, THINKING_EFFORTS } from "@oh-my-pi/pi-ai";
import { COMMAND_NAME } from "@oh-my-pi/pi-utils";
import chalk from "chalk";

import {
	DEFAULT_MODEL_PROFILE_NAME,
	type ModelProfileScopedPath,
	normalizeModelProfileName,
	Settings,
	settings,
} from "../config/settings";
import {
	applyModelProfilePreset,
	isModelProfilePreset,
	MODEL_PROFILE_PRESETS,
	type ModelProfilePreset,
} from "../config/model-profile-presets";
import { theme } from "../modes/theme/theme";

export type ProfileAction = "list" | "show" | "create" | "use" | "delete" | "set";

export interface ProfileCommandArgs {
	action: ProfileAction;
	name?: string;
	key?: string;
	value?: string;
	flags: {
		json?: boolean;
		empty?: boolean;
		activate?: boolean;
		preset?: ModelProfilePreset;
	};
}

const ARRAY_PROFILE_KEYS = new Set<ModelProfileScopedPath>(["enabledModels", "cycleOrder", "modelProviderOrder"]);

function formatProfileName(name: string | undefined): string {
	return name ?? DEFAULT_MODEL_PROFILE_NAME;
}

function getEffectiveProfileSnapshot() {
	return {
		modelRoles: settings.get("modelRoles"),
		defaultThinkingLevel: settings.get("defaultThinkingLevel"),
		enabledModels: settings.get("enabledModels"),
		cycleOrder: settings.get("cycleOrder"),
		modelProviderOrder: settings.get("modelProviderOrder"),
	};
}

function parseArrayValue(rawValue: string): string[] {
	const trimmed = rawValue.trim();
	if (trimmed.startsWith("[")) {
		const parsed = JSON.parse(trimmed) as unknown;
		if (!Array.isArray(parsed) || !parsed.every(item => typeof item === "string")) {
			throw new Error("Expected JSON array of strings");
		}
		return parsed;
	}
	return trimmed
		.split(",")
		.map(item => item.trim())
		.filter(Boolean);
}

function parseProfileValue(key: ModelProfileScopedPath, rawValue: string): Effort | string[] | Record<string, string> {
	if (key === "modelRoles") {
		const parsed = JSON.parse(rawValue) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("modelRoles expects a JSON object");
		}
		const roles: Record<string, string> = {};
		for (const [role, model] of Object.entries(parsed)) {
			if (typeof model !== "string") throw new Error("modelRoles values must be strings");
			roles[role] = model;
		}
		return roles;
	}
	if (key === "defaultThinkingLevel") {
		const effort = rawValue as Effort;
		if (!THINKING_EFFORTS.includes(effort)) {
			throw new Error(`defaultThinkingLevel must be one of: ${THINKING_EFFORTS.join(", ")}`);
		}
		return effort;
	}
	if (ARRAY_PROFILE_KEYS.has(key)) {
		return parseArrayValue(rawValue);
	}
	throw new Error(`Unsupported profile setting: ${key}`);
}

function parseProfileKey(key: string): { path: ModelProfileScopedPath; role?: string } {
	if (key.startsWith("modelRoles.")) {
		const role = key.slice("modelRoles.".length);
		if (!role) throw new Error("Role name is required");
		return { path: "modelRoles", role };
	}
	if (key.startsWith("role.")) {
		const role = key.slice("role.".length);
		if (!role) throw new Error("Role name is required");
		return { path: "modelRoles", role };
	}
	if (
		key === "modelRoles" ||
		key === "defaultThinkingLevel" ||
		key === "enabledModels" ||
		key === "cycleOrder" ||
		key === "modelProviderOrder"
	) {
		return { path: key };
	}
	throw new Error(`Unsupported profile setting: ${key}`);
}

function printJson(value: unknown): void {
	console.log(JSON.stringify(value, null, 2));
}

function printProfile(name: string | undefined): void {
	const active = settings.getActiveModelProfileName();
	const label = formatProfileName(name);
	const profile = name ? settings.getModelProfile(name) : undefined;
	console.log(chalk.bold(`${label}${active === name || (!active && !name) ? " (active)" : ""}`));
	if (profile) {
		console.log(JSON.stringify(profile, null, 2));
		return;
	}
	console.log(JSON.stringify(getEffectiveProfileSnapshot(), null, 2));
}

function formatCreateUsage(): string {
	return `Usage: ${COMMAND_NAME} profile create <name> [--empty] [--activate] [--preset <${MODEL_PROFILE_PRESETS.join("|")}>]`;
}

function handleList(flags: { json?: boolean }): void {
	const active = settings.getActiveModelProfileName();
	const names = Object.keys(settings.getModelProfiles()).sort();
	if (flags.json) {
		printJson({ active: formatProfileName(active), profiles: names });
		return;
	}
	console.log(chalk.bold("Model profiles:"));
	console.log(`  ${active ? " " : "*"} ${DEFAULT_MODEL_PROFILE_NAME}`);
	for (const name of names) {
		console.log(`  ${active === name ? "*" : " "} ${name}`);
	}
}

function handleShow(name: string | undefined, flags: { json?: boolean }): void {
	const normalized =
		name === undefined || name === DEFAULT_MODEL_PROFILE_NAME ? undefined : normalizeModelProfileName(name);
	if (normalized && !settings.getModelProfile(normalized)) {
		throw new Error(`Unknown model profile: ${normalized}`);
	}
	if (flags.json) {
		printJson({
			name: formatProfileName(normalized),
			active: formatProfileName(settings.getActiveModelProfileName()),
			settings: normalized ? settings.getModelProfile(normalized) : getEffectiveProfileSnapshot(),
		});
		return;
	}
	printProfile(normalized);
}

async function handleCreate(
	name: string | undefined,
	flags: { empty?: boolean; activate?: boolean; json?: boolean; preset?: ModelProfilePreset },
): Promise<void> {
	if (!name) throw new Error(formatCreateUsage());
	const normalized = normalizeModelProfileName(name);
	if (flags.preset && !isModelProfilePreset(flags.preset)) {
		throw new Error(`Unknown profile preset: ${flags.preset}`);
	}
	settings.createModelProfile(normalized, flags.empty ? "empty" : "current");
	if (flags.preset) {
		applyModelProfilePreset(settings, normalized, flags.preset);
	}
	if (flags.activate) settings.switchModelProfile(normalized);
	await settings.flush();
	if (flags.json) {
		printJson({ name: normalized, active: formatProfileName(settings.getActiveModelProfileName()) });
		return;
	}
	console.log(chalk.green(`${theme.status.success} Created profile ${normalized}`));
}

async function handleUse(name: string | undefined, flags: { json?: boolean }): Promise<void> {
	if (!name) throw new Error(`Usage: ${COMMAND_NAME} profile use <name|default>`);
	const normalized = name === DEFAULT_MODEL_PROFILE_NAME ? undefined : normalizeModelProfileName(name);
	settings.switchModelProfile(normalized);
	await settings.flush();
	if (flags.json) {
		printJson({ active: formatProfileName(settings.getActiveModelProfileName()) });
		return;
	}
	console.log(
		chalk.green(`${theme.status.success} Active profile: ${formatProfileName(settings.getActiveModelProfileName())}`),
	);
}

async function handleDelete(name: string | undefined, flags: { json?: boolean }): Promise<void> {
	if (!name) throw new Error(`Usage: ${COMMAND_NAME} profile delete <name>`);
	const normalized = normalizeModelProfileName(name);
	settings.deleteModelProfile(normalized);
	await settings.flush();
	if (flags.json) {
		printJson({ deleted: normalized, active: formatProfileName(settings.getActiveModelProfileName()) });
		return;
	}
	console.log(chalk.green(`${theme.status.success} Deleted profile ${normalized}`));
}

async function handleSet(
	name: string | undefined,
	key: string | undefined,
	value: string | undefined,
	flags: { json?: boolean },
): Promise<void> {
	if (!name || !key || value === undefined) throw new Error(`Usage: ${COMMAND_NAME} profile set <name> <key> <value>`);
	const normalized = normalizeModelProfileName(name);
	const parsedKey = parseProfileKey(key);
	if (parsedKey.role) {
		const current =
			normalized === DEFAULT_MODEL_PROFILE_NAME
				? settings.get("modelRoles")
				: (settings.getModelProfile(normalized)?.modelRoles ?? {});
		const next = { ...current, [parsedKey.role]: value };
		settings.setModelProfileValue(normalized, "modelRoles", next);
	} else {
		const parsedValue = parseProfileValue(parsedKey.path, value);
		settings.setModelProfileValue(normalized, parsedKey.path, parsedValue);
	}
	await settings.flush();
	if (flags.json) {
		printJson({
			name: normalized,
			key,
			value: settings.getModelProfile(normalized) ?? getEffectiveProfileSnapshot(),
		});
		return;
	}
	console.log(chalk.green(`${theme.status.success} Set ${normalized}.${key}`));
}

export async function runProfileCommand(cmd: ProfileCommandArgs): Promise<void> {
	await Settings.init();
	try {
		switch (cmd.action) {
			case "list":
				handleList(cmd.flags);
				break;
			case "show":
				handleShow(cmd.name, cmd.flags);
				break;
			case "create":
				await handleCreate(cmd.name, cmd.flags);
				break;
			case "use":
				await handleUse(cmd.name, cmd.flags);
				break;
			case "delete":
				await handleDelete(cmd.name, cmd.flags);
				break;
			case "set":
				await handleSet(cmd.name, cmd.key, cmd.value, cmd.flags);
				break;
		}
	} catch (error) {
		console.error(chalk.red(error instanceof Error ? error.message : String(error)));
		process.exit(1);
	}
}
