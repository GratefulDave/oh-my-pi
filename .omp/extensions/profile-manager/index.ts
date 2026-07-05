/**
 * Profile Manager — slash-command extension for model profile management.
 *
 * Provides `/pm` (profile-manager) as a profile management slash command
 * that lives outside the OMP source tree and survives upstream pulls.
 *
 * Runs on stock OMP: profiles are persisted directly to the active agent-dir
 * `config.yml` (`activeModelProfile` + `modelProfiles`). The active model is
 * switched through the public ExtensionAPI (`setModel` / `setThinkingLevel`).
 * No LEX fork binary or fork-only imports are required.
 *
 *   /pm              — interactive selector (profile list marks active inline)
 *   /pm list         — list all profiles with active marker
 *   /pm show [name]  — show active (or named) profile settings
 *   /pm create <name> — snapshot current model config as a named profile
 *   /pm use <name>    — switch to a profile (applies model + thinking level)
 *   /pm <name> [profile] — switch to a profile using the shorthand form
 *   /pm delete <name> — delete a profile
 *   /pm model [role]  — pick a model for a role in the active profile (default: "smol")
 */

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

import { YAML } from "bun";

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

type ExtensionAPIWithSessionOverrides = ExtensionAPI;

const DEFAULT_PROFILE_NAME = "default";
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WINDOWS_RESERVED_BASENAME_RE =
	/^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;

const PM_PROFILE_FLAG = "pm-profile";
const PM_MODEL_FLAG = "pm-model";
const PM_THINKING_FLAG = "pm-thinking";

/** Valid ThinkingLevel suffixes (mirrors @oh-my-pi/pi-agent-core ThinkingLevel). */
const THINKING_LEVELS = new Set([
	"inherit",
	"off",
	"auto",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
]);

const PROFILE_KEYS = [
	"modelRoles",
	"defaultThinkingLevel",
	"enabledModels",
	"cycleOrder",
	"modelProviderOrder",
] as const;

// ── extension entry ───────────────────────────────────────────────────────────

