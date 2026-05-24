export type ExternalAgentProvider = "claude" | "codex" | "gemini";

export type ExternalAgentBackend = "acpx" | "tmux" | "cmux";

export type ExternalAgentMode = "exec" | "prompt";

export interface ExternalAgentRequest {
	provider: ExternalAgentProvider;
	backend?: ExternalAgentBackend;
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
	value: ExternalAgentJsonObject;
}

export interface ExternalAgentToolStartEvent {
	type: "tool_start";
	name?: string;
	id?: string;
	value: ExternalAgentJsonObject;
}

export interface ExternalAgentToolEndEvent {
	type: "tool_end";
	name?: string;
	id?: string;
	value: ExternalAgentJsonObject;
}

export interface ExternalAgentTerminalEvent {
	type: "terminal";
	command: string[];
	message: string;
	session?: string;
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
	session?: string;
	cwd: string;
	events: ExternalAgentEvent[];
	text: string;
	exitCode: number | null;
	success: boolean;
}

/** Bounded summary extracted from a delegated agent's output via DELEGATION_SUMMARY: marker. */
export interface DelegationSummary {
	/** Extracted text, trimmed and capped; undefined if no marker was present. */
	text?: string;
	/** Line count of the raw extracted text (before capping). */
	lines: number;
}

/** Full result of a parallel external-agent orchestration run. */
export interface ExternalOrchestrationResult {
	backend: ExternalAgentBackend;
	agents: ExternalAgentProvider[];
	results: ExternalAgentResult[];
	fullReport: string;
	contextSummary: string;
	artifactId?: string;
	successCount: number;
}

export type ExternalAgentEventHandler = (event: ExternalAgentEvent, request: ExternalAgentRequest) => void;

export type ExternalAgentParallelEventHandler = (
	event: ExternalAgentEvent,
	index: number,
	request: ExternalAgentRequest,
) => void;
