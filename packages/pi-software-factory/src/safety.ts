import * as path from "node:path";
import type { ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";

type SafetyAction = "block" | "warn";

interface SafetyRule {
	id?: string;
	tool?: string | string[];
	toolName?: string | string[];
	name?: string | string[];
	pattern?: string;
	argumentPattern?: string;
	argsPattern?: string;
	action: SafetyAction;
	message?: string;
}

interface SafetyRulesFile {
	rules: SafetyRule[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readStringList(value: unknown): string | string[] | undefined {
	if (typeof value === "string" && value.length > 0) return value;
	if (Array.isArray(value) && value.every(item => typeof item === "string" && item.length > 0)) {
		return value;
	}
	return undefined;
}

function parseSafetyRules(value: unknown): SafetyRulesFile | undefined {
	if (!isRecord(value) || !Array.isArray(value.rules)) return undefined;

	const rules: SafetyRule[] = [];
	for (const item of value.rules) {
		if (!isRecord(item)) continue;
		const action = item.action;
		if (action !== "block" && action !== "warn") continue;

		rules.push({
			id: readString(item.id),
			tool: readStringList(item.tool),
			toolName: readStringList(item.toolName),
			name: readStringList(item.name),
			pattern: readString(item.pattern),
			argumentPattern: readString(item.argumentPattern),
			argsPattern: readString(item.argsPattern),
			action,
			message: readString(item.message),
		});
	}

	return rules.length > 0 ? { rules } : undefined;
}

async function loadSafetyRules(cwd: string): Promise<SafetyRulesFile | undefined> {
	const rulesFile = Bun.file(path.join(cwd, ".omp/factory/safety.rules.json"));
	if (!(await rulesFile.exists())) return undefined;

	try {
		return parseSafetyRules(await rulesFile.json());
	} catch {
		return undefined;
	}
}

function matchesName(rule: SafetyRule, toolName: string): boolean {
	const configured = rule.tool ?? rule.toolName ?? rule.name;
	if (!configured) return true;
	if (typeof configured === "string") return configured === toolName;
	return configured.includes(toolName);
}

function stringifyInput(input: unknown): string {
	if (isRecord(input) && typeof input.command === "string") {
		return `${input.command}\n${JSON.stringify(input)}`;
	}
	return JSON.stringify(input);
}

function matchesArguments(rule: SafetyRule, input: unknown): boolean {
	const pattern = rule.argumentPattern ?? rule.argsPattern ?? rule.pattern;
	if (!pattern) return true;

	try {
		return new RegExp(pattern).test(stringifyInput(input));
	} catch {
		return false;
	}
}

function formatSafetyMessage(rule: SafetyRule, toolName: string): string {
	return rule.message ?? `Factory safety rule${rule.id ? ` ${rule.id}` : ""} matched tool ${toolName}`;
}

export async function evaluateSafetyRule(
	event: { toolName: string; input: unknown },
	ctx: { cwd: string; ui?: { notify?: (message: string, level: "info" | "warning") => void } },
): Promise<ToolCallEventResult | undefined> {
	const rulesFile = await loadSafetyRules(ctx.cwd);
	if (!rulesFile) return undefined;

	for (const rule of rulesFile.rules) {
		if (!matchesName(rule, event.toolName) || !matchesArguments(rule, event.input)) continue;

		const message = formatSafetyMessage(rule, event.toolName);
		if (rule.action === "block") {
			return { block: true, reason: message };
		}

		ctx.ui?.notify?.(message, "warning");
		return undefined;
	}

	return undefined;
}
