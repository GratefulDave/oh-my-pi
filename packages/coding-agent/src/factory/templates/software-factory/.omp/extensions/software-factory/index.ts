import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import {
	buildFactoryMemoryCandidate,
	type FactoryConfig,
	type FactoryMemoryCandidate,
	type FactorySafetyRules,
	loadFactoryAgentPrompt,
	loadFactoryConfig,
	loadFactoryPrompt,
	loadFactorySafetyRules,
	loadFactorySettings,
	loadFactoryWorkflow,
} from "./config";
import { getFactoryDir } from "./paths";
import { evaluateSafetyEvent, validateRulePaths } from "./safety";
import {
	buildVerifierFollowUp,
	collectDiffSummary,
	type FactoryMessage,
	type FactoryTurnSnapshot,
	latestUserText,
	runFactoryVerifier,
	shouldRequestFollowUp,
} from "./verifier";
import { createWorkflowLaunch, validateWorkflowDefinition } from "./workflow";

interface FactoryRuntimeState {
	config?: FactoryConfig;
	rules?: FactorySafetyRules;
	currentTurn: FactoryTurnSnapshot;
	awaitingVerifierFollowUp: boolean;
}

const VERIFIER_CHILD_ENV = "FACTORY_VERIFIER_CHILD";

function emptySnapshot(ctx: ExtensionContext): FactoryTurnSnapshot {
	return {
		prompt: "",
		source: "unknown",
		trigger: "manual",
		loopCount: 0,
		sessionId: ctx.sessionManager.getSessionId(),
		sessionFile: ctx.sessionManager.getSessionFile(),
	};
}

function readSessionMessages(ctx: ExtensionContext): FactoryMessage[] {
	return ctx.sessionManager
		.getEntries()
		.flatMap(entry => (entry.type === "message" ? [entry.message as FactoryMessage] : []));
}

async function loadState(state: FactoryRuntimeState, ctx: ExtensionContext): Promise<void> {
	state.config = await loadFactoryConfig(ctx.cwd);
	state.rules = state.config ? await loadFactorySafetyRules(ctx.cwd, state.config) : undefined;
	state.currentTurn.sessionId = ctx.sessionManager.getSessionId();
	state.currentTurn.sessionFile = ctx.sessionManager.getSessionFile();
}

function factoryStatusSummary(state: FactoryRuntimeState, cwd: string): string {
	if (!state.config) return `Factory scaffold not configured in ${getFactoryDir(cwd)}`;
	const warnings = state.rules ? validateRulePaths(cwd, state.rules) : [];
	return [
		`Factory preset: ${state.config.template.preset}`,
		`Template version: ${state.config.template.version}`,
		`Verifier: ${state.config.verifier.enabled ? state.config.verifier.trigger : "disabled"}`,
		`Safety: ${state.config.safety.enabled ? `${state.rules?.rules.length ?? 0} rules` : "disabled"}`,
		`Workflow default: ${state.config.workflow.default} (${state.config.workflow.enabled ? "enabled" : "disabled"})`,
		`Warnings: ${warnings.length}`,
	].join("\n");
}

async function maybeStoreMemoryCandidate(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	candidate: FactoryMemoryCandidate,
): Promise<string> {
	pi.appendEntry("factory-memory-candidate", candidate);
	if (candidate.backend !== "icm") {
		return `Stored repo-local factory memory candidate (${candidate.kind}); active backend: ${candidate.backend}.`;
	}
	const keywords = candidate.keywords.length > 0 ? candidate.keywords.join(",") : `kind:${candidate.kind}`;
	const summary = `${candidate.summary}${candidate.verification ? ` | verification: ${candidate.verification}` : ""}`;
	const result = await pi.exec("icm-store-project", ["--keywords", keywords, summary], {
		cwd: ctx.cwd,
		timeout: 15_000,
	});
	if (result.code === 0) {
		return `Stored factory lesson in ICM and session cache.`;
	}
	pi.logger.warn("factory remember fallback", { stderr: result.stderr, stdout: result.stdout });
	return `Saved factory memory candidate locally; ICM store command unavailable or failed.`;
}

