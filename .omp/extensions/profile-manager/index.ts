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

// ── settings store (.omp/settings.json I/O) ───────────────────────────────────
//
// Profiles are GLOBAL: stored at the user level (~/.omp/agent/settings.json) so
// they persist across every project, not just the directory where they were
// created. Reads merge user-level + project-level (project overrides on name
// clash) so a repo can still pin its own profile; writes always go to the user
// file and touch ONLY the profile keys, preserving extensions/disabledProviders
// and anything else already in it. This mirrors the file the binary loads user
// settings from (settings.ts -> #agentDir/settings.json).

function userSettingsPath(): string {
	return path.join(os.homedir(), ".omp", "agent", "settings.json");
}

function projectSettingsPath(ctx: ExtensionContext): string {
	return path.join(ctx.cwd, ".omp", "settings.json");
}

function readSettingsFile(file: string): OmpSettings {
	try {
		const raw = fs.readFileSync(file, "utf8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as OmpSettings;
		}
	} catch {
		// Missing or unreadable file → treat as empty.
	}
	return {};
}

function readSettings(ctx: ExtensionContext): OmpSettings {
	const user = readSettingsFile(userSettingsPath());
	const project = readSettingsFile(projectSettingsPath(ctx));
	return {
		...user,
		...project,
		// Union the profile maps so user-global and project profiles both show;
		// a project profile shadows a same-named user profile.
		modelProfiles: { ...(user.modelProfiles ?? {}), ...(project.modelProfiles ?? {}) },
		// Project active selection wins if present, else the user-level one.
		activeModelProfile: project.activeModelProfile ?? user.activeModelProfile,
	};
}

function writeSettings(_ctx: ExtensionContext, settings: OmpSettings): void {
	// Persist only the profile keys to the user file; preserve everything else
	// already there (extensions[], disabledProviders, …).
	const file = userSettingsPath();
	const existing = readSettingsFile(file);
	existing.modelProfiles = settings.modelProfiles;
	if (settings.activeModelProfile !== undefined) {
		existing.activeModelProfile = settings.activeModelProfile;
	} else {
		delete existing.activeModelProfile;
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
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
 * Returns a status string describing what was applied (or why it was skipped).
 *
 * NOTE: Only the `default` model role and thinking level can be applied live —
 * the public ExtensionAPI exposes no setter for secondary model roles,
 * cycleOrder, enabledModels, or modelProviderOrder. Those persist to
 * settings.json for the binary to consume on load/reload.
 */
async function applyProfile(pi: ExtensionAPI, ctx: ExtensionContext, profile: ModelProfile): Promise<string> {
	// Apply ALL roles (default + smol/plan/slow/…) live for sub-agent dispatch.
	// overrideModelRoles is the fork's intended mechanism (in-memory, no disk).
	if (profile.modelRoles && Object.keys(profile.modelRoles).length > 0) {
		pi.overrideModelRoles(profile.modelRoles);
	}

	const selector = profile.modelRoles?.default;
	if (!selector) return "Applied model roles; no 'default' role to set as the active model.";

	const { id, thinkingLevel } = splitModelSelector(selector);
	const model = resolveModel(ctx, id);
	if (!model) return `Profile saved, but model "${id}" is not available in this session.`;

	const ok = await pi.setModel(model);
	if (!ok) return `Profile saved, but no API key is configured for ${model.provider}/${model.id}.`;

	const level = thinkingLevel ?? profile.defaultThinkingLevel;
	if (level && level !== "auto" && THINKING_LEVELS.has(level)) {
		pi.setThinkingLevel(level as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
	}
	return `Switched model to ${model.provider}/${model.id}${level ? ` (${level})` : ""}.`;
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
		delete settings.activeModelProfile;
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
	writeSettings(ctx, settings);
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
