// ---------------------------------------------------------------------------
// Stats Collector — accumulates agent activity metrics in memory.
// Zero file I/O. Resets per session.
// ---------------------------------------------------------------------------

export interface ToolCallTiming {
	toolName: string;
	toolCallId: string;
	startTime: number;
	/** Set when tool completes. Null = still running. */
	endTime: number | null;
	/** Duration in ms once completed. */
	durationMs: number | null;
}

export interface TurnStats {
	turnNumber: number;
	startTime: number;
	endTime: number | null;
	toolCalls: ToolCallTiming[];
	tokensInput: number | null;
	tokensOutput: number | null;
}

/** Subagent run status (mirrors AgentProgress["status"] from pi-coding-agent/task). */
export type SubagentStatus = "pending" | "running" | "completed" | "failed" | "aborted";

export interface SubagentRetryState {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorMessage: string;
	startedAtMs: number;
}

export interface SubagentRetryFailure {
	attempt: number;
	errorMessage: string;
}

export interface IrcMessageActivity {
	id?: string;
	timestamp: number;
	channel: string;
	from: string;
	to: string;
	body: string;
	kind: "message" | "reply";
	delivered: string[];
	failed: string[];
}

export type SubagentTimelineKind = "chat" | "tool" | "irc" | "retry" | "status" | "outcome";

/** A bounded, display-ready event in a subagent's chronological audit trail. */
export interface SubagentTimelineEntry {
	timestamp: number;
	sourceId?: string;
	kind: SubagentTimelineKind;
	title: string;
	detail: string;
}

export interface SubagentRecentTool {
	tool: string;
	args: string;
	endMs: number;
}

export interface SubagentProgressUpdate {
	id: string;
	agent: string;
	status: SubagentStatus;
	tokens: number;
	toolCount: number;
	cost: number;
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
	failureReason?: string;
	agentSource?: string;
	sessionFile?: string;
	recentTools?: SubagentRecentTool[];
	extractedToolData?: Record<string, unknown[]>;
	inflightTaskDetails?: unknown;
}

const MAX_IRC_MESSAGES = 100;
const MAX_IRC_TEXT = 4_000;
const MAX_TIMELINE_ENTRIES = 160;
const MAX_TIMELINE_TEXT = 320;

