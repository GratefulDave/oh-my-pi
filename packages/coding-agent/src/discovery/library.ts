/**
 * Library Provider
 *
 * Loads skills from the-library hub (library.yaml) with per-skill
 * `enabled_for: [omp]` filtering and proper provider attribution.
 *
 * Hub path resolution order:
 *   1. $LIBRARY_HUB environment variable
 *   2. ~/.config/library/path file (trimmed)
 *   3. Neither present → skip loading, log debug
 *
 * Per-repo .library.yaml overrides support:
 *   skills:        [names]  — intersect with hub-enabled set
 *   extra_skills:  [names]  — add on top (must exist in hub library.yaml)
 *   disable_skills:[names]  — remove from final set
 *
 * Toggle keys (both default true):
 *   skills.enableLibraryUser    — enable global hub skills
 *   skills.enableLibraryProject — enable per-repo .library.yaml overrides
 *
 * Priority: 90 (between native/100 and claude/80)
 *
 * TODO: Load hooks, MCPs, slash-commands, and rules from library.yaml
 *       (deferred — skills only for now; see docs/adrs/library-provider.md)
 */
import * as path from "node:path";
import { logger, parseFrontmatter } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { registerProvider } from "../capability";
import { readFile } from "../capability/fs";
import { type Skill, type SkillFrontmatter, skillCapability } from "../capability/skill";
import type { LoadContext, LoadResult } from "../capability/types";
import { settings } from "../config/settings";
import { compareSkillOrder, createSourceMeta } from "./helpers";

const PROVIDER_ID = "library";
const DISPLAY_NAME = "Library";
const PRIORITY = 90;

// =============================================================================
// Types
// =============================================================================

interface LibrarySkillEntry {
	local_path?: string;
	enabled_for?: string[];
	compatible_with?: string[];
}

interface LibraryYaml {
	skills?: Record<string, LibrarySkillEntry>;
}

interface LocalLibraryYaml {
	/** Intersect hub-enabled set with this list (replaces global allowed set) */
	skills?: string[];
	/** Add these skills on top, regardless of their enabled_for[] value */
	extra_skills?: string[];
	/** Remove these from the final set */
	disable_skills?: string[];
}

// =============================================================================
// Hub resolution
// =============================================================================

/**
 * Resolve the-library hub path from, in order:
 *   1. $LIBRARY_HUB env var
 *   2. ~/.config/library/path file (trimmed)
 *   3. null → no hub configured
 */
async function resolveHubPath(ctx: LoadContext): Promise<string | null> {
	const envHub = Bun.env.LIBRARY_HUB;
	if (envHub?.trim()) return envHub.trim();

	const configFile = path.join(ctx.home, ".config", "library", "path");
	const content = await readFile(configFile);
	if (content?.trim()) return content.trim();

	return null;
}

// =============================================================================
// Toggle helpers
// =============================================================================

function readToggles(): { enableUser: boolean; enableProject: boolean } {
	try {
		return {
			enableUser: settings.get("skills.enableLibraryUser") ?? true,
			enableProject: settings.get("skills.enableLibraryProject") ?? true,
		};
	} catch {
		return { enableUser: true, enableProject: true };
	}
}

// =============================================================================
// YAML parsing
// =============================================================================

function parseLibraryYaml(content: string): LibraryYaml | null {
	try {
		const data = YAML.parse(content);
		if (!data || typeof data !== "object" || Array.isArray(data)) return null;
		return data as LibraryYaml;
	} catch {
		return null;
	}
}

function parseLocalLibraryYaml(content: string): LocalLibraryYaml | null {
	try {
		const data = YAML.parse(content);
		if (!data || typeof data !== "object" || Array.isArray(data)) return null;
		return data as LocalLibraryYaml;
	} catch {
		return null;
	}
}

// =============================================================================
// Skill loading
// =============================================================================

async function loadSkillFromPath(
	skillName: string,
	skillFilePath: string,
	level: "user" | "project",
): Promise<Skill | null> {
	const content = await readFile(skillFilePath);
	if (!content) return null;

	const { frontmatter, body } = parseFrontmatter(content, { source: skillFilePath });
	if (frontmatter.enabled === false) return null;

	const rawName = frontmatter.name;
	const name = typeof rawName === "string" ? rawName.trim() || skillName : skillName;

	return {
		name,
		path: skillFilePath,
		content: body,
		frontmatter: frontmatter as SkillFrontmatter,
		level,
		_source: createSourceMeta(PROVIDER_ID, skillFilePath, level),
	};
}

