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
 *
 * fd-dup redirections (`2>&1`, `>&2`, `&>file`, `&>>file`) are treated as
 * word characters, not shell operators, so `cmd 2>&1` is classified as a
 * single-command call rather than a compound command.
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
		// unquoted shell operators become single-character tokens.
		// Exception: `&` followed immediately by `>` is a redirect prefix (`&>`, `&>>`),
		// not the shell AND/background operator — treat it as the start of a word token.
		if (ch0 === "|" || ch0 === ";" || ch0 === "\n" || ch0 === "\r") {
			tokens.push(ch0);
			i++;
			continue;
		}
		if (ch0 === "&" && (i + 1 >= len || command[i + 1] !== ">")) {
			// Bare `&` (background / && operator) — emit as operator token.
			tokens.push(ch0);
			i++;
			continue;
		}
		let token = "";
		// When `&>` or `&>>` starts the word, consume the prefix immediately so
		// the word builder's inner `&` handler (which requires token.endsWith(">"))
		// works correctly and we avoid an infinite loop on an empty token.
		if (ch0 === "&" && i + 1 < len && command[i + 1] === ">") {
			token += command[i++]; // consume `&`
			token += command[i++]; // consume `>`
			if (i < len && command[i] === ">") token += command[i++]; // `&>>`
		}
		// consume one word token (may contain quoted spans or escape sequences)
		while (i < len) {
			const ch = command[i];
			if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") break;
			if (ch === "|" || ch === ";") break;
			// `&` is an operator unless it is part of a fd-dup redirect: the
			// token so far ends with `>` (e.g. `2>` or `>`) and this `&` begins
			// the target fd (`>&1`, `>>&1`).  In that case, consume it as a word
			// character along with the following fd digits / `-`.
			if (ch === "&") {
				if (token.endsWith(">")) {
					token += ch;
					i++;
					// consume the target fd: digit(s) or `-` (close-fd form)
					while (i < len && (/\d/.test(command[i]!) || command[i] === "-")) {
						token += command[i++];
					}
					continue;
				}
				// `&` in the middle of a non-redirect token is a genuine operator.
				break;
			}
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

/** Skip the operand value of an option flag. Mirrors `skip_option_value` in the Rust minimizer. */
function skipOptionValue(tokens: string[], index: number): number {
	const token = tokens[index];
	if (!token) return index + 1;
	// --opt=value → value is attached
	if (token.startsWith("--") && token.includes("=")) return index + 1;
	// -uvalue → value is attached to short opt
	if (token.startsWith("-") && !token.startsWith("--") && token.length > 2) return index + 1;
	// opt value (separate token)
	return index + 2;
}

/** Skip sudo options and their operands. Mirrors `skip_sudo_options` in the Rust minimizer. */
function skipSudoOptions(tokens: string[], start: number): number {
	let idx = start;
	while (idx < tokens.length) {
		const t = tokens[idx]!;
		if (t === "--") {
			idx++;
			break;
		}
		if (t === "-E" || t === "-H" || t === "-n" || t === "-S" || t === "-k" || t === "-K" || t === "-b") {
			// Flags that take no additional argument
			idx++;
			continue;
		}
		if (
			t === "-u" ||
			t === "--user" ||
			t === "-g" ||
			t === "--group" ||
			t === "-h" ||
			t === "--host" ||
			t === "-p" ||
			t === "--prompt" ||
			t === "-C" ||
			t === "--close-from" ||
			t === "-T" ||
			t === "--command-timeout"
		) {
			idx = skipOptionValue(tokens, idx);
			continue;
		}
		if (
			t.startsWith("--user=") ||
			t.startsWith("--group=") ||
			t.startsWith("--host=") ||
			t.startsWith("--prompt=") ||
			t.startsWith("--close-from=") ||
			t.startsWith("--command-timeout=")
		) {
			idx++;
			continue;
		}
		if (t.startsWith("-")) {
			// Unknown flag — the Rust minimizer returns None here (no identity).
			// For telemetry, still advance past it to a reasonable fallback.
			idx = skipOptionValue(tokens, idx);
			continue;
		}
		break;
	}
	return idx;
}

/** Skip command options and return the new index, or null for -v/-V probes. Mirrors `skip_command_options` in the Rust minimizer. */
function skipCommandOptions(tokens: string[], start: number): number | null {
	let idx = start;
	while (idx < tokens.length) {
		const t = tokens[idx]!;
		if (t === "--") {
			return idx + 1;
		}
		if (t === "-p") {
			idx++;
			continue;
		}
		if (t === "-v" || t === "-V") {
			return null; // probe → no minimizer identity
		}
		if (t.startsWith("-")) return null;
		break;
	}
	return idx;
}

/**
 * Apply the same program-name normalisations as the native minimizer's
 * `normalize_program` in `crates/pi-shell/src/minimizer/detect.rs`.
 */
function normalizeProgramName(name: string): string {
	const lowered = name.toLowerCase();
	switch (lowered) {
		case "gradlew.bat":
			return "gradlew";
		case "mvnw.cmd":
			return "mvnw";
		case "docker-compose":
			return "docker";
		default:
			return lowered;
	}
}

export function inferBashMinimizerMissedFilter(command: string): string {
	const trimmed = command.trim();
	if (trimmed.length === 0) return "missed";
	// Tokenize first so quoted operators (e.g. `rg 'foo|bar'`) are not
	// misidentified as compound commands.
	const tokens = shellTokens(trimmed);
	// NOTE: do NOT bail on shell operators here — the native minimizer
	// stops tokenization at `|`, `;`, `&` and still detects the first
	// command (e.g. `git` from `git status | cat`). Let the prefix-stripping
	// loop below work through launch prefixes to find the first executable
	// before any operator.

	let idx = 0;
	let lastLaunchPrefix: string | undefined;

	// Loop: strip NAME=value assignments, then check for a known launch prefix.
	// Mirrors crates/pi-shell/src/minimizer/detect.rs fn strip_launch_prefix.
	// eslint-disable-next-line no-constant-condition
	while (true) {
		const before = idx;

		// Skip leading NAME=value env assignments at each stage
		while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]!)) {
			idx++;
		}

		const token = tokens[idx];
		if (!token) break;

		if (token === "env") {
			lastLaunchPrefix = "env";
			idx++;
			// skip env options and remaining NAME=value pairs
			idx = skipEnvOptionsAndAssignments(tokens, idx);
		} else if (token === "sudo") {
			lastLaunchPrefix = "sudo";
			idx++;
			idx = skipSudoOptions(tokens, idx);
		} else if (token === "command") {
			const commandIdx = skipCommandOptions(tokens, idx + 1);
			if (commandIdx === null) return "missed"; // -v/-V probe → no minimizer identity
			lastLaunchPrefix = "command";
			idx = commandIdx;
		} else if (token === "builtin" || token === "noglob") {
			lastLaunchPrefix = token;
			idx++;
		} else if (token === "exec") {
			lastLaunchPrefix = "exec";
			idx++;
			// -a NAME, -c, -l take no separate operand besides -a's argument
			while (idx < tokens.length && tokens[idx]!.startsWith("-")) {
				const opt = tokens[idx]!;
				if (opt === "-a" && idx + 1 < tokens.length) idx++; // -a consumes next token
				idx++;
			}
		} else if (token === "time") {
			lastLaunchPrefix = "time";
			idx++;
			// -p, -o FILE, -a FILE, -f FORMAT consume operands
			while (idx < tokens.length && tokens[idx]!.startsWith("-")) {
				const opt = tokens[idx]!;
				if ((opt === "-o" || opt === "-a" || opt === "-f") && idx + 1 < tokens.length) idx++;
				idx++;
			}
		}

		if (idx === before) break;
	}

	const first = tokens[idx] ?? "";
	if (!first) return lastLaunchPrefix ?? "missed";
	// A bare shell operator as the first token means the command is compound.
	if (first === "|" || first === "&" || first === ";" || first === "\n" || first === "\r") return "compound";
	const slash = first.lastIndexOf("/");
	const name = slash === -1 ? first : first.slice(slash + 1);
	if (name.length === 0) return "missed";
	// Apply native-program normalization (e.g. gradlew.bat → gradlew)
	return normalizeProgramName(name);
}

