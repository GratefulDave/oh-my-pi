import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { DelegateMonitorComponent } from "./monitor";
import { buildContextSummary, buildExternalOrchestrationReport, runExternalAgentsParallel } from "./runner";
import type {
	ExternalAgentBackend,
	ExternalAgentMode,
	ExternalAgentProvider,
	ExternalOrchestrationResult,
	ParsedDelegateArgs,
} from "./types";

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

export default function omnidelegate(pi: ExtensionAPI): void {
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
			const cwd = ctx.cwd;
			const requests = value.providers.map(provider => ({
				provider,
				backend: value.backend ?? (defaultBackend as ExternalAgentBackend),
				prompt: value.prompt,
				cwd,
				session: value.session,
				mode: value.mode ?? (defaultMode as ExternalAgentMode),
				timeoutMs: value.timeoutMs,
			}));

			// Types for tui/theme/keybindings are inferred from ExtensionUIContext.custom() signature.
			const result = await ctx.ui.custom<ExternalOrchestrationResult>(
				(tui, _theme, _keybindings, done) => {
					let report: ExternalOrchestrationResult | null = null;
					const monitor = new DelegateMonitorComponent(
						value.backend ?? "acpx",
						value.providers,
						() => tui.terminal.rows,
						() => tui.requestRender(),
						() => {
							if (report) done(report);
						},
					);

					void runExternalAgentsParallel(requests, (event, index, request) => {
						monitor.append(event, index, request);
					}).then(async results => {
						const fullReport = buildExternalOrchestrationReport(results, {
							backend: value.backend ?? "acpx",
							cwd,
							agentCount: value.providers.length,
						});
						const contextSummary = buildContextSummary(results);
						const successCount = results.filter(r => r.success).length;

						let artifactId: string | undefined;
						try {
							artifactId = await ctx.sessionManager.saveArtifact(fullReport, "external-orchestration");
						} catch {
							// best-effort
						}

						report = {
							backend: value.backend ?? "acpx",
							agents: value.providers,
							results,
							contextSummary,
							fullReport,
							successCount,
							artifactId,
						};
						monitor.complete(successCount, artifactId);
					});

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
}
