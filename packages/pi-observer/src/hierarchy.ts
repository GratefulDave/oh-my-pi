import { getOrderedSubagents } from "./renderer";
import {
	formatCount,
	formatDuration,
	type IrcMessageActivity,
	type ObserverStats,
	type SubagentActivity,
	type SubagentStatus,
	type SubagentTimelineEntry,
} from "./stats-collector";

export type ObserverNodeKind =
	| "phase"
	| "group"
	| "agent"
	| "task"
	| "activity"
	| "prompt"
	| "outcome"
	| "intercom"
	| "metrics";

export interface ObserverNodeMetrics {
	count?: number;
	activeCount?: number;
	tokens?: number;
	toolCount?: number;
	cost?: number;
	durationMs?: number;
}

interface ObserverTotals {
	count: number;
	activeCount: number;
	tokens: number;
	toolCount: number;
	cost: number;
}

export interface ObserverNode {
	id: string;
	kind: ObserverNodeKind;
	label: string;
	status?: SubagentStatus | "active" | "idle";
	summary: string;
	metrics?: ObserverNodeMetrics;
	children: ObserverNode[];
	agentId?: string;
	taskIndex?: number;
	messageIndex?: number;
	detail?: string[];
}

export interface ObserverHierarchy {
	rootNodes: ObserverNode[];
	nodeById: Map<string, ObserverNode>;
	getChildren(parentId: string | undefined): ObserverNode[];
	getNode(id: string | undefined): ObserverNode | undefined;
	getBreadcrumb(path: readonly string[]): ObserverNode[];
}

interface TaskToolDetailsLike {
	results?: unknown[];
	progress?: unknown[];
	totalDurationMs?: number;
	async?: { state?: string; jobId?: string; type?: string };
}

interface NestedProgressLike {
	id?: string;
	agent?: string;
	status?: SubagentStatus;
	task?: string;
	description?: string;
	assignment?: string;
	currentTool?: string;
	currentToolArgs?: string;
	recentOutput?: string[];
	toolCount?: number;
	tokens?: number;
	cost?: number;
	durationMs?: number;
}

interface RecentToolLike {
	tool: string;
	args: string;
	endMs: number;
}

const ROOT_PHASE_ID = "phase:active-session";

export function buildObserverHierarchy(stats: ObserverStats, now: number): ObserverHierarchy {
	const nodeById = new Map<string, ObserverNode>();
	const agents = getOrderedSubagents(stats);
	const totals = calculateTotals(agents);
	const completed = agents.filter(agent => agent.status === "completed").length;
	const failed = agents.filter(agent => agent.status === "failed" || agent.status === "aborted").length;
	// Top-level structure is Agents-rooted: each agent owns its own Tasks and
	// Activity sub-tree (see buildAgentNode), so the drill-down reads
	//   Agents → <agent> → Tasks → <task> → Activity …
	// Flat top-level "Tasks"/"Activity" groups would duplicate that nested data
	// as a second, de-contextualized copy, so they are intentionally omitted.
	// Intercom and Metrics remain as session-wide utility groups.
	const phaseChildren = [
		buildAgentsGroup(agents, stats.ircMessages, now),
		buildIntercomGroup(stats.ircMessages),
		buildMetricsGroup(stats),
	];
	const rootNodes: ObserverNode[] = [
		{
			id: ROOT_PHASE_ID,
			kind: "phase",
			label: "Session observability",
			status: totals.activeCount > 0 ? "active" : "idle",
			summary: `${completed}/${agents.length} agents · ${formatDuration(Math.max(0, now - stats.sessionStartTime))}`,
			metrics: { ...totals },
			children: phaseChildren,
			detail: [
				"Session observability",
				`${agents.length} agents · ${totals.activeCount} active · ${failed} failed`,
				`${formatCount(totals.tokens)} tokens · ${totals.toolCount} tools · $${totals.cost.toFixed(4)}`,
				"",
				"Child groups",
				...phaseChildren.map(child => `  ${child.label} · ${child.summary}`),
			],
		},
	];
	for (const node of rootNodes) indexNode(node, nodeById);
	return {
		rootNodes,
		nodeById,
		getChildren(parentId: string | undefined): ObserverNode[] {
			if (!parentId) return rootNodes;
			return nodeById.get(parentId)?.children ?? [];
		},
		getNode(id: string | undefined): ObserverNode | undefined {
			return id ? nodeById.get(id) : undefined;
		},
		getBreadcrumb(path: readonly string[]): ObserverNode[] {
			return path.map(id => nodeById.get(id)).filter((node): node is ObserverNode => node != null);
		},
	};
}

