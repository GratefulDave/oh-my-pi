// ---------------------------------------------------------------------------
// pi-observer — real-time agent activity monitor extension.
// ---------------------------------------------------------------------------

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DEFAULT_REFRESH_INTERVAL_MS, ObserverDashboard } from "./dashboard";
import { renderLiveObserverWidgetLines } from "./live-widget";
import { type RenderTheme } from "./renderer";
import {
	defaultExportPath,
	getStats,
	onAgentStart,
	onIrcMessage,
	onSubagentLifecycle,
	onSubagentProgress,
	onTokensUsed,
	onToolExecutionEnd,
	onToolExecutionStart,
	onTurnEnd,
	onTurnStart,
	resetStats,
	type SubagentStatus,
	snapshotStats,
	statsSnapshotToCsv,
	statsSnapshotToJson,
} from "./stats-collector";

// ---------------------------------------------------------------------------
// Subagent fan-in EventBus channels.
//
// Source of truth: packages/coding-agent/src/task/types.ts
//   TASK_SUBAGENT_PROGRESS_CHANNEL  = "task:subagent:progress"
//   TASK_SUBAGENT_LIFECYCLE_CHANNEL = "task:subagent:lifecycle"
//
// Subagents run in a *separate* AgentSession (createAgentSession) with their own
// EventBus, so their tool/token/turn events never reach this extension's per-session
// pi.on(...) handlers. The task executor re-emits aggregated subagent progress on the
// PARENT session's shared EventBus (pi.events) via these channels. We subscribe here
// to roll subagent activity into the observer dashboard. Channel names are inlined to
// keep this bundle free of a runtime value dependency on the host package.
// ---------------------------------------------------------------------------

const TASK_SUBAGENT_PROGRESS_CHANNEL = "task:subagent:progress";
const TASK_SUBAGENT_LIFECYCLE_CHANNEL = "task:subagent:lifecycle";
const IRC_MESSAGE_CHANNEL = "irc:message";

type ProviderUsage = {
	input?: number;
	inputTokens?: number;
	output?: number;
	outputTokens?: number;
};

type ProviderResponseEvent = {
	model?: string;
	usage?: ProviderUsage;
	metadata?: { usage?: ProviderUsage; model?: string };
	response?: { model?: string; usage?: ProviderUsage };
};

type SubagentRetryState = {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorMessage: string;
	startedAtMs: number;
};

type SubagentRetryFailure = {
	attempt: number;
	errorMessage: string;
};
type SubagentRecentTool = {
	tool: string;
	args: string;
	endMs: number;
};

type SubagentProgressSnapshot = {
	id?: string;
	agent?: string;
	status: SubagentStatus;
	tokens?: number;
	toolCount?: number;
	cost?: number;
	requests?: number;
	index?: number;
	task?: string;
	assignment?: string;
	description?: string;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartMs?: number;
	lastIntent?: string;
	recentOutput?: string[];
	durationMs?: number;
	contextTokens?: number;
	contextWindow?: number;
	resolvedModel?: string;
	retryState?: SubagentRetryState;
	retryFailure?: SubagentRetryFailure;
	error?: string;
	abortReason?: string;
	agentSource?: string;
	sessionFile?: string;
	recentTools?: SubagentRecentTool[];
	extractedToolData?: Record<string, unknown[]>;
	inflightTaskDetails?: unknown;
};

type SubagentProgressPayload = {
	id: string;
	index?: number;
	agent?: string;
	task?: string;
	assignment?: string;
	description?: string;
	status: string;
	progress: SubagentProgressSnapshot;
};

type SubagentLifecyclePayload = {
	id: string;
	agent?: string;
	description?: string;
	task?: string;
	index?: number;
	status: "started" | SubagentStatus;
};

type IrcMessagePayload = {
	timestamp?: number;
	channel?: string;
	from?: string;
	to?: string;
	body?: string;
	kind?: "message" | "reply";
	delivered?: string[];
	failed?: string[];
};