/**
 * Skip env options and NAME=value pairs starting at `start` in `tokens`.
 * Returns the index of the first non-option, non-assignment token.
 *
 * Mirrors crates/pi-shell/src/minimizer/detect.rs fn skip_env_options.
 */
function skipEnvOptionsAndAssignments(tokens: string[], start: number): number {
	let idx = start;
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
					const attached = optChars.slice(clusterIdx);
					const splitArg = attached.length > 0 ? attached : (tokens[idx + 1] ?? "");
					if (!attached.length) idx++; // consumed next token
					// The -S argument defines the real command — splice it back into
					// tokens and return past the original env token.
					const splitTokens = shellTokens(splitArg);
					// Skip any leading NAME=value assignments from the re-tokenized args.
					let splitIdx = 0;
					while (splitIdx < splitTokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(splitTokens[splitIdx]!)) {
						splitIdx++;
					}
					// Splice the split tokens in place of the env token
					const realCommand = splitTokens.slice(splitIdx);
					tokens.splice(idx, 1, ...realCommand);
					consumedRest = true;
					break;
				} else if ("Cu".includes(ch)) {
					// -C (chdir) and -u (unset) each take the next argument when
					// they appear at the end of the cluster; if attached, the rest
					// of the cluster IS the argument.
					const attached = optChars.slice(clusterIdx);
					if (attached.length > 0) {
						// argument is attached — whole token consumed; advance past it
						idx++;
						consumedRest = true;
						break;
					}
					// argument is the next (separate) token
					idx++;
					if (idx < tokens.length) idx++;
					consumedRest = true;
					break;
				}
				// -i, -v, -0 and any other single-char flag: no argument, continue cluster
			}
			if (!consumedRest) idx++;
			if (consumedRest) continue;
		} else {
			break;
		}
	}
	return idx;
}

/**
 * Returns whether a command is eligible for native minimization under the
 * given `only` / `except` pattern lists (from `ShellMinimizerSettings`).
 *
 * Mirrors the native minimizer's exact-lowercase membership check:
 * `is_program_enabled` in `crates/pi-shell/src/minimizer/config.rs` lowercases
 * the program and `HashSet::contains`-checks `only` and `except`.
 *
 * Compound or unrecognised commands are always ineligible.
 */
export function isBashCommandMinimizerEligible(command: string, only: string[], except: string[]): boolean {
	const filter = inferBashMinimizerMissedFilter(command);
	// Compound commands, empty results, and bare-prefix results are never minimized.
	if (filter === "compound" || filter === "missed" || filter === "env") return false;
	if (only.length === 0 && except.length === 0) return true;
	const lower = filter.toLowerCase();
	if (only.length > 0 && !only.some(p => p.toLowerCase() === lower)) return false;
	if (except.length > 0 && except.some(p => p.toLowerCase() === lower)) return false;
	return true;
}
