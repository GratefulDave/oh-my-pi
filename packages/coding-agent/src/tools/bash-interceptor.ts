/**
 * Bash intent interceptor - redirects common shell patterns to proper tools.
 *
 * When an LLM calls bash with patterns like `grep`, `cat`, `find`, etc.,
 * this interceptor provides helpful error messages directing them to use
 * the specialized tools instead.
 */
import { type BashInterceptorRule, DEFAULT_BASH_INTERCEPTOR_RULES } from "../config/settings-schema";

export interface InterceptionResult {
	/** If true, the bash command should be blocked */
	block: boolean;
	/** Error message to return instead of executing */
	message?: string;
	/** Suggested tool to use instead */
	suggestedTool?: string;
}

const SHELL_WORD_SEPARATOR = /\s/;

function maskQuotedShellText(command: string): string {
	let masked = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (const char of command) {
		if (escaped) {
			masked += quote ? " " : char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			masked += quote ? " " : char;
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) {
				quote = undefined;
				masked += char;
			} else {
				masked += " ";
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			masked += char;
			continue;
		}
		masked += char;
	}
	return masked;
}

function shellCommandSegments(command: string): string[][] {
	const segments: string[][] = [];
	let currentSegment: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	const pushCurrent = () => {
		if (current) {
			currentSegment.push(current);
			current = "";
		}
	};
	const pushSegment = () => {
		pushCurrent();
		if (currentSegment.length > 0) {
			segments.push(currentSegment);
			currentSegment = [];
		}
	};
	for (const char of command) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else {
				current += char;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (SHELL_WORD_SEPARATOR.test(char)) {
			pushCurrent();
			continue;
		}
		if (char === ";" || char === "|" || char === "&") {
			pushSegment();
			continue;
		}
		current += char;
	}
	pushSegment();
	return segments;
}

export function checkBunBuildStdoutPreflight(command: string): InterceptionResult {
	for (const tokens of shellCommandSegments(command)) {
		if (tokens[0] !== "bun" || tokens[1] !== "build") {
			continue;
		}
		const args = tokens.slice(2);
		if (args.some(arg => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-v")) {
			continue;
		}
		if (
			args.some(
				arg =>
					arg === "--outfile" || arg.startsWith("--outfile=") || arg === "--outdir" || arg.startsWith("--outdir="),
			)
		) {
			continue;
		}
		return {
			block: true,
			message:
				"`bun build` writes bundled output to stdout unless `--outfile` or `--outdir` is supplied; provide one or use a package build script that writes files.",
		};
	}
	return { block: false };
}

/**
 * Compile bash interceptor rules into regexes, skipping invalid patterns.
 */
function compileRules(rules: BashInterceptorRule[]): Array<{ rule: BashInterceptorRule; regex: RegExp }> {
	const compiled: Array<{ rule: BashInterceptorRule; regex: RegExp }> = [];
	for (const rule of rules) {
		const flags = rule.flags ?? "";
		try {
			compiled.push({ rule, regex: new RegExp(rule.pattern, flags) });
		} catch {
			// Skip invalid regex patterns
		}
	}
	return compiled;
}

/**
 * Check if a bash command should be intercepted.
 *
 * @param command The bash command to check
 * @param availableTools Set of tool names that are available
 * @returns InterceptionResult indicating if the command should be blocked
 */
export function checkBashInterception(
	command: string,
	availableTools: string[],
	rules: BashInterceptorRule[] = DEFAULT_BASH_INTERCEPTOR_RULES,
): InterceptionResult {
	// Normalize command for pattern matching and mask quoted text so shell
	// separators inside strings do not look like executable command starts.
	const normalizedCommand = maskQuotedShellText(command.trim());
	const compiled = compileRules(rules);

	for (const { rule, regex } of compiled) {
		// Only block if the suggested tool is actually available
		if (!availableTools.includes(rule.tool)) {
			continue;
		}

		if (regex.test(normalizedCommand)) {
			return {
				block: true,
				message: `Blocked: ${rule.message}\n\nOriginal command: ${command}`,
				suggestedTool: rule.tool,
			};
		}
	}

	return { block: false };
}
