import * as path from "node:path";

import type { ToolCallEvent } from "@oh-my-pi/pi-coding-agent";

import type { FactoryPolicyMode, FactorySafetyRule, FactorySafetyRules } from "./config";
import { isPathWithinRepo, normalizePathForMatch } from "./paths";

export interface FactorySafetyDecision {
	action: "allow" | "block" | "ask" | "advise" | "continue";
	message?: string;
	ruleId?: string;
}

function escapeRegex(text: string): string {
	return text.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function globToRegex(glob: string): RegExp {
	const normalized = glob.replace(/\\/g, "/");
	const source = normalized
		.split("**")
		.map(segment => segment.split("*").map(escapeRegex).join("[^/]*"))
		.join(".*");
	return new RegExp(`^(?:${source})$`, "i");
}

export function matchesPathGlob(cwd: string, candidatePath: string, glob: string): boolean {
	const relative = normalizePathForMatch(cwd, candidatePath);
	const basename = path.basename(relative);
	const patterns = glob.startsWith("**/") ? [glob, glob.slice(3)] : [glob];
	return patterns.some(pattern => {
		const regex = globToRegex(pattern);
		return regex.test(relative) || regex.test(basename);
	});
}

export function extractToolPaths(event: ToolCallEvent): string[] {
	if (event.toolName === "read") {
		return [String(event.input.path)];
	}
	if (event.toolName === "write") {
		return [String(event.input.path)];
	}
	if (event.toolName === "find") {
		return event.input.paths.map(value => String(value));
	}
	if (event.toolName === "search") {
		return event.input.paths.map(value => String(value));
	}
	if (event.toolName === "edit") {
		const record = event.input as Record<string, unknown>;
		const explicitPath = record.path;
		if (typeof explicitPath === "string") return [explicitPath];
		const patch = record.patch;
		if (typeof patch === "string") {
			const matches = [...patch.matchAll(/^@@\s+(.+)$/gm)].map(match => match[1]?.trim()).filter(Boolean);
			return matches as string[];
		}
	}
	return [];
}

export function validateRulePaths(cwd: string, rules: FactorySafetyRules): string[] {
	const errors: string[] = [];
	for (const rule of rules.rules) {
		for (const glob of rule.pathGlobs ?? []) {
			if (path.isAbsolute(glob) && !isPathWithinRepo(cwd, glob)) {
				errors.push(`Safety rule ${rule.id} points outside repo: ${glob}`);
			}
		}
	}
	return errors;
}

function matchesRule(event: ToolCallEvent, cwd: string, rule: FactorySafetyRule): boolean {
	if (rule.tool && rule.tool !== event.toolName) return false;
	if (event.toolName === "bash" && rule.commandRegex) {
		const command = String(event.input.command ?? "");
		return new RegExp(rule.commandRegex, "i").test(command);
	}

	const toolPaths = extractToolPaths(event);
	if (toolPaths.length > 0 && (rule.pathGlobs?.length ?? 0) > 0) {
		return toolPaths.some(candidatePath =>
			(rule.pathGlobs ?? []).some(glob => matchesPathGlob(cwd, candidatePath, glob)),
		);
	}

	return false;
}

export function modeMessage(mode: FactoryPolicyMode, rule: FactorySafetyRule): string {
	const label = rule.description ?? rule.id;
	if (mode === "ask") return `Factory safety requires confirmation: ${label}`;
	if (mode === "advise") return `Factory safety warning: ${label}`;
	if (mode === "continue") return `Factory safety rejected this call; choose a safer path: ${label}`;
	return `Factory safety blocked this call: ${label}`;
}

export function evaluateSafetyEvent(
	event: ToolCallEvent,
	cwd: string,
	rules: FactorySafetyRules | undefined,
): FactorySafetyDecision {
	if (!rules) return { action: "allow" };
	for (const rule of rules.rules) {
		if (!matchesRule(event, cwd, rule)) continue;
		return {
			action: rule.mode,
			message: modeMessage(rule.mode, rule),
			ruleId: rule.id,
		};
	}
	return { action: "allow" };
}
