import { readLines } from "@oh-my-pi/pi-utils";

import type {
	ExternalAgentBackend,
	ExternalAgentEvent,
	ExternalAgentEventHandler,
	ExternalAgentJsonObject,
	ExternalAgentMode,
	ExternalAgentParallelEventHandler,
	ExternalAgentProvider,
	ExternalAgentRequest,
	ExternalAgentResult,
} from "./types";

interface CommandResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

interface ToolEventDetails {
	kind: "tool_start" | "tool_end";
	name?: string;
	id?: string;
}

const TEXT_KEYS = ["text", "delta", "final", "output"];
const EVENT_KEYS = ["type", "event", "kind", "name"];
const TOOL_NAME_KEYS = ["tool", "tool_name", "toolName", "name"];
const TOOL_ID_KEYS = ["id", "tool_id", "toolId", "call_id", "callId"];

function getBackend(request: ExternalAgentRequest): ExternalAgentBackend {
	return request.backend ?? "acpx";
}

function getMode(request: ExternalAgentRequest): ExternalAgentMode {
	return request.mode ?? "exec";
}

function eventRecordValue(value: ExternalAgentJsonObject, keys: string[]): string | undefined {
	for (const key of keys) {
		const field = value[key];
		if (typeof field === "string" && field.length > 0) return field;
	}
	return undefined;
}

function readNestedText(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (!value || typeof value !== "object") return undefined;
	if (Array.isArray(value)) {
		let text = "";
		for (const item of value) {
			const itemText = readNestedText(item);
			if (itemText) text += itemText;
		}
		return text.length > 0 ? text : undefined;
	}
	const record = value as Record<string, unknown>;
	const direct = eventRecordValue(record, TEXT_KEYS);
	if (direct) return direct;
	return readNestedText(record.content ?? record.message);
}

function textFromJsonEvent(value: ExternalAgentJsonObject): string | undefined {
	const direct = eventRecordValue(value, TEXT_KEYS);
	if (direct) return direct;
	const marker = eventRecordValue(value, EVENT_KEYS)?.toLowerCase();
	if (
		marker?.includes("text") ||
		marker?.includes("delta") ||
		marker?.includes("message") ||
		marker?.includes("final")
	) {
		return readNestedText(value.content ?? value.message);
	}
	return undefined;
}

function toolEventFromJson(value: ExternalAgentJsonObject): ToolEventDetails | undefined {
	const marker = eventRecordValue(value, EVENT_KEYS)?.toLowerCase().replaceAll("-", "_");
	if (!marker?.includes("tool")) return undefined;

	const name = eventRecordValue(value, TOOL_NAME_KEYS);
	const id = eventRecordValue(value, TOOL_ID_KEYS);
	if (marker.includes("start") || marker.includes("begin") || marker.includes("call") || marker.includes("use")) {
		return { kind: "tool_start", name, id };
	}
	if (marker.includes("end") || marker.includes("finish") || marker.includes("result") || marker.includes("stop")) {
		return { kind: "tool_end", name, id };
	}
	return undefined;
}