export default function softwareFactoryExtension(pi: ExtensionAPI) {
	const state: FactoryRuntimeState = {
		currentTurn: {
			prompt: "",
			source: "unknown",
			trigger: "manual",
			loopCount: 0,
			sessionId: "",
			sessionFile: undefined,
		},
		awaitingVerifierFollowUp: false,
	};

	pi.registerCommand("factory", {
		description: "Show software-factory status for current repo",
		handler: async (_args, ctx) => {
			await loadState(state, ctx);
			ctx.ui.notify(factoryStatusSummary(state, ctx.cwd));
		},
	});

	pi.registerCommand("verify", {
		description: "Run project-scoped factory verifier once",
		handler: async (_args, ctx) => {
			await loadState(state, ctx);
			if (!state.config) {
				ctx.ui.notify("Factory verifier unavailable: missing .omp/factory/factory.json");
				return;
			}
			const messages = readSessionMessages(ctx);
			const systemPrompt = await loadFactoryAgentPrompt(ctx.cwd, state.config.verifier.systemPrompt);
			const promptTemplate = await loadFactoryPrompt(ctx.cwd, state.config.verifier.prompt);
			if (!systemPrompt || !promptTemplate) {
				ctx.ui.notify("Factory verifier unavailable: missing agent prompt or verify-on-stop prompt.");
				return;
			}
			const diffSummary = await collectDiffSummary((command, args, options) => pi.exec(command, args, options), ctx.cwd);
			const report = await runFactoryVerifier({
				cwd: ctx.cwd,
				config: state.config,
				snapshot: {
					...state.currentTurn,
					prompt: state.currentTurn.prompt || latestUserText(messages, "Manual factory verification"),
					trigger: "manual",
					sessionId: ctx.sessionManager.getSessionId(),
					sessionFile: ctx.sessionManager.getSessionFile(),
				},
				messages,
				diffSummary,
				systemPrompt,
				promptTemplate,
				exec: (command, args, options) => pi.exec(command, args, options),
			});
			ctx.ui.notify([`Verifier status: ${report.status}`, `Confidence: ${report.confidence}`, ...report.gaps].join("\n"));
		},
	});

	pi.registerCommand("factory-workflow", {
		description: "Queue configured workflow guidance for current repo",
		handler: async (args, ctx) => {
			await loadState(state, ctx);
			if (!state.config) {
				ctx.ui.notify("Factory workflow unavailable: missing .omp/factory/factory.json");
				return;
			}
			const workflowName = args.trim() || state.config.workflow.default;
			const workflow = await loadFactoryWorkflow(ctx.cwd, workflowName);
			if (!workflow) {
				ctx.ui.notify(`Factory workflow missing: ${workflowName}`);
				return;
			}
			const errors = validateWorkflowDefinition(workflow);
			if (errors.length > 0) {
				ctx.ui.notify(`Workflow invalid:\n${errors.join("\n")}`);
				return;
			}
			const messages = readSessionMessages(ctx);
			const original = latestUserText(messages, state.currentTurn.prompt || "Start factory workflow");
			const launch = createWorkflowLaunch(workflow, original);
			pi.sendUserMessage(launch.message, { deliverAs: "followUp" });
			ctx.ui.notify(`Queued workflow ${workflow.name}`);
		},
	});

	const { z } = pi.zod;
	pi.registerTool({
		name: "factory_remember",
		label: "Factory Remember",
		description: "Capture durable repo-scoped lessons for later retention without polluting transient context.",
		parameters: z.object({
			kind: z.enum(["error", "decision", "workflow", "preference", "gap"]),
			summary: z.string().min(8).describe("Durable repo-scoped lesson"),
			verification: z.string().optional().describe("How this lesson was verified"),
			keywords: z.array(z.string()).optional().describe("Short search keywords"),
		}),
		async execute(_toolCallId, params, _onUpdate, ctx, _signal) {
			const settings = await loadFactorySettings(ctx.cwd);
			const candidate = buildFactoryMemoryCandidate({
				kind: params.kind,
				summary: params.summary,
				verification: params.verification,
				keywords: params.keywords,
				backend: settings.memoryBackend,
			});
			const text = await maybeStoreMemoryCandidate(pi, ctx, candidate);
			return {
				content: [{ type: "text", text }],
				details: { candidate },
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await loadState(state, ctx);
		state.currentTurn = emptySnapshot(ctx);
	});

	pi.on("input", async event => {
		const loopCount = state.awaitingVerifierFollowUp ? state.currentTurn.loopCount + 1 : 0;
		state.awaitingVerifierFollowUp = false;
		state.currentTurn = {
			...state.currentTurn,
			prompt: event.text,
			source: event.source,
			trigger: "agent_end",
			loopCount,
		};
	});

	pi.on("before_agent_start", async (event, ctx) => {
		await loadState(state, ctx);
		if (!state.config?.metaPrompt.enabled) return;
		const metaPrompt = await loadFactoryPrompt(ctx.cwd, state.config.metaPrompt.prompt);
		if (!metaPrompt) return;
		return {
			systemPrompt: [...event.systemPrompt, metaPrompt],
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		await loadState(state, ctx);
		if (!state.config?.safety.enabled) return;
		const decision = evaluateSafetyEvent(event, ctx.cwd, state.rules);
		if (decision.action === "allow") return;
		if (decision.action === "advise") {
			pi.sendMessage({
				customType: "factory-safety-warning",
				content: decision.message ?? "Factory safety warning",
				display: true,
			});
			return;
		}
		if (decision.action === "ask") {
			if (!ctx.hasUI) {
				return {
					block: true,
					reason: `${decision.message ?? "Factory safety requires confirmation"} (non-interactive mode cannot confirm)`,
				};
			}
			const approved = await ctx.ui.confirm("Factory safety confirmation", decision.message ?? "Proceed?");
			if (approved) return;
			return {
				block: true,
				reason: `${decision.message ?? "Factory safety blocked this call"} (user denied confirmation)`,
			};
		}
		return {
			block: true,
			reason: decision.message ?? "Factory safety blocked this call",
		};
	});

	pi.on("agent_end", async (event, ctx) => {
		if (process.env[VERIFIER_CHILD_ENV] === "1") return;
		await loadState(state, ctx);
		if (!state.config?.verifier.enabled || state.config.verifier.trigger !== "agent_end") return;
		const systemPrompt = await loadFactoryAgentPrompt(ctx.cwd, state.config.verifier.systemPrompt);
		const promptTemplate = await loadFactoryPrompt(ctx.cwd, state.config.verifier.prompt);
		if (!systemPrompt || !promptTemplate) return;
		const diffSummary = await collectDiffSummary((command, args, options) => pi.exec(command, args, options), ctx.cwd);
		const report = await runFactoryVerifier({
			cwd: ctx.cwd,
			config: state.config,
			snapshot: {
				...state.currentTurn,
				sessionId: ctx.sessionManager.getSessionId(),
				sessionFile: ctx.sessionManager.getSessionFile(),
				trigger: "agent_end",
			},
			messages: event.messages as FactoryMessage[],
			diffSummary,
			systemPrompt,
			promptTemplate,
			exec: (command, args, options) => pi.exec(command, args, options),
		});
		pi.appendEntry("factory-verifier-report", report);
		if (!shouldRequestFollowUp(report, state.currentTurn.loopCount, state.config.verifier.maxLoops)) {
			return;
		}
		state.awaitingVerifierFollowUp = true;
		pi.sendUserMessage(buildVerifierFollowUp(report), { deliverAs: "followUp" });
	});
