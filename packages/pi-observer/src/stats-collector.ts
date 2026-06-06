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
export function onSubagentProgress(update: {
	id: string;
	agent: string;
	status: SubagentStatus;
	tokens: number;
	toolCount: number;
	cost: number;
}): void {
	stats.subagents.set(update.id, {
		id: update.id,
		agent: update.agent,
		status: update.status,
		tokens: update.tokens,
		toolCount: update.toolCount,
		cost: update.cost,
		lastUpdate: Date.now(),
	});
}

/** Update a subagent's terminal status from a lifecycle event. */
export function onSubagentLifecycle(id: string, agent: string, status: SubagentStatus): void {
	const existing = stats.subagents.get(id);
	if (existing) {
		existing.status = status;
		existing.lastUpdate = Date.now();
	} else {
		stats.subagents.set(id, {
			id,
			agent,
			status,
			tokens: 0,
			toolCount: 0,
			cost: 0,
			lastUpdate: Date.now(),
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
