import type { IrcMessageActivity, ObserverStats, SubagentActivity, SubagentStatus } from "./stats-collector";

declare const process:
	| {
			argv: string[];
			stdout: { write(value: string): void };
	  }
	| undefined;

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const CHILD_PREFIX = "  └ ";

export interface RenderTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
	dim(text: string): string;
}

export interface RenderOptions {
	width: number;
	now?: number;
	spinnerFrame?: number;
	theme?: RenderTheme;
	maxAgents?: number;
	maxIrcMessages?: number;
	compact?: boolean;
	selectedAgentIndex?: number;
	includeDetails?: boolean;
	maxDetailLines?: number;
	ircMessages?: readonly IrcMessageActivity[];
}

export interface RenderResult {
	key: string;
	lines: string[];
	changed: boolean;
}

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const RESET = "\x1b[0m";
const GREEN_FG = "\x1b[32m";
const RED_FG = "\x1b[31m";
const CYAN_TINT = "\x1b[46;30m";
const GREEN_TINT = "\x1b[42;30m";
const RED_TINT = "\x1b[41;37m";
const DIM_TINT = "\x1b[48;5;238m\x1b[37m";
const SELECT_TINT = "\x1b[48;5;24m\x1b[37m";
const DEFAULT_WIDTH = 100;
const MAX_RECENT_OUTPUT_LINES = 3;
type TimerHandle = { ref?: () => unknown; unref?: () => unknown } | number;

export function stripAnsi(value: string): string {
	return value.replace(ANSI_PATTERN, "");
}

export function visibleWidth(value: string): number {
	let width = 0;
	for (const char of stripAnsi(value)) {
		const code = char.codePointAt(0) ?? 0;
		if (code === 0) continue;
		if (code < 32 || (code >= 0x7f && code < 0xa0)) continue;
		width += isWideCodePoint(code) ? 2 : 1;
	}
	return width;
}

function isWideCodePoint(code: number): boolean {
	return (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2329 && code <= 0x232a) ||
		(code >= 0x2e80 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe10 && code <= 0xfe19) ||
		(code >= 0xfe30 && code <= 0xfe6f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x1f300 && code <= 0x1faff)
	);
}

export function truncateVisible(value: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(value) <= maxWidth) return value;
	let used = 0;
	let output = "";
	for (const char of stripAnsi(value)) {
		const charWidth = visibleWidth(char);
		if (used + charWidth > maxWidth - 1) break;
		output += char;
		used += charWidth;
	}
	return `${output}…`;
}

export function padTintedLine(text: string, width: number, tint = CYAN_TINT): string {
	const available = Math.max(0, width - 2);
	const paddedText = ` ${truncateVisible(text, available)} `;
	const padding = Math.max(0, width - visibleWidth(paddedText));
	return `${tint}${paddedText}${" ".repeat(padding)}${RESET}`;
}

export class SubagentRenderer {
	#lastKey = "";

