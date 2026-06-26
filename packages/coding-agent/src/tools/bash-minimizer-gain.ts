import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";

const MINIMIZER_GAIN_FILE = "minimizer-gain.jsonl";
const BYTES_PER_TOKEN_ESTIMATE = 4;

export type BashMinimizerGainKind = "saved" | "missed";

export interface BashMinimizerGainInput {
	command: string;
	cwd?: string;
	sessionCwd?: string;
	sessionId?: string;
	filter: string;
	inputBytes: number;
	outputBytes: number;
	exitCode: number | null;
	kind?: BashMinimizerGainKind;
	agentDir?: string;
}

export function getBashMinimizerGainPath(agentDir = getAgentDir()): string {
	return path.join(agentDir, MINIMIZER_GAIN_FILE);
}

export async function appendBashMinimizerGainRecord(input: BashMinimizerGainInput): Promise<void> {
	const kind = input.kind ?? "saved";
	const savedBytes = kind === "saved" ? input.inputBytes - input.outputBytes : 0;
	if (kind === "saved" && savedBytes <= 0) return;

	const observedInputBytes = input.inputBytes;
	const observedOutputBytes = input.outputBytes;
	if (kind === "missed" && observedInputBytes <= 0 && observedOutputBytes <= 0) return;

	const recordsPath = getBashMinimizerGainPath(input.agentDir);
	const resolvedCwd = input.cwd ? path.resolve(input.cwd) : undefined;
	const resolvedSessionCwd = input.sessionCwd ? path.resolve(input.sessionCwd) : undefined;
	const cwdRealpath = resolvedCwd ? await fs.realpath(resolvedCwd).catch(() => resolvedCwd) : undefined;
	const sessionCwdRealpath = resolvedSessionCwd
		? await fs.realpath(resolvedSessionCwd).catch(() => resolvedSessionCwd)
		: undefined;
	const record = {
		schemaVersion: 1,
		timestamp: new Date().toISOString(),
		...(cwdRealpath ? { cwd: cwdRealpath } : {}),
		...(sessionCwdRealpath ? { sessionCwd: sessionCwdRealpath } : {}),
		...(input.sessionId ? { sessionId: input.sessionId } : {}),
		command: input.command,
		filter: input.filter,
		inputBytes: observedInputBytes,
		outputBytes: observedOutputBytes,
		savedBytes,
		...(kind === "saved" ? { savedTokens: Math.round(savedBytes / BYTES_PER_TOKEN_ESTIMATE) } : {}),
		exitCode: input.exitCode,
		kind,
	};

	await fs.mkdir(path.dirname(recordsPath), { recursive: true });
	await fs.appendFile(recordsPath, `${JSON.stringify(record)}\n`, "utf8");
}

/**
 * Shell-aware tokenizer: splits `command` on unquoted whitespace and
 * detects shell operators (`|`, `&`, `;`). Returns token strings; operator
 * tokens are the single characters `|`, `&`, or `;`. Backslash-escaped
 * spaces are treated as word characters, not delimiters.
 */
function shellTokens(command: string): string[] {
	const tokens: string[] = [];
	let i = 0;
	const len = command.length;
	while (i < len) {
		// skip unquoted whitespace
		while (i < len && (command[i] === " " || command[i] === "\t")) i++;
		if (i >= len) break;
		const ch0 = command[i];
		// unquoted shell operators become single-character tokens
		if (ch0 === "|" || ch0 === "&" || ch0 === ";") {
			tokens.push(ch0);
			i++;
			continue;
		}
		let token = "";
		// consume one word token (may contain quoted spans or escape sequences)
		while (i < len) {
			const ch = command[i];
			if (ch === " " || ch === "\t") break;
			if (ch === "|" || ch === "&" || ch === ";") break;
			if (ch === "\\") {
				// backslash escape: next char is a literal word character
				i++;
				if (i < len) token += command[i++];
			} else if (ch === "'") {
				// single-quoted: consume until closing '
				i++;
				while (i < len && command[i] !== "'") {
					token += command[i++];
				}
				if (i < len) i++; // skip closing '
			} else if (ch === '"') {
				// double-quoted: consume until closing "
				i++;
				while (i < len && command[i] !== '"') {
					if (command[i] === "\\" && i + 1 < len) i++; // skip escape
					token += command[i++];
				}
				if (i < len) i++; // skip closing "
			} else {
				token += ch;
				i++;
			}
		}
		tokens.push(token);
	}
	return tokens;
}

export function inferBashMinimizerMissedFilter(command: string): string {
	const trimmed = command.trim();
	if (trimmed.length === 0) return "missed";
	// Tokenize first so quoted operators (e.g. `rg 'foo|bar'`) are not
	// misidentified as compound commands.
	const tokens = shellTokens(trimmed);
	// Any unquoted shell operator token means compound command.
	if (tokens.some(t => t === "|" || t === "&" || t === ";")) return "compound";
	let idx = 0;
	let first = tokens[0] ?? "";
	// Skip env wrapper and its assignments/flags (e.g. `env -u FOO cmd` or `env FOO=bar cmd`)
	if (first === "env") {
		idx++;
		// skip env options and NAME=value pairs; env -u VAR takes a following argument
		while (idx < tokens.length) {
			const t = tokens[idx]!;
			if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
				idx++;
			} else if (t.startsWith("-")) {
				idx++;
				// single-char option that takes a following argument (e.g. -u, -n, -i)
				if (/^-[a-z]$/.test(t) && idx < tokens.length && !tokens[idx]!.startsWith("-")) {
					idx++; // skip the option's argument
				}
			} else {
				break;
			}
		}
		first = tokens[idx] ?? "";
	}
	// Skip leading NAME=value env assignments
	while (first && /^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
		idx++;
		first = tokens[idx] ?? "";
	}
	if (!first) return "env";
	const slash = first.lastIndexOf("/");
	const name = slash === -1 ? first : first.slice(slash + 1);
	return name.length === 0 ? "missed" : name;
}
