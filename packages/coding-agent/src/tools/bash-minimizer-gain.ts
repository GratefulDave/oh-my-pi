import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";

const MINIMIZER_GAIN_FILE = "minimizer-gain.jsonl";
const BYTES_PER_TOKEN_ESTIMATE = 4;

export type BashMinimizerGainKind = "saved" | "missed";
export interface BashMinimizerEligibilityConfig {
	enabled: boolean;
	only: string[];
	except: string[];
	maxCaptureBytes: number;
	legacyFilters: boolean | undefined;
	userPipelineFilters: BashMinimizerPipelineFilter[];
}

interface BashMinimizerPipelineFilter {
	matchCommand: RegExp;
	matchSubcommand?: RegExp;
}

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
 * Shell-aware tokenizer: splits `command` on unquoted whitespace,
 * ignores unquoted shell comments, and detects shell operators (`|`, `&`,
 * `;`, newlines). Returns token strings; operator tokens are the single
 * characters `|`, `&`, `;`, `\n`, or `\r`. Backslash-escaped spaces are
 * treated as word characters, not delimiters.
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
		if (ch0 === "#") {
			while (i < len && command[i] !== "\n" && command[i] !== "\r") i++;
			continue;
		}
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
function skipSudoOptions(tokens: string[], start: number): number | null {
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
			// Unknown flag — mirrors Rust minimizer returning None (no identity).
			return null;
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

/**
 * Tokenize, strip launch prefixes (env/sudo/command/builtin/noglob/exec/time),
 * and return the normalized program plus the subcommand the native minimizer
 * would dispatch on. Returns `null` when the native minimizer would return no
 * identity (empty command, bare shell operator, `env -S`, unknown sudo flag,
 * `command -v`, …).
 *
 * Mirrors `detect()` + `strip_launch_prefix()` + `detect_subcommand()` in
 * `crates/pi-shell/src/minimizer/detect.rs`. The subcommand is extracted with
 * the same per-program global-flag skipping the native detector uses, so that
 * `supports(program, subcommand)` agrees with the Rust `filters::supports`
 * dispatch — a command like `git -C repo rev-parse` resolves to subcommand
 * `rev-parse`, which `git::supports` rejects, instead of being mis-bucketed
 * under a supported subcommand.
 */
function detectProgramAndSubcommandFromTokens(
	tokens: string[],
): { program: string; subcommand: string | undefined } | null {
	if (tokens.length === 0) return null;
	// NOTE: do NOT bail on shell operators here — the native minimizer
	// stops tokenization at `|`, `;`, `&` and still detects the first
	// command (e.g. `git` from `git status | cat`). Eligibility for piped /
	// background / compound commands is rejected separately in
	// `isBashCommandMinimizerEligible` via the operator-token scan.

	let idx = 0;

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
			idx++;
			// skip env options and remaining NAME=value pairs
			// null → native returns no identity (e.g. -S/--split-string) → ineligible
			const envIdx = skipEnvOptionsAndAssignments(tokens, idx);
			if (envIdx === null) return null;
			idx = envIdx;
		} else if (token === "sudo") {
			idx++;
			const sudoIdx = skipSudoOptions(tokens, idx);
			if (sudoIdx === null) return null; // unknown sudo flag → no identity (mirrors Rust None)
			idx = sudoIdx;
		} else if (token === "command") {
			const commandIdx = skipCommandOptions(tokens, idx + 1);
			if (commandIdx === null) return null; // -v/-V probe → no minimizer identity
			idx = commandIdx;
		} else if (token === "builtin" || token === "noglob") {
			idx++;
		} else if (token === "exec") {
			idx++;
			while (idx < tokens.length) {
				const opt = tokens[idx]!;
				if (opt === "--") {
					idx++;
					break;
				}
				if (opt === "-c" || opt === "-l") {
					idx++;
					continue;
				}
				if (opt === "-a") {
					if (idx + 1 >= tokens.length) return null;
					idx += 2;
					continue;
				}
				if (opt.startsWith("-")) return null;
				break;
			}
		} else if (token === "time") {
			idx++;
			while (idx < tokens.length) {
				const opt = tokens[idx]!;
				if (opt === "--") {
					idx++;
					break;
				}
				if (opt === "-p" || opt === "--portability" || opt === "-v" || opt === "--verbose") {
					idx++;
					continue;
				}
				if (opt === "-f" || opt === "--format" || opt === "-o" || opt === "--output") {
					if (idx + 1 >= tokens.length) return null;
					idx += 2;
					continue;
				}
				if (opt.startsWith("--format=") || opt.startsWith("--output=")) {
					idx++;
					continue;
				}
				if (opt.startsWith("-")) return null;
				break;
			}
		}

		if (idx === before) break;
	}

	const first = tokens[idx] ?? "";
	if (!first) return null;
	// A bare shell operator as the first token means the command is compound.
	if (first === "|" || first === "&" || first === ";" || first === "\n" || first === "\r") return null;
	const slash = first.lastIndexOf("/");
	const name = slash === -1 ? first : first.slice(slash + 1);
	if (name.length === 0) return null;
	// Apply native-program normalization (e.g. gradlew.bat → gradlew)
	const program = normalizeProgramName(name);
	const rest = tokens.slice(idx + 1);
	// docker-compose v1 normalizes to "docker" but has its own global flags
	// (-f/--file/--profile/-p/--project-name/…) that consume values; mirror the
	// native detect_tokens docker-compose branch so the real action is found.
	const isDockerCompose = name.toLowerCase() === "docker-compose";
	const subcommand = isDockerCompose
		? firstNonGlobalArg(
				rest,
				[
					"-f",
					"--file",
					"--profile",
					"-p",
					"--project-name",
					"--env-file",
					"--parallel",
					"--progress",
					"--project-directory",
					"--workdir",
					"-w",
					"--ansi",
					"--log-level",
					"-H",
					"--host",
					"--tlscacert",
					"--tlscert",
					"--tlskey",
				],
				["--compatibility", "--dry-run", "--verbose", "-v", "--no-ansi"],
				[],
			)
		: detectSubcommand(program, rest);
	return { program, subcommand };
}

