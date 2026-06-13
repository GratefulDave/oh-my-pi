import { DelegateMonitorComponent } from "./monitor";
import { buildContextSummary, buildExternalOrchestrationReport, runExternalAgentsParallel } from "./runner";
import type {
	ExternalAgentBackend,
	ExternalAgentMode,
	ExternalAgentProvider,
	ExternalAgentRequest,
	ExternalAgentResult,
	ExternalOrchestrationResult,
	ParsedDelegateArgs,
} from "./types";

interface DelegateTui {
	terminal: { rows: number };
	requestRender(): void;
}

interface DelegateUi {
	setEditorText(value: string): void;
	setStatus(id: string, value: string): void;
	notify(message: string, level: "info" | "warning" | "error"): void;
	custom<T>(
		factory: (tui: DelegateTui, theme: unknown, keybindings: unknown, done: (value: T) => void) => unknown,
		options: { overlay: boolean },
	): Promise<T>;
}

interface DelegateCommandContext {
	cwd: string;
	ui: DelegateUi;
	sessionManager: {
		saveArtifact(content: string, label: string): Promise<string>;
	};
}

interface DelegateExtensionApi {
	setLabel(value: string): void;
	registerFlag(name: string, options: { type: "string"; default: string }): void;
	getFlag?(name: string): unknown;
	registerCommand(
		name: string,
		command: {
			description: string;
			handler(args: string, ctx: DelegateCommandContext): Promise<void>;
		},
	): void;
}

function isExternalAgentBackend(value: string): value is ExternalAgentBackend {
	return value === "acpx" || value === "tmux" || value === "cmux";
}

function isExternalAgentProvider(value: string): value is ExternalAgentProvider {
	return value === "claude" || value === "codex" || value === "gemini";
}

function isExternalAgentMode(value: string): value is ExternalAgentMode {
	return value === "exec" || value === "prompt";
}

function parseExternalProviders(value: string): ExternalAgentProvider[] | undefined {
	const parts = value
		.split(",")
		.map(s => s.trim())
		.filter(Boolean);
	if (parts.length === 0) return undefined;
	const providers: ExternalAgentProvider[] = [];
	for (const p of parts) {
		if (isExternalAgentProvider(p)) {
			providers.push(p);
		}
	}
	return providers.length > 0 ? providers : undefined;
}