	render(stats: Pick<ObserverStats, "subagents">, options: RenderOptions): RenderResult {
		const now = options.now ?? Date.now();
		const width = normalizeWidth(options.width);
		const agents = getOrderedSubagents(stats);
		const queued = agents.filter(agent => agent.status === "pending").length;
		const renderableAgents = agents.filter(agent => agent.status !== "pending");
		const visibleAgents = renderableAgents.slice(0, options.maxAgents ?? renderableAgents.length);
		const selectedIndex = clampIndex(options.selectedAgentIndex ?? 0, renderableAgents.length);
		const lines: string[] = [];
		if (agents.length > 0) lines.push("● Agents");
		for (let index = 0; index < visibleAgents.length; index++) {
			const agent = visibleAgents[index];
			lines.push(
				...this.#renderAgent(
					agent,
					{ ...options, width, now },
					options.includeDetails === true && index === selectedIndex,
				),
			);
		}
		if (queued > 0) lines.push(truncateVisible(`o ${queued} queued`, width));
		if (renderableAgents.length > visibleAgents.length) {
			lines.push(truncateVisible(`o ${renderableAgents.length - visibleAgents.length} more queued`, width));
		}
		const selected = renderableAgents[selectedIndex];
		if (options.includeDetails === true && selected) {
			lines.push(
				...renderSelectedAgentDetail(selected, {
					width,
					now,
					maxDetailLines: options.maxDetailLines ?? 14,
					ircMessages: options.ircMessages ?? [],
				}),
			);
		}
		const key = lines.join("\n");
		const changed = key !== this.#lastKey;
		this.#lastKey = key;
		return { key, lines, changed };
	}

	#renderAgent(
		agent: SubagentActivity,
		options: Required<Pick<RenderOptions, "width" | "now">> & RenderOptions,
		selected: boolean,
	): string[] {
		const label = formatLabel(agent);
		const role = formatRole(agent);
		const elapsedMs = resolveDurationMs(agent, options.now);
		if (agent.status === "running") {
			const frame = SPINNER_FRAMES[(options.spinnerFrame ?? Math.floor(options.now / 120)) % SPINNER_FRAMES.length];
			const header = `▶ [${role}] ${label}`;
			const live = `${frame} [${agent.agent}] ${label} · ${Math.floor(elapsedMs / 1000)}s`;
			return options.compact
				? [
						truncateVisible(live, options.width),
						truncateVisible(`${CHILD_PREFIX}${describeState(agent)}`, options.width),
					]
				: [
						padTintedLine(header, options.width, selected ? SELECT_TINT : CYAN_TINT),
						truncateVisible(`${CHILD_PREFIX}Running in background (ID: ${agent.id})`, options.width),
						truncateVisible(`${CHILD_PREFIX}${describeState(agent)}`, options.width),
					];
		}
		if (agent.status === "completed") {
			const header = `✔ [${role}] ${label} · ${agent.toolCount} tool uses · ${formatTokens(agent.tokens)} · ${formatSeconds(elapsedMs)}`;
			return [
				options.compact
					? color(GREEN_FG, header)
					: padTintedLine(header, options.width, selected ? SELECT_TINT : GREEN_TINT),
			];
		}
		if (agent.status === "failed" || agent.status === "aborted") {
			const header = `✗ [${role}] ${label} · ${agent.toolCount} tool uses · ${formatTokens(agent.tokens)} · ${formatSeconds(elapsedMs)}`;
			const state = agent.failureReason ?? agent.retryFailure?.errorMessage;
			return state
				? [
						options.compact
							? color(RED_FG, header)
							: padTintedLine(header, options.width, selected ? SELECT_TINT : RED_TINT),
						truncateVisible(`${CHILD_PREFIX}${state}`, options.width),
					]
				: [
						options.compact
							? color(RED_FG, header)
							: padTintedLine(header, options.width, selected ? SELECT_TINT : RED_TINT),
					];
		}
		return [
			options.compact
				? `◇ [${role}] ${label}`
				: padTintedLine(`◇ [${role}] ${label}`, options.width, selected ? SELECT_TINT : DIM_TINT),
		];
	}
}

export class IrcRenderer {
	#lastKey = "";

	render(messages: readonly IrcMessageActivity[], options: RenderOptions): RenderResult {
		const width = normalizeWidth(options.width);
		const shown = messages.slice(-(options.maxIrcMessages ?? messages.length));
		const lines: string[] = [];
		let lastChannel = "";
		for (const message of shown) {
			const channel = message.channel || message.to;
			if (channel !== lastChannel) {
				lines.push(truncateVisible(formatIrcHeader(message), width));
				lastChannel = channel;
			}
			lines.push(truncateVisible(`${CHILD_PREFIX}${formatIrcMessage(message)}`, width));
		}
		const key = lines.join("\n");
		const changed = key !== this.#lastKey;
		this.#lastKey = key;
		return { key, lines, changed };
	}
}

export function getOrderedSubagents(stats: Pick<ObserverStats, "subagents">): SubagentActivity[] {
	return [...stats.subagents.values()].sort(compareSubagents);
}