function detectProgramAndSubcommand(command: string): { program: string; subcommand: string | undefined } | null {
	const trimmed = command.trim();
	if (trimmed.length === 0) return null;
	// Tokenize first so quoted operators (e.g. `rg 'foo|bar'`) are not
	// misidentified as compound commands.
	return detectProgramAndSubcommandFromTokens(shellTokens(trimmed));
}

/**
 * Return the minimizer program name for a command, or `"missed"` when the
 * native minimizer would return no identity. This is the value recorded in
 * the `filter` field of missed telemetry rows and shown in the Gain
 * dashboard's top-filters list.
 */
export function inferBashMinimizerMissedFilter(command: string): string {
	return detectProgramAndSubcommand(command)?.program ?? "missed";
}

/**
 * Skip env options and NAME=value pairs starting at `start` in `tokens`.
 * Returns the index of the first non-option, non-assignment token, or `null`
 * when the native minimizer returns no identity (e.g. `-S`/`--split-string`).
 *
 * Mirrors `skip_env_options` in `crates/pi-shell/src/minimizer/detect.rs`:
 * exact-token matching only — no clustered short options, no attached short
 * values (e.g. `-C/tmp`, `-iS`). The Rust detector breaks on those, making
 * the unknown token the "program" (which fails identity_has_filter); we
 * mirror by breaking out of the loop so `detectProgramAndSubcommand` returns
 * the raw token as the program (ineligible).
 */
function skipEnvOptionsAndAssignments(tokens: string[], start: number): number | null {
	let idx = start;
	while (idx < tokens.length) {
		const t = tokens[idx]!;
		if (t === "--") {
			idx++;
			break;
		}
		if (t === "-S" || t === "--split-string" || t.startsWith("--split-string=")) return null;
		if (t === "-i" || t === "-" || t === "--ignore-environment") {
			idx++;
			continue;
		}
		if (t === "-u" || t === "--unset" || t === "-C" || t === "--chdir") {
			idx = skipOptionValue(tokens, idx);
			continue;
		}
		if (t.startsWith("--unset=") || t.startsWith("--chdir=")) {
			idx++;
			continue;
		}
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
			idx++;
			continue;
		}
		break;
	}
	return idx;
}

/**
 * Returns whether a command is eligible for native minimization under the
 * resolved minimizer config.
 *
 * For safe `&&`/`;` chains, the native minimizer routes through
 * `SegmentedChain` and captures each segment independently. This function
 * mirrors that by splitting the command on `&&`/`;` separators and checking
 * whether ANY segment is eligible — so `echo prep && git status` returns
 * true (the `git status` segment is eligible) even though `echo` is not.
 *
 * Piped segments are opaque, but they do not make the whole chain ineligible:
 * native `SegmentedChain` can still capture a later eligible segment in
 * `ls | head -5 && git status`. Standalone background `&` and `||` remain
 * ineligible.
 *
 * The `only`/`except` check mirrors the native `is_program_enabled` exact-
 * lowercase membership test in
 * `crates/pi-shell/src/minimizer/config.rs`.
 */
export function isBashCommandMinimizerEligible(
	command: string,
	only: string[],
	except: string[],
	config?: Partial<BashMinimizerEligibilityConfig>,
): boolean {
	const tokens = shellTokens(command.trim());
	if (tokens.length === 0) return false;
	if (config?.enabled === false) return false;
	if (hasIneligibleShellOperatorFromTokens(tokens)) return false;
	const segments = splitChainSegments(tokens);
	if (segments.length > 1 && config?.legacyFilters === true) return false;
	if (segments.length > 1 && segments.some(segmentMutatesShellState)) return false;
	if (segments.length > 1 && segments.some(segmentUnsafeForChain)) return false;
	const resolved = {
		only,
		except,
		userPipelineFilters: config?.userPipelineFilters ?? [],
	};
	return segments.some(seg =>
		isSegmentEligible(seg, resolved.only, resolved.except, resolved.userPipelineFilters, segments.length > 1),
	);
}

