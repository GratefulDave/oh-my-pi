import { sanitizeRunToken } from "./run-state/store";

export interface ParsedFactoryPlanArgs {
	orchestrator: "omp" | "claude";
	workers: string[];
	runId?: string;
	title?: string;
	objective: string;
}

export interface ParsedFactoryLaunchArgs {
	runId?: string;
	dryRun: boolean;
	claudeCommand: string;
}

export interface ParsedFactorySendArgs {
	runId?: string;
	laneId: string;
	message: string;
}

export interface ParsedFactoryGateArgs {
	runId: string;
	laneId: string;
	status: "approved" | "rejected" | "needs_changes";
	verifier: string;
	severity?: "info" | "warning" | "blocking";
	evidence: string[];
	commands: string[];
	requiredChanges: string[];
	note?: string;
}

const FACTORY_PLAN_USAGE =
	"Usage: /factory-plan [--orchestrator omp|claude] [--workers builder,reviewer] [--run-id <id>] [--title <title>] <objective>";
const FACTORY_LAUNCH_USAGE = "Usage: /factory-launch [--dry-run] [--claude-command <binary>] [run-id]";
const FACTORY_SEND_USAGE = "Usage: /factory-send [run-id] <lane-id> <message>";
const FACTORY_GATE_USAGE =
	"Usage: /factory-gate <run-id> <lane-id> <approved|rejected|needs_changes> --verifier <id> [--severity info|warning|blocking] [--evidence <path>] [--command <command>] [--required-change <text>] [--note <text>]";
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

interface ParsedTokens {
	flags: Map<string, string[]>;
	positionals: string[];
}

function tokenizeArgs(args: string): string[] {
	const trimmed = args.trim();
	if (!trimmed) return [];
	const tokens: string[] = [];
	let index = 0;
	while (index < trimmed.length) {
		if (trimmed[index] === " " || trimmed[index] === "\t") {
			index++;
			continue;
		}
		if (trimmed[index] === '"' || trimmed[index] === "'") {
			const quote = trimmed[index];
			index++;
			let token = "";
			while (index < trimmed.length && trimmed[index] !== quote) {
				if (trimmed[index] === "\\" && index + 1 < trimmed.length) {
					index++;
				}
				token += trimmed[index];
				index++;
			}
			if (index < trimmed.length) index++;
			tokens.push(token);
			continue;
		}
		let token = "";
		while (index < trimmed.length && trimmed[index] !== " " && trimmed[index] !== "\t") {
			token += trimmed[index];
			index++;
		}
		tokens.push(token);
	}
	return tokens;
}

function parseFlagTokens(tokens: string[]): ParsedTokens {
	const flags = new Map<string, string[]>();
	const positionals: string[] = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token.startsWith("--")) {
			const next = tokens[index + 1];
			if (next && !next.startsWith("--")) {
				const values = flags.get(token) ?? [];
				values.push(next);
				flags.set(token, values);
				index++;
				continue;
			}
			flags.set(token, flags.get(token) ?? []);
			continue;
		}
		positionals.push(token);
	}
	return { flags, positionals };
}

function readSingleFlagValue(flags: Map<string, string[]>, flag: string): string | undefined {
	const values = flags.get(flag);
	if (!values || values.length === 0) return undefined;
	return values[values.length - 1];
}

function isValidRunId(value: string | undefined): value is string {
	return typeof value === "string" && RUN_ID_PATTERN.test(value);
}

export function parseFactoryPlanArgs(args: string): ParsedFactoryPlanArgs | { error: string } {
	const parsed = parseFlagTokens(tokenizeArgs(args));
	if (parsed.positionals.length === 0) return { error: FACTORY_PLAN_USAGE };
	const orchestratorValue = readSingleFlagValue(parsed.flags, "--orchestrator");
	if (orchestratorValue && orchestratorValue !== "omp" && orchestratorValue !== "claude") {
		return { error: FACTORY_PLAN_USAGE };
	}
	const runId = readSingleFlagValue(parsed.flags, "--run-id");
	if (runId !== undefined && !isValidRunId(runId)) {
		return { error: FACTORY_PLAN_USAGE };
	}
	const rawWorkers = readSingleFlagValue(parsed.flags, "--workers");
	const workers = rawWorkers
		? [
				...new Set(
					rawWorkers
						.split(",")
						.map(worker => worker.trim())
						.filter(worker => worker.length > 0)
						.map(worker => sanitizeRunToken(worker)),
				),
			]
		: ["builder", "reviewer"];
	if (workers.length === 0) {
		return { error: FACTORY_PLAN_USAGE };
	}
	const orchestrator = orchestratorValue === "claude" ? "claude" : "omp";
	return {
		orchestrator,
		workers,
		runId,
		title: readSingleFlagValue(parsed.flags, "--title"),
		objective: parsed.positionals.join(" "),
	};
}

export function parseFactoryLaunchArgs(args: string): ParsedFactoryLaunchArgs | { error: string } {
	const parsed = parseFlagTokens(tokenizeArgs(args));
	if (parsed.positionals.length > 1) return { error: FACTORY_LAUNCH_USAGE };
	const claudeCommand = readSingleFlagValue(parsed.flags, "--claude-command") ?? "claude";
	if (!claudeCommand || /\s/.test(claudeCommand)) {
		return { error: FACTORY_LAUNCH_USAGE };
	}
	const runId = parsed.positionals[0];
	if (runId !== undefined && !isValidRunId(runId)) {
		return { error: FACTORY_LAUNCH_USAGE };
	}
	return {
		runId,
		dryRun: parsed.flags.has("--dry-run"),
		claudeCommand,
	};
}

export function parseFactorySendArgs(args: string): ParsedFactorySendArgs | { error: string } {
	const tokens = tokenizeArgs(args);
	if (tokens.length < 2) return { error: FACTORY_SEND_USAGE };
	if (tokens.length === 2) {
		return { laneId: tokens[0], message: tokens[1] };
	}
	return {
		runId: tokens[0],
		laneId: tokens[1],
		message: tokens.slice(2).join(" "),
	};
}

export function parseFactoryGateArgs(args: string): ParsedFactoryGateArgs | { error: string } {
	const parsed = parseFlagTokens(tokenizeArgs(args));
	if (parsed.positionals.length !== 3) return { error: FACTORY_GATE_USAGE };
	const [runId, laneId, status] = parsed.positionals;
	if (!isValidRunId(runId)) return { error: FACTORY_GATE_USAGE };
	if (status !== "approved" && status !== "rejected" && status !== "needs_changes") {
		return { error: FACTORY_GATE_USAGE };
	}
	const verifier = readSingleFlagValue(parsed.flags, "--verifier");
	if (!verifier) return { error: FACTORY_GATE_USAGE };
	const severityValue = readSingleFlagValue(parsed.flags, "--severity");
	if (severityValue && severityValue !== "info" && severityValue !== "warning" && severityValue !== "blocking") {
		return { error: FACTORY_GATE_USAGE };
	}
	const severity =
		severityValue === "info" || severityValue === "warning" || severityValue === "blocking"
			? severityValue
			: undefined;
	return {
		runId,
		laneId,
		status,
		verifier,
		severity,
		evidence: parsed.flags.get("--evidence") ?? [],
		commands: parsed.flags.get("--command") ?? [],
		requiredChanges: parsed.flags.get("--required-change") ?? [],
		note: readSingleFlagValue(parsed.flags, "--note"),
	};
}