function isJsonObject(value: unknown): value is ExternalAgentJsonObject {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function buildAcpxArgs(request: ExternalAgentRequest): string[] {
	const args = ["--cwd", request.cwd, "--format", "json", request.provider];
	if (request.session) args.push("-s", request.session);
	args.push(getMode(request), request.prompt);
	return args;
}

function sanitizeSessionName(session: string): string {
	const safe = session.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
	return safe.length > 0 ? safe : "external-agent";
}

function createSessionName(provider: ExternalAgentProvider, session: string | undefined): string {
	return sanitizeSessionName(session ?? `external-${provider}-${Date.now()}`);
}

function emitEvent(
	events: ExternalAgentEvent[],
	request: ExternalAgentRequest,
	onEvent: ExternalAgentEventHandler | undefined,
	event: ExternalAgentEvent,
): void {
	events.push(event);
	onEvent?.(event, request);
}

async function readAcpxStdout(
	stream: ReadableStream<Uint8Array>,
	events: ExternalAgentEvent[],
	request: ExternalAgentRequest,
	onEvent: ExternalAgentEventHandler | undefined,
	textParts: string[],
	signal: AbortSignal,
): Promise<void> {
	const decoder = new TextDecoder();
	for await (const bytes of readLines(stream, signal)) {
		const line = decoder.decode(bytes).trimEnd();
		if (line.length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			textParts.push(line);
			emitEvent(events, request, onEvent, { type: "text", text: line });
			continue;
		}
		if (!isJsonObject(parsed)) {
			textParts.push(line);
			emitEvent(events, request, onEvent, { type: "text", text: line });
			continue;
		}
		emitEvent(events, request, onEvent, { type: "json", json: parsed });
		const text = textFromJsonEvent(parsed);
		if (text) {
			textParts.push(text);
			emitEvent(events, request, onEvent, { type: "text", text });
		}
		const tool = toolEventFromJson(parsed);
		if (tool?.kind === "tool_start") {
			emitEvent(events, request, onEvent, {
				type: "tool_start",
				toolName: tool.name ?? "unknown",
				toolId: tool.id ?? "",
			});
		} else if (tool?.kind === "tool_end") {
			emitEvent(events, request, onEvent, {
				type: "tool_end",
				toolName: tool.name ?? "unknown",
				toolId: tool.id ?? "",
			});
		}
	}
}

async function readStderr(
	stream: ReadableStream<Uint8Array>,
	events: ExternalAgentEvent[],
	request: ExternalAgentRequest,
	onEvent: ExternalAgentEventHandler | undefined,
	signal: AbortSignal,
): Promise<void> {
	const decoder = new TextDecoder();
	for await (const bytes of readLines(stream, signal)) {
		const line = decoder.decode(bytes).trimEnd();
		if (line.length > 0) emitEvent(events, request, onEvent, { type: "error", message: line });
	}
}

async function runCommand(cmd: string[], cwd: string): Promise<CommandResult> {
	try {
		const proc = Bun.spawn(cmd, {
			cwd,
			env: process.env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { exitCode, stdout, stderr };
	} catch (error) {
		return { exitCode: null, stdout: "", stderr: errorMessage(error) };
	}
}

async function runAcpxAgent(
	request: ExternalAgentRequest,
	onEvent: ExternalAgentEventHandler | undefined,
): Promise<ExternalAgentResult> {
	const startTime = Date.now();
	const backend = getBackend(request);
	const events: ExternalAgentEvent[] = [];
	const textParts: string[] = [];
	const command = ["acpx", ...buildAcpxArgs(request)];
	emitEvent(events, request, onEvent, { type: "status", message: "starting acpx external agent" });

	const controller = new AbortController();
	const timeout =
		request.timeoutMs && request.timeoutMs > 0 ? setTimeout(() => controller.abort(), request.timeoutMs) : undefined;
	try {
		const proc = Bun.spawn(command, {
			cwd: request.cwd,
			stdin: "ignore",
			env: process.env,
			stdout: "pipe",
			stderr: "pipe",
			signal: controller.signal,
		});
		await Promise.all([
			proc.exited,
			readAcpxStdout(proc.stdout, events, request, onEvent, textParts, controller.signal),
			readStderr(proc.stderr, events, request, onEvent, controller.signal),
		]);
		const output = textParts.join("");
		const success = true;
		emitEvent(events, request, onEvent, { type: "status", message: "acpx external agent completed" });
		return {
			provider: request.provider,
			backend,
			success,
			output,
			events,
			durationMs: Date.now() - startTime,
		};
	} catch (error) {
		const message = controller.signal.aborted ? "external agent timed out" : errorMessage(error);
		emitEvent(events, request, onEvent, { type: "error", message });
		return {
			provider: request.provider,
			backend,
			success: false,
			output: textParts.join(""),
			events,
			error: message,
			durationMs: Date.now() - startTime,
		};
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

async function runTmuxAgent(
	request: ExternalAgentRequest,
	onEvent: ExternalAgentEventHandler | undefined,
): Promise<ExternalAgentResult> {
	const startTime = Date.now();
	const backend = getBackend(request);
	const session = createSessionName(request.provider, request.session);
	const events: ExternalAgentEvent[] = [];
	const newSessionCommand = ["tmux", "new-session", "-d", "-s", session, request.provider];
	const sendCommand = ["tmux", "send-keys", "-t", session, request.prompt, "C-m"];
	emitEvent(events, request, onEvent, { type: "status", message: "starting tmux external agent" });

	const newSession = await runCommand(newSessionCommand, request.cwd);
	if (newSession.exitCode !== 0) {
		return {
			provider: request.provider,
			backend,
			success: false,
			output: newSession.stderr,
			events,
			error: newSession.stderr || "tmux session creation failed",
			durationMs: Date.now() - startTime,
		};
	}
	const send = await runCommand(sendCommand, request.cwd);
	const success = send.exitCode === 0;
	return {
		provider: request.provider,
		backend,
		success,
		output: send.stdout,
		events,
		error: success ? undefined : send.stderr || "tmux command failed",
		durationMs: Date.now() - startTime,
	};
}

async function runCmuxAgent(
	request: ExternalAgentRequest,
	onEvent: ExternalAgentEventHandler | undefined,
): Promise<ExternalAgentResult> {
	const startTime = Date.now();
	const backend = getBackend(request);
	const events: ExternalAgentEvent[] = [];
	const newSplitCommand = ["cmux", "new-split", "right"];
	const sendCommand = ["cmux", "send", `${request.provider} ${request.prompt}`];
	emitEvent(events, request, onEvent, { type: "status", message: "starting cmux external agent" });

	const newSplit = await runCommand(newSplitCommand, request.cwd);
	if (newSplit.exitCode !== 0) {
		return {
			provider: request.provider,
			backend,
			success: false,
			output: newSplit.stderr,
			events,
			error: newSplit.stderr || "cmux session creation failed",
			durationMs: Date.now() - startTime,
		};
	}
	const send = await runCommand(sendCommand, request.cwd);
	const success = send.exitCode === 0;
	return {
		provider: request.provider,
		backend,
		success,
		output: send.stdout,
		events,
		error: success ? undefined : send.stderr || "cmux command failed",
		durationMs: Date.now() - startTime,
	};
}

export async function runExternalAgent(
	request: ExternalAgentRequest,
	onEvent?: ExternalAgentEventHandler,
): Promise<ExternalAgentResult> {
	const backend = getBackend(request);
	if (backend === "tmux") return await runTmuxAgent(request, onEvent);
	if (backend === "cmux") return await runCmuxAgent(request, onEvent);
	return await runAcpxAgent(request, onEvent);
}

export async function runExternalAgentsParallel(
	requests: ExternalAgentRequest[],
	onEvent?: ExternalAgentParallelEventHandler,
): Promise<ExternalAgentResult[]> {
	return await Promise.all(
		requests.map((request, index) => runExternalAgent(request, event => onEvent?.(event, index, request))),
	);
}

const DELEGATION_SUMMARY_MARKER = "DELEGATION_SUMMARY:";
const MAX_SUMMARY_LINES = 20;
const MAX_SUMMARY_CHARS = 2000;

/** Extract bounded summary from agent output via DELEGATION_SUMMARY: marker. */
export function extractDelegationSummary(text: string): { text?: string; lines: number } {
	const idx = text.lastIndexOf(DELEGATION_SUMMARY_MARKER);
	if (idx === -1) return { lines: 0 };
	const raw = text.slice(idx + DELEGATION_SUMMARY_MARKER.length).trim();
	const allLines = raw.split("\n");
	const cappedLines = allLines.slice(0, MAX_SUMMARY_LINES);
	let result = cappedLines.join("\n");
	if (result.length > MAX_SUMMARY_CHARS) {
		result = result.slice(0, MAX_SUMMARY_CHARS);
		const lastSpace = result.lastIndexOf(" ");
		if (lastSpace > 0) result = result.slice(0, lastSpace).trimEnd();
	}
	return { text: result, lines: Math.min(allLines.length, MAX_SUMMARY_LINES) };
}

/**
 * Build a concise context summary from results.
 */
export function buildContextSummary(results: ExternalAgentResult[]): string {
	const lines: string[] = [];
	for (const r of results) {
		const delegation = extractDelegationSummary(r.output);
		if (delegation.text) {
			lines.push(`## ${r.provider}`, delegation.text);
			continue;
		}
		const statusIcon = r.success ? "✓" : "✗";
		let line = `${statusIcon} ${r.provider} (${r.backend})`;
		if (r.reusedFromCache) line += " reused exact same-session result";
		if (r.error) line += ` error: ${r.error}`;
		const toolCount = r.events.filter(e => e.type === "tool_start").length;
		if (toolCount > 0) line += ` tools: ${toolCount}`;
		lines.push(line);
	}
	return lines.join("\n");
}

/**
 * Build the full orchestration markdown report from agent results.
 */
export function buildExternalOrchestrationReport(
	results: ExternalAgentResult[],
	metadata: { backend: ExternalAgentBackend; cwd: string; agentCount: number },
): string {
	const reportLines = [
		"# External Orchestration",
		`- Backend: \`${metadata.backend}\``,
		`- CWD: \`${metadata.cwd}\``,
		`- Agent count: ${metadata.agentCount}`,
	];
	for (const result of results) {
		reportLines.push("", `## ${result.provider}`, `- Status: ${result.success ? "success" : "failure"}`);
		if (result.reusedFromCache) reportLines.push("- Reuse: exact same-session cache hit");
		reportLines.push(`- Duration: ${result.durationMs ?? "?"}ms`);

		const output = result.output.trim();
		if (output.length > 0) {
			reportLines.push("", "```text", output, "```");
		} else {
			reportLines.push("", "_No captured output._");
		}
	}
	return reportLines.join("\n");
}