export async function resolveBashMinimizerEligibilityConfig(input: {
	settingsPath: string | undefined;
	only: string[];
	except: string[];
	maxCaptureBytes: number;
	legacyFilters: boolean | undefined;
	enabled: boolean;
}): Promise<BashMinimizerEligibilityConfig> {
	const legacyRequested = resolveLegacyFilters(input.legacyFilters);
	const resolved: BashMinimizerEligibilityConfig = {
		enabled: input.enabled,
		only: input.only,
		except: input.except,
		maxCaptureBytes: Math.max(input.maxCaptureBytes, 1024),
		legacyFilters: legacyRequested,
		userPipelineFilters: [],
	};
	if (!input.settingsPath) return resolved;
	const text = await Bun.file(expandTilde(input.settingsPath))
		.text()
		.catch(() => undefined);
	if (!text) return resolved;
	const parsed = parseMinimizerSettingsFile(text);
	if (!parsed) return resolved;
	const parsedLegacy = parsed.legacyFilters ?? resolved.legacyFilters;
	return {
		enabled: input.enabled === false ? false : (parsed.enabled ?? resolved.enabled),
		only: parsed.only ?? resolved.only,
		except: parsed.except ?? resolved.except,
		maxCaptureBytes: parsed.maxCaptureBytes ?? resolved.maxCaptureBytes,
		legacyFilters: input.legacyFilters === false ? false : legacyRequested || parsedLegacy,
		userPipelineFilters: parsed.userPipelineFilters,
	};
}

interface ParsedMinimizerSettingsFile {
	enabled?: boolean;
	only?: string[];
	except?: string[];
	maxCaptureBytes?: number;
	legacyFilters?: boolean;
	userPipelineFilters: BashMinimizerPipelineFilter[];
}

function parseMinimizerSettingsFile(text: string): ParsedMinimizerSettingsFile | undefined {
	let raw: Record<string, unknown>;
	try {
		raw = Bun.TOML.parse(text) as Record<string, unknown>;
	} catch {
		return undefined;
	}
	const schemaVersion = raw.schema_version;
	if (typeof schemaVersion === "number" && schemaVersion !== 1) {
		return undefined;
	}
	return {
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : undefined,
		only: collectStringArray(raw.only),
		except: collectStringArray(raw.except),
		maxCaptureBytes: typeof raw.max_capture_bytes === "number" ? Math.max(raw.max_capture_bytes, 1024) : undefined,
		legacyFilters: typeof raw.legacy_filters === "boolean" ? raw.legacy_filters : undefined,
		userPipelineFilters: collectPipelineFilters(raw.filters),
	};
}

function collectStringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every(item => typeof item === "string") ? value : undefined;
}

function collectPipelineFilters(value: unknown): BashMinimizerPipelineFilter[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	const filters: BashMinimizerPipelineFilter[] = [];
	let hasInvalidRegex = false;
	for (const raw of Object.values(value)) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const matchCommand = (raw as Record<string, unknown>).match_command;
		if (typeof matchCommand !== "string") continue;
		const commandRegex = compileRegex(matchCommand);
		if (!commandRegex) {
			hasInvalidRegex = true;
			continue;
		}
		const matchSubcommand = (raw as Record<string, unknown>).match_subcommand;
		const subcommandRegex = typeof matchSubcommand === "string" ? compileRegex(matchSubcommand) : undefined;
		if (typeof matchSubcommand === "string" && !subcommandRegex) {
			hasInvalidRegex = true;
			continue;
		}
		filters.push({ matchCommand: commandRegex, ...(subcommandRegex ? { matchSubcommand: subcommandRegex } : {}) });
	}
	return hasInvalidRegex ? [] : filters;
}

function compileRegex(pattern: string): RegExp | undefined {
	try {
		return new RegExp(pattern);
	} catch {
		return undefined;
	}
}

function expandTilde(rawPath: string): string {
	if (rawPath === "~") return os.homedir();
	if (rawPath.startsWith("~/")) return path.join(os.homedir(), rawPath.slice(2));
	return rawPath;
}

function resolveLegacyFilters(option: boolean | undefined): boolean {
	if (option !== undefined) return option;
	const raw = Bun.env.OMP_MINIMIZER_LEGACY_FILTERS;
	if (raw === undefined) return false;
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes";
}

