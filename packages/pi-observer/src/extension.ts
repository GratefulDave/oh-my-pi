// ---------------------------------------------------------------------------
// pi-observer — real-time agent activity monitor extension.
// ---------------------------------------------------------------------------

import { ObserverDashboard } from "./dashboard";
import { type RenderOptions, renderJobResult, type ThemeLike, type ToolResult } from "./job-renderer";
import {
	onAgentStart,
	onIrcMessage,
	onSubagentLifecycle,
	onSubagentProgress,
	onSubagentTimeline,
	onTokensUsed,
	onToolExecutionEnd,
	onToolExecutionStart,
	onTurnEnd,
	onTurnStart,
	resetStats,
	type SubagentStatus,
	type SubagentTimelineEntry,
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
const TASK_SUBAGENT_EVENT_CHANNEL = "task:subagent:event";
const TASK_SUBAGENT_PROGRESS_CHANNEL = "task:subagent:progress";
const TASK_SUBAGENT_LIFECYCLE_CHANNEL = "task:subagent:lifecycle";
const IRC_MESSAGE_CHANNEL = "irc:message";

const fanInBuses = new WeakSet<object>();

type ProviderUsage = {
	input?: number;
	inputTokens?: number;
	output?: number;
	outputTokens?: number;
};

type AssistantMessageEndEvent = {
	message: {
		role?: string;
		model?: string;
		usage?: ProviderUsage;
	};
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
	id?: string;
	timestamp?: number;
	channel?: string;
	from?: string;
	to?: string;
	body?: string;
	kind?: "message" | "reply";
	delivered?: string[];
	failed?: string[];
};

type HostThemeColor =
	| "accent"
	| "border"
	| "borderAccent"
	| "success"
	| "error"
	| "warning"
	| "muted"
	| "dim"
	| "text"
	| "toolOutput";

type CustomTheme = {
	fg?: (color: HostThemeColor, text: string) => string;
	bold?: (text: string) => string;
};

type ExtensionCommandContext = {
	cwd: string;
	hasUI?: boolean;
	ui: {
		setEditorText(text: string): void;
		custom<T>(
			factory: (
				tui: { requestRender(): void; terminal?: { rows: number } },
				theme: CustomTheme,
				keybindings: unknown,
				done: (result: T) => void,
			) => unknown,
			options?: { overlay?: boolean },
		): Promise<T>;
	};
	model?: { id?: string };
};

type ExtensionAPI = {
	events: { on(channel: string, handler: (data: unknown) => void): unknown };
	setLabel(label: string): void;
	on(event: "message_end", handler: (event: AssistantMessageEndEvent, ctx: ExtensionCommandContext) => void): void;
	on(event: "tool_execution_start", handler: (event: { toolName: string; toolCallId: string }) => void): void;
	on(event: "tool_execution_end", handler: (event: { toolCallId: string }) => void): void;
	on(event: string, handler: (event: unknown, ctx: ExtensionCommandContext) => void): void;
	registerCommand(
		name: string,
		command: { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void },
	): void;
	registerToolRenderer?(
		toolName: string,
		renderer: {
			inline?: boolean;
			mergeCallAndResult?: boolean;
			renderResult?: (result: ToolResult, options: RenderOptions, theme: ThemeLike) => unknown;
		},
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
		id: payload.id,
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

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
	return value != null && typeof value === "object" ? (value as UnknownRecord) : undefined;
}

function compactPreview(value: unknown): string {
	if (typeof value === "string") return value;
	if (value == null) return "";
	try {
		const encoded = JSON.stringify(value);
		return typeof encoded === "string" ? encoded : String(value);
	} catch {
		return String(value);
	}
}

function messagePreview(message: unknown): string {
	const record = asRecord(message);
	if (!record) return compactPreview(message);
	const content = record.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts = content
			.map(item => {
				const block = asRecord(item);
				if (!block) return "";
				if (typeof block.text === "string") return block.text;
				if (typeof block.thinking === "string") return block.thinking;
				return typeof block.type === "string" ? `[${block.type}]` : "";
			})
			.filter(Boolean);
		if (parts.length > 0) return parts.join(" ");
	}
	if (typeof record.text === "string") return record.text;
	if (typeof record.errorMessage === "string") return record.errorMessage;
	return compactPreview(message);
}

function eventTimestamp(event: UnknownRecord): number {
	return typeof event.timestamp === "number" && Number.isFinite(event.timestamp) ? event.timestamp : Date.now();
}

function recordSubagentEvent(payload: unknown): void {
	const envelope = asRecord(payload);
	const id = envelope?.id;
	const event = asRecord(envelope?.event);
	if (typeof id !== "string" || !event || typeof event.type !== "string") return;
	const timestamp = eventTimestamp(event);
	let entry: SubagentTimelineEntry | undefined;
	switch (event.type) {
		case "message_end": {
			const message = asRecord(event.message);
			const role = typeof message?.role === "string" ? message.role : "message";
			entry = {
				timestamp,
				kind: role === "assistant" || role === "user" ? "chat" : role === "toolResult" ? "tool" : "status",
				title: role === "assistant" ? "Assistant" : role === "user" ? "User" : role,
				detail: messagePreview(event.message),
			};
			break;
		}
		case "tool_execution_start": {
			const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
			entry = {
				timestamp,
				kind: "tool",
				title: `Tool ${toolName}`,
				detail: compactPreview(event.toolArgs ?? event.args),
			};
			break;
		}
		case "tool_execution_end": {
			const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
			const result = asRecord(event.result);
			const isError = event.isError === true || result?.isError === true;
			const error =
				typeof event.error === "string"
					? event.error
					: typeof result?.error === "string"
						? result.error
						: isError
							? messagePreview(event.result) || "Tool failed"
							: undefined;
			entry = {
				timestamp,
				kind: error ? "outcome" : "tool",
				title: error ? `Tool ${toolName} error` : `Tool ${toolName} result`,
				detail: error ?? compactPreview(event.result),
			};
			break;
		}
		case "auto_retry_start":
			entry = {
				timestamp,
				kind: "retry",
				title: "Retry started",
				detail: `attempt ${compactPreview(event.attempt)}/${compactPreview(event.maxAttempts)} · ${compactPreview(event.delayMs)}ms`,
			};
			break;
		case "auto_retry_end":
			entry = {
				timestamp,
				kind: event.success === true ? "status" : "outcome",
				title: event.success === true ? "Retry recovered" : "Retry failed",
				detail:
					typeof event.finalError === "string" ? event.finalError : `attempt ${compactPreview(event.attempt)}`,
			};
			break;
		case "agent_start":
		case "turn_start":
			entry = { timestamp, kind: "status", title: event.type.replaceAll("_", " "), detail: "started" };
			break;
		case "turn_end":
			entry = { timestamp, kind: "status", title: "turn end", detail: "completed" };
			break;
		case "agent_end": {
			let outcome =
				typeof event.error === "string"
					? event.error
					: typeof event.abortReason === "string"
						? event.abortReason
						: "";
			if (!outcome && Array.isArray(event.messages)) {
				for (let index = event.messages.length - 1; index >= 0; index--) {
					const message = asRecord(event.messages[index]);
					if (message?.role !== "assistant") continue;
					outcome = messagePreview(message);
					if (outcome) break;
				}
			}
			entry = {
				timestamp,
				kind: "outcome",
				title: "Agent outcome",
				detail: outcome || "completed",
			};
			break;
		}
		default:
			break;
	}
	if (entry) onSubagentTimeline(id, entry);
}

function normalizeTheme(theme: CustomTheme): {
	fg(color: HostThemeColor, text: string): string;
	bold(text: string): string;
} {
	const rawFg = typeof theme.fg === "function" ? theme.fg.bind(theme) : undefined;
	const fg = (color: HostThemeColor, text: string): string => {
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
	return { fg, bold };
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function observer(pi: ExtensionAPI): void {
	pi.setLabel("Observer");

	// Hook into agent lifecycle events.
	pi.on("session_start", (_event, ctx) => {
		// Only the interactive parent owns the process-wide observer state.
		// Nested AgentSessions run headless and must never clear active telemetry.
		if (ctx?.hasUI === true) resetStats();
	});

	pi.on("agent_start", () => {
		onAgentStart();
	});

	pi.on("turn_start", () => {
		onTurnStart();
	});

	pi.on("turn_end", () => {
		onTurnEnd();
	});

	pi.on("tool_execution_start", event => {
		onToolExecutionStart(event.toolName, event.toolCallId);
	});

	pi.on("tool_execution_end", event => {
		onToolExecutionEnd(event.toolCallId);
	});

	// Fan in subagent activity from the parent session's shared EventBus.
	if (!fanInBuses.has(pi.events)) {
		fanInBuses.add(pi.events);
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
		});

		pi.events.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
			const payload = data as SubagentLifecyclePayload | undefined;
			if (!payload || typeof payload.id !== "string" || !isSubagentStatus(lifecycleToStatus(payload.status))) return;
			onSubagentLifecycle(payload.id, payload.agent ?? "subagent", lifecycleToStatus(payload.status), {
				index: payload.index,
				task: payload.task,
				description: payload.description,
			});
		});

		pi.events.on(TASK_SUBAGENT_EVENT_CHANNEL, data => {
			recordSubagentEvent(data);
		});

		pi.events.on(IRC_MESSAGE_CHANNEL, data => {
			recordIrcPayload(data as IrcMessagePayload | undefined);
		});
	}

	// Provider metadata events no longer include usage. The persisted assistant
	// message is the authoritative response payload in current OMP.
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		const usage = message.usage;
		if (!usage) return;
		const input = usage.input ?? usage.inputTokens ?? 0;
		const output = usage.output ?? usage.outputTokens ?? 0;
		if (input > 0 || output > 0) {
			onTokensUsed(message.model ?? ctx.model?.id ?? "unknown", input, output);
		}
	});

	pi.registerToolRenderer?.("job", {
		inline: true,
		mergeCallAndResult: true,
		renderResult: (result: ToolResult, options: RenderOptions, theme: ThemeLike) =>
			renderJobResult(result, options, theme),
	});

	// Register /observe slash command.
	pi.registerCommand("observe", {
		description: "Show real-time agent activity monitor",
		handler: async (_args, ctx) => {
			ctx.ui.setEditorText("");

			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					const dashboard = new ObserverDashboard(
						normalizeTheme(theme),
						() => tui.requestRender(),
						() => done(undefined),
					);
					return dashboard;
				},
				{ overlay: true },
			);
		},
	});
}