function renderSelectedAgentDetail(
	agent: SubagentActivity,
	options: { width: number; now: number; maxDetailLines: number; ircMessages: readonly IrcMessageActivity[] },
): string[] {
	const lines = ["● Selected Agent"];
	const push = (text: string): void => {
		if (lines.length <= options.maxDetailLines) lines.push(truncateVisible(`${CHILD_PREFIX}${text}`, options.width));
	};
	push(`Prompt: ${formatLabel(agent)}`);
	if (agent.assignment && agent.assignment !== agent.task && agent.assignment !== agent.description) {
		push(`Task: ${agent.assignment}`);
	}
	push(`Activity: ${describeState(agent)}`);
	for (const output of agent.recentOutput.slice(-MAX_RECENT_OUTPUT_LINES)) push(`Trace: ${output.trim()}`);
	push(`Outcome: ${formatOutcome(agent)}`);
	if (agent.retryState) {
		push(
			`Retry: ${agent.retryState.attempt}/${agent.retryState.maxAttempts} in ${formatSeconds(agent.retryState.delayMs)} · ${agent.retryState.errorMessage}`,
		);
	} else if (agent.retryFailure) {
		push(`Retry: attempt ${agent.retryFailure.attempt} failed · ${agent.retryFailure.errorMessage}`);
	}
	push(`Model: ${agent.resolvedModel ?? "unknown"}`);
	push(
		`Metrics: ${agent.toolCount} tools · ${formatTokens(agent.tokens)} · ${formatSeconds(resolveDurationMs(agent, options.now))} · ${formatDollar(agent.cost)}`,
	);
	if (agent.contextTokens != null && agent.contextWindow != null) {
		push(`Context: ${formatTokens(agent.contextTokens)} / ${formatTokens(agent.contextWindow)}`);
	}
	for (const message of findAgentIrcMessages(agent, options.ircMessages).slice(-3))
		push(`IRC: ${formatIrcMessage(message)}`);
	return lines.slice(0, options.maxDetailLines + 1);
}

function compareSubagents(a: SubagentActivity, b: SubagentActivity): number {
	const statusDelta = statusRank(a.status) - statusRank(b.status);
	if (statusDelta !== 0) return statusDelta;
	const indexDelta = a.index - b.index;
	if (indexDelta !== 0) return indexDelta;
	return a.agent.localeCompare(b.agent) || a.id.localeCompare(b.id);
}

function statusRank(status: SubagentStatus): number {
	switch (status) {
		case "running":
			return 0;
		case "pending":
			return 1;
		case "failed":
			return 2;
		case "aborted":
			return 3;
		case "completed":
			return 4;
	}
}

function normalizeWidth(width: number): number {
	return width > 0 ? width : DEFAULT_WIDTH;
}

function clampIndex(index: number, length: number): number {
	if (length <= 0) return 0;
	if (index < 0) return 0;
	if (index >= length) return length - 1;
	return index;
}

function formatLabel(agent: SubagentActivity): string {
	return agent.description ?? agent.task ?? agent.assignment ?? agent.id;
}

function formatRole(agent: SubagentActivity): string {
	return agent.resolvedModel ? `${agent.agent} ${agent.resolvedModel}` : agent.agent;
}

function describeState(agent: SubagentActivity): string {
	if (agent.retryState)
		return `retry ${agent.retryState.attempt}/${agent.retryState.maxAttempts}: ${agent.retryState.errorMessage}`;
	if (agent.currentTool)
		return agent.currentToolArgs ? `${agent.currentTool} ${agent.currentToolArgs}` : `using ${agent.currentTool}`;
	if (agent.lastIntent) return agent.lastIntent;
	const output = agent.recentOutput.at(-1)?.trim();
	return output || agent.status;
}

function resolveDurationMs(agent: SubagentActivity, now: number): number {
	if (agent.durationMs > 0) return agent.durationMs;
	return Math.max(0, now - agent.startedAt);
}

function formatOutcome(agent: SubagentActivity): string {
	if (agent.status === "failed" || agent.status === "aborted")
		return agent.failureReason ?? agent.retryFailure?.errorMessage ?? agent.status;
	if (agent.status === "completed")
		return `completed at ${formatSeconds(resolveDurationMs(agent, agent.completedAt ?? agent.lastUpdate))}`;
	return agent.status;
}

function formatTokens(tokens: number): string {
	return `${(tokens / 1000).toFixed(1)}k tokens`;
}

function formatSeconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatDollar(value: number): string {
	return `$${value.toFixed(4)}`;
}

function formatIrcHeader(message: IrcMessageActivity): string {
	if (message.to.startsWith("@") || !message.to.startsWith("#")) return `● Intercom ${message.to} (Direct Message)`;
	return `▶ IRC ${message.channel}`;
}

