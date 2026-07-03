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
function detectProgramAndSubcommand(command: string): { program: string; subcommand: string | undefined } | null {
	const trimmed = command.trim();
	if (trimmed.length === 0) return null;
	// Tokenize first so quoted operators (e.g. `rg 'foo|bar'`) are not
	// misidentified as compound commands.
	const tokens = shellTokens(trimmed);
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
			// -a NAME, -c, -l take no separate operand besides -a's argument
			while (idx < tokens.length && tokens[idx]!.startsWith("-")) {
				const opt = tokens[idx]!;
				if (opt === "-a" && idx + 1 < tokens.length) idx++; // -a consumes next token
				idx++;
			}
		} else if (token === "time") {
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
 * Mirrors crates/pi-shell/src/minimizer/detect.rs fn skip_env_options.
 * The Rust implementation returns `None` for `-S`/`--split-string=S` because
 * env -S passes its argument to a sub-shell, which the minimizer does not
 * attempt to parse; we mirror that by returning `null`.
 */
function skipEnvOptionsAndAssignments(tokens: string[], start: number): number | null {
	let idx = start;
	while (idx < tokens.length) {
		const t = tokens[idx]!;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
			idx++;
		} else if (t === "--") {
			// bare `--` terminates env option parsing; next token is the program.
			idx++;
			break;
		} else if (t.startsWith("--")) {
			// Long options that take a following separate argument.
			// --split-string → native returns None (no identity); mirror that.
			if (/^--(split-string)(=.*)?$/.test(t)) return null;
			// Known passthrough long opts: --ignore-environment, --null, --debug do not take an arg.
			// --unset, --chdir consume the next token.
			// Unknown long opts: the Rust `skip_env_options` breaks on them (the unknown token
			// becomes the "program name", failing identity_has_filter). Mirror as null.
			const isKnown = /^--(ignore-environment|null|debug|unset|chdir)(=.*)?$/.test(t);
			if (!isKnown) return null;
			const longTakesArg = /^--(unset|chdir)$/.test(t);
			idx++;
			if (longTakesArg && idx < tokens.length) {
				idx++; // skip the option's argument
			}
		} else if (t === "-") {
			// bare `-` is -i / --ignore-environment (no argument); just advance.
			idx++;
		} else if (t.startsWith("-") && t.length >= 2 && !t.startsWith("--")) {
			// Short options (possibly clustered, e.g. -iS or -S'cmd')
			// Walk character by character through the option cluster.
			const optChars = t.slice(1); // chars after the leading '-'
			let clusterIdx = 0;
			let consumedRest = false;
			let foundS = false;
			while (clusterIdx < optChars.length) {
				const ch = optChars[clusterIdx]!;
				clusterIdx++;
				if (ch === "S") {
					// -S (split-string) → native returns None; mirror as null.
					foundS = true;
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
			if (foundS) return null;
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
 * A command is eligible only when:
 *  - the native minimizer would detect a program identity for it (not
 *    `env -S`, unknown sudo flag, `command -v`, …),
 *  - it is a single simple command — not piped, backgrounded, or compound
 *    (the native engine returns `MinimizerMode::None` for those), and
 *  - the `(program, subcommand)` pair has a registered filter
 *    (`filters::supports`), so commands like `git rev-parse` or `bun
 *    --version` — supported program, unsupported subcommand — are not
 *    recorded as false misses.
 *
 * The `only`/`except` check mirrors the native `is_program_enabled` exact-
 * lowercase membership test in
 * `crates/pi-shell/src/minimizer/config.rs`.
 */
export function isBashCommandMinimizerEligible(command: string, only: string[], except: string[]): boolean {
	const identity = detectProgramAndSubcommand(command);
	if (!identity) return false;
	// The native minimizer engine does not attempt piped, background, or
	// compound commands (MinimizerMode::None). shellTokens emits `|`, `&`,
	// and `;` as single-character operator tokens for these; fd-dup
	// redirects like `2>&1` and `&>file` are kept as word characters so they
	// do not trip this guard.
	if (shellTokens(command).some(t => t === "|" || t === "&" || t === ";")) return false;
	if (!supportsProgram(identity.program, identity.subcommand)) return false;
	if (only.length === 0 && except.length === 0) return true;
	const lower = identity.program.toLowerCase();
	if (only.length > 0 && !only.some(p => p.toLowerCase() === lower)) return false;
	if (except.length > 0 && except.some(p => p.toLowerCase() === lower)) return false;
	return true;
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

const GTEST_BINARY_RE = /(?:_test|_tests|-test|-tests)$/;

/** Mirrors `cpp::is_gtest_binary_name` in detect.rs filters. */
function isGtestBinaryName(program: string): boolean {
	if (program === "gtest" || program === "gtest-parallel") return true;
	if (GTEST_BINARY_RE.test(program)) return true;
	// `.test` extension (Rust: Path::new(program).extension() eq_ignore_ascii_case("test"))
	const dot = program.lastIndexOf(".");
	return dot > 0 && program.slice(dot + 1).toLowerCase() === "test";
}

/**
 * Mirrors `filters::supports(program, subcommand)` in
 * `crates/pi-shell/src/minimizer/filters/mod.rs`. The dispatch order and
 * per-program subcommand allowlists match the Rust source so that telemetry
 * eligibility agrees with the native minimizer's actual capture decision.
 */
function supportsProgram(program: string, subcommand?: string): boolean {
	switch (program) {
		case "git":
		case "yadm":
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
		case "docker":
		case "kubectl":
		case "helm":
			return subIs(subcommand, [
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
			]);
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
			return !(subcommand === "db:migrate" || subcommand === "db:rollback" || subcommand === "routes");
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
			return (
				subIs(subcommand, ["tsc", "eslint", "biome", "jest", "vitest", "playwright"]) ||
				subIs(subcommand, ["tsc", "eslint", "prisma", "prettier", "next"])
			);
		case "pnpm":
			if (subcommand === "dlx") return true;
			return subIs(subcommand, PKG_SUBCOMMANDS);
		case "uv":
			if (subcommand === "run") return true;
			return subIs(subcommand, ["pytest", "ruff", "mypy", "-m"]) || subIs(subcommand, PKG_SUBCOMMANDS);
		case "npm":
		case "yarn":
		case "pip":
		case "pip3":
		case "bundle":
		case "brew":
		case "composer":
		case "poetry":
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
		case "ssh":
		case "sops":
			return true; // system::supports is program-only
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