export function statusGlyph(status: ObserverNode["status"]): string {
	switch (status) {
		case "completed":
			return "✓";
		case "failed":
			return "✗";
		case "aborted":
			return "■";
		case "running":
			return "◌";
		case "pending":
			return "●";
		case "active":
			return "●";
		case "idle":
			return "○";
		default:
			return "•";
	}
}

function indexNode(node: ObserverNode, nodeById: Map<string, ObserverNode>): void {
	nodeById.set(node.id, node);
	for (const child of node.children) indexNode(child, nodeById);
}

function buildAgentsGroup(
	agents: readonly SubagentActivity[],
	messages: readonly IrcMessageActivity[],
	now: number,
): ObserverNode {
	const children = agents.map(agent => buildAgentNode(agent, messages, now));
	const active = agents.filter(agent => agent.status === "running" || agent.status === "pending").length;
	return {
		id: "group:agents",
		kind: "group",
		label: "Agents",
		status: active > 0 ? "active" : "idle",
		summary: `${agents.length} agents · ${active} active`,
		metrics: { count: agents.length, activeCount: active },
		children,
		detail: ["Agents", `${agents.length} observed · ${active} active`, "Enter opens the selected agent list."],
	};
}

function buildIntercomGroup(messages: readonly IrcMessageActivity[]): ObserverNode {
	const children = messages.slice(-20).map((message, index) => ({
		id: `intercom:${message.timestamp}:${index}`,
		kind: "intercom" as const,
		label: `${message.from} → ${message.to}`,
		status: "idle" as const,
		summary: message.body,
		children: [],
		messageIndex: index,
		detail: ["Intercom", ircLine(message)],
	}));
	return {
		id: "group:intercom",
		kind: "group",
		label: "Intercom",
		status: children.length > 0 ? "active" : "idle",
		summary: `${messages.length} messages`,
		metrics: { count: messages.length },
		children,
		detail: ["Intercom", `${messages.length} observed messages.`],
	};
}

function buildMetricsGroup(stats: ObserverStats): ObserverNode {
	const totals = calculateTotals([...stats.subagents.values()]);
	const children: ObserverNode[] = [
		metricNode("metrics:tokens", "Tokens", `${formatCount(totals.tokens)} subagent tokens`),
		metricNode("metrics:tools", "Tools", `${totals.toolCount} subagent tool calls`),
		metricNode("metrics:cost", "Cost", `$${totals.cost.toFixed(4)} subagent cost`),
		metricNode("metrics:turns", "Turns", `${stats.turns.length}${stats.currentTurn ? " + current" : ""} turns`),
	];
	return {
		id: "group:metrics",
		kind: "group",
		label: "Metrics",
		status: "idle",
		summary: `${formatCount(totals.tokens)} tok · ${totals.toolCount} tools`,
		metrics: { ...totals },
		children,
		detail: [
			"Metrics",
			`${formatCount(totals.tokens)} subagent tokens`,
			`${totals.toolCount} tools · $${totals.cost.toFixed(4)}`,
			`${stats.activeToolCalls.size} active parent tools`,
		],
	};
}

function calculateTotals(agents: readonly SubagentActivity[]): ObserverTotals {
	let tokens = 0;
	let toolCount = 0;
	let cost = 0;
	let activeCount = 0;
	for (const agent of agents) {
		tokens += agent.tokens;
		toolCount += agent.toolCount;
		cost += agent.cost;
		if (agent.status === "running" || agent.status === "pending") activeCount++;
	}
	return { count: agents.length, activeCount, tokens, toolCount, cost };
}
function metricNode(id: string, label: string, summary: string): ObserverNode {
	return { id, kind: "metrics", label, status: "idle", summary, children: [], detail: [label, summary] };
}

