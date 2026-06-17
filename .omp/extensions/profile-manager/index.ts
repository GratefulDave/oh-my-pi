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
 *   /pm              — interactive selector (profile list with * on active)
 *   /pm list         — list all profiles
 *   /pm show [name]  — show active (or named) profile settings
 *   /pm create <name> — snapshot current model config as a named profile
 *   /pm use <name>    — switch to a profile (applies model + thinking level)
 *   /pm delete <name> — delete a profile
 *   /pm model [role]  — pick a model for a role in the active profile (default: "smol")
 */

import { YAML } from "bun";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, resolveProfileEnv } from "@oh-my-pi/pi-utils";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Effort, Model } from "@oh-my-pi/pi-ai";
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
			const active = getEffectiveActiveProfileName(settings);
			if (!active || active === DEFAULT_PROFILE_NAME) return;
			const profile = getProfiles(settings)[active];
			if (!profile) return;
			const startupSkip = preflightProfileStartup(ctx, profile);
			if (startupSkip) {
				notify(pi, `[pm] startup: profile "${active}" — ${startupSkip}`);
				return;
			}
			const status = await applyProfile(pi, ctx, profile);
			notify(pi, `[pm] startup: profile "${active}" — ${status}`);
		} catch (err) {
			notify(pi, `[pm] startup error: ${err instanceof Error ? err.message : String(err)}`);
		}
	});

	// Auto-apply the active profile when switching pages/projects so new models
	// from the project's .omp/settings.json are loaded. Best-effort.
	pi.on("session_switch", async (_event, ctx) => {
		try {
			const settings = readSettings(ctx);
			const active = getEffectiveActiveProfileName(settings);
			if (!active || active === DEFAULT_PROFILE_NAME) return;
			const profile = getProfiles(settings)[active];
			if (!profile || preflightProfileStartup(ctx, profile)) return;
			await applyProfile(pi, ctx, profile);
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
				if (action === "model") return await handleModel(pi, ctx, tokens[1]);
				notify(pi, "Usage: /pm [list|show|create|use|delete|model] [name]");
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
	return process.env.PI_CODING_AGENT_DIR || getAgentDir() || path.join(os.homedir(), ".omp", "agent");
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
	settings.modelRoles = profile.modelRoles ? { ...profile.modelRoles } : {};
	settings.enabledModels = profile.enabledModels ? [...profile.enabledModels] : [];
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

function resolvePinnedOmpProfileName(settings: OmpSettings): string | undefined {
	const profileName = resolveProfileEnv(process.env.OMP_PROFILE, process.env.PI_PROFILE);
	if (!profileName) return undefined;
	return getProfiles(settings)[profileName] ? profileName : undefined;
}

function getEffectiveActiveProfileName(settings: OmpSettings): string | undefined {
	return resolvePinnedOmpProfileName(settings) ?? settings.activeModelProfile;
}

function preflightProfileStartup(ctx: ExtensionContext, profile: ModelProfile): string | undefined {
	const selector = profile.modelRoles?.default;
	if (!selector) return undefined;
	const { id } = splitModelSelector(selector);
	if (resolveModel(ctx, id)) return undefined;
	const allRegistryModels = ctx.modelRegistry.getAll();
	const provider = id.split("/")[0];
	const providerCount = allRegistryModels.filter(model => model.provider === provider).length;
	return `Skipped startup apply. Model "${id}" not in registry (${allRegistryModels.length} total; ${providerCount} from "${provider}").`;
}

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
	return ctx.modelRegistry.getAll().find(m => `${m.provider}/${m.id}` === id || m.id === id);
}

function notify(pi: ExtensionAPI, message: string): void {
	pi.sendMessage({ customType: "text", content: message, display: true });
}

/**
 * Apply a profile to the live session via pi.applySettings (updates Settings
 * singleton immediately — no reload required) then switch the active model to
 * the profile's default role.
 *
 * subagents spawned after this call inherit the updated modelRoles and
 * modelProviderOrder unless they declare their own agent-type model override.
 */
async function applyProfile(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	profile: ModelProfile,
	{ switchModel = true }: { switchModel?: boolean } = {},
): Promise<string> {
	const patch: Parameters<ExtensionAPI["applySettings"]>[0] = {
		modelRoles: profile.modelRoles ?? {},
		enabledModels: profile.enabledModels ?? [],
	};
	if (profile.modelProviderOrder !== undefined) patch.modelProviderOrder = profile.modelProviderOrder;
	if (profile.cycleOrder !== undefined) patch.cycleOrder = profile.cycleOrder;
	if (profile.defaultThinkingLevel !== undefined) patch.defaultThinkingLevel = profile.defaultThinkingLevel as Effort | "auto";

	if (typeof pi.applySettings !== "function") {
		return "applySettings not available (binary needs rebuild)";
	}
	pi.applySettings(patch);

	if (!switchModel) return "Settings applied.";

	const selector = profile.modelRoles?.default;
	if (!selector) return "Settings applied. No 'default' role — model unchanged.";

	const { id, thinkingLevel: selectorThinkingLevel } = splitModelSelector(selector);
	const allRegistryModels = ctx.modelRegistry.getAll();
	const resolvedModel = resolveModel(ctx, id);
	if (!resolvedModel) {
		const provider = id.split("/")[0];
		const providerCount = allRegistryModels.filter(m => m.provider === provider).length;
		return `Settings applied. Model "${id}" not in registry (${allRegistryModels.length} total; ${providerCount} from "${provider}") — start the local server and use /pm use to switch.`;
	}

	const ok = await pi.setModel(resolvedModel);
	if (!ok) {
		const allAuth = ctx.models.list();
		const providerAuth = allAuth.filter(m => m.provider === resolvedModel.provider);
		return `Settings applied. setModel returned false for "${id}" (${providerAuth.length} authenticated from this provider; ${allAuth.length} total).`;
	}

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
	const active = getEffectiveActiveProfileName(settings) ?? DEFAULT_PROFILE_NAME;
	const persistedActive = settings.activeModelProfile;
	const names = profileNames(settings);
	const allNames = [DEFAULT_PROFILE_NAME, ...names.filter(n => n !== DEFAULT_PROFILE_NAME)];
	const profileOptions = allNames.map(n => ({
		label: `${active === n || (n === DEFAULT_PROFILE_NAME && !active) ? "* " : "  "}${n}`,
		description:
			n === DEFAULT_PROFILE_NAME
				? "Global settings (no profile)"
				: n === active && persistedActive && persistedActive !== active
					? `Pinned by active OMP profile; saved /pm profile is ${persistedActive}`
					: undefined,
	}));
	const CREATE_LABEL = "  Create new profile...";
	const choices = [...profileOptions, { label: CREATE_LABEL, description: "Snapshot current model config" }];
	const choice = await ctx.ui.select("Model profiles", choices, {
		helpText: "Type to filter · Enter to select · * = active",
	});
	if (!choice) return;

	// Strip the leading "* " or "  " marker that was added for visual indication.
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
	const active = getEffectiveActiveProfileName(settings);
	const persistedActive = settings.activeModelProfile;
	let out = "Model profiles:\n";
	out += `  ${!active || active === DEFAULT_PROFILE_NAME ? "*" : " "} ${DEFAULT_PROFILE_NAME}\n`;
	if (active && persistedActive && persistedActive !== active) {
		out += `  (active OMP profile pins /pm to "${active}"; saved /pm profile is "${persistedActive}")\n`;
	}
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
	notify(pi, `Active profile: ${name}. ${status}`);
}

/**
 * /pm model [role] — show available models filtered by the active profile's
 * enabledModels, mark the current role assignment with *, allow the user to
 * pick a new one. Saves the new role to the active profile and calls applyProfile.
 *
 * Role defaults to "smol" when omitted (the most common adjustment).
 */
async function handleModel(pi: ExtensionAPI, ctx: ExtensionCommandContext, rawRole: string | undefined): Promise<void> {
	const role = rawRole?.trim() || "smol";
	const settings = readSettings(ctx);
	const active = getEffectiveActiveProfileName(settings);
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
		// Non-interactive: just print the current value.
		notify(pi, `Profile "${active}" — role "${role}": ${currentSelector ?? "(not set)"}`);
		return;
	}

	// Build model list from all authenticated models. Profiles may carry
	// enabledModels again, but this picker stays broad so reassignment can escape
	// an over-tight scope.
	const allModels = ctx.models.list();
	const filtered = allModels;

	if (filtered.length === 0) {
		notify(pi, `No authenticated models available.`);
		return;
	}

	// Sort: current role model first, then alphabetically by provider/id.
	const currentBase = currentSelector?.split(":")[0]; // strip :level suffix
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

	// Strip the leading "* " or "  " marker to recover provider/id.
	const chosenFull = chosen.replace(/^\*?\s+/, "");

	// Build selector: keep existing thinking level suffix if the model matches.
	let newSelector = chosenFull;
	if (currentSelector && currentBase === chosenFull) {
		// Same model re-selected — keep existing selector unchanged (preserves :level).
		newSelector = currentSelector;
	} else {
		// Ask for thinking level if the model supports it.
		const chosenModel = filtered.find(m => `${m.provider}/${m.id}` === chosenFull);
		if (chosenModel) {
			const thinkingLevel = await promptThinkingLevel(ctx, chosenFull);
			if (thinkingLevel) newSelector = `${chosenFull}:${thinkingLevel}`;
		}
	}

	// Persist to profile and apply live.
	profile.modelRoles = { ...(profile.modelRoles ?? {}), [role]: newSelector };
	settings.modelProfiles = { ...profiles, [active]: profile };
	if (settings.activeModelProfile === active) {
		// Keep top-level modelRoles in sync.
		settings.modelRoles = { ...(settings.modelRoles ?? {}), [role]: newSelector };
	}
	writeSettings(ctx, settings);
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