function formatIrcMessage(message: IrcMessageActivity): string {
	const time = new Date(message.timestamp).toISOString().slice(11, 16);
	if (message.body.startsWith("/me ")) return `[${time}] * ${message.from} ${message.body.slice(4)}`;
	return `[${time}] <${message.from}> ${message.body}`;
}

function findAgentIrcMessages(agent: SubagentActivity, messages: readonly IrcMessageActivity[]): IrcMessageActivity[] {
	const names = new Set([agent.agent, agent.id, `@${agent.agent}`, `@${agent.id}`]);
	return messages.filter(message => names.has(message.from) || names.has(message.to) || names.has(message.channel));
}

function color(prefix: string, text: string): string {
	return `${prefix}${text}${RESET}`;
}

function createMockStats(now: number): ObserverStats {
	return {
		sessionStartTime: now,
		agentRuns: 1,
		turns: [],
		currentTurn: null,
		activeToolCalls: new Map(),
		totalTokensInput: 0,
		totalTokensOutput: 0,
		toolCallCounts: new Map(),
		estimatedCost: 0,
		subagents: new Map([
			[
				"mock-running",
				{
					id: "mock-running",
					agent: "executor",
					status: "running",
					tokens: 920,
					toolCount: 3,
					cost: 0.01,
					lastUpdate: now,
					index: 0,
					task: "Build dashboard",
					assignment: "Implement diagnostic dashboard hierarchy and drill-down",
					currentTool: "edit",
					recentOutput: ["patched renderer"],
					durationMs: 0,
					startedAt: now,
					resolvedModel: "anthropic/claude-sonnet-4",
				},
			],
			[
				"mock-queued",
				{
					id: "mock-queued",
					agent: "reviewer",
					status: "pending",
					tokens: 0,
					toolCount: 0,
					cost: 0,
					lastUpdate: now,
					index: 1,
					task: "Review diff",
					recentOutput: [],
					durationMs: 0,
					startedAt: now,
				},
			],
		]),
		ircMessages: [],
	};
}

export function runMockRuntime(): void {
	const start = Date.now();
	const stats = createMockStats(start);
	const master = new SubagentRenderer();
	const liveSubagents = new SubagentRenderer();
	const irc = new IrcRenderer();
	let tick = 0;
	let selectedAgentIndex = 0;
	let lastKey = "";
	const handle: TimerHandle = setInterval(() => {
		const now = Date.now();
		const running = stats.subagents.get("mock-running");
		if (running && tick === 10) {
			running.status = "completed";
			running.durationMs = now - running.startedAt;
			running.tokens = 1600;
			running.toolCount = 5;
			running.completedAt = now;
		}
		if (tick === 4) {
			stats.ircMessages.push({
				timestamp: now,
				channel: "#agents",
				from: "Main",
				to: "#agents",
				body: "status check",
				kind: "message",
				delivered: ["executor"],
				failed: [],
			});
		}
		if (tick === 8) {
			stats.ircMessages.push({
				timestamp: now,
				channel: "@Main",
				from: "executor",
				to: "@Main",
				body: "/me pushed renderer update",
				kind: "reply",
				delivered: ["Main"],
				failed: [],
			});
			selectedAgentIndex = 0;
		}
		const rendered = [
			...master.render(stats, {
				width: 96,
				now,
				spinnerFrame: tick,
				includeDetails: true,
				selectedAgentIndex,
				ircMessages: stats.ircMessages,
			}).lines,
			"● Live",
			...liveSubagents.render(stats, { width: 96, now, spinnerFrame: tick, compact: true }).lines,
			...irc.render(stats.ircMessages, { width: 96 }).lines,
		];
		const key = rendered.join("\n");
		if (key !== lastKey) {
			const runtimeProcess = process;
			if (runtimeProcess) runtimeProcess.stdout.write(`\x1b[2J\x1b[H${key}\n`);
			lastKey = key;
		}
		tick++;
		if (tick > 14 && typeof clearInterval === "function") clearInterval(handle as never);
	}, 120);
}

if (
	typeof process !== "undefined" &&
	process.argv[1] != null &&
	import.meta.url === new URL(process.argv[1], "file:").href
) {
	runMockRuntime();
}
