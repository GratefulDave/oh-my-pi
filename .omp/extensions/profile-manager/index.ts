/**
 * Profile Manager — slash-command extension for model profile management.
 *
 * Provides `/pm` (profile-manager) as a profile management slash command
 * that lives outside the OMP source tree and survives upstream pulls.
 *
 * Storage: ~/.omp/agent/config.yml (YAML, primary — what the binary reads)
 * Fallback: ~/.omp/agent/settings.json (legacy JSON, migrated on first write)
 *
 * Subcommands:
 *   /pm              — interactive selector
 *   /pm list         — list all profiles
 *   /pm show [name]  — show active (or named) profile settings
 *   /pm create <name> — snapshot current model config as a named profile
 *   /pm use <name>    — switch to a profile (applies model + thinking level)
 *   /pm delete <name> — delete a profile
 *   /pm model [role]  — pick a model for a role in the active profile
 */

import { YAML } from "bun";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

interface LiveSettings {
	set(path: string, value: unknown): void;
}

interface LivePiExports {
	settings?: LiveSettings;
}

const DEFAULT_PROFILE_NAME = "default";

/** Valid ThinkingLevel suffixes (mirrors @oh-my-pi/pi-agent-core ThinkingLevel). */
const THINKING_LEVELS: Record<string, true> = {
	inherit: true, off: true, auto: true, minimal: true,
	low: true, medium: true, high: true, xhigh: true,
};

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

	// Re-apply when switching sessions so the profile follows you across projects.
	pi.on("session_switch", async (_event, ctx) => {
		try {
			const settings = readSettings(ctx);
			const active = settings.activeModelProfile;
			if (!active || active === DEFAULT_PROFILE_NAME) return;
			const profile = getProfiles(settings)[active];
			if (profile) await applyProfile(pi, ctx, profile);
		} catch {
			// Best-effort; protect session switch.
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
				if (action === "model") return await handleModel(pi, ctx, tokens[1]);
				notify(pi, "Usage: /pm [list|show|create|use|delete|model] [name]");
			} catch (err) {
				notify(pi, `Error: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});
}

// ── settings store (config.yml primary, settings.json fallback) ───────────────
//
// The OMP binary reads ~/.omp/agent/config.yml as the authoritative settings
// source in v16+. Settings written only to settings.json are silently ignored.
// Profile-manager must therefore read/write config.yml so that modelRoles,
// activeModelProfile, and modelProfiles actually take effect at runtime.
//
// Migration: on first write, any modelProfiles found in settings.json are
// merged into config.yml so profiles created on older builds survive.

function activeAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".omp", "agent");
}

function userConfigYmlPath(): string {
	return path.join(activeAgentDir(), "config.yml");
}

function legacySettingsJsonPath(): string {
	return path.join(activeAgentDir(), "settings.json");
}

function projectSettingsPath(ctx: ExtensionContext): string {
	return path.join(ctx.cwd, ".omp", "settings.json");
}

function readYamlFile(file: string): OmpSettings {
	try {
		const parsed = YAML.parse(fs.readFileSync(file, "utf8"));
		return (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) as OmpSettings;
	} catch {
		return {};
	}
}

function readJsonFile(file: string): OmpSettings {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		return (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) as OmpSettings;
	} catch {
		return {};
	}
}

/**
 * Read the merged settings that the profile-manager sees:
 *  1. config.yml (authoritative — what the binary runs on)
 *  2. Overlay any modelProfiles from settings.json (migration source)
 *  3. Project .omp/settings.json overlay for project-level profiles/active
 */
function readSettings(ctx: ExtensionContext): OmpSettings {
	const yml = readYamlFile(userConfigYmlPath());
	const json = readJsonFile(legacySettingsJsonPath());
	const project = readJsonFile(projectSettingsPath(ctx));

	// Merge profile maps: yml wins on key collision at user level;
	// project shadows same-named user profiles.
	const userProfiles: Record<string, ModelProfile> = {
		...(json.modelProfiles ?? {}),
		...(yml.modelProfiles ?? {}),
	};
	const allProfiles: Record<string, ModelProfile> = {
		...userProfiles,
		...(project.modelProfiles ?? {}),
	};

	return {
		// config.yml is the live settings base
		...yml,
		// project-level keys shadow user-level
		...project,
		// Re-apply model config keys from yml (project shouldn't shadow these for
		// the active model — only profiles should)
		modelRoles: project.modelRoles ?? yml.modelRoles,
		defaultThinkingLevel: project.defaultThinkingLevel ?? yml.defaultThinkingLevel,
		enabledModels: project.enabledModels ?? yml.enabledModels,
		cycleOrder: project.cycleOrder ?? yml.cycleOrder,
		modelProviderOrder: project.modelProviderOrder ?? yml.modelProviderOrder,
		modelProfiles: allProfiles,
		activeModelProfile: project.activeModelProfile ?? yml.activeModelProfile ?? json.activeModelProfile,
	};
}

function copyProfileKeys(target: OmpSettings, source: ModelProfile): void {
	if (source.modelRoles !== undefined) target.modelRoles = { ...source.modelRoles };
	if (source.defaultThinkingLevel !== undefined) target.defaultThinkingLevel = source.defaultThinkingLevel;
	if (source.enabledModels !== undefined) target.enabledModels = [...source.enabledModels];
	if (source.cycleOrder !== undefined) target.cycleOrder = [...source.cycleOrder];
	if (source.modelProviderOrder !== undefined) target.modelProviderOrder = [...source.modelProviderOrder];
}

/**
 * Write profile changes to config.yml (authoritative).
 * Migrates any modelProfiles from settings.json on first write.
 * Also syncs the project .omp/settings.json if it has activeModelProfile.
 */
function writeSettings(ctx: ExtensionContext, settings: OmpSettings): void {
	const ymlFile = userConfigYmlPath();
	const jsonFile = legacySettingsJsonPath();

	// Read current config.yml base; merge in any profiles still only in settings.json.
	const existing = readYamlFile(ymlFile);
	const legacyJson = readJsonFile(jsonFile);

	// Migrate profiles from JSON → YAML on first encounter.
	const migratedProfiles: Record<string, ModelProfile> = {
		...(legacyJson.modelProfiles ?? {}),
		...(existing.modelProfiles ?? {}),
		...(settings.modelProfiles ?? {}),
	};

	existing.modelProfiles = migratedProfiles;
	copyProfileKeys(existing, settings);

	if (settings.activeModelProfile !== undefined) {
		existing.activeModelProfile = settings.activeModelProfile;
	} else {
		delete existing.activeModelProfile;
	}

	fs.mkdirSync(path.dirname(ymlFile), { recursive: true });
	fs.writeFileSync(ymlFile, YAML.stringify(existing, null, 2), "utf8");

	// If the project .omp/settings.json has its own activeModelProfile, keep it
	// in sync so `/pm use X` survives a restart when the project file is also read.
	const projectFile = projectSettingsPath(ctx);
	const project = readJsonFile(projectFile);
	if ("activeModelProfile" in project) {
		copyProfileKeys(project, settings);
		if (settings.activeModelProfile !== undefined) {
			project.activeModelProfile = settings.activeModelProfile;
		} else {
			delete project.activeModelProfile;
		}
		fs.writeFileSync(projectFile, `${JSON.stringify(project, null, 2)}\n`, "utf8");
	}
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

/** Strip a trailing `:thinkingLevel` suffix from a model selector string. */
function splitModelSelector(selector: string): { id: string; thinkingLevel?: string } {
	const colonIdx = selector.lastIndexOf(":");
	if (colonIdx !== -1) {
		const suffix = selector.slice(colonIdx + 1);
		if (suffix in THINKING_LEVELS) {
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
 * Apply a profile to the live session:
 * 1. Override all model roles in-memory (overrideModelRoles — immediate session state).
 * 2. Switch the active model (setModel).
 * 3. Set thinking level.
 *
 * Disk writes happen before this function; callers also sync the live Settings
 * singleton so `/models` sees the selected profile without requiring a restart.
 *
 * Returns a status string suitable for display.
 */
function syncLiveModelSettings(pi: ExtensionAPI, settings: OmpSettings): void {
	const liveSettings = (pi.pi as LivePiExports).settings;
	if (!liveSettings) return;
	for (const key of PROFILE_KEYS) {
		const value = settings[key];
		if (value !== undefined) liveSettings.set(key, structuredClone(value));
	}
}

async function applyProfile(pi: ExtensionAPI, ctx: ExtensionContext, profile: ModelProfile): Promise<string> {
	// Override ALL roles live so subagent dispatching uses the profile's full role map.
	if (profile.modelRoles && Object.keys(profile.modelRoles).length > 0) {
		pi.overrideModelRoles(profile.modelRoles);
	}

	const selector = profile.modelRoles?.default;
	if (!selector) return "Applied model roles; no 'default' role to set as the active model.";

	const { id, thinkingLevel } = splitModelSelector(selector);
	const model = resolveModel(ctx, id);
	if (!model) {
		const allModels = ctx.modelRegistry.getAll();
		const providerModels = allModels.filter(m => m.provider === id.split("/")[0]);
		return `Profile saved, but model "${id}" not in registry (${allModels.length} total; ${providerModels.length} from provider "${id.split("/")[0]}").`;
	}

	const ok = await pi.setModel(model);
	if (!ok) {
		const allAuth = ctx.models.list();
		const providerAuth = allAuth.filter(m => m.provider === model.provider);
		return `Profile saved, but setModel returned false for "${id}" (${providerAuth.length} authenticated from this provider; ${allAuth.length} total authenticated).`;
	}

	const level = thinkingLevel ?? profile.defaultThinkingLevel;
	if (level && level !== "auto" && level in THINKING_LEVELS) {
		pi.setThinkingLevel(level as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
	}
	return `Switched to ${model.provider}/${model.id}${level ? ` (${level})` : ""}.`;
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
	const active = settings.activeModelProfile ?? DEFAULT_PROFILE_NAME;
	const names = profileNames(settings);
	const allNames = [DEFAULT_PROFILE_NAME, ...names.filter(n => n !== DEFAULT_PROFILE_NAME)];
	const profileOptions = allNames.map(n => ({
		label: `${active === n || (n === DEFAULT_PROFILE_NAME && !settings.activeModelProfile) ? "* " : "  "}${n}`,
		description: n === DEFAULT_PROFILE_NAME ? "Global settings (no profile)" : undefined,
	}));
	const CREATE_LABEL = "  Create new profile...";
	const choices = [...profileOptions, { label: CREATE_LABEL, description: "Snapshot current model config" }];
	const choice = await ctx.ui.select("Model profiles", choices, {
		helpText: "Type to filter · Enter to select · * = active",
	});
	if (!choice) return;

	// Strip the leading "* " or "  " marker.
	const chosenName = choice.replace(/^\*?\s+/, "").trim();

	if (chosenName === "Create new profile...") {
		const name = await ctx.ui.input("Create model profile", "Profile name");
		if (!name) return;
		return handleCreate(pi, ctx, [name]);
	}

	if (chosenName === DEFAULT_PROFILE_NAME) return handleUse(pi, ctx, DEFAULT_PROFILE_NAME);
	if (active === chosenName) {
		notify(pi, `Already on profile: ${chosenName}`);
		return;
	}
	return handleUse(pi, ctx, chosenName);
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
		copyProfileKeys(settings, profiles[name]);
		writeSettings(ctx, settings);
		syncLiveModelSettings(pi, settings);
		const status = await applyProfile(pi, ctx, profiles[name]);
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
			copyProfileKeys(settings, profile);
			writeSettings(ctx, settings);
			syncLiveModelSettings(pi, settings);
			const status = await applyProfile(pi, ctx, profile);
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
	copyProfileKeys(settings, profile);
	writeSettings(ctx, settings);
	syncLiveModelSettings(pi, settings);
	const status = await applyProfile(pi, ctx, profile);
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

/**
 * /pm model [role] — pick a model for a role in the active profile.
 * Role defaults to "smol" when omitted.
 */
async function handleModel(pi: ExtensionAPI, ctx: ExtensionCommandContext, rawRole: string | undefined): Promise<void> {
	const role = rawRole?.trim() || "smol";
	const settings = readSettings(ctx);
	const active = settings.activeModelProfile;
	if (!active || active === DEFAULT_PROFILE_NAME) {
		notify(pi, "No named profile active. Use /pm use <name> first.");
		return;
	}
	const profiles = getProfiles(settings);
	const profile = profiles[active];
	if (!profile) {
		notify(pi, `Profile "${active}" not found in settings.`);
		return;
	}

	const currentSelector = profile.modelRoles?.[role];

	if (!ctx.hasUI) {
		notify(pi, `Profile "${active}" — role "${role}": ${currentSelector ?? "(not set)"}`);
		return;
	}

	// Build model list, pre-filtered by the profile's enabledModels if set.
	const allModels = ctx.models.list();
	const enabledGlobs = profile.enabledModels;
	const filtered = enabledGlobs
		? allModels.filter(m => {
				const full = `${m.provider}/${m.id}`;
				return enabledGlobs.some(glob => {
					if (glob.endsWith("/*")) return m.provider === glob.slice(0, -2);
					return full === glob || m.id === glob;
				});
		  })
		: allModels;

	if (filtered.length === 0) {
		notify(pi, `No models available for profile "${active}" (check enabledModels).`);
		return;
	}

	const currentBase = currentSelector?.split(":")[0];
	const sorted = [...filtered].sort((a, b) => {
		const aFull = `${a.provider}/${a.id}`;
		const bFull = `${b.provider}/${b.id}`;
		if (currentBase && aFull === currentBase) return -1;
		if (currentBase && bFull === currentBase) return 1;
		return aFull.localeCompare(bFull);
	});

	const options = sorted.map(m => {
		const full = `${m.provider}/${m.id}`;
		const isCurrent = currentBase === full;
		return {
			label: `${isCurrent ? "* " : "  "}${full}`,
			description: m.name ?? m.id,
		};
	});

	const chosen = await ctx.ui.select(
		`Set "${role}" model for profile "${active}"`,
		options,
		{ initialIndex: 0, helpText: "Type to filter · Enter to select · Esc to cancel" },
	);
	if (!chosen) return;

	const chosenFull = chosen.replace(/^\*?\s+/, "");

	let newSelector = chosenFull;
	if (currentSelector && currentBase === chosenFull) {
		newSelector = currentSelector;
	} else {
		const thinkingLevel = await promptThinkingLevel(ctx, chosenFull);
		if (thinkingLevel) newSelector = `${chosenFull}:${thinkingLevel}`;
	}

	profile.modelRoles = { ...(profile.modelRoles ?? {}), [role]: newSelector };
	settings.modelProfiles = { ...profiles, [active]: profile };
	if (settings.activeModelProfile === active) {
		settings.modelRoles = { ...(settings.modelRoles ?? {}), [role]: newSelector };
	}
	writeSettings(ctx, settings);
	syncLiveModelSettings(pi, settings);
	const status = await applyProfile(pi, ctx, profile);
	notify(pi, `Profile "${active}" — role "${role}" → ${newSelector}. ${status}`);
}

async function promptThinkingLevel(ctx: ExtensionCommandContext, modelFull: string): Promise<string | undefined> {
	const options = [
		{ label: "(none)", description: "No thinking level suffix" },
		{ label: "low", description: ":low" },
		{ label: "medium", description: ":medium" },
		{ label: "high", description: ":high" },
		{ label: "xhigh", description: ":xhigh" },
	];
	const chosen = await ctx.ui.select(`Thinking level for ${modelFull}`, options, { initialIndex: 0 });
	if (!chosen || chosen === "(none)") return undefined;
	return chosen;
}
