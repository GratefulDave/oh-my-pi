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
		// skip unquoted horizontal whitespace (newlines are command separators, not whitespace)
		while (i < len && (command[i] === " " || command[i] === "\t")) i++;
		if (i >= len) break;
		const ch0 = command[i];
		// unquoted shell operators become single-character tokens
		if (ch0 === "|" || ch0 === "&" || ch0 === ";" || ch0 === "\n" || ch0 === "\r") {
			tokens.push(ch0);
			i++;
			continue;
		}
		let token = "";
		// consume one word token (may contain quoted spans or escape sequences)
		while (i < len) {
			const ch = command[i];
			if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") break;
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
	if (tokens.some(t => t === "|" || t === "&" || t === ";" || t === "\n" || t === "\r")) return "compound";
	let idx = 0;
	let first = tokens[0] ?? "";
	// Skip env wrapper and its assignments/flags
	if (first === "env") {
		idx++;
		// skip env options and NAME=value pairs
		while (idx < tokens.length) {
			const t = tokens[idx]!;
			if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
				idx++;
			} else if (t.startsWith("--")) {
				// Long options that take a following separate argument.
				// --unset, --chdir, --split-string consume the next token.
				// --ignore-environment, --null, --debug do not.
				const longTakesArg = /^--(unset|chdir|split-string)$/.test(t);
				idx++;
				if (longTakesArg && idx < tokens.length) {
					idx++; // skip the option's argument
				}
			} else if (t.startsWith("-") && t.length >= 2 && !t.startsWith("--")) {
				// Short options (possibly clustered, e.g. -iS or -S'cmd')
				// Walk character by character through the option cluster.
				const optChars = t.slice(1); // chars after the leading '-'
				let clusterIdx = 0;
				let consumedRest = false;
				while (clusterIdx < optChars.length) {
					const ch = optChars[clusterIdx]!;
					clusterIdx++;
					if (ch === "S") {
						// -S takes the rest of this token (attached) or the next token
						// as a string to re-tokenize and feed as the command.
						const attached = optChars.slice(clusterIdx); // may be empty
						const splitArg = attached.length > 0 ? attached : (tokens[idx + 1] ?? "");
						if (!attached.length) idx++; // consumed next token
						// Re-tokenize the -S argument as if it were a mini-command.
						const splitTokens = shellTokens(splitArg);
						// Skip any leading NAME=value assignments from the re-tokenized args.
						let splitIdx = 0;
						while (splitIdx < splitTokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(splitTokens[splitIdx]!)) {
							splitIdx++;
						}
						// Treat the first non-assignment token as the real command.
						first = splitTokens[splitIdx] ?? "";
						idx++; // advance past the env token itself
						consumedRest = true;
						break;
					} else if ("Cu".includes(ch)) {
						// -C (chdir) and -u (unset) each take the next argument when
						// they appear at the end of the cluster; if attached, the rest
						// of the cluster IS the argument.
						const attached = optChars.slice(clusterIdx);
						if (attached.length > 0) {
							// argument is attached — consumed entirely; stop cluster loop
							consumedRest = true;
							break;
						}
						// argument is the next token
						idx++;
						if (idx < tokens.length) idx++;
						consumedRest = true;
						break;
					}
					// -i, -v, -0 and any other single-char flag: no argument, continue cluster
				}
				if (!consumedRest) idx++;
				if (first !== tokens[0]) break; // -S set first already
			} else {
				break;
			}
		}
		// Only update first from tokens[idx] when -S didn't already set it.
		if (first === tokens[0]) {
			first = tokens[idx] ?? "";
		}
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
