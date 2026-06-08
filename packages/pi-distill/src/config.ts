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
	verbatimTools?: unknown;
}

export interface DistillConfig {
	minBytes: number;
	arrayHead: number;
	arrayTail: number;
	scalarMax: number;
	builtinSkip: Set<string>;
	verbatimTools: Set<string>;
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

export function loadConfig(): DistillConfig {
	const file = readFileConfig();
	const envVerbatim = (process.env.PI_DISTILL_VERBATIM_TOOLS ?? "")
		.split(",")
		.map(item => item.trim())
		.filter(Boolean);
	return {
		minBytes: configNumber("PI_DISTILL_MIN_BYTES", file.minBytes, DEFAULTS.minBytes),
		arrayHead: configNumber("PI_DISTILL_ARRAY_HEAD", file.arrayHead, DEFAULTS.arrayHead),
		arrayTail: configNumber("PI_DISTILL_ARRAY_TAIL", file.arrayTail, DEFAULTS.arrayTail),
		scalarMax: configNumber("PI_DISTILL_SCALAR_MAX", file.scalarMax, DEFAULTS.scalarMax),
		builtinSkip: new Set(BUILTIN_TOOLS),
		verbatimTools: new Set([...stringArray(file.verbatimTools), ...envVerbatim]),
	};
}
