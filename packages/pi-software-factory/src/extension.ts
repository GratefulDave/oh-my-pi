import * as path from "node:path";
import { runFactoryDoctor } from "./doctor";
import { dryRunScaffoldFactory, dryRunUpgradeFactory, getFactoryPresets, scaffoldFactory } from "./scaffold";

interface FactoryUi {
	notify(message: string, level: "info" | "warning"): void;
	setEditorText(value: string): void;
	setStatus(id: string, value: string): void;
}

interface FactoryCommandContext {
	cwd: string;
	ui: FactoryUi;
}

interface FactoryToolCallEvent {
	toolName: string;
	input: unknown;
}

interface FactoryToolCallContext {
	cwd: string;
	ui?: { notify?: (message: string, level: "info" | "warning") => void };
}

interface FactoryToolCallResult {
	block?: boolean;
	reason?: string;
}

interface FactoryExtensionApi {
	setLabel(value: string): void;
	registerCommand(
		name: string,
		command: {
			description: string;
			handler(args: string, ctx: FactoryCommandContext): Promise<void>;
		},
	): void;
	on(
		event: "tool_call",
		handler: (event: FactoryToolCallEvent, ctx: FactoryToolCallContext) => Promise<FactoryToolCallResult | undefined>,
	): void;
}

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

async function evaluateSafetyRule(
	event: FactoryToolCallEvent,
	ctx: FactoryToolCallContext,
): Promise<FactoryToolCallResult | undefined> {
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

export default function softwareFactory(pi: FactoryExtensionApi): void {
	pi.setLabel("Software Factory");

	// Register slash command: /factory-status
	pi.registerCommand("factory-status", {
		description: "Check factory health and configuration",
		handler: async (_args, ctx) => {
			const cwd = ctx.cwd;
			const result = await runFactoryDoctor(cwd);

			const lines = [`# Factory Status (${cwd})`, ""];
			for (const check of result.checks) {
				const icon = check.ok ? "✓" : "✗";
				const path = check.path ? `\`${check.path}\`` : "";
				lines.push(`${icon} ${check.message} ${path}`);
			}
			lines.push("", `**Result**: ${result.ok ? "PASSED" : "FAILED"}`);

			ctx.ui.notify(lines.join("\n"), result.ok ? "info" : "warning");
			ctx.ui.setStatus("factory", result.ok ? "Factory: OK" : "Factory: Issues found");
			ctx.ui.setEditorText("");
		},
	});

	// Register slash command: /factory-init
	pi.registerCommand("factory-init", {
		description: "Scaffold a software factory for the current project",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd;
			const parts = args.split(/\s+/).filter(Boolean);
			let preset = "standard";
			const presetIdx = parts.indexOf("--preset");
			if (presetIdx !== -1 && parts[presetIdx + 1]) {
				preset = parts[presetIdx + 1];
			}

			if (parts.includes("--list-presets")) {
				const presets = getFactoryPresets();
				ctx.ui.notify(["# Factory Presets", ...presets.map(presetName => `- ${presetName}`)].join("\n"), "info");
				ctx.ui.setEditorText("");
				return;
			}

			if (parts.includes("--dry-run")) {
				const result = await dryRunScaffoldFactory({ cwd, preset, enableMemory: true });
				const lines = [
					"# Factory Scaffold Dry Run",
					`Preset: ${preset}`,
					"",
					`Would write ${result.filesToWrite.length} file(s):`,
					...result.filesToWrite.map(f => `- \`${f}\``),
				];
				if (result.filesSkipped.length > 0) {
					lines.push(
						"",
						`Would skip ${result.filesSkipped.length} existing file(s):`,
						...result.filesSkipped.map(f => `- \`${f}\``),
					);
				}
				if (result.errors.length > 0) {
					lines.push("", "## Errors", ...result.errors.map(e => `- ${e.target}: ${e.error}`));
				}
				ctx.ui.notify(lines.join("\n"), result.errors.length > 0 ? "warning" : "info");
				ctx.ui.setStatus("factory", `Factory dry run: ${result.filesToWrite.length} files would be written`);
				ctx.ui.setEditorText("");
				return;
			}

			ctx.ui.setStatus("factory", `Scaffolding factory (preset: ${preset})...`);

			const result = await scaffoldFactory({ cwd, preset, enableMemory: true });

			const lines = [
				"# Factory Scaffolded",
				`Created ${result.filesWritten.length} file(s):`,
				...result.filesWritten.map(f => `- \`${f}\``),
			];

			if (result.errors.length > 0) {
				lines.push("", "## Errors", ...result.errors.map(e => `- ${e.target}: ${e.error}`));
			}

			ctx.ui.notify(lines.join("\n"), result.errors.length > 0 ? "warning" : "info");
			ctx.ui.setStatus("factory", `Factory scaffolded: ${result.filesWritten.length} files created`);
			ctx.ui.setEditorText("");
		},
	});

	// Register slash command: /factory-upgrade --dry-run
	pi.registerCommand("factory-upgrade", {
		description: "Compare existing factory files with current templates",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd;
			const parts = args.split(/\s+/).filter(Boolean);
			let preset = "standard";
			const presetIdx = parts.indexOf("--preset");
			if (presetIdx !== -1 && parts[presetIdx + 1]) {
				preset = parts[presetIdx + 1];
			}

			if (!parts.includes("--dry-run")) {
				ctx.ui.notify("`/factory-upgrade` currently supports only `--dry-run`.", "warning");
				ctx.ui.setEditorText("");
				return;
			}

			const result = await dryRunUpgradeFactory({ cwd, preset, enableMemory: true });
			const lines = [
				"# Factory Upgrade Dry Run",
				`Preset: ${preset}`,
				"",
				`Create (${result.create.length}):`,
				...result.create.map(f => `- \`${f}\``),
				"",
				`Update (${result.update.length}):`,
				...result.update.map(f => `- \`${f}\``),
				"",
				`Conflict (${result.conflict.length}):`,
				...result.conflict.map(item => `- \`${item.target}\`: ${item.error}`),
				"",
				`Unchanged (${result.unchanged.length}):`,
				...result.unchanged.map(f => `- \`${f}\``),
			];

			ctx.ui.notify(lines.join("\n"), result.conflict.length > 0 ? "warning" : "info");
			ctx.ui.setStatus(
				"factory",
				`Factory upgrade dry run: ${result.create.length} create, ${result.update.length} update`,
			);
			ctx.ui.setEditorText("");
		},
	});

	// Safety enforcement hook
	pi.on("tool_call", async (event, ctx) => {
		return evaluateSafetyRule(event, ctx);
	});
}