function normalizeDisplayText(value: string): string {
	return value
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function timelineText(value: string): string {
	const flattened = normalizeDisplayText(value);
	if (flattened.length <= MAX_TIMELINE_TEXT) return flattened;
	return `${flattened.slice(0, MAX_TIMELINE_TEXT - 1)}…`;
}

function ircBodyText(value: string): string {
	const flattened = normalizeDisplayText(value);
	if (flattened.length <= MAX_IRC_TEXT) return flattened;
	return `${flattened.slice(0, MAX_IRC_TEXT - 1)}…`;
}

function timelineIrcLine(message: IrcMessageActivity): string {
	const time = new Date(message.timestamp).toISOString().slice(11, 16);
	if (message.body.startsWith("/me ")) return `[${time}] * ${message.from} ${message.body.slice(4)}`;
	return `[${time}] <${message.from}> ${message.body}`;
}

function ircSourceId(message: IrcMessageActivity): string {
	return message.id
		? `irc:${message.id}`
		: `irc:legacy:${message.timestamp}\u0000${message.from}\u0000${message.to}\u0000${message.kind}\u0000${message.body}`;
}

function addTimelineEntry(agent: SubagentActivity, entry: SubagentTimelineEntry): void {
	agent.timeline ??= [];
	const timeline = agent.timeline;
	const sourceId = entry.sourceId?.trim() || undefined;
	if (sourceId && timeline.some(existing => existing.sourceId === sourceId)) return;
	timeline.push({
		timestamp: Number.isFinite(entry.timestamp) ? entry.timestamp : Date.now(),
		kind: entry.kind,
		title: timelineText(entry.title),
		detail: timelineText(entry.detail),
		sourceId,
	});
	timeline.sort((left, right) => left.timestamp - right.timestamp);
	if (timeline.length > MAX_TIMELINE_ENTRIES) timeline.splice(0, timeline.length - MAX_TIMELINE_ENTRIES);
}

/**
 * Latest cumulative activity snapshot for a single subagent run, keyed by run id.
 * Values are cumulative (overwrite, not add) because the source AgentProgress
 * payload reports running totals on every TASK_SUBAGENT_PROGRESS_CHANNEL emit.
 */
export interface SubagentActivity {
	id: string;
	agent: string;
	status: SubagentStatus;
	/** Cumulative input + output + cacheWrite tokens (excludes cacheRead). */
	tokens: number;
	toolCount: number;
	/** Cumulative billing cost in USD reported by the subagent. */
	cost: number;
	lastUpdate: number;
	index: number;
	task?: string;
	assignment?: string;
	description?: string;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartMs?: number;
	lastIntent?: string;
	recentOutput: string[];
	durationMs: number;
	contextTokens?: number;
	contextWindow?: number;
	resolvedModel?: string;
	retryState?: SubagentRetryState;
	retryFailure?: SubagentRetryFailure;
	startedAt: number;
	completedAt?: number;
	failureReason?: string;
	agentSource?: string;
	sessionFile?: string;
	recentTools?: SubagentRecentTool[];
	extractedToolData?: Record<string, unknown[]>;
	timeline?: SubagentTimelineEntry[];
	inflightTaskDetails?: unknown;
}
function matchesAgent(message: IrcMessageActivity, agent: SubagentActivity): boolean {
	return message.from === agent.id || message.to === agent.id;
}

function attachHistoricalIrc(agent: SubagentActivity): void {
	for (const message of stats.ircMessages) {
		if (!matchesAgent(message, agent)) continue;
		addTimelineEntry(agent, {
			timestamp: message.timestamp,
			kind: "irc",
			title: "IRC",
			detail: timelineIrcLine(message),
			sourceId: ircSourceId(message),
		});
	}
}

/** Rolled-up totals across all observed subagents. */
export interface SubagentTotals {
	count: number;
	activeCount: number;
	tokens: number;
	toolCount: number;
	cost: number;
}

export interface ObserverStats {
	sessionStartTime: number;
	agentRuns: number;
	turns: TurnStats[];
	currentTurn: TurnStats | null;
	activeToolCalls: Map<string, ToolCallTiming>;
	totalTokensInput: number;
	totalTokensOutput: number;
	toolCallCounts: Map<string, number>;
	/** Estimated cost in USD (proprietary estimate based on model tier). */
	estimatedCost: number;
	/**
	 * Latest cumulative activity per subagent run id. Fanned in from the parent
	 * EventBus (TASK_SUBAGENT_PROGRESS_CHANNEL / TASK_SUBAGENT_LIFECYCLE_CHANNEL),
	 * since subagents run in a separate AgentSession whose own pi.on(...) lifecycle
	 * events never reach this (parent) extension instance.
	 */
	subagents: Map<string, SubagentActivity>;
	ircMessages: IrcMessageActivity[];
}

export function createObserverStats(): ObserverStats {
	return {
		sessionStartTime: Date.now(),
		agentRuns: 0,
		turns: [],
		currentTurn: null,
		activeToolCalls: new Map(),
		totalTokensInput: 0,
		totalTokensOutput: 0,
		toolCallCounts: new Map(),
		estimatedCost: 0,
		subagents: new Map(),
		ircMessages: [],
	};
}

// ---------------------------------------------------------------------------
// Model tier → cost-per-1K-tokens estimates (prompt / completion)
// ---------------------------------------------------------------------------

const MODEL_COST_ESTIMATES: Record<string, { prompt: number; completion: number }> = {
	// Claude
	"claude-sonnet-4-20250514": { prompt: 0.003, completion: 0.015 },
	"claude-3-5-sonnet-20241022": { prompt: 0.003, completion: 0.015 },
	"claude-3-5-haiku-20241022": { prompt: 0.001, completion: 0.005 },
	"claude-opus-4-20250514": { prompt: 0.015, completion: 0.075 },
	// GPT
	"gpt-5": { prompt: 0.0025, completion: 0.01 },
	"gpt-4o": { prompt: 0.0025, completion: 0.01 },
	"gpt-4o-mini": { prompt: 0.00015, completion: 0.0006 },
	// Gemini
	"gemini-2.5-flash": { prompt: 0.00015, completion: 0.0006 },
	"gemini-2.5-pro": { prompt: 0.00125, completion: 0.01 },
} as const;

const DEFAULT_COST = { prompt: 0.001, completion: 0.005 };

export function estimateCost(modelId: string, inputTokens: number, outputTokens: number): number {
	const tier = MODEL_COST_ESTIMATES[modelId] ?? DEFAULT_COST;
	return (inputTokens / 1000) * tier.prompt + (outputTokens / 1000) * tier.completion;
}

// ---------------------------------------------------------------------------
// Stats accumulator functions (called by extension event handlers)
// ---------------------------------------------------------------------------

let stats = createObserverStats();

/** Reset stats (session_start). */
export function resetStats(): void {
	stats = createObserverStats();
}

export function getStats(): Readonly<ObserverStats> {
	return stats;
}

export function onAgentStart(): void {
	stats.agentRuns++;
}

export function onTurnStart(): void {
	const turnNumber = stats.turns.length + 1;
	stats.currentTurn = {
		turnNumber,
		startTime: Date.now(),
		endTime: null,
		toolCalls: [],
		tokensInput: null,
		tokensOutput: null,
	};
}

export function onTurnEnd(): void {
	if (stats.currentTurn) {
		stats.currentTurn.endTime = Date.now();
		stats.turns.push(stats.currentTurn);
		stats.currentTurn = null;
	}
}

export function onToolExecutionStart(toolName: string, toolCallId: string): void {
	const entry: ToolCallTiming = {
		toolName,
		toolCallId,
		startTime: Date.now(),
		endTime: null,
		durationMs: null,
	};
	stats.activeToolCalls.set(toolCallId, entry);
	if (stats.currentTurn) {
		stats.currentTurn.toolCalls.push(entry);
	}
	const count = stats.toolCallCounts.get(toolName) ?? 0;
	stats.toolCallCounts.set(toolName, count + 1);
}

export function onToolExecutionEnd(toolCallId: string): void {
	const entry = stats.activeToolCalls.get(toolCallId);
	if (entry) {
		entry.endTime = Date.now();
		entry.durationMs = entry.endTime - entry.startTime;
		stats.activeToolCalls.delete(toolCallId);
	}
}

export function onTokensUsed(modelId: string, inputTokens: number, outputTokens: number): void {
	stats.totalTokensInput += inputTokens;
	stats.totalTokensOutput += outputTokens;
	if (stats.currentTurn) {
		stats.currentTurn.tokensInput = (stats.currentTurn.tokensInput ?? 0) + inputTokens;
		stats.currentTurn.tokensOutput = (stats.currentTurn.tokensOutput ?? 0) + outputTokens;
	}
	stats.estimatedCost += estimateCost(modelId, inputTokens, outputTokens);
}

// ---------------------------------------------------------------------------
// Subagent fan-in (cross-session activity rolled up from the parent EventBus)
// ---------------------------------------------------------------------------

/**
 * Record the latest cumulative activity snapshot for a subagent run.
 * Cumulative values overwrite (do not add) the previous snapshot for the id.
 */
export function onSubagentProgress(update: SubagentProgressUpdate): void {
	const now = Date.now();
	const existing = stats.subagents.get(update.id);
	const startedAt = existing?.startedAt ?? now - (update.durationMs ?? 0);
	const completedAt = isTerminalStatus(update.status) ? (existing?.completedAt ?? now) : undefined;
	const next: SubagentActivity = {
		id: update.id,
		agent: update.agent,
		status: update.status,
		tokens: update.tokens,
		toolCount: update.toolCount,
		cost: update.cost,
		lastUpdate: now,
		index: update.index ?? existing?.index ?? Number.MAX_SAFE_INTEGER,
		task: update.task ?? existing?.task,
		assignment: update.assignment ?? existing?.assignment,
		description: update.description ?? existing?.description,
		currentTool: update.currentTool ?? existing?.currentTool,
		currentToolArgs: update.currentToolArgs ?? existing?.currentToolArgs,
		currentToolStartMs: update.currentToolStartMs ?? existing?.currentToolStartMs,
		lastIntent: update.lastIntent ?? existing?.lastIntent,
		recentOutput: update.recentOutput ?? existing?.recentOutput ?? [],
		durationMs: update.durationMs ?? existing?.durationMs ?? 0,
		contextTokens: update.contextTokens ?? existing?.contextTokens,
		contextWindow: update.contextWindow ?? existing?.contextWindow,
		resolvedModel: update.resolvedModel ?? existing?.resolvedModel,
		retryState: update.retryState ?? existing?.retryState,
		retryFailure: update.retryFailure ?? existing?.retryFailure,
		startedAt,
		completedAt,
		failureReason: update.failureReason ?? existing?.failureReason,
		agentSource: update.agentSource ?? existing?.agentSource,
		sessionFile: update.sessionFile ?? existing?.sessionFile,
		recentTools: update.recentTools ?? existing?.recentTools,
		extractedToolData: update.extractedToolData ?? existing?.extractedToolData,
		timeline: existing?.timeline ?? [],
		inflightTaskDetails: update.inflightTaskDetails ?? existing?.inflightTaskDetails,
	};
	stats.subagents.set(update.id, next);
	attachHistoricalIrc(next);
}

function isTerminalStatus(status: SubagentStatus): boolean {
	return status === "completed" || status === "failed" || status === "aborted";
}

/** Update a subagent's status from a lifecycle event while preserving any progress fields already observed. */
export function onSubagentLifecycle(
	id: string,
	agent: string,
	status: SubagentStatus,
	details: { index?: number; task?: string; description?: string } = {},
): void {
	const existing = stats.subagents.get(id);
	const now = Date.now();
	if (existing) {
		existing.status = status;
		existing.agent = agent;
		existing.lastUpdate = now;
		existing.index = details.index ?? existing.index;
		existing.task = details.task ?? existing.task;
		existing.description = details.description ?? existing.description;
		if (isTerminalStatus(status)) existing.completedAt = now;
	} else {
		stats.subagents.set(id, {
			id,
			agent,
			status,
			tokens: 0,
			toolCount: 0,
			cost: 0,
			lastUpdate: now,
			index: details.index ?? Number.MAX_SAFE_INTEGER,
			task: details.task,
			description: details.description,
			recentOutput: [],
			durationMs: 0,
			startedAt: now,
			completedAt: isTerminalStatus(status) ? now : undefined,
			timeline: [],
		});
	}
	const activity = stats.subagents.get(id);
	if (activity) attachHistoricalIrc(activity);
}

export function onSubagentTimeline(id: string, entry: SubagentTimelineEntry): void {
	const existing = stats.subagents.get(id);
	if (!existing) {
		const now = Date.now();
		stats.subagents.set(id, {
			id,
			agent: "subagent",
			status: "running",
			tokens: 0,
			toolCount: 0,
			cost: 0,
			lastUpdate: now,
			index: Number.MAX_SAFE_INTEGER,
			recentOutput: [],
			durationMs: 0,
			startedAt: now,
			timeline: [],
		});
	}
	const agent = stats.subagents.get(id);
	if (agent) addTimelineEntry(agent, entry);
}

export function onIrcMessage(message: IrcMessageActivity): void {
	const normalized: IrcMessageActivity = {
		...message,
		id: message.id?.trim() || undefined,
		body: ircBodyText(message.body),
	};
	const sourceId = ircSourceId(normalized);
	if (stats.ircMessages.some(existing => ircSourceId(existing) === sourceId)) return;
	stats.ircMessages.push(normalized);
	if (stats.ircMessages.length > MAX_IRC_MESSAGES) {
		stats.ircMessages.splice(0, stats.ircMessages.length - MAX_IRC_MESSAGES);
	}
	for (const agent of stats.subagents.values()) {
		if (!matchesAgent(normalized, agent)) continue;
		addTimelineEntry(agent, {
			timestamp: normalized.timestamp,
			kind: "irc",
			title: "IRC",
			detail: timelineIrcLine(normalized),
			sourceId,
		});
	}
}
/** Sum the latest per-subagent snapshots into rolled-up totals. */
export function getSubagentTotals(): SubagentTotals {
	let tokens = 0;
	let toolCount = 0;
	let cost = 0;
	let activeCount = 0;
	for (const sub of stats.subagents.values()) {
		tokens += sub.tokens;
		toolCount += sub.toolCount;
		cost += sub.cost;
		if (sub.status === "running" || sub.status === "pending") activeCount++;
	}
	return { count: stats.subagents.size, activeCount, tokens, toolCount, cost };
}

/** Format a duration in ms as a human-readable string. */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms.toFixed(0)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const mins = Math.floor(ms / 60_000);
	const secs = Math.round((ms % 60_000) / 1000);
	return `${mins}m ${secs}s`;
}

/** Format large numbers with commas. */
export function formatCount(n: number): string {
	return n.toLocaleString("en-US");
}

export function getSessionUptime(): number {
	return Date.now() - stats.sessionStartTime;
}