function isSegmentEligible(
	tokens: string[],
	only: string[],
	except: string[],
	userPipelineFilters: BashMinimizerPipelineFilter[],
	inChain: boolean,
): boolean {
	if (segmentHasPipe(tokens) && !inChain) return false;
	const identity = detectProgramAndSubcommandFromTokens(tokens);
	if (!identity) return false;
	if (inChain && isCommonChainUtility(rawSegmentProgram(tokens))) return true;
	if (!programEnabled(identity.program, only, except)) return false;
	if (supportsProgram(identity.program, identity.subcommand)) return true;
	if (userPipelineFilters.some(filter => pipelineFilterMatches(filter, identity.program, identity.subcommand)))
		return true;
	return false;
}

function isCommonChainUtility(program: string | undefined): boolean {
	return program !== undefined && COMMON_CHAIN_UTILITIES[program] === true;
}

function rawSegmentProgram(tokens: string[]): string | undefined {
	for (const token of tokens) {
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
		return token;
	}
	return undefined;
}

function programEnabled(program: string, only: string[], except: string[]): boolean {
	const lower = program.toLowerCase();
	if (except.length > 0 && except.some(p => p.toLowerCase() === lower)) return false;
	if (only.length > 0 && !only.some(p => p.toLowerCase() === lower)) return false;
	return true;
}

function pipelineFilterMatches(
	filter: BashMinimizerPipelineFilter,
	program: string,
	subcommand: string | undefined,
): boolean {
	if (!filter.matchCommand.test(program)) return false;
	filter.matchCommand.lastIndex = 0;
	if (!filter.matchSubcommand) return true;
	const matches = filter.matchSubcommand.test(subcommand ?? "");
	filter.matchSubcommand.lastIndex = 0;
	return matches;
}

function segmentHasPipe(tokens: string[]): boolean {
	return tokens.includes("|");
}

function segmentMutatesShellState(tokens: string[]): boolean {
	const program = firstExecutableToken(tokens);
	if (!program) return false;
	if (isShellStateMutatingProgram(program)) return true;
	if ((program === "command" || program === "builtin") && commandWrapperInvokesMutator(tokens)) return true;
	return false;
}

function firstExecutableToken(tokens: string[]): string | undefined {
	for (const token of tokens) {
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
		return normalizeProgramName(token);
	}
	return undefined;
}

function isShellStateMutatingProgram(program: string): boolean {
	return (
		program === "exec" ||
		program === "eval" ||
		program === "source" ||
		program === "." ||
		program === "alias" ||
		program === "unalias"
	);
}

function commandWrapperInvokesMutator(tokens: string[]): boolean {
	for (const token of tokens) {
		if (isShellStateMutatingProgram(normalizeProgramName(token))) return true;
		if (isAmbiguousAssignmentFragment(token)) return true;
		if (
			token === "command" ||
			token === "builtin" ||
			token.startsWith("-") ||
			/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
		) {
			continue;
		}
		return false;
	}
	return false;
}

function segmentUnsafeForChain(tokens: string[]): boolean {
	const program = rawSegmentProgram(tokens);
	if (program?.startsWith("(") && program.endsWith(")")) return true;
	if (
		tokens.some(token => {
			if (token.startsWith("<<<")) {
				return token.includes("$(") || token.includes("`") || token.includes("<(") || token.includes(">(");
			}
			return (
				token.includes("$(") ||
				token.includes("`") ||
				token.includes("<(") ||
				token.includes(">(") ||
				token.startsWith("<<")
			);
		})
	) {
		return true;
	}
	if (
		tokens.some(token => {
			if (token === "{" || token === "}") return true;
			if (token.startsWith("(") && !token.includes(")")) return true;
			return token.endsWith(")") && !token.includes("(");
		})
	) {
		return true;
	}
	return isNativeOpaqueChainWord(program);
}

function isNativeOpaqueChainWord(program: string | undefined): boolean {
	switch (program) {
		case "!":
		case "time":
		case "if":
		case "then":
		case "else":
		case "elif":
		case "fi":
		case "for":
		case "while":
		case "until":
		case "do":
		case "done":
		case "case":
		case "esac":
		case "select":
		case "function":
			return true;
		default:
			return false;
	}
}
function isAmbiguousAssignmentFragment(token: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token) && (token.includes('"') || token.includes("'"));
}

/**
 * Split a token array on safe chain separators (`&&`, `;`, and newlines),
 * returning each segment as a sub-array. Mirrors the native `SegmentedChain`
 * extraction. Pipe (`|`) tokens stay inside their segment; an opaque piped
 * segment does not prevent a later eligible segment from being captured.
 */
function splitChainSegments(tokens: string[]): string[][] {
	const segments: string[][] = [];
	let current: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]!;
		if (t === ";" || t === "\n" || t === "\r") {
			if (current.length > 0) segments.push(current);
			current = [];
		} else if (t === "&" && tokens[i + 1] === "&") {
			if (current.length > 0) segments.push(current);
			current = [];
			i++; // skip the second &
		} else {
			current.push(t);
		}
	}
	if (current.length > 0) segments.push(current);
	return segments.length > 0 ? segments : [tokens];
}