function buildAgentNode(agent: SubagentActivity, messages: readonly IrcMessageActivity[], now: number): ObserverNode {
	const children = [
		buildPromptNode(agent),
		buildAgentTasksGroup(agent),
		buildAgentActivityNode(agent),
		buildOutcomeNode(agent),
		buildAgentIntercomNode(agent, messages),
	].filter((node): node is ObserverNode => node != null);
	const model = agent.resolvedModel ?? agent.agent;
	const timeline = agent.timeline ?? [];
	return {
		id: `agent:${agent.id}`,
		kind: "agent",
		label: agentLabel(agent),
		status: agent.status,
		summary: `${timeline.length > 0 ? `${timeline.at(-1)?.detail ?? ""} · ` : ""}${model} · ${formatCount(agent.tokens)} tok · ${agent.toolCount} tools`,
		metrics: {
			tokens: agent.tokens,
			toolCount: agent.toolCount,
			cost: agent.cost,
			durationMs: agentDuration(agent, now),
		},
		children,
		agentId: agent.id,
		detail: [
			`${statusGlyph(agent.status)} ${statusLabel(agent.status)} · ${model}`,
			`${formatCount(agent.tokens)} tokens · ${agent.toolCount} tools · ${formatDuration(agentDuration(agent, now))}`,
			`Cost $${agent.cost.toFixed(4)}`,
			"",
			"Prompt",
			`  ${firstPromptLine(agent)}`,
			"",
			"Current activity",
			...latestActivity(agent)
				.slice(-3)
				.map(line => `  ${line}`),
			"",
			"Timeline",
			...timeline.map(timelineLine),
			...(timeline.length === 0 ? ["  No activity recorded yet."] : []),
		],
	};
}

function buildPromptNode(agent: SubagentActivity): ObserverNode {
	const prompt = agent.assignment ?? agent.task ?? agent.description ?? "No prompt recorded";
	return {
		id: `agent:${agent.id}:prompt`,
		kind: "prompt",
		label: "Prompt",
		status: agent.status,
		summary: firstPromptLine(agent) || "No prompt recorded",
		children: [],
		agentId: agent.id,
		detail: ["Prompt", ...splitDetail(prompt)],
	};
}

function buildAgentTasksGroup(agent: SubagentActivity): ObserverNode {
	const children = buildAgentTaskNodes(agent, `agent:${agent.id}:tasks`);
	return {
		id: `agent:${agent.id}:tasks`,
		kind: "group",
		label: "Tasks",
		status: children.some(child => child.status === "running") ? "active" : agent.status,
		summary: `${children.length} task/tool nodes`,
		metrics: { count: children.length },
		children,
		agentId: agent.id,
		detail: ["Tasks", `${children.length} task/tool nodes for ${agentLabel(agent)}.`],
	};
}

function buildAgentTaskNodes(agent: SubagentActivity, prefix: string): ObserverNode[] {
	const nodes: ObserverNode[] = [];
	const snapshots = collectNestedTaskSnapshots(agent);
	for (let index = 0; index < snapshots.length; index++) {
		const snapshot = snapshots[index]!;
		nodes.push(...taskSnapshotNodes(snapshot, `${prefix}:nested:${index}`, agent.id, index));
	}
	if (agent.currentTool) {
		nodes.push({
			id: `${prefix}:current-tool`,
			kind: "task",
			label: agent.currentTool,
			status: "running",
			summary: agent.currentToolArgs ?? agent.lastIntent ?? "running",
			children: [],
			agentId: agent.id,
			detail: ["Current tool", agent.currentTool, agent.currentToolArgs ?? agent.lastIntent ?? "running"],
		});
	}
	for (let index = 0; index < (agent.recentTools ?? []).length; index++) {
		const tool = agent.recentTools![index]!;
		nodes.push(toolNode(tool, `${prefix}:recent-tool:${index}`, agent.id));
	}
	if (nodes.length === 0) {
		nodes.push({
			id: `${prefix}:assignment`,
			kind: "task",
			label: agentLabel(agent),
			status: agent.status,
			summary: firstPromptLine(agent) || statusLabel(agent.status),
			children: [],
			agentId: agent.id,
			detail: ["Task", agent.assignment ?? agent.task ?? agent.description ?? statusLabel(agent.status)],
		});
	}
	return nodes;
}