type IrcCustomMessage = {
	customType?: string;
	timestamp?: number;
	details?: {
		from?: string;
		to?: string;
		message?: string;
		reply?: string;
		body?: string;
		kind?: "message" | "reply";
	};
};

type IrcSessionEvent = {
	message?: IrcCustomMessage;
};

type CustomTheme = {
	fg?: (color: string, text: string) => string;
	bold?: (text: string) => string;
	dim?: (text: string) => string;
};

type ExtensionCommandContext = {
	hasUI?: boolean;
	cwd: string;
	ui: {
		setEditorText(text: string): void;
		setWidget?(key: string, content: string[] | undefined, options?: { placement?: "subagentHud" }): void;
		custom<T>(
			factory: (
				tui: { requestRender(): void; terminal?: { rows: number } },
				theme: CustomTheme,
				keybindings: unknown,
				done: (result: T) => void,
			) => unknown,
			options?: { overlay?: boolean },
		): Promise<T>;
		notify?(message: string, level?: "info" | "warning" | "error"): void;
	};
	getModel?: () => { id?: string } | undefined;
};

type ExtensionAPI = {
	events: { on(channel: string, handler: (data: unknown) => void): unknown };
	setLabel(label: string): void;
	on(
		event: "after_provider_response",
		handler: (event: ProviderResponseEvent, ctx: ExtensionCommandContext) => void,
	): void;
	on(event: "tool_execution_start", handler: (event: { toolName: string; toolCallId: string }) => void): void;
	on(event: "tool_execution_end", handler: (event: { toolCallId: string }) => void): void;
	on(event: string, handler: (event: unknown, ctx: ExtensionCommandContext) => void): void;
	registerCommand(
		name: string,
		command: { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void },
	): void;
};

/** Map a lifecycle status string onto the observer's SubagentStatus union. */
function lifecycleToStatus(status: SubagentLifecyclePayload["status"]): SubagentStatus {
	return status === "started" ? "running" : status;
}

function isSubagentStatus(status: unknown): status is SubagentStatus {
	return (
		status === "pending" ||
		status === "running" ||
		status === "completed" ||
		status === "failed" ||
		status === "aborted"
	);
}

function recordIrcPayload(payload: IrcMessagePayload | undefined): void {
	if (!payload || typeof payload.body !== "string") return;
	onIrcMessage({
		timestamp: typeof payload.timestamp === "number" ? payload.timestamp : Date.now(),
		channel: payload.channel ?? payload.to ?? "irc",
		from: payload.from ?? "unknown",
		to: payload.to ?? payload.channel ?? "irc",
		body: payload.body,
		kind: payload.kind ?? "message",
		delivered: payload.delivered ?? [],
		failed: payload.failed ?? [],
	});
}

function recordIrcSessionEvent(event: unknown): void {
	const message = (event as IrcSessionEvent | undefined)?.message;
	const details = message?.details;
	if (!details) return;
	if (message?.customType === "irc:incoming") {
		recordIrcPayload({ timestamp: message.timestamp, from: details.from, to: "@Main", body: details.message });
	} else if (message?.customType === "irc:autoreply") {
		recordIrcPayload({
			timestamp: message.timestamp,
			from: "Main",
			to: details.to,
			body: details.reply,
			kind: "reply",
		});
	} else if (message?.customType === "irc:relay") {
		recordIrcPayload({
			timestamp: message.timestamp,
			channel: details.to,
			from: details.from,
			to: details.to,
			body: details.body,
			kind: details.kind,
		});
	}
}

function normalizeTheme(theme: CustomTheme): {
	fg(color: string, text: string): string;
	bold(text: string): string;
	dim(text: string): string;
} {
	const rawFg = typeof theme.fg === "function" ? theme.fg.bind(theme) : undefined;
	const fg = (color: string, text: string): string => {
		if (!rawFg) return text;
		try {
			return rawFg(color, text);
		} catch {
			return text;
		}
	};
	const rawBold = typeof theme.bold === "function" ? theme.bold.bind(theme) : undefined;
	const bold = (text: string): string => {
		if (!rawBold) return text;
		try {
			return rawBold(text);
		} catch {
			return text;
		}
	};
	const rawDim = typeof theme.dim === "function" ? theme.dim.bind(theme) : undefined;
	const dim = (text: string): string => {
		if (!rawDim) return fg("dim", text);
		try {
			return rawDim(text);
		} catch {
			return fg("dim", text);
		}
	};
	return { fg, bold, dim };
}

