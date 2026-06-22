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
		schemaVersion: 2,
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
 * Shell-aware tokenizer: splits `command` on unquoted whitespace, consuming
 * single-quoted ('…') and double-quoted ("…") spans without splitting on the
 * whitespace inside them.  Only the first few tokens are needed, so we stop
 * once we have found the real program token.
 */
function shellTokens(command: string): string[] {
	const tokens: string[] = [];
	let i = 0;
	const len = command.length;
	while (i < len) {
		// skip unquoted whitespace
		while (i < len && (command[i] === " " || command[i] === "\t")) i++;
		if (i >= len) break;
		let token = "";
		// consume one token (may contain quoted spans)
		while (i < len && command[i] !== " " && command[i] !== "\t") {
			const ch = command[i];
			if (ch === "'") {
				// single-quoted: consume until closing '
				i++;
				while (i < len && command[i] !== "'") {
					token += command[i++];
				}
				if (i < len) i++; // skip closing '
			} else if (ch === '"') {
				// double-quoted: consume until closing " (no backslash handling needed for identity)
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
	if (/[;&|]/.test(trimmed)) return "compound";
	// Use shell-aware tokenization so quoted env values containing whitespace
	// (e.g. NODE_OPTIONS='--max-old-space-size=4096 --trace-warnings' pnpm test)
	// don't cause the loop to stop at a value fragment instead of the real command.
	const tokens = shellTokens(trimmed);
	let first = tokens[0] ?? "";
	let idx = 0;
	while (first && /^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
		idx++;
		first = tokens[idx] ?? "";
	}
	if (!first) return "env";
	const slash = first.lastIndexOf("/");
	const name = slash === -1 ? first : first.slice(slash + 1);
	return name.length === 0 ? "missed" : name;
}