function buildAgentActivityNode(agent: SubagentActivity): ObserverNode {
	const activity = latestActivity(agent);
	return {
		id: `agent:${agent.id}:activity`,
		kind: "activity",
		label: "Activity",
		status: agent.status,
		summary: activity[0] ?? "thinking…",
		children: [],
		agentId: agent.id,
		detail: ["Activity", ...activity.map(line => `  ${line}`)],
	};
}

function buildOutcomeNode(agent: SubagentActivity): ObserverNode {
	const outcome =
		agent.failureReason ?? agent.retryFailure?.errorMessage ?? agent.recentOutput.at(-1) ?? statusLabel(agent.status);
	return {
		id: `agent:${agent.id}:outcome`,
		kind: "outcome",
		label: "Outcome",
		status: agent.status,
		summary: outcome,
		children: [],
		agentId: agent.id,
		detail: ["Outcome", ...splitDetail(outcome)],
	};
}

function buildAgentIntercomNode(
	agent: SubagentActivity,
	messages: readonly IrcMessageActivity[],
): ObserverNode | undefined {
	const relevant = findIrc(agent, messages).slice(-5);
	if (relevant.length === 0) return undefined;
	return {
		id: `agent:${agent.id}:intercom`,
		kind: "intercom",
		label: "Intercom",
		status: "active",
		summary: `${relevant.length} messages`,
		children: relevant.map((message, index) => ({
			id: `agent:${agent.id}:intercom:${index}`,
			kind: "intercom" as const,
			label: `${message.from} → ${message.to}`,
			status: "idle" as const,
			summary: message.body,
			children: [],
			agentId: agent.id,
			messageIndex: index,
			detail: ["Intercom", ircLine(message)],
		})),
		agentId: agent.id,
		detail: ["Intercom", ...relevant.map(message => `  ${ircLine(message)}`)],
	};
}

function collectNestedTaskSnapshots(agent: SubagentActivity): TaskToolDetailsLike[] {
	const completed = (agent.extractedToolData?.task ?? []).filter(isTaskToolDetailsLike);
	const inflight = isTaskToolDetailsLike(agent.inflightTaskDetails) ? [agent.inflightTaskDetails] : [];
	return [...completed, ...inflight];
}

function taskSnapshotNodes(
	snapshot: TaskToolDetailsLike,
	prefix: string,
	agentId: string,
	snapshotIndex: number,
): ObserverNode[] {
	const progressItems = (snapshot.progress ?? []).filter(isNestedProgressLike);
	const resultItems = (snapshot.results ?? []).filter(isNestedProgressLike);
	const items = progressItems.length > 0 ? progressItems : resultItems;
	if (items.length === 0) {
		return [
			{
				id: prefix,
				kind: "task",
				label: snapshot.async?.jobId ?? "Nested task",
				status: snapshot.async?.state === "running" ? "running" : "completed",
				summary: `${snapshot.totalDurationMs ?? 0}ms`,
				children: [],
				agentId,
				taskIndex: snapshotIndex,
				detail: ["Nested task", snapshot.async?.jobId ?? "task", `${snapshot.totalDurationMs ?? 0}ms`],
			},
		];
	}
	return items.map((item, index) => {
		const taskId = `${prefix}:${item.id ?? index}`;
		const taskLabel = item.description ?? item.task ?? item.agent ?? item.id ?? `Task ${index + 1}`;
		return {
			id: taskId,
			kind: "task" as const,
			label: taskLabel,
			status: item.status ?? "completed",
			summary: item.currentTool ?? item.recentOutput?.at(-1) ?? `${item.toolCount ?? 0} tools`,
			metrics: { tokens: item.tokens, toolCount: item.toolCount, cost: item.cost, durationMs: item.durationMs },
			// Activity drills one level below the task: Task → Activity 1, Activity 2…
			children: buildTaskActivityNodes(item, taskId, agentId),
			agentId,
			taskIndex: index,
			detail: [
				"Nested task",
				taskLabel,
				item.currentTool ? `Current tool: ${item.currentTool}` : `${item.toolCount ?? 0} tools`,
				...(item.recentOutput ?? []).slice(-3).map(line => `  ${line}`),
			],
		};
	});
}