function parsePositiveInteger(value: string): number | undefined {
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

const USAGE = [
	"Usage: /delegate [--agents <providers>] [--backend <acpx|tmux|cmux>] [--mode <exec|prompt>] [--session <name>] [--timeout <ms>] <prompt>",
	"",
	"Examples:",
	'  /delegate --agents gemini "what is 2+2"',
	'  /delegate --agents claude,gemini "compare Rust vs Zig"',
	'  /delegate --backend tmux --mode prompt "explain monads"',
].join("\n");

type ParseResult = { value: ParsedDelegateArgs } | { error: string };
interface DelegateReportRecord {
	id: number;
	createdAtMs: number;
	backend: ExternalAgentBackend;
	mode: ExternalAgentMode;
	cwd: string;
	promptHash: string;
	promptPreview: string;
	agents: ExternalAgentProvider[];
	successCount: number;
	artifactId?: string;
	contextSummary: string;
	fullReport: string;
	reusedCount: number;
}
const cachedResults = new Map<string, ExternalAgentResult>();
const reportIndex: DelegateReportRecord[] = [];
let nextReportId = 1;

function hashPrompt(prompt: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < prompt.length; i++) {
		hash ^= prompt.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

function buildResultCacheKey(request: ExternalAgentRequest): string {
	return [request.provider, request.backend, request.mode ?? "exec", request.cwd, hashPrompt(request.prompt)].join(
		"\u001f",
	);
}

function cloneCachedResult(result: ExternalAgentResult): ExternalAgentResult {
	return {
		...result,
		events: [...result.events, { type: "status", message: "reused exact same-session delegate result" }],
		reusedFromCache: true,
		durationMs: 0,
	};
}

function promptPreview(prompt: string): string {
	const compact = prompt.replace(/\s+/g, " ").trim();
	return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
}

function formatReportList(): string {
	if (reportIndex.length === 0) return "No delegate results in this session.";
	const lines = ["# Delegate results", ""];
	for (const record of reportIndex) {
		const date = new Date(record.createdAtMs).toISOString();
		const artifact = record.artifactId ? ` artifact=${record.artifactId}` : "";
		const reused = record.reusedCount > 0 ? ` reused=${record.reusedCount}` : "";
		lines.push(
			`${record.id}. ${date} ${record.successCount}/${record.agents.length} ${record.backend}/${record.mode} ${record.agents.join(",")} prompt=${record.promptHash}${artifact}${reused}`,
			`   ${record.promptPreview}`,
		);
	}
	return lines.join("\n");
}

function findReportRecord(selector: string): DelegateReportRecord | undefined {
	const trimmed = selector.trim();
	if (!trimmed) return reportIndex.at(-1);
	const id = Number.parseInt(trimmed, 10);
	if (Number.isFinite(id)) return reportIndex.find(record => record.id === id);
	return reportIndex.find(record => record.artifactId === trimmed || record.promptHash === trimmed);
}

function formatReportRecord(record: DelegateReportRecord): string {
	const lines = [
		`# Delegate result ${record.id}`,
		`- Created: ${new Date(record.createdAtMs).toISOString()}`,
		`- Backend: ${record.backend}`,
		`- Mode: ${record.mode}`,
		`- CWD: ${record.cwd}`,
		`- Agents: ${record.agents.join(", ")}`,
		`- Prompt hash: ${record.promptHash}`,
		`- Reused exact same-session results: ${record.reusedCount}`,
	];
	if (record.artifactId) lines.push(`- Artifact: ${record.artifactId}`);
	lines.push("", record.fullReport);
	return lines.join("\n");
}

function parseDelegateResultsArgs(
	args: string,
): { action: "list" | "show" | "clear"; selector?: string } | { error: string } {
	const trimmed = args.trim();
	if (!trimmed || trimmed === "list") return { action: "list" };
	if (trimmed === "clear") return { action: "clear" };
	if (trimmed === "show") return { action: "show" };
	if (trimmed.startsWith("show ")) return { action: "show", selector: trimmed.slice(5) };
	return { error: "Usage: /delegate-results list|show [id|artifactId|promptHash]|clear" };
}

function parseDelegateArgs(args: string): ParseResult {
	const trimmed = args.trim();
	if (!trimmed) return { error: USAGE };

	const tokens: string[] = [];
	let i = 0;
	while (i < trimmed.length) {
		if (trimmed[i] === " " || trimmed[i] === "\t") {
			i++;
			continue;
		}
		if (trimmed[i] === '"' || trimmed[i] === "'") {
			const quote = trimmed[i];
			i++;
			let token = "";
			while (i < trimmed.length && trimmed[i] !== quote) {
				if (trimmed[i] === "\\" && i + 1 < trimmed.length) i++;
				token += trimmed[i];
				i++;
			}
			if (i < trimmed.length) i++;
			tokens.push(token);
		} else {
			let token = "";
			while (i < trimmed.length && trimmed[i] !== " " && trimmed[i] !== "\t") {
				token += trimmed[i];
				i++;
			}
			tokens.push(token);
		}
	}

	let agents: ExternalAgentProvider[] | undefined;
	let backend: ExternalAgentBackend | undefined;
	let mode: ExternalAgentMode | undefined;
	let session: string | undefined;
	let timeoutMs: number | undefined;
	const promptParts: string[] = [];

	for (let j = 0; j < tokens.length; j++) {
		const tok = tokens[j];
		if (tok === "--agents" && j + 1 < tokens.length) {
			agents = parseExternalProviders(tokens[++j]);
		} else if (tok === "--backend" && j + 1 < tokens.length) {
			const v = tokens[++j];
			if (!isExternalAgentBackend(v)) return { error: `Invalid backend: ${v}. Use acpx, tmux, or cmux.` };
			backend = v;
		} else if (tok === "--mode" && j + 1 < tokens.length) {
			const v = tokens[++j];
			if (!isExternalAgentMode(v)) return { error: `Invalid mode: ${v}. Use exec or prompt.` };
			mode = v;
		} else if (tok === "--session" && j + 1 < tokens.length) {
			session = tokens[++j];
		} else if (tok === "--timeout" && j + 1 < tokens.length) {
			const v = parsePositiveInteger(tokens[++j]);
			if (v === undefined) return { error: `Invalid timeout: ${tokens[j]}` };
			timeoutMs = v;
		} else {
			promptParts.push(tok);
		}
	}

	const prompt = promptParts.join(" ");
	if (!prompt) return { error: `Missing prompt. ${USAGE}` };

	const resolvedProviders = agents ?? ["gemini"];
	return {
		value: {
			providers: resolvedProviders,
			prompt,
			backend: backend ?? "acpx",
			mode: mode ?? "exec",
			session,
			timeoutMs,
		},
	};
}

export default function omnidelegate(pi: DelegateExtensionApi): void {
	pi.setLabel("OmniDelegate");

	pi.registerFlag("delegate-default-backend", {
		type: "string",
		default: "acpx",
	});

	pi.registerFlag("delegate-default-agents", {
		type: "string",
		default: "gemini,claude",
	});

	pi.registerFlag("delegate-default-mode", {
		type: "string",
		default: "exec",
	});

	pi.registerCommand("delegate", {
		description: "Spawn external AI agents (Claude/Codex/Gemini) for parallel investigation",
		handler: async (args, ctx) => {
			const parsed = parseDelegateArgs(args);
			if ("error" in parsed) {
				ctx.ui.setStatus("omnidelegate", parsed.error);
				ctx.ui.setEditorText("");
				return;
			}

			const { value } = parsed;

			const defaultBackend = (pi.getFlag?.("delegate-default-backend") as string) ?? "acpx";
			const defaultMode = (pi.getFlag?.("delegate-default-mode") as string) ?? "exec";
			const backend = value.backend ?? (defaultBackend as ExternalAgentBackend);
			const mode = value.mode ?? (defaultMode as ExternalAgentMode);
			const cwd = ctx.cwd;
			const requests: ExternalAgentRequest[] = value.providers.map(provider => ({
				provider,
				backend,
				prompt: value.prompt,
				cwd,
				session: value.session,
				mode,
				timeoutMs: value.timeoutMs,
			}));
			const cacheKeys = requests.map(buildResultCacheKey);

			// Types for tui/theme/keybindings are inferred from ExtensionUIContext.custom() signature.
			const result = await ctx.ui.custom<ExternalOrchestrationResult>(
				(tui, _theme, _keybindings, done) => {
					let report: ExternalOrchestrationResult | null = null;
					const monitor = new DelegateMonitorComponent(
						backend,
						value.providers,
						() => tui.terminal.rows,
						() => tui.requestRender(),
						() => {
							if (report) done(report);
						},
					);

					const results: ExternalAgentResult[] = new Array(requests.length);
					const missingRequests: ExternalAgentRequest[] = [];
					const missingIndexes: number[] = [];
					for (let index = 0; index < requests.length; index++) {
						const request = requests[index];
						const cached = cachedResults.get(cacheKeys[index]);
						if (cached) {
							const reused = cloneCachedResult(cached);
							results[index] = reused;
							monitor.append({ type: "status", message: "reused exact same-session result" }, index, request);
						} else {
							missingRequests.push(request);
							missingIndexes.push(index);
						}
					}

					const finish = async (): Promise<void> => {
						const fullReport = buildExternalOrchestrationReport(results, {
							backend,
							cwd,
							agentCount: value.providers.length,
						});
						const contextSummary = buildContextSummary(results);
						const successCount = results.filter(r => r.success).length;
						const reusedCount = results.filter(r => r.reusedFromCache).length;

						let artifactId: string | undefined;
						try {
							artifactId = await ctx.sessionManager.saveArtifact(fullReport, "external-orchestration");
						} catch {
							// best-effort
						}

						report = {
							backend,
							agents: value.providers,
							results,
							contextSummary,
							fullReport,
							successCount,
							artifactId,
						};
						reportIndex.push({
							id: nextReportId++,
							createdAtMs: Date.now(),
							backend,
							mode,
							cwd,
							promptHash: hashPrompt(value.prompt),
							promptPreview: promptPreview(value.prompt),
							agents: value.providers,
							successCount,
							artifactId,
							contextSummary,
							fullReport,
							reusedCount,
						});
						monitor.complete(successCount, artifactId, reusedCount);
					};

					if (missingRequests.length === 0) {
						void finish();
					} else {
						void runExternalAgentsParallel(missingRequests, (event, index, request) => {
							monitor.append(event, missingIndexes[index], request);
						}).then(async freshResults => {
							for (let i = 0; i < freshResults.length; i++) {
								const originalIndex = missingIndexes[i];
								const fresh = freshResults[i];
								results[originalIndex] = fresh;
								cachedResults.set(cacheKeys[originalIndex], fresh);
							}
							await finish();
						});
					}

					return monitor;
				},
				{ overlay: true },
			);

			ctx.ui.notify(
				`External orchestration completed: ${result.successCount}/${result.agents.length} succeeded.\n\n${result.contextSummary}`,
				"info",
			);
			ctx.ui.setStatus("omnidelegate", `Done: ${result.successCount}/${result.agents.length} succeeded.`);
			ctx.ui.setEditorText("");
		},
	});

	pi.registerCommand("delegate-results", {
		description: "List, show, or clear same-session delegate reports",
		handler: async (args, ctx) => {
			const parsed = parseDelegateResultsArgs(args);
			if ("error" in parsed) {
				ctx.ui.setStatus("omnidelegate", parsed.error);
				ctx.ui.setEditorText("");
				return;
			}

			if (parsed.action === "clear") {
				const clearedReports = reportIndex.length;
				const clearedResults = cachedResults.size;
				reportIndex.length = 0;
				cachedResults.clear();
				ctx.ui.setEditorText("");
				ctx.ui.setStatus(
					"omnidelegate",
					`Cleared ${clearedReports} delegate report(s) and ${clearedResults} cached result(s).`,
				);
				return;
			}

			if (parsed.action === "list") {
				ctx.ui.setEditorText(formatReportList());
				ctx.ui.setStatus("omnidelegate", `${reportIndex.length} delegate result(s) in this session.`);
				return;
			}

			const record = findReportRecord(parsed.selector ?? "");
			if (!record) {
				ctx.ui.setStatus("omnidelegate", "Delegate result not found.");
				ctx.ui.setEditorText("");
				return;
			}

			ctx.ui.setEditorText(formatReportRecord(record));
			ctx.ui.setStatus("omnidelegate", `Showing delegate result ${record.id}.`);
		},
	});
}
