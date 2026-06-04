// ---------------------------------------------------------------------------
// pi-observer — real-time agent activity monitor extension.
// ---------------------------------------------------------------------------

import { ObserverDashboard } from "./dashboard";
import {
	onAgentStart,
	onSubagentLifecycle,
	onSubagentProgress,
	onTokensUsed,
	onToolExecutionEnd,
	onToolExecutionStart,
	onTurnEnd,
	onTurnStart,
	resetStats,
	type SubagentStatus,
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

type SubagentProgressPayload = {
	id: string;
	agent?: string;
	status: string;
	progress: {
		id?: string;
		agent?: string;
		status: SubagentStatus;
		tokens?: number;
		toolCount?: number;
		cost?: number;
	};
};

type SubagentLifecyclePayload = {
	id: string;
	agent?: string;
	status: "started" | SubagentStatus;
};

type ExtensionCommandContext = {
	cwd: string;
	ui: {
		setEditorText(text: string): void;
		custom<T>(
			factory: (
				tui: { requestRender(): void; terminal?: { rows: number } },
				theme: { fg(color: string, text: string): string; bold(text: string): string; dim(text: string): string },
				keybindings: unknown,
				done: (result: T) => void,
			) => unknown,
			options?: { overlay?: boolean },
		): Promise<T>;
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

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function observer(pi: ExtensionAPI): void {
	pi.setLabel("Observer");

	// Hook into agent lifecycle events.
	pi.on("session_start", () => {
		resetStats();
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
	// Subagents emit aggregated progress (cumulative tokens/toolCount/cost) here
	// because their own session events do not reach this extension instance.
	pi.events.on(TASK_SUBAGENT_PROGRESS_CHANNEL, data => {
		const payload = data as SubagentProgressPayload | undefined;
		const progress = payload?.progress;
		if (!progress || typeof progress.id !== "string") return;
		onSubagentProgress({
			id: progress.id,
			agent: progress.agent ?? payload?.agent ?? "subagent",
			status: progress.status,
			tokens: progress.tokens ?? 0,
			toolCount: progress.toolCount ?? 0,
			cost: progress.cost ?? 0,
		});
	});

	pi.events.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
		const payload = data as SubagentLifecyclePayload | undefined;
		if (!payload || typeof payload.id !== "string") return;
		onSubagentLifecycle(payload.id, payload.agent ?? "subagent", lifecycleToStatus(payload.status));
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
		handler: async (_args, ctx) => {
			ctx.ui.setEditorText("");

			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => {
					const dashboard = new ObserverDashboard(
						{ fg: theme.fg.bind(theme), bold: theme.bold.bind(theme), dim: theme.dim.bind(theme) },
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