/**
 * Returns true when the command contains a shell operator that makes the
 * native minimizer return `MinimizerMode::None` for the entire command:
 * logical-or (`||`) or standalone background `&`. Safe chain operators —
 * `&&` and `;` — are NOT rejected because the native engine routes them
 * through `SegmentedChain`; pipes are handled per segment.
 */
function hasIneligibleShellOperatorFromTokens(tokens: string[]): boolean {
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i]!;
		if (t === "|" && tokens[i + 1] === "|") return true;
		if (t === "&") {
			if (tokens[i + 1] !== "&") return true; // standalone background &
			i++; // skip the paired & (&& is a safe chain operator)
		}
	}
	return false;
}

/**
 * Returns whether the native minimizer has a filter registered for the
 * `(program, subcommand)` pair.
 *
 * Mirrors `filters::supports(program, subcommand)` in
 * `crates/pi-shell/src/minimizer/filters/mod.rs`. `subcommand` is
 * `undefined` for commands with no subcommand token (Rust `None`); programs
 * whose `supports` requires a subcommand (e.g. `git`) return `false` here,
 * matching the native detector's decision not to capture them.
 */
export function hasBashMinimizerFilter(program: string, subcommand?: string): boolean {
	if (!program || program === "missed" || program === "compound") return false;
	return supportsProgram(program, subcommand);
}

// ---------------------------------------------------------------------------
// supports(program, subcommand) — port of filters/mod.rs::supports
// ---------------------------------------------------------------------------

const COMMON_CHAIN_UTILITIES: Record<string, true> = {
	echo: true,
	printf: true,
	head: true,
	tail: true,
	file: true,
	which: true,
	type: true,
	sed: true,
	awk: true,
	sleep: true,
	seq: true,
	cp: true,
	mv: true,
	rm: true,
	mkdir: true,
	rmdir: true,
	touch: true,
	basename: true,
	dirname: true,
	realpath: true,
	readlink: true,
	true: true,
	false: true,
	yes: true,
	tr: true,
	tee: true,
	sort: true,
	uniq: true,
	cut: true,
	paste: true,
	rev: true,
	split: true,
	comm: true,
	patch: true,
	xargs: true,
	unzip: true,
	zip: true,
	tar: true,
	gzip: true,
	gunzip: true,
	cd: true,
	pwd: true,
	export: true,
	env: true,
	test: true,
};

const GTEST_BINARY_RE = /(?:_test|_tests|-test|-tests)$/;

/** Mirrors `cpp::is_gtest_binary_name` in detect.rs filters. */
function isGtestBinaryName(program: string): boolean {
	if (program === "gtest" || program === "gtest-parallel") return true;
	if (GTEST_BINARY_RE.test(program)) return true;
	// `.test` extension (Rust: Path::new(program).extension() eq_ignore_ascii_case("test"))
	const dot = program.lastIndexOf(".");
	return dot > 0 && program.slice(dot + 1).toLowerCase() === "test";
}

const CONTAINER_SUBCOMMANDS = [
	"ps",
	"images",
	"logs",
	"compose",
	"build",
	"pull",
	"push",
	"get",
	"describe",
	"status",
	"list",
	"ls",
	"install",
	"upgrade",
	"template",
	"lint",
	"apply",
	"delete",
	"rollout",
	"scale",
	"create",
	"wait",
	"label",
	"annotate",
	"up",
	"down",
	"start",
	"stop",
	"restart",
	"rm",
];

/**
 * Mirrors `filters::supports(program, subcommand)` in
 * `crates/pi-shell/src/minimizer/filters/mod.rs`. The dispatch order and
 * per-program subcommand allowlists match the Rust source so that telemetry
 * eligibility agrees with the native minimizer's actual capture decision.
 */
