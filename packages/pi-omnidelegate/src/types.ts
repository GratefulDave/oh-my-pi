export type ExternalAgentProvider = "claude" | "codex" | "gemini";

export type ExternalAgentBackend = "acpx" | "tmux" | "cmux";

export type ExternalAgentMode = "exec" | "prompt";

export interface ExternalAgentRequest {
	provider: ExternalAgentProvider;
	backend: ExternalAgentBackend;
	prompt: string;
	cwd: string;
	session?: string;
	mode?: ExternalAgentMode;
	timeoutMs?: number;
}

export type ExternalAgentJsonObject = Record<string, unknown>;

export interface ExternalAgentStatusEvent {
	type: "status";
	message: string;
}

export interface ExternalAgentTextEvent {
	type: "text";
	text: string;
}

export interface ExternalAgentJsonEvent {
	type: "json";
	json: ExternalAgentJsonObject;
}

export interface ExternalAgentToolStartEvent {
	type: "tool_start";
	toolName: string;
	toolId: string;
}

export interface ExternalAgentToolEndEvent {
	type: "tool_end";
	toolName: string;
	toolId: string;
}

export interface ExternalAgentTerminalEvent {
	type: "terminal";
	lines: string;
}

export interface ExternalAgentErrorEvent {
	type: "error";
	message: string;
}

export type ExternalAgentEvent =
	| ExternalAgentStatusEvent
	| ExternalAgentTextEvent
	| ExternalAgentJsonEvent
	| ExternalAgentToolStartEvent
	| ExternalAgentToolEndEvent
	| ExternalAgentTerminalEvent
	| ExternalAgentErrorEvent;

export interface ExternalAgentResult {
	provider: ExternalAgentProvider;
	backend: ExternalAgentBackend;
	success: boolean;
	output: string;
	events: ExternalAgentEvent[];
	error?: string;
	durationMs?: number;
}

/** Bounded summary extracted from a delegated agent's output via DELEGATION_SUMMARY: marker. */
export interface DelegationSummary {
	text: string;
	lineCount: number;
	charCount: number;
}

/** Full result of a parallel external-agent orchestration run. */
export interface ExternalOrchestrationResult {
	backend: ExternalAgentBackend;
	agents: ExternalAgentProvider[];
	results: ExternalAgentResult[];
	contextSummary: string;
	fullReport: string;
	successCount: number;
	artifactId?: string;
}

export type ExternalAgentEventHandler = (event: ExternalAgentEvent, request: ExternalAgentRequest) => void;

export type ExternalAgentParallelEventHandler = (
	event: ExternalAgentEvent,
	index: number,
	request: ExternalAgentRequest,
) => void;

/** Parsed arguments for the /delegate slash command. */
export interface ParsedDelegateArgs {
	backend: ExternalAgentBackend;
	providers: ExternalAgentProvider[];
	session?: string;
	mode: ExternalAgentMode;
	timeoutMs?: number;
	prompt: string;
}