function parseExportArgs(args: string): { format: "json" | "csv"; outputPath: string | undefined } | undefined {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const format = parts[0];
	if (format !== "json" && format !== "csv") return undefined;
	return { format, outputPath: parts[1] };
}

function parseObserveArgs(args: string): { refreshIntervalMs: number } {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const refreshIndex = parts.findIndex(part => part === "--refresh-ms" || part === "--refresh-interval-ms");
	if (refreshIndex === -1) return { refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS };
	const raw = parts[refreshIndex + 1];
	const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
	return {
		refreshIntervalMs: Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REFRESH_INTERVAL_MS,
	};
}
function resolveExportPath(cwd: string, outputPath: string | undefined, format: "json" | "csv"): string {
	const target = outputPath ?? defaultExportPath(format);
	return path.isAbsolute(target) ? target : path.join(cwd, target);
}

async function writeExportFile(targetPath: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(targetPath), { recursive: true });
	await Bun.write(targetPath, content);
}

async function exportStats(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const parsed = parseExportArgs(args);
	if (!parsed) {
		ctx.ui.notify?.("Usage: /observe-export json|csv [path]", "warning");
		ctx.ui.setEditorText("");
		return;
	}
	const snapshot = snapshotStats();
	const content = parsed.format === "json" ? statsSnapshotToJson(snapshot) : statsSnapshotToCsv(snapshot);
	const targetPath = resolveExportPath(ctx.cwd, parsed.outputPath, parsed.format);
	await writeExportFile(targetPath, content);
	ctx.ui.notify?.(`Observer stats exported to ${targetPath}`, "info");
	ctx.ui.setEditorText("");
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function observer(pi: ExtensionAPI): void {
	pi.setLabel("Observer");

	// Hook into agent lifecycle events.
	const widgetKey = "observer-live";
	let widgetContext: ExtensionCommandContext | undefined;
	let cachedTheme: RenderTheme | undefined;
	const refreshLiveWidget = (ctx?: ExtensionCommandContext) => {
		if (ctx) widgetContext = ctx;
		if (!widgetContext?.hasUI || !widgetContext.ui.setWidget) return;

		const lines = renderLiveObserverWidgetLines(Date.now(), cachedTheme);
		if (!lines || lines.length === 0) {
			// Only clear the widget when no agents have ever been tracked.
			// If agents exist but rendering produced nothing, keep the last frame
			// rather than flashing to empty during a transient gap.
			if (getStats().subagents.size === 0 && getStats().ircMessages.length === 0) {
				widgetContext.ui.setWidget(widgetKey, undefined);
			}
			return;
		}

		widgetContext.ui.setWidget(widgetKey, lines, { placement: "subagentHud" });
	};

	// Hook into agent lifecycle events.
	// session_start fires for every subagent spawn as well as the parent session.
	// Only use it to capture the UI context (widgetContext). Never resetStats() here
	// because child session_start events would wipe all in-flight subagent data.
	pi.on("session_start", (_event, ctx) => {
		// Only capture the UI context for future refreshes.
		// Do NOT call refreshLiveWidget() — session_start fires for every subagent
		// spawn before lifecycle data arrives, which would clear the widget.
		if (ctx) widgetContext = ctx;
	});

	pi.on("agent_start", () => {
		onAgentStart();
	});

	pi.on("turn_start", (_event, ctx) => {
		onTurnStart();
		refreshLiveWidget(ctx);
	});

	pi.on("turn_end", (_event, ctx) => {
		onTurnEnd();
		refreshLiveWidget(ctx);
	});

	pi.on("tool_execution_start", event => {
		onToolExecutionStart(event.toolName, event.toolCallId);
	});

	pi.on("tool_execution_end", event => {
		onToolExecutionEnd(event.toolCallId);
	});

	// Fan in subagent activity from the parent session's shared EventBus.
	// Subagents emit aggregated progress (cumulative tokens/toolCount/cost) here
	// because their own session events do not reach this extension instance.
	pi.events.on(TASK_SUBAGENT_PROGRESS_CHANNEL, data => {
		const payload = data as SubagentProgressPayload | undefined;
		const progress = payload?.progress;
		if (!progress || typeof progress.id !== "string" || !isSubagentStatus(progress.status)) return;
		onSubagentProgress({
			id: progress.id,
			agent: progress.agent ?? payload?.agent ?? "subagent",
			status: progress.status,
			tokens: progress.tokens ?? 0,
			toolCount: progress.toolCount ?? 0,
			cost: progress.cost ?? 0,
			index: progress.index ?? payload.index,
			task: progress.task ?? payload.task,
			assignment: progress.assignment ?? payload.assignment,
			description: progress.description ?? payload.description,
			currentTool: progress.currentTool,
			currentToolArgs: progress.currentToolArgs,
			currentToolStartMs: progress.currentToolStartMs,
			lastIntent: progress.lastIntent,
			recentOutput: progress.recentOutput,
			durationMs: progress.durationMs,
			requests: progress.requests,
			contextTokens: progress.contextTokens,
			contextWindow: progress.contextWindow,
			resolvedModel: progress.resolvedModel,
			retryState: progress.retryState,
			retryFailure: progress.retryFailure,
			failureReason: progress.error ?? progress.abortReason,
			agentSource: progress.agentSource,
			sessionFile: progress.sessionFile,
			recentTools: progress.recentTools,
			extractedToolData: progress.extractedToolData,
			inflightTaskDetails: progress.inflightTaskDetails,
		});
		refreshLiveWidget();
	});

	pi.events.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
		const payload = data as SubagentLifecyclePayload | undefined;
		if (!payload || typeof payload.id !== "string" || !isSubagentStatus(lifecycleToStatus(payload.status))) return;
		onSubagentLifecycle(payload.id, payload.agent ?? "subagent", lifecycleToStatus(payload.status), {
			index: payload.index,
			task: payload.task,
			description: payload.description,
		});
		refreshLiveWidget();
	});

	pi.events.on(IRC_MESSAGE_CHANNEL, data => {
		recordIrcPayload(data as IrcMessagePayload | undefined);
		refreshLiveWidget();
	});

	pi.on("irc_message", event => {
		recordIrcSessionEvent(event);
		refreshLiveWidget();
	});

	// Track token usage from provider responses.
	pi.on("after_provider_response", (event, ctx) => {
		const usage = event.response?.usage ?? event.usage ?? event.metadata?.usage;
		if (usage) {
			const modelId =
				event.response?.model ?? event.model ?? event.metadata?.model ?? ctx.getModel?.()?.id ?? "unknown";
			const input = usage.input ?? usage.inputTokens ?? 0;
			const output = usage.output ?? usage.outputTokens ?? 0;
			if (input > 0 || output > 0) {
				onTokensUsed(modelId, input, output);
			}
		}
	});


	// Register /observe slash command.
	pi.registerCommand("observe", {
		description: "Show real-time agent activity monitor",
		handler: async (args, ctx) => {
			const { refreshIntervalMs } = parseObserveArgs(args);
			ctx.ui.setEditorText("");

			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					cachedTheme = normalizeTheme(theme);
					const dashboard = new ObserverDashboard(
						cachedTheme,
						() => tui.requestRender(),
						() => done(undefined),
						{ refreshIntervalMs },
					);
					return dashboard;
				},
				{ overlay: true },
			);
		},
	});

	pi.registerCommand("observe-export", {
		description: "Export accumulated observer stats as json or csv",
		handler: exportStats,
	});
}