function supportsProgram(program: string, subcommand?: string): boolean {
	switch (program) {
		case "git":
			return subIs(subcommand, [
				"status",
				"diff",
				"show",
				"log",
				"add",
				"commit",
				"push",
				"pull",
				"branch",
				"fetch",
				"stash",
				"worktree",
				"merge",
				"rebase",
				"checkout",
				"switch",
				"restore",
				"clean",
				"reset",
				"tag",
			]);
		case "gt":
			return subIs(subcommand, [
				"log",
				"submit",
				"sync",
				"restack",
				"create",
				"branch",
				"diff",
				"show",
				"add",
				"push",
				"pull",
				"fetch",
				"stash",
				"worktree",
			]);
		case "bun":
			return subIs(subcommand, [
				"install",
				"i",
				"add",
				"update",
				"up",
				"upgrade",
				"remove",
				"rm",
				"outdated",
				"pm",
				"audit",
				"run",
				"exec",
				"check",
				"test",
				"build",
				"tsc",
				"eslint",
				"biome",
				"next",
				"prettier",
				"prisma",
				"jest",
				"vitest",
				"playwright",
				"cmake",
				"ctest",
				"ninja",
				"gtest",
				"gtest-parallel",
			]);
		case "bunx":
			return subIs(subcommand, [
				"tsc",
				"eslint",
				"biome",
				"next",
				"prettier",
				"prisma",
				"jest",
				"vitest",
				"playwright",
				"cmake",
				"ctest",
				"ninja",
				"gtest",
				"gtest-parallel",
			]);
		case "cargo":
			return subIs(subcommand, [
				"build",
				"check",
				"test",
				"clippy",
				"nextest",
				"fmt",
				"doc",
				"bench",
				"run",
				"metadata",
				"tree",
				"update",
				"install",
				"publish",
			]);
		case "go":
			return subIs(subcommand, ["test", "build", "vet", "tool"]);
		case "golangci-lint":
			return subcommand === undefined || subcommand === "run";
		case "cmake":
		case "ctest":
		case "ninja":
		case "gtest":
		case "gtest-parallel":
			return true;
		case "dotnet":
			return subIs(subcommand, ["build", "test", "restore", "format"]);
		case "mvn":
		case "mvnw":
		case "gradle":
		case "gradlew":
			// jvm::supports claims every subcommand (phase decided inside filter)
			return true;
		case "ls":
		case "tree":
		case "find":
		case "grep":
		case "rg":
		case "wc":
		case "cat":
		case "read":
		case "stat":
		case "du":
		case "df":
		case "jq":
		case "json":
			return true;
		case "aws":
		case "curl":
		case "wget":
		case "psql":
			return true; // cloud::supports is program-only
		case "helm":
			return subIs(subcommand, ["repo", "search", "list", "history"]) || subIs(subcommand, CONTAINER_SUBCOMMANDS);
		case "docker":
		case "kubectl":
			return subIs(subcommand, CONTAINER_SUBCOMMANDS);
		case "gh":
			return subIs(subcommand, [
				"pr",
				"issue",
				"run",
				"workflow",
				"repo",
				"api",
				"search",
				"release",
				"codespace",
				"gist",
			]);
		case "glab":
			return subIs(subcommand, ["mr", "issue", "ci", "pipeline", "release"]);
		case "pytest":
		case "ruff":
		case "mypy":
			return true; // python::supports: program-only for these
		case "python":
		case "python3":
		case "py":
			return subIs(subcommand, ["pytest", "ruff", "mypy"]);
		case "rspec":
		case "rubocop":
			return true;
		case "rake":
		case "rails":
			return true;
		case "rustfmt":
			return true;
		case "xxd":
		case "strings":
		case "od":
			return true; // binary_tools::supports is program-only
		case "tsc":
		case "eslint":
		case "biome":
		case "shellcheck":
		case "markdownlint":
		case "hadolint":
		case "yamllint":
		case "oxlint":
		case "pyright":
		case "basedpyright": {
			// lint::supports(sub) || lint::supports_program(program, sub)
			const lintPrograms = [
				"ruff",
				"mypy",
				"rubocop",
				"pyright",
				"basedpyright",
				"tsc",
				"eslint",
				"biome",
				"oxlint",
				"shellcheck",
				"markdownlint",
				"hadolint",
				"yamllint",
			];
			if (lintPrograms.includes(program)) return true;
			return subcommand === undefined || ["check", "lint", "run", "format", "fmt", "typecheck"].includes(subcommand);
		}
		case "jest":
		case "vitest":
		case "playwright":
			return true;
		case "next":
		case "prettier":
		case "prisma":
			return true; // js_tools::supports: program in SUPPORTED_TOOLS
		case "npx":
			return true;
		case "pnpm":
			if (subcommand === "dlx" || subcommand === "nx") return true;
			return subIs(subcommand, PKG_SUBCOMMANDS);
		case "uv":
			if (subcommand === "run") return true;
			return subIs(subcommand, ["pytest", "ruff", "mypy", "-m"]) || subIs(subcommand, PKG_SUBCOMMANDS);
		case "composer":
			return subcommand === "require" || subIs(subcommand, PKG_SUBCOMMANDS);
		case "npm":
		case "pip":
		case "pip3":
		case "bundle":
		case "brew":
		case "poetry":
			return subIs(subcommand, PKG_SUBCOMMANDS);
		case "yarn":
			if (subcommand === "nx") return true;
			return subIs(subcommand, PKG_SUBCOMMANDS);
		case "env":
		case "log":
		case "deps":
		case "summary":
		case "err":
		case "test":
		case "diff":
		case "format":
		case "pipe":
		case "ps":
		case "ping":
		case "ping6":
		case "ssh":
		case "sops":
			return true; // system::supports is program-only
		// --- TOML-defined pipeline filters (crates/pi-shell/src/minimizer/defs/) ---
		// Programs with a TOML def that has no match_subcommand gate — all subcommands
		// are supported by the pipeline registry.
		case "yadm":
		case "make":
		case "ansible":
		case "ansible-playbook":
		case "ansible-galaxy":
		case "apt":
		case "apt-get":
		case "yum":
		case "dnf":
		case "apk":
		case "conda":
		case "fail2ban-client":
		case "gcc":
		case "g++":
		case "clang":
		case "clang++":
		case "gcloud":
		case "iptables":
		case "ip6tables":
		case "iptables-save":
		case "ip6tables-save":
		case "jira":
		case "jj":
		case "just":
		case "liquibase":
		case "mise":
		case "rtx":
		case "mix":
		case "nx":
		case "pre-commit":
		case "rsync":
		case "rustc":
		case "skopeo":
		case "spring-boot":
		case "task":
		case "trunk":
		case "turbo":
		case "ty":
		case "xcodebuild":
		case "systemctl":
		case "quarto":
			return true; // TOML defs with no match_subcommand gate
		// --- TOML defs with match_subcommand gates ---
		case "terraform":
		case "tofu":
			return subIs(subcommand, ["plan", "apply", "destroy", "init", "validate", "fmt"]);
		case "ollama":
			return subIs(subcommand, [
				"pull",
				"push",
				"list",
				"ls",
				"rm",
				"cp",
				"show",
				"create",
				"serve",
				"stop",
				"ps",
				"run",
			]);
		case "shopify":
			return subIs(subcommand, ["theme"]);
		case "swift":
			return subIs(subcommand, ["build", "test"]);
		case "pio":
		case "platformio":
			return subIs(subcommand, ["run"]);
		default:
			// cpp::is_gtest_binary_name guard (covers foo_test, foo-tests, foo.test, …)
			return isGtestBinaryName(program);
	}
}

