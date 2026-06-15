import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULTS } from "./compress";

const BUILTIN_TOOLS = [
	"bash",
	"read",
	"write",
	"edit",
	"search",
	"grep",
	"find",
	"ls",
	"fetch",
	"lsp",
	"todo",
	"job",
	"ask",
	"resolve",
];

interface FileConfig {
	minBytes?: unknown;
	arrayHead?: unknown;
	arrayTail?: unknown;
	scalarMax?: unknown;
	builtinSkip?: unknown;
	verbatimTools?: unknown;
	whitelistTools?: unknown;
}

export interface DistillConfig {
	minBytes: number;
	arrayHead: number;
	arrayTail: number;
	scalarMax: number;
	builtinSkip: Set<string>;
	verbatimTools: Set<string>;
	whitelistTools: Set<string> | null;
}

function readFileConfig(): FileConfig {
	try {
		const configPath = path.join(os.homedir(), ".omp", "agent", "extensions", "pi-distill", "config.json");
		return JSON.parse(fs.readFileSync(configPath, "utf8")) as FileConfig;
	} catch {
		return {};
	}
}

function envNumber(key: string): number | undefined {
	const raw = process.env[key];
	if (raw === undefined) return undefined;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function configNumber(envKey: string, fileValue: unknown, fallback: number): number {
	return envNumber(envKey) ?? (typeof fileValue === "number" && Number.isFinite(fileValue) ? fileValue : fallback);
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter(item => typeof item === "string") : [];
}

function envStringArray(key: string): string[] | undefined {
	const raw = process.env[key];
	if (raw === undefined) return undefined;
	return raw
		.split(",")
		.map(item => item.trim())
		.filter(Boolean);
}

function configuredStringArray(envKey: string, fileValue: unknown): string[] | undefined {
	const envValue = envStringArray(envKey);
	if (envValue !== undefined) return envValue;
	return Array.isArray(fileValue) ? stringArray(fileValue) : undefined;
}

export function loadConfig(): DistillConfig {
	const file = readFileConfig();
	const envVerbatim = envStringArray("PI_DISTILL_VERBATIM_TOOLS") ?? [];
	const builtinSkip = configuredStringArray("PI_DISTILL_BUILTIN_SKIP", file.builtinSkip) ?? BUILTIN_TOOLS;
	const whitelistTools = configuredStringArray("PI_DISTILL_WHITELIST_TOOLS", file.whitelistTools);
	return {
		minBytes: configNumber("PI_DISTILL_MIN_BYTES", file.minBytes, DEFAULTS.minBytes),
		arrayHead: configNumber("PI_DISTILL_ARRAY_HEAD", file.arrayHead, DEFAULTS.arrayHead),
		arrayTail: configNumber("PI_DISTILL_ARRAY_TAIL", file.arrayTail, DEFAULTS.arrayTail),
		scalarMax: configNumber("PI_DISTILL_SCALAR_MAX", file.scalarMax, DEFAULTS.scalarMax),
		builtinSkip: new Set(builtinSkip),
		verbatimTools: new Set([...stringArray(file.verbatimTools), ...envVerbatim]),
		whitelistTools: whitelistTools === undefined ? null : new Set(whitelistTools),
	};
}
