/**
 * Profile Manager — slash-command extension for model profile management.
 *
 * Provides `/pm` (profile-manager) as a profile management slash command
 * that lives outside the OMP source tree and survives upstream pulls.
 *
 * Runs on stock OMP: profiles are persisted directly to `.omp/settings.json`
 * (the `activeModelProfile` + `modelProfiles` schema) and the active model is
 * switched through the public ExtensionAPI (`setModel` / `setThinkingLevel`).
 * No LEX fork binary or fork-only imports are required.
 *
 * Subcommands:
 *   /pm              — interactive selector
 *   /pm list         — list all profiles
 *   /pm show [name]  — show active (or named) profile settings
 *   /pm create <name> — snapshot current model config as a named profile
 *   /pm use <name>    — switch to a profile (applies model + thinking level)
 *   /pm delete <name> — delete a profile
 */

import { YAML } from "bun";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

// ── local types (inlined, no fork imports) ───────────────────────────────────

interface ModelProfile {
	modelRoles?: Record<string, string>;
	defaultThinkingLevel?: string;
	enabledModels?: string[];
	cycleOrder?: string[];
	modelProviderOrder?: string[];
}

interface OmpSettings {
	activeModelProfile?: string;
	modelProfiles?: Record<string, ModelProfile>;
	// Top-level "current" model config keys snapshotted by `create`.
	modelRoles?: Record<string, string>;
	defaultThinkingLevel?: string;
	enabledModels?: string[];
	cycleOrder?: string[];
	modelProviderOrder?: string[];
	[key: string]: unknown;
}

const DEFAULT_PROFILE_NAME = "default";

/** Valid ThinkingLevel suffixes (mirrors @oh-my-pi/pi-agent-core ThinkingLevel). */
const THINKING_LEVELS = new Set(["inherit", "off", "auto", "minimal", "low", "medium", "high", "xhigh"]);

/** Profile config keys snapshotted from top-level settings by `create`. */
const PROFILE_KEYS = ["modelRoles", "defaultThinkingLevel", "enabledModels", "cycleOrder", "modelProviderOrder"] as const;

// ── extension entry ───────────────────────────────────────────────────────────