const PKG_SUBCOMMANDS = [
	"install",
	"i",
	"ci",
	"add",
	"update",
	"up",
	"upgrade",
	"remove",
	"rm",
	"uninstall",
	"list",
	"ls",
	"tree",
	"pip",
	"outdated",
	"sync",
	"lock",
	"run",
	"exec",
	"audit",
	"check",
	"show",
	"info",
	"view",
	"fund",
	"explain",
	"test",
	"t",
	"start",
	"stop",
	"restart",
	"config",
	"cache",
	"prune",
	"dedupe",
	"publish",
	"pack",
	"link",
	"why",
	"export",
];

/** True when `subcommand` is defined and equals one of `allow` (case-sensitive, matching the lowercased subcommand the detector yields). */
function subIs(subcommand: string | undefined, allow: readonly string[]): boolean {
	return subcommand !== undefined && allow.includes(subcommand);
}

// ---------------------------------------------------------------------------
// detect_subcommand — port of detect.rs::detect_subcommand + first_non_global_arg
// ---------------------------------------------------------------------------

/**
 * Extract the subcommand token the native minimizer would dispatch on, given
 * the normalized `program` and the raw argument tokens after it. Returns
 * `undefined` (Rust `None`) when no subcommand is present.
 *
 * Mirrors `detect_subcommand` + `first_non_global_arg` in
 * `crates/pi-shell/src/minimizer/detect.rs`, including the per-program global
 * flag tables, so that `git -C repo status` resolves to `status` (not `-C`)
 * and `npx jest@latest` resolves to `jest`.
 */