export default function profileManagerExtension(pi: ExtensionAPI): void {
	pi.setLabel("Profile Manager");
	pi.registerFlag(PM_PROFILE_FLAG, {
		description: "Temporarily apply a named /pm profile for this launch",
		type: "string",
	});
	pi.registerFlag(PM_MODEL_FLAG, {
		description:
			"Temporarily override the active /pm default model selector for this launch",
		type: "string",
	});
	pi.registerFlag(PM_THINKING_FLAG, {
		description:
			"Temporarily override the active /pm thinking level for this launch",
		type: "string",
	});

	let startupApplied = false;

	// Auto-apply the active profile when a session starts so model roles
	// (default + smol/plan/slow) take effect on launch in EVERY directory,
	// not only after a manual `/pm use`. Best-effort: never block startup.
	pi.on("session_start", async (_event, ctx) => {
		if (startupApplied) return;
		startupApplied = true;
		try {
			const settings = readSettings(ctx);
			const selection = resolveStartupSelection(pi, settings);
			if (!selection) return;
			const startupSkip = preflightProfileStartup(ctx, selection.profile);
			if (startupSkip) {
				notifyStartup(
					ctx,
					pi,
					`[pm] startup: ${selection.label} — ${startupSkip}`,
					"warning",
				);
				return;
			}
			const status = await applyProfile(pi, ctx, selection.profile);
			notifyStartup(ctx, pi, `[pm] startup: ${selection.label} — ${status}`);
		} catch (err) {
			notifyStartup(
				ctx,
				pi,
				`[pm] startup error: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
		}
	});

	// Auto-apply the active profile when switching pages/projects so new models
	// from the project's .omp/settings.json are loaded. Best-effort.
	pi.on("session_switch", async (_event, ctx) => {
		try {
			const settings = readSettings(ctx);
			const selection = resolveStartupSelection(pi, settings);
			if (!selection || preflightProfileStartup(ctx, selection.profile)) return;
			await applyProfile(pi, ctx, selection.profile);
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
				if (action === "create")
					return await handleCreate(pi, ctx, tokens.slice(1));
				if (action === "use") return await handleUse(pi, ctx, tokens[1]);
				if (action === "delete") return await handleDelete(pi, ctx, tokens[1]);
				if (action === "model") return await handleModel(pi, ctx, tokens[1]);
				if (await handleProfileAlias(pi, ctx, tokens)) return;
				notify(pi, "Usage: /pm [list|show|create|use|delete|model] [name]");
			} catch (err) {
				notify(
					pi,
					`Error: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	});

	// Clean up the per-instance profile file on process exit so it doesn't
	// linger after the OMP instance terminates.
	process.on("exit", () => {
		try {
			fs.unlinkSync(perInstanceProfilePath());
		} catch {
			/* ignore */
		}
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
	return (
		process.env.PI_CODING_AGENT_DIR ||
		path.join(os.homedir(), process.env.PI_CONFIG_DIR || ".omp", "agent")
	);
}

function userConfigPath(): string {
	return path.join(activeAgentDir(), "config.yml");
}

function legacySettingsPath(): string {
	return path.join(activeAgentDir(), "settings.json");
}

/** Per-instance active profile file — keyed by PID so concurrent OMP instances
 * don't clobber each other's activeModelProfile. Profile definitions stay shared
 * in config.yml; only the active selection is per-instance. */
function perInstanceProfilePath(): string {
	return path.join(activeAgentDir(), `.active-profile-${process.pid}.json`);
}

/** Read the per-instance active profile (if any). */
function readPerInstanceActiveProfile(): string | undefined {
	try {
		const data = fs.readFileSync(perInstanceProfilePath(), "utf8");
		const parsed = JSON.parse(data);
		return typeof parsed === "object" &&
			parsed !== null &&
			"activeModelProfile" in parsed
			? (parsed as { activeModelProfile?: string }).activeModelProfile
			: undefined;
	} catch {
		return undefined;
	}
}

/** Write the per-instance active profile. */
function writePerInstanceActiveProfile(name: string | undefined): void {
	const file = perInstanceProfilePath();
	if (name === undefined) {
		try {
			fs.unlinkSync(file);
		} catch {
			/* ignore */
		}
		return;
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ activeModelProfile: name }), "utf8");
}

function asSettings(value: unknown): OmpSettings {
	if (value && typeof value === "object" && !Array.isArray(value))
		return value as OmpSettings;
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
	const settings =
		Object.keys(config).length > 0
			? config
			: readJsonSettingsFile(legacySettingsPath());
	// Merge per-instance activeModelProfile on top, so it overrides
	// any stale value in the shared config.
	const perInstance = readPerInstanceActiveProfile();
	if (perInstance !== undefined) {
		settings.activeModelProfile = perInstance;
	}
	return settings;
}

function copyProfileKeys(
	target: OmpSettings | ModelProfile,
	source: OmpSettings | ModelProfile,
): void {
	if (source.modelRoles !== undefined)
		target.modelRoles = { ...source.modelRoles };
	if (source.defaultThinkingLevel !== undefined)
		target.defaultThinkingLevel = source.defaultThinkingLevel;
	if (source.enabledModels !== undefined)
		target.enabledModels = [...source.enabledModels];
	if (source.cycleOrder !== undefined)
		target.cycleOrder = [...source.cycleOrder];
	if (source.modelProviderOrder !== undefined)
		target.modelProviderOrder = [...source.modelProviderOrder];
}

function applyProfileToSettings(
	settings: OmpSettings,
	profile: ModelProfile,
): void {
	settings.modelRoles = profile.modelRoles ? { ...profile.modelRoles } : {};
	settings.enabledModels = profile.enabledModels
		? [...profile.enabledModels]
		: [];
	copyProfileKeys(settings, profile);
}

function writeSettings(_ctx: ExtensionContext, settings: OmpSettings): void {
	// Persist profile keys to the active agent-dir config.yml; preserve
	// everything else already there (extensions[], disabledProviders, MCPs,
	// skills, etc.). activeModelProfile is NOT written here — it is per-instance
	// and stored in a PID-scoped file so concurrent OMP instances don't clobber
	// each other's active selection.
	const file = userConfigPath();
	const existing = readYamlSettingsFile(file);
	const base =
		Object.keys(existing).length > 0
			? existing
			: readJsonSettingsFile(legacySettingsPath());
	base.modelProfiles = settings.modelProfiles;
	copyProfileKeys(base, settings);
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
		throw new Error(
			"Profile names may only contain letters, numbers, underscores, and hyphens",
		);
	}
	return normalized;
}

function normalizeProfileEnvName(profile: string | undefined): string | undefined {
	const normalized = profile?.trim();
	if (!normalized || normalized === DEFAULT_PROFILE_NAME) return undefined;
	if (
		normalized === "." ||
		normalized === ".." ||
		normalized.endsWith(".") ||
		!PROFILE_NAME_RE.test(normalized) ||
		WINDOWS_RESERVED_BASENAME_RE.test(normalized)
	) {
		throw new Error(
			`Invalid OMP profile "${profile}". Profile names must match ${PROFILE_NAME_RE.source}, ` +
				`cannot be "." or "..", cannot end with ".", and cannot be a Windows reserved device name ` +
				`(CON, PRN, AUX, NUL, COM0-9, LPT0-9, or any of those with an extension).`,
		);
	}
	return normalized;
}


function splitModelSelector(selector: string): {
	id: string;
	thinkingLevel?: string;
} {
	const colonIdx = selector.lastIndexOf(":");
	if (colonIdx !== -1) {
		const suffix = selector.slice(colonIdx + 1);
		if (THINKING_LEVELS.has(suffix)) {
			return { id: selector.slice(0, colonIdx), thinkingLevel: suffix };
		}
	}
	return { id: selector };
}

function readStringFlag(pi: ExtensionAPI, name: string): string | undefined {
	const value = pi.getFlag(name);
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function validateThinkingLevel(level: string, source: string): string {
	if (!THINKING_LEVELS.has(level)) {
		throw new Error(
			`${source} must be one of: ${Array.from(THINKING_LEVELS).join(", ")}`,
		);
	}
	return level;
}

function resolveCliProfileName(
	pi: ExtensionAPI,
	settings: OmpSettings,
): string | undefined {
	const profileName = readStringFlag(pi, PM_PROFILE_FLAG);
	if (!profileName) return undefined;
	const normalized = normalizeProfileName(profileName);
	if (normalized === DEFAULT_PROFILE_NAME) return DEFAULT_PROFILE_NAME;
	if (!getProfiles(settings)[normalized]) {
		throw new Error(
			`Unknown profile passed via --${PM_PROFILE_FLAG}: ${normalized}`,
		);
	}
	return normalized;
}

function resolvePinnedOmpProfileName(
	settings: OmpSettings,
): string | undefined {
	const profileName = normalizeProfileEnvName(
		process.env.OMP_PROFILE !== undefined
			? process.env.OMP_PROFILE
			: process.env.PI_PROFILE,
	);
	if (!profileName) return undefined;
	return getProfiles(settings)[profileName] ? profileName : undefined;
}

function getEffectiveActiveProfileName(
	settings: OmpSettings,
	pi: ExtensionAPI,
): string | undefined {
	return (
		resolveCliProfileName(pi, settings) ??
		resolvePinnedOmpProfileName(settings) ??
		settings.activeModelProfile
	);
}

function currentSettingsProfile(settings: OmpSettings): ModelProfile {
	const profile: ModelProfile = {};
	if (settings.modelRoles !== undefined)
		profile.modelRoles = structuredClone(settings.modelRoles);
	if (settings.defaultThinkingLevel !== undefined)
		profile.defaultThinkingLevel = settings.defaultThinkingLevel;
	if (settings.enabledModels !== undefined)
		profile.enabledModels = structuredClone(settings.enabledModels);
	if (settings.cycleOrder !== undefined)
		profile.cycleOrder = structuredClone(settings.cycleOrder);
	if (settings.modelProviderOrder !== undefined)
		profile.modelProviderOrder = structuredClone(settings.modelProviderOrder);
	return profile;
}

function applyLaunchOverrides(
	pi: ExtensionAPI,
	profile: ModelProfile,
): ModelProfile {
	const modelSelector = readStringFlag(pi, PM_MODEL_FLAG);
	const thinkingOverride = readStringFlag(pi, PM_THINKING_FLAG);
	if (!modelSelector && !thinkingOverride) return profile;

	const nextProfile: ModelProfile = {
		...profile,
		modelRoles: profile.modelRoles ? { ...profile.modelRoles } : {},
	};

	if (modelSelector) {
		const { id, thinkingLevel } = splitModelSelector(modelSelector);
		nextProfile.modelRoles ??= {};
		nextProfile.modelRoles.default = modelSelector;
		if (thinkingOverride === undefined && thinkingLevel !== undefined) {
			nextProfile.defaultThinkingLevel = thinkingLevel;
		} else if (thinkingLevel === undefined) {
			nextProfile.modelRoles.default = id;
		}
	}

	if (thinkingOverride !== undefined) {
		const level = validateThinkingLevel(
			thinkingOverride,
			`--${PM_THINKING_FLAG}`,
		);
		nextProfile.defaultThinkingLevel = level;
		const modelRoles = nextProfile.modelRoles;
		if (modelRoles?.default) {
			const { id } = splitModelSelector(modelRoles.default);
			modelRoles.default = `${id}:${level}`;
		}
	}

	return nextProfile;
}

function describeLaunchOverrides(pi: ExtensionAPI): string[] {
	const parts: string[] = [];
	const profileName = readStringFlag(pi, PM_PROFILE_FLAG);
	const modelSelector = readStringFlag(pi, PM_MODEL_FLAG);
	const thinkingLevel = readStringFlag(pi, PM_THINKING_FLAG);
	if (profileName) parts.push(`profile "${normalizeProfileName(profileName)}"`);
	if (modelSelector) parts.push(`model "${modelSelector}"`);
	if (thinkingLevel)
		parts.push(
			`thinking "${validateThinkingLevel(thinkingLevel, `--${PM_THINKING_FLAG}`)}"`,
		);
	return parts;
}

function resolveStartupSelection(
	pi: ExtensionAPI,
	settings: OmpSettings,
): { label: string; profile: ModelProfile } | undefined {
	const active = getEffectiveActiveProfileName(settings, pi);
	const baseProfile =
		active && active !== DEFAULT_PROFILE_NAME
			? getProfiles(settings)[active]
			: undefined;
	const overrides = describeLaunchOverrides(pi);
	if (
		!baseProfile &&
		!overrides.length &&
		(!active || active === DEFAULT_PROFILE_NAME)
	)
		return undefined;

	const profile = applyLaunchOverrides(
		pi,
		baseProfile ?? currentSettingsProfile(settings),
	);
	const labelBase =
		active && active !== DEFAULT_PROFILE_NAME
			? `profile "${active}"`
			: "current settings";
	if (!overrides.length) return { label: labelBase, profile };
	const suffix = overrides.filter((part) => part !== labelBase).join(", ");
	return { label: suffix ? `${labelBase} with ${suffix}` : labelBase, profile };
}

function preflightProfileStartup(
	ctx: ExtensionContext,
	profile: ModelProfile,
): string | undefined {
	const selector = profile.modelRoles?.default;
	if (!selector) return undefined;
	const { id } = splitModelSelector(selector);
	if (resolveModel(ctx, id)) return undefined;
	const allRegistryModels = ctx.modelRegistry.getAll();
	const provider = id.split("/")[0];
	const providerCount = allRegistryModels.filter(
		(model) => model.provider === provider,
	).length;
	return `Skipped startup apply. Model "${id}" not in registry yet (${allRegistryModels.length} total; ${providerCount} from "${provider}") — extension providers may not have registered yet.`;
}

/** Canonical display namespace → internal provider ID mappings for extension-registered providers. */
const CANONICAL_NAMESPACE_MAP: Record<string, string[]> = {
	ag: ["antigravity"],
};

function resolveModel(ctx: ExtensionContext, id: string): Model | undefined {
	const slashIdx = id.indexOf("/");
	const namespace = slashIdx > 0 ? id.slice(0, slashIdx) : undefined;
	const modelId = slashIdx > 0 ? id.slice(slashIdx + 1) : id;
	const aliases = namespace ? (CANONICAL_NAMESPACE_MAP[namespace] ?? []) : [];
	const providerCandidates = namespace ? [namespace, ...aliases] : [];

	// 1. Search authenticated models first — these are what setModel() accepts.
	const authModels = ctx.models.list();
	if (authModels.length > 0) {
		// Match by provider + id, trying namespace and all aliases.
		if (providerCandidates.length > 0) {
			for (const p of providerCandidates) {
				const hit = authModels.find(
					(m) => m.provider === p && m.id === modelId,
				);
				if (hit) return hit;
			}
		}
		// Match by id alone across any provider (last resort within auth set).
		const byId = authModels.find((m) => m.id === modelId);
		if (byId) return byId;
	}

	// 2. Fall back to registry (handles not-yet-authenticated or static models).
	if (providerCandidates.length > 0) {
		for (const p of providerCandidates) {
			const hit = ctx.modelRegistry.find(p, modelId);
			if (hit) return hit;
		}
	}
	return ctx.modelRegistry
		.getAll()
		.find((m) => `${m.provider}/${m.id}` === id || m.id === modelId);
}

function notify(pi: ExtensionAPI, message: string): void {
	pi.sendMessage({ customType: "text", content: message, display: true });
}

function notifyStartup(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	message: string,
	type: "info" | "warning" | "error" = "info",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}
	notify(pi, message);
}
/**
 * Apply a profile to the live session. `replaceModelRoles` replaces all role
 * overrides (clearing previous profile's roles); `overrideEnabledModels`
 * applies the profile's model filter to the live session; `setModel` switches
 * the visible default model for the current session.
 */
export async function applyProfile(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	profile: ModelProfile,
	{ switchModel = true }: { switchModel?: boolean } = {},
): Promise<string> {
	const sessionApi = pi as ExtensionAPIWithSessionOverrides;
	// Replace (not merge) role overrides so switching profiles clears stale roles.
	sessionApi.replaceModelRoles?.(profile.modelRoles ?? {});
	// Apply enabledModels to the live session so /models shows the right scope.
	const enabledPatterns = profile.enabledModels;
	sessionApi.overrideEnabledModels?.(
		enabledPatterns && enabledPatterns.length > 0 ? enabledPatterns : null,
	);
	if (!switchModel) return "Settings applied.";

	const selector = profile.modelRoles?.default;
	if (!selector)
		return "Settings applied. No 'default' role — model unchanged.";

	const { id, thinkingLevel: selectorThinkingLevel } =
		splitModelSelector(selector);
	const allRegistryModels = ctx.modelRegistry.getAll();
	const resolvedModel = resolveModel(ctx, id);
	if (!resolvedModel) {
		const provider = id.split("/")[0];
		const providerCount = allRegistryModels.filter(
			(m) => m.provider === provider,
		).length;
		return `Settings applied. Model "${id}" not in registry (${allRegistryModels.length} total; ${providerCount} from "${provider}") — extension may not be loaded yet, try /pm use again.`;
	}

	const ok = await pi.setModel(resolvedModel);
	if (!ok) {
		const allAuth = ctx.models.list();
		const providerAuth = allAuth.filter(
			(m) => m.provider === resolvedModel.provider,
		);
		return `Settings applied. setModel returned false for "${id}" (${providerAuth.length} authenticated from this provider; ${allAuth.length} total).`;
	}

	const thinkingLevel = selectorThinkingLevel ?? profile.defaultThinkingLevel;
	if (thinkingLevel && thinkingLevel !== "inherit") {
		pi.setThinkingLevel(thinkingLevel as ThinkingLevel);
	}

	return `Switched to ${selector}`;
}

/** Snapshot the current model config (live model + top-level settings) into a profile. */
function snapshotCurrent(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	settings: OmpSettings,
): ModelProfile {
	const profile: ModelProfile = {};
	for (const key of PROFILE_KEYS) {
		const value = settings[key];
		if (value !== undefined)
			(profile as Record<string, unknown>)[key] = structuredClone(value);
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

async function handleNoArg(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!ctx.hasUI) return printList(pi, ctx);

	const settings = readSettings(ctx);
	const active =
		getEffectiveActiveProfileName(settings, pi) ?? DEFAULT_PROFILE_NAME;
	const persistedActive = settings.activeModelProfile;
	const names = profileNames(settings);
	const allNames = [
		DEFAULT_PROFILE_NAME,
		...names.filter((n) => n !== DEFAULT_PROFILE_NAME),
	];
	const profileOptions = allNames.map((n) => {
		const isActive = active === n || (n === DEFAULT_PROFILE_NAME && !active);
		return {
			label: `${n}${isActive ? " (active)" : ""}`,
			description:
				n === DEFAULT_PROFILE_NAME
					? "Global settings (no profile)"
					: isActive && persistedActive && persistedActive !== active
						? `Pinned by active OMP profile; saved /pm profile is ${persistedActive}`
						: undefined,
		};
	});
	const CREATE_LABEL = "Create new profile...";
	const choices = [
		...profileOptions,
		{ label: CREATE_LABEL, description: "Snapshot current model config" },
	];
	const choice = await ctx.ui.select("Model profiles", choices, {
		helpText:
			"Type to filter · Enter to select · active profile is marked inline",
	});
	if (!choice) return;

	// Remove the inline active marker added for visual indication.
	const chosenName = choice.replace(/\s+\(active\)$/, "").trim();

	if (chosenName === "Create new profile...") {
		const name = await ctx.ui.input("Create model profile", "Profile name");
		if (!name) return;
		return handleCreate(pi, ctx, [name]);
	}

	if (chosenName === DEFAULT_PROFILE_NAME)
		return handleUse(pi, ctx, DEFAULT_PROFILE_NAME);
	if (active === chosenName) {
		notify(pi, `Already on profile: ${chosenName}`);
		return;
	}
	return handleUse(pi, ctx, chosenName);
}

function printList(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
	const settings = readSettings(ctx);
	const active =
		getEffectiveActiveProfileName(settings, pi) ?? DEFAULT_PROFILE_NAME;
	const persistedActive = settings.activeModelProfile;
	let out = `Active model profile: ${active}\nModel profiles:\n`;
	out += `  ${DEFAULT_PROFILE_NAME}${active === DEFAULT_PROFILE_NAME ? " (active)" : ""}\n`;
	if (active !== persistedActive && persistedActive) {
		out += `  note: active OMP profile pins /pm to "${active}"; saved /pm profile is "${persistedActive}"\n`;
	}
	for (const name of profileNames(settings)) {
		if (name === DEFAULT_PROFILE_NAME) continue;
		out += `  ${name}${active === name ? " (active)" : ""}\n`;
	}
	notify(pi, out);
}

function handleShow(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	rawName: string | undefined,
): void {
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

async function handleCreate(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string[],
): Promise<void> {
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
		writePerInstanceActiveProfile(name);
		applyProfileToSettings(settings, profiles[name]);
		writeSettings(ctx, settings);
		const status = await applyProfile(pi, ctx, profiles[name]);
		notify(pi, `Created and switched to profile: ${name}. ${status}`);
	} else {
		writeSettings(ctx, settings);
		notify(pi, `Created profile: ${name}`);
	}
}

async function handleProfileAlias(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	tokens: string[],
): Promise<boolean> {
	if (tokens.length === 0) return false;
	const settings = readSettings(ctx);
	const name = normalizeProfileName(tokens[0]);
	const profile = getProfiles(settings)[name];
	if (!profile) return false;
	if (tokens.length > 1 && tokens[1] !== "profile" && tokens[1] !== "use")
		return false;
	await handleUse(pi, ctx, name);
	return true;
}

async function handleUse(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	rawName: string | undefined,
): Promise<void> {
	if (!rawName) {
		notify(pi, "Usage: /pm use <name|default>");
		return;
	}
	const settings = readSettings(ctx);

	if (rawName === DEFAULT_PROFILE_NAME) {
		const profile = getProfiles(settings)[DEFAULT_PROFILE_NAME];
		delete settings.activeModelProfile;
		writePerInstanceActiveProfile(undefined); // clear per-instance profile
		if (profile) {
			applyProfileToSettings(settings, profile);
			writeSettings(ctx, settings);
			const status = await applyProfile(pi, ctx, profile);
			notify(pi, `Active profile: ${DEFAULT_PROFILE_NAME}. ${status}`);
			return;
		}
	// No explicit "default" profile entry — clear all runtime overrides so
	// top-level config modelRoles/enabledModels take effect.
	const sessionApi = pi as ExtensionAPIWithSessionOverrides;
	sessionApi.replaceModelRoles?.({});
	sessionApi.overrideEnabledModels?.(null);
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
	writePerInstanceActiveProfile(name); // per-instance, not shared config
	applyProfileToSettings(settings, profile);
	writeSettings(ctx, settings);
	const status = await applyProfile(pi, ctx, profile);
	notify(pi, `Active profile: ${name}. ${status}`);
}

/**
 * /pm model [role] — show available models filtered by the active profile's
 * enabledModels, mark the current role assignment inline, allow the user to
 * pick a new one. Saves the new role to the active profile and calls applyProfile.
 *
 * Role defaults to "smol" when omitted (the most common adjustment).
 */
async function handleModel(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	rawRole: string | undefined,
): Promise<void> {
	const role = rawRole?.trim() || "smol";
	const settings = readSettings(ctx);
	const active = getEffectiveActiveProfileName(settings, pi);
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
		notify(
			pi,
			`Profile "${active}" — role "${role}": ${currentSelector ?? "(not set)"}`,
		);
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

	const options = sorted.map((m) => {
		const full = `${m.provider}/${m.id}`;
		const isCurrent = currentBase === full;
		return {
			label: `${full}${isCurrent ? " (current)" : ""}`,
			description: m.name ?? m.id,
		};
	});

	const chosen = await ctx.ui.select(
		`Set "${role}" model for profile "${active}"`,
		options,
		{
			initialIndex: 0,
			helpText: "Type to filter · Enter to select · Esc to cancel",
		},
	);
	if (!chosen) return;

	// Remove the inline current marker to recover provider/id.
	const chosenFull = chosen.replace(/\s+\(current\)$/, "");

	// Build selector: keep existing thinking level suffix if the model matches.
	let newSelector = chosenFull;
	if (currentSelector && currentBase === chosenFull) {
		// Same model re-selected — keep existing selector unchanged (preserves :level).
		newSelector = currentSelector;
	} else {
		// Ask for thinking level if the model supports it.
		const chosenModel = filtered.find(
			(m) => `${m.provider}/${m.id}` === chosenFull,
		);
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
		settings.modelRoles = {
			...(settings.modelRoles ?? {}),
			[role]: newSelector,
		};
	}
	writeSettings(ctx, settings);
	const status = await applyProfile(pi, ctx, profile);
	notify(
		pi,
		`Profile "${active}" — role "${role}" → ${newSelector}. ${status}`,
	);
}

async function promptThinkingLevel(
	ctx: ExtensionCommandContext,
	modelFull: string,
): Promise<string | undefined> {
	const options = [
		{ label: "(none)", description: "No thinking level suffix" },
		{ label: "low", description: ":low" },
		{ label: "medium", description: ":medium" },
		{ label: "high", description: ":high" },
		{ label: "xhigh", description: ":xhigh" },
	];
	const chosen = await ctx.ui.select(
		`Thinking level for ${modelFull}`,
		options,
		{ initialIndex: 0 },
	);
	if (!chosen || chosen === "(none)") return undefined;
	return chosen;
}

async function handleDelete(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	rawName: string | undefined,
): Promise<void> {
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
	if (settings.activeModelProfile === name) {
		delete settings.activeModelProfile;
		writePerInstanceActiveProfile(undefined);
	}
	writeSettings(ctx, settings);
	notify(pi, `Deleted profile: ${name}`);
}