export default function profileManagerExtension(pi: ExtensionAPI): void {
	pi.setLabel("Profile Manager");

	// Auto-apply the active profile when a session starts so model roles
	// (default + smol/plan/slow) take effect on launch in EVERY directory,
	// not only after a manual `/pm use`. Best-effort: never block startup.
	pi.on("session_start", async (_event, ctx) => {
		try {
			const settings = readSettings(ctx);
			const active = settings.activeModelProfile;
			if (!active || active === DEFAULT_PROFILE_NAME) return;
			const profile = getProfiles(settings)[active];
			if (profile) await applyProfile(pi, ctx, profile);
		} catch {
			// Profile application is best-effort; swallow to protect session start.
		}
	});

	// Auto-apply the active profile when switching pages/projects so new models
	// from the project's .omp/settings.json are loaded. Best-effort.
	pi.on("session_switch", async (_event, ctx) => {
		try {
			const settings = readSettings(ctx);
			const active = settings.activeModelProfile;
			if (!active || active === DEFAULT_PROFILE_NAME) return;
			const profile = getProfiles(settings)[active];
			if (profile) await applyProfile(pi, ctx, profile);
		} catch {
			// Profile application is best-effort; swallow to protect page switch.
		}
	});

	pi.registerCommand("pm", {
		description: "Manage named model profiles",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const action = tokens[0] ?? "";

			try {
				if (action === "list") return printList(pi, ctx);
				if (action === "") return handleNoArg(pi, ctx);
				if (action === "show") return handleShow(pi, ctx, tokens[1]);
				if (action === "create") return await handleCreate(pi, ctx, tokens.slice(1));
				if (action === "use") return await handleUse(pi, ctx, tokens[1]);
				if (action === "delete") return await handleDelete(pi, ctx, tokens[1]);
				notify(pi, "Usage: /pm [list|show|create|use|delete] [name]");
			} catch (err) {
				notify(pi, `Error: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});
}

// ── settings store (active agent-dir config.yml I/O) ─────────────────────────
//
// Profiles are GLOBAL to the active Lex/OMP agent dir. Use PI_CODING_AGENT_DIR
// when a named OMP profile is active; default mode falls back to ~/.omp/agent.
// Project .omp/settings.json is intentionally ignored: fork worktrees must not
// shadow or reset shared profiles.
//
// The runtime reads ~/.omp/agent/config.yml after the one-time legacy migration.
// settings.json is kept only as a fallback for pre-migration installs; writing
// profile changes to settings.json silently fails for current Lex/OMP sessions.

function activeAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".omp", "agent");
}

function userConfigPath(): string {
	return path.join(activeAgentDir(), "config.yml");
}

function legacySettingsPath(): string {
	return path.join(activeAgentDir(), "settings.json");
}

function asSettings(value: unknown): OmpSettings {
	if (value && typeof value === "object" && !Array.isArray(value)) return value as OmpSettings;
	return {};
}

function readYamlSettingsFile(file: string): OmpSettings {
	try {
		return asSettings(YAML.parse(fs.readFileSync(file, "utf8")));
	} catch {
		// Missing or unreadable file → treat as empty.
		return {};
	}
}

function readJsonSettingsFile(file: string): OmpSettings {
	try {
		return asSettings(JSON.parse(fs.readFileSync(file, "utf8")));
	} catch {
		// Missing or unreadable file → treat as empty.
		return {};
	}
}

function readSettings(_ctx: ExtensionContext): OmpSettings {
	const config = readYamlSettingsFile(userConfigPath());
	if (Object.keys(config).length > 0) return config;
	return readJsonSettingsFile(legacySettingsPath());
}

function copyProfileKeys(target: OmpSettings, source: OmpSettings): void {
	if (source.modelRoles !== undefined) target.modelRoles = { ...source.modelRoles };
	if (source.defaultThinkingLevel !== undefined) target.defaultThinkingLevel = source.defaultThinkingLevel;
	if (source.enabledModels !== undefined) target.enabledModels = [...source.enabledModels];
	if (source.cycleOrder !== undefined) target.cycleOrder = [...source.cycleOrder];
	if (source.modelProviderOrder !== undefined) target.modelProviderOrder = [...source.modelProviderOrder];
}

function applyProfileToSettings(settings: OmpSettings, profile: ModelProfile): void {
	copyProfileKeys(settings, profile);
}



function writeSettings(_ctx: ExtensionContext, settings: OmpSettings): void {
	// Persist only the profile keys to the active agent-dir config.yml; preserve
	// everything else already there (extensions[], disabledProviders, MCPs,
	// skills, etc.).
	const file = userConfigPath();
	const existing = readYamlSettingsFile(file);
	const base = Object.keys(existing).length > 0 ? existing : readJsonSettingsFile(legacySettingsPath());
	base.modelProfiles = settings.modelProfiles;
	copyProfileKeys(base, settings);
	if (settings.activeModelProfile !== undefined) {
		base.activeModelProfile = settings.activeModelProfile;
	} else {
		delete base.activeModelProfile;
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, YAML.stringify(base, null, 2), "utf8");
}

function getProfiles(settings: OmpSettings): Record<string, ModelProfile> {
	return settings.modelProfiles ?? {};
}

// ── helpers ───────────────────────────────────────────────────────────────────

function normalizeProfileName(name: string): string {
	const normalized = name.trim();
	if (normalized.length === 0) throw new Error("Profile name is required");
	if (!/^[A-Za-z0-9_-]+$/.test(normalized)) {
		throw new Error("Profile names may only contain letters, numbers, underscores, and hyphens");
	}
	return normalized;
}

function notify(pi: ExtensionAPI, message: string): void {
	pi.sendMessage({ customType: "text", content: message, display: true });
}

async function reloadAfterProfileWrite(ctx: ExtensionContext): Promise<void> {
	try {
		await ctx.reload();
	} catch {
		// Older/non-interactive extension harnesses may not provide a usable reload.
		// The profile is still persisted, and the default model is applied below.
	}
}

/** Strip a trailing `:thinkingLevel` suffix from a model selector string. */
function splitModelSelector(selector: string): { id: string; thinkingLevel?: string } {
	const colonIdx = selector.lastIndexOf(":");
	if (colonIdx !== -1) {
		const suffix = selector.slice(colonIdx + 1);
		if (THINKING_LEVELS.has(suffix)) {
			return { id: selector.slice(0, colonIdx), thinkingLevel: suffix };
		}
	}
	return { id: selector };
}

/** Resolve a model selector ("provider/id" or canonical id) via the public registry. */
function resolveModel(ctx: ExtensionContext, id: string): Model | undefined {
	const slashIdx = id.indexOf("/");
	if (slashIdx > 0) {
		const provider = id.slice(0, slashIdx);
		const modelId = id.slice(slashIdx + 1);
		const found = ctx.modelRegistry.find(provider, modelId);
		if (found) return found;
	}
	const canonical = ctx.modelRegistry.resolveCanonicalModel(id);
	if (canonical) return canonical;
	// Fallback: scan all models for an exact "provider/id" match.
	return ctx.modelRegistry.getAll().find(m => `${m.provider}/${m.id}` === id || m.id === id);
}

/**
 * Apply a profile's active model + thinking level via the public ExtensionAPI.
 * This gives the current turn the selected default model immediately; ctx.reload
 * then makes persisted role/provider/cycle defaults visible to subsequent work.
 */
async function applyProfile(pi: ExtensionAPI, ctx: ExtensionContext, profile: ModelProfile): Promise<string> {
	const selector = profile.modelRoles?.default;
	if (!selector) return "Applied model roles; no 'default' role to set as the active model.";

	const { id, thinkingLevel: selectorThinkingLevel } = splitModelSelector(selector);
	const resolvedModel = resolveModel(ctx, id);
	if (!resolvedModel) return `Model selector "${id}" not found in registry.`;

	const ok = await pi.setModel(resolvedModel);
	if (!ok) return `Cannot switch to ${id}: no credentials configured.`;

	const thinkingLevel = selectorThinkingLevel ?? profile.defaultThinkingLevel;
	if (thinkingLevel && thinkingLevel !== "inherit") {
		pi.setThinkingLevel(thinkingLevel as ThinkingLevel);
	}

	return `Switched to ${selector}`;
}

/** Snapshot the current model config (live model + top-level settings) into a profile. */
function snapshotCurrent(pi: ExtensionAPI, ctx: ExtensionContext, settings: OmpSettings): ModelProfile {
	const profile: ModelProfile = {};
	for (const key of PROFILE_KEYS) {
		const value = settings[key];
		if (value !== undefined) (profile as Record<string, unknown>)[key] = structuredClone(value);
	}
	// Capture the live active model into the `default` role so the snapshot
	// reflects the running session even when top-level modelRoles is absent.
	const model = ctx.model;
	if (model) {
		const level = pi.getThinkingLevel();
		const selector = `${model.provider}/${model.id}`;
		profile.modelRoles = {
			...(profile.modelRoles ?? {}),
			default: level && level !== "inherit" ? `${selector}:${level}` : selector,
		};
		if (level && level !== "inherit") profile.defaultThinkingLevel = level;
	}
	return profile;
}

// ── handlers ─────────────────────────────────────────────────────────────────

function profileNames(settings: OmpSettings): string[] {
	return Object.keys(getProfiles(settings)).sort();
}

async function handleNoArg(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) return printList(pi, ctx);

	const settings = readSettings(ctx);
	const active = settings.activeModelProfile;
	const names = profileNames(settings);
	const choices = [DEFAULT_PROFILE_NAME, ...names.filter(n => n !== DEFAULT_PROFILE_NAME), "Create new profile..."];
	const choice = await ctx.ui.select("Model profiles", choices);
	if (!choice) return;

	if (choice === "Create new profile...") {
		const name = await ctx.ui.input("Create model profile", "Profile name");
		if (!name) return;
		return handleCreate(pi, ctx, [name]);
	}

	if (choice === DEFAULT_PROFILE_NAME) return handleUse(pi, ctx, DEFAULT_PROFILE_NAME);
	if (active === choice) {
		notify(pi, `Already on profile: ${choice}`);
		return;
	}
	return handleUse(pi, ctx, choice);
}

function printList(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
	const settings = readSettings(ctx);
	const active = settings.activeModelProfile;
	let out = "Model profiles:\n";
	out += `  ${!active || active === DEFAULT_PROFILE_NAME ? "*" : " "} ${DEFAULT_PROFILE_NAME}\n`;
	for (const name of profileNames(settings)) {
		if (name === DEFAULT_PROFILE_NAME) continue;
		out += `  ${active === name ? "*" : " "} ${name}\n`;
	}
	notify(pi, out);
}

function handleShow(pi: ExtensionAPI, ctx: ExtensionCommandContext, rawName: string | undefined): void {
	const settings = readSettings(ctx);
	if (rawName) {
		const name = normalizeProfileName(rawName);
		const profile = getProfiles(settings)[name];
		if (!profile) {
			notify(pi, `Unknown profile: ${name}`);
			return;
		}
		notify(pi, JSON.stringify(profile, null, 2));
		return;
	}
	// No name → show current top-level config (the live "default" view).
	const current: ModelProfile = {};
	for (const key of PROFILE_KEYS) {
		const value = settings[key];
		if (value !== undefined) (current as Record<string, unknown>)[key] = value;
	}
	if (ctx.model) {
		const level = pi.getThinkingLevel();
		current.modelRoles = {
			...(current.modelRoles ?? {}),
			default: `${ctx.model.provider}/${ctx.model.id}${level && level !== "inherit" ? `:${level}` : ""}`,
		};
	}
	notify(pi, JSON.stringify(current, null, 2));
}

async function handleCreate(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string[]): Promise<void> {
	if (args.length === 0) {
		notify(pi, "Usage: /pm create <name> [--no-activate]");
		return;
	}
	const name = normalizeProfileName(args[0]);
	const activate = !args.includes("--no-activate");

	const settings = readSettings(ctx);
	const profiles = { ...getProfiles(settings) };
	profiles[name] = snapshotCurrent(pi, ctx, settings);
	settings.modelProfiles = profiles;

	if (activate) {
		settings.activeModelProfile = name;
		applyProfileToSettings(settings, profiles[name]);
		writeSettings(ctx, settings);
		const status = await applyProfile(pi, ctx, profiles[name]);
		await reloadAfterProfileWrite(ctx);
		notify(pi, `Created and switched to profile: ${name}. ${status}`);
	} else {
		writeSettings(ctx, settings);
		notify(pi, `Created profile: ${name}`);
	}
}

async function handleUse(pi: ExtensionAPI, ctx: ExtensionCommandContext, rawName: string | undefined): Promise<void> {
	if (!rawName) {
		notify(pi, "Usage: /pm use <name|default>");
		return;
	}
	const settings = readSettings(ctx);

	if (rawName === DEFAULT_PROFILE_NAME) {
		const profile = getProfiles(settings)[DEFAULT_PROFILE_NAME];
		delete settings.activeModelProfile;
		if (profile) {
			applyProfileToSettings(settings, profile);
			writeSettings(ctx, settings);
			const status = await applyProfile(pi, ctx, profile);
			await reloadAfterProfileWrite(ctx);
			notify(pi, `Active profile: ${DEFAULT_PROFILE_NAME}. ${status}`);
			return;
		}
		writeSettings(ctx, settings);
		notify(pi, `Active profile: ${DEFAULT_PROFILE_NAME}`);
		return;
	}

	const name = normalizeProfileName(rawName);
	const profile = getProfiles(settings)[name];
	if (!profile) {
		notify(pi, `Unknown profile: ${name}`);
		return;
	}
	settings.activeModelProfile = name;
	applyProfileToSettings(settings, profile);
	writeSettings(ctx, settings);
	const status = await applyProfile(pi, ctx, profile);
	await reloadAfterProfileWrite(ctx);
	notify(pi, `Active profile: ${name}. ${status}`);
}

async function handleDelete(pi: ExtensionAPI, ctx: ExtensionCommandContext, rawName: string | undefined): Promise<void> {
	if (!rawName) {
		notify(pi, "Usage: /pm delete <name>");
		return;
	}
	const name = normalizeProfileName(rawName);
	const settings = readSettings(ctx);
	const profiles = { ...getProfiles(settings) };
	if (!profiles[name]) {
		notify(pi, `Unknown profile: ${name}`);
		return;
	}
	delete profiles[name];
	settings.modelProfiles = profiles;
	if (settings.activeModelProfile === name) delete settings.activeModelProfile;
	writeSettings(ctx, settings);
	notify(pi, `Deleted profile: ${name}`);
}