/**
 * Build the per-task Activity children so the Miller column can drill
 * Task → Activity 1 → … The activity lines come from the task's own
 * current tool plus its recent output tail.
 */
function buildTaskActivityNodes(item: NestedProgressLike, taskPrefix: string, agentId: string): ObserverNode[] {
	const lines: string[] = [];
	if (item.currentTool) {
		lines.push(item.currentToolArgs ? `${item.currentTool} ${item.currentToolArgs}` : item.currentTool);
	}
	for (const line of item.recentOutput ?? []) {
		const trimmed = line.trim();
		if (trimmed.length > 0) lines.push(trimmed);
	}
	return lines.slice(-8).map((line, index) => ({
		id: `${taskPrefix}:activity:${index}`,
		kind: "activity" as const,
		label: `Activity ${index + 1}`,
		status: "idle" as const,
		summary: line,
		children: [],
		agentId,
		detail: ["Activity", line],
	}));
}

function toolNode(tool: RecentToolLike, id: string, agentId: string): ObserverNode {
	return {
		id,
		kind: "task",
		label: tool.tool,
		status: "completed",
		summary: tool.args || new Date(tool.endMs).toISOString().slice(11, 19),
		children: [],
		agentId,
		detail: ["Recent tool", tool.tool, tool.args || `ended ${new Date(tool.endMs).toISOString()}`],
	};
}

function isTaskToolDetailsLike(value: unknown): value is TaskToolDetailsLike {
	return value != null && typeof value === "object" && ("results" in value || "progress" in value || "async" in value);
}

function isNestedProgressLike(value: unknown): value is NestedProgressLike {
	return value != null && typeof value === "object";
}

function agentLabel(agent: SubagentActivity): string {
	return agent.description ?? agent.task ?? agent.assignment ?? agent.id;
}

function agentDuration(agent: SubagentActivity, now: number): number {
	return agent.durationMs > 0 ? agent.durationMs : Math.max(0, now - agent.startedAt);
}

function firstPromptLine(agent: SubagentActivity): string {
	return (agent.assignment ?? agent.task ?? agent.description ?? "").split(/\r?\n/)[0]?.trim() ?? "";
}

function timelineLine(entry: SubagentTimelineEntry): string {
	const time = new Date(entry.timestamp).toISOString().slice(11, 19);
	return `  [${time}] ${entry.title}: ${entry.detail}`;
}

function latestActivity(agent: SubagentActivity): string[] {
	if (agent.currentTool) return [agent.currentTool, agent.lastIntent ?? agent.currentToolArgs ?? ""];
	if ((agent.recentTools ?? []).length > 0) {
		const tool = agent.recentTools![0]!;
		return [tool.tool, tool.args];
	}
	const recent = agent.recentOutput
		.slice(-3)
		.map(line => line.trim())
		.filter(Boolean);
	return recent.length > 0 ? recent : ["thinking…"];
}

function statusLabel(status: SubagentStatus): string {
	switch (status) {
		case "completed":
			return "Completed";
		case "failed":
			return "Failed";
		case "aborted":
			return "Aborted";
		case "running":
			return "Running";
		case "pending":
			return "Queued";
	}
}

function findIrc(agent: SubagentActivity, messages: readonly IrcMessageActivity[]): IrcMessageActivity[] {
	return messages.filter(message => message.from === agent.id || message.to === agent.id);
}

function ircLine(message: IrcMessageActivity): string {
	const time = new Date(message.timestamp).toISOString().slice(11, 16);
	if (message.body.startsWith("/me ")) return `[${time}] * ${message.from} ${message.body.slice(4)}`;
	return `[${time}] <${message.from}> ${message.body}`;
}

function splitDetail(text: string): string[] {
	return text
		.split(/\r?\n/)
		.filter(line => line.length > 0)
		.map(line => `  ${line}`);
}