function detectSubcommand(program: string, args: string[]): string | undefined {
	switch (program) {
		case "git":
		case "yadm":
			return firstNonGlobalArg(
				args,
				["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--html-path"],
				[
					"--bare",
					"--no-pager",
					"--paginate",
					"--no-optional-locks",
					"--literal-pathspecs",
					"--glob-pathspecs",
					"--noglob-pathspecs",
					"--icase-pathspecs",
					"--no-replace-objects",
				],
				[],
			);
		case "cargo":
			return firstNonGlobalArg(
				args,
				["-C", "--manifest-path", "--target-dir", "--config", "-Z", "--color", "--jobs", "-j"],
				["--locked", "--offline", "--frozen", "--workspace", "--all", "--verbose", "-v", "--quiet", "-q"],
				["+"],
			);
		case "docker":
			return firstNonGlobalArg(
				args,
				["--config", "--context", "-c", "--host", "-H", "--log-level", "--tlscacert", "--tlscert", "--tlskey"],
				["--debug", "-D", "--tls", "--tlsverify"],
				[],
			);
		case "gh":
			return firstNonGlobalArg(
				args,
				["--repo", "-R", "--hostname", "--jq", "--template"],
				["--paginate", "--slurp", "--verbose"],
				[],
			);
		case "glab":
			return firstNonGlobalArg(args, ["-R", "--repo", "-g", "--group"], [], []);
		case "gt":
			return firstNonGlobalArg(
				args,
				["--repo", "--cwd", "--config", "--debug-context"],
				["--no-interactive", "--interactive", "--version", "--help"],
				[],
			);
		case "npm":
			return firstNonGlobalArg(
				args,
				["--prefix", "-C", "--workspace", "-w", "--userconfig", "--cache", "--registry"],
				["--global", "-g", "--workspaces", "--include-workspace-root", "--offline", "--prefer-offline"],
				[],
			);
		case "npx": {
			const s = firstNonGlobalArg(
				args,
				[
					"--workspace",
					"-w",
					"--package",
					"-p",
					"--prefix",
					"--cache",
					"--registry",
					"--userconfig",
					"--call",
					"--shell",
					"--node-arg",
				],
				["--yes", "--no", "--no-install", "--quiet", "--silent", "--verbose"],
				[],
			);
			if (s === undefined) return undefined;
			// Strip npm version qualifier (jest@latest → jest, @scope/pkg@1.0 → @scope/pkg)
			const at = s.lastIndexOf("@");
			return at > 0 ? s.slice(0, at) : s;
		}
		case "pnpm":
			return firstNonGlobalArg(
				args,
				["--dir", "-C", "--filter", "-F", "--workspace", "--config", "--store-dir"],
				["--global", "-g", "--workspace-root", "-w", "--offline", "--recursive", "-r"],
				[],
			);
		case "yarn":
			return firstNonGlobalArg(
				args,
				["--cwd", "--cache-folder", "--global-folder", "--modules-folder", "--mutex"],
				["--offline", "--silent", "--verbose"],
				[],
			);
		case "bun":
			return firstNonGlobalArg(
				args,
				["--cwd", "-C", "--config", "--registry", "--cache-dir"],
				["--bun", "--silent", "--verbose", "--watch", "--hot", "--no-clear-screen"],
				[],
			);
		case "pip":
		case "pip3":
			return firstNonGlobalArg(
				args,
				["--python", "--cache-dir", "--proxy", "--timeout", "--trusted-host", "--cert", "--client-cert"],
				["--isolated", "--require-virtualenv", "--no-cache-dir", "--disable-pip-version-check"],
				[],
			);
		case "bundle":
			return firstNonGlobalArg(
				args,
				["--gemfile", "--path", "--jobs", "--retry"],
				["--verbose", "--quiet", "--no-color"],
				[],
			);
		case "uv":
		case "uvx":
			return firstNonGlobalArg(
				args,
				[
					"--directory",
					"-C",
					"--project",
					"-p",
					"--cache-dir",
					"--config-file",
					"--config-setting",
					"--python",
					"--python-preference",
					"--exclude-newer",
					"--color",
					"--allow-insecure-host",
					"--no-binary",
					"--only-binary",
				],
				[
					"--offline",
					"--no-cache",
					"--no-cache-dir",
					"--no-progress",
					"--native-tls",
					"--no-native-tls",
					"--quiet",
					"-q",
					"--verbose",
					"-v",
					"--upgrade",
					"--no-upgrade",
					"--require-hashes",
					"--verify-hashes",
					"--no-verify-hashes",
					"--no-build",
					"--reinstall",
				],
				[],
			);
		case "jest":
		case "vitest":
			return firstNonGlobalArg(args, [], [], []);
		default:
			for (const arg of args) {
				if (!arg.startsWith("-")) return arg.toLowerCase();
			}
			return undefined;
	}
}

/**
 * Find the first non-global argument, skipping value-taking flags (`-C dir`,
 * `--manifest-path path`), bare boolean flags, and `--`. Mirrors
 * `first_non_global_arg` + `option_consumes_value`/`option_has_inline_value`
 * in `crates/pi-shell/src/minimizer/detect.rs`.
 */
function firstNonGlobalArg(
	args: string[],
	flagsWithValues: readonly string[],
	flagOnly: readonly string[],
	barePrefixes: readonly string[],
): string | undefined {
	let index = 0;
	while (index < args.length) {
		const arg = args[index]!;
		if (arg === "--") return args[index + 1]?.toLowerCase();
		if (barePrefixes.some(p => arg.startsWith(p))) {
			index++;
			continue;
		}
		if (flagOnly.includes(arg)) {
			index++;
			continue;
		}
		if (optionConsumesValue(arg, flagsWithValues)) {
			index += optionHasInlineValue(arg, flagsWithValues) ? 1 : 2;
			continue;
		}
		if (arg.startsWith("-")) {
			index++;
			continue;
		}
		return arg.toLowerCase();
	}
	return undefined;
}

function optionConsumesValue(arg: string, flags: readonly string[]): boolean {
	return flags.some(flag => {
		if (arg === flag) return true;
		if (flag.startsWith("--")) return arg.startsWith(`${flag}=`);
		return arg.startsWith(flag) && arg.length > flag.length;
	});
}

function optionHasInlineValue(arg: string, flags: readonly string[]): boolean {
	return flags.some(flag => {
		if (flag.startsWith("--")) return arg.startsWith(`${flag}=`);
		return arg.startsWith(flag) && arg.length > flag.length;
	});
}
