/**
 * Config resolution: code defaults < config.json < environment variables.
 *
 * ExtensionAPI exposes no settings accessor, so configuration follows the
 * pi-lean-ctx convention: an optional JSON file plus PI_DISTILL_* env vars.
 *
 *   ~/.omp/agent/extensions/pi-distill/config.json
 *   {
 *     "minBytes": 4096,
 *     "arrayHead": 8,
 *     "arrayTail": 4,
 *     "scalarMax": 240,
 *     "verbatimTools": ["some_mcp_tool"]   // never compress these
 *   }
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { DEFAULTS } from "./compress";

export interface DistillConfig {
	minBytes: number;
	arrayHead: number;
	arrayTail: number;
	scalarMax: number;
	/** Builtin tools whose output is already covered by the native artifact spill. */
	builtinSkip: Set<string>;
	/** Tools whose output must NEVER be elided (returned verbatim). */
	verbatimTools: Set<string>;
}

/**
 * OMP builtin tool names. Their output already goes through
 * `wrapToolWithMetaNotice` → `spillLargeResultToArtifact`, so pi-distill leaves
 * them alone and only acts on MCP / custom tools.
 */
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
] as const;

function configPath(): string {
	return join(homedir(), ".omp", "agent", "extensions", "pi-distill", "config.json");
}

function readFileConfig(): Record<string, unknown> {
	try {
		return JSON.parse(readFileSync(configPath(), "utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function envNum(key: string): number | undefined {
	const raw = process.env[key];
	if (raw === undefined) return undefined;
	const n = Number(raw);
	return Number.isFinite(n) ? n : undefined;
}

function pickNum(env: string, file: unknown, fallback: number): number {
	return envNum(env) ?? (typeof file === "number" ? file : fallback);
}

function toStringArray(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function loadConfig(): DistillConfig {
	const file = readFileConfig();

	const envVerbatim = (process.env.PI_DISTILL_VERBATIM_TOOLS ?? "")
		.split(",")
		.map(s => s.trim())
		.filter(Boolean);

	return {
		minBytes: pickNum("PI_DISTILL_MIN_BYTES", file.minBytes, DEFAULTS.minBytes),
		arrayHead: pickNum("PI_DISTILL_ARRAY_HEAD", file.arrayHead, DEFAULTS.arrayHead),
		arrayTail: pickNum("PI_DISTILL_ARRAY_TAIL", file.arrayTail, DEFAULTS.arrayTail),
		scalarMax: pickNum("PI_DISTILL_SCALAR_MAX", file.scalarMax, DEFAULTS.scalarMax),
		builtinSkip: new Set<string>(BUILTIN_TOOLS),
		verbatimTools: new Set<string>([...toStringArray(file.verbatimTools), ...envVerbatim]),
	};
}