// =============================================================================
// Main loader
// =============================================================================

async function loadSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	const items: Skill[] = [];
	const warnings: string[] = [];
	const { enableUser, enableProject } = readToggles();

	const hubPath = await resolveHubPath(ctx);
	if (!hubPath) {
		logger.debug("library: no hub configured (set $LIBRARY_HUB or ~/.config/library/path)");
		return { items, warnings };
	}

	// ── Read and parse hub library.yaml ─────────────────────────────────────
	const libraryYamlPath = path.join(hubPath, "library.yaml");
	const libraryYamlContent = await readFile(libraryYamlPath);
	if (!libraryYamlContent) {
		warnings.push(`library: hub found at ${hubPath} but library.yaml is missing or unreadable`);
		return { items, warnings };
	}

	const libraryData = parseLibraryYaml(libraryYamlContent);
	if (!libraryData) {
		warnings.push(`library: failed to parse ${libraryYamlPath}`);
		return { items, warnings };
	}

	const allSkills = libraryData.skills ?? {};

	// ── Build hub-enabled set (enabled_for[] must contain "omp") ────────────
	const hubEnabledNames = new Set<string>();
	if (enableUser) {
		for (const [name, entry] of Object.entries(allSkills)) {
			if (Array.isArray(entry.enabled_for) && entry.enabled_for.includes("omp")) {
				hubEnabledNames.add(name);
			}
		}
	}

	let enabledNames = new Set(hubEnabledNames);

	// ── Per-repo .library.yaml override (project-level) ──────────────────────
	const projectOnlyNames = new Set<string>();
	if (enableProject) {
		const localYamlPath = path.join(ctx.cwd, ".library.yaml");
		const localContent = await readFile(localYamlPath);
		if (localContent) {
			const local = parseLocalLibraryYaml(localContent);
			if (local) {
				// skills: intersect the hub-enabled set
				if (Array.isArray(local.skills) && local.skills.length > 0) {
					const allowed = new Set(local.skills);
					enabledNames = new Set([...enabledNames].filter(n => allowed.has(n)));
				}
				// extra_skills: add project-only skills (must exist in library.yaml)
				if (Array.isArray(local.extra_skills)) {
					for (const name of local.extra_skills) {
						if (name in allSkills && !enabledNames.has(name)) {
							projectOnlyNames.add(name);
						}
					}
				}
				// disable_skills: remove from both sets
				if (Array.isArray(local.disable_skills)) {
					for (const name of local.disable_skills) {
						enabledNames.delete(name);
						projectOnlyNames.delete(name);
					}
				}
			}
		}
	}

	// ── Load all enabled skills in parallel ───────────────────────────────────
	const loadTasks: Array<{ name: string; level: "user" | "project" }> = [
		...[...enabledNames].map(name => ({ name, level: "user" as const })),
		...[...projectOnlyNames].map(name => ({ name, level: "project" as const })),
	];

	await Promise.all(
		loadTasks.map(async ({ name, level }) => {
			const entry = allSkills[name];
			if (!entry?.local_path) {
				warnings.push(`library: skill "${name}" has no local_path, skipping`);
				return;
			}
			const skillFilePath = path.join(hubPath, entry.local_path, "SKILL.md");
			const skill = await loadSkillFromPath(name, skillFilePath, level);
			if (skill) {
				items.push(skill);
			} else {
				warnings.push(`library: failed to read skill "${name}" at ${skillFilePath}`);
			}
		}),
	);

	// Deterministic ordering (matches scanSkillsFromDir convention)
	items.sort((a, b) => compareSkillOrder(a.name, a.path, b.name, b.path));

	return { items, warnings };
}

// =============================================================================
// Provider registration
// =============================================================================

registerProvider<Skill>(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load skills from the-library hub (library.yaml, enabled_for: [omp])",
	priority: PRIORITY,
	load: loadSkills,
});
