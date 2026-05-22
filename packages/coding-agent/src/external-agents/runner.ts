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
		emitEvent(events, request, onEvent, { type: "json", value: parsed });
		const text = textFromJsonEvent(parsed);
		if (text) {
			textParts.push(text);
			emitEvent(events, request, onEvent, { type: "text", text });
		}
		const tool = toolEventFromJson(parsed);
		if (tool?.kind === "tool_start") {
			emitEvent(events, request, onEvent, { type: "tool_start", name: tool.name, id: tool.id, value: parsed });
		} else if (tool?.kind === "tool_end") {
			emitEvent(events, request, onEvent, { type: "tool_end", name: tool.name, id: tool.id, value: parsed });
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
	const backend = getBackend(request);
	const events: ExternalAgentEvent[] = [];
	const textParts: string[] = [];
	const command = ["acpx", ...buildAcpxArgs(request)];
	emitEvent(events, request, onEvent, { type: "status", message: "starting acpx external agent" });
	emitEvent(events, request, onEvent, { type: "terminal", command, message: "spawning acpx" });

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
		const [exitCode] = await Promise.all([
			proc.exited,
			readAcpxStdout(proc.stdout, events, request, onEvent, textParts, controller.signal),
			readStderr(proc.stderr, events, request, onEvent, controller.signal),
		]);
		const success = exitCode === 0;
		emitEvent(events, request, onEvent, {
			type: "status",
			message: success ? "external agent completed" : "external agent failed",
		});
		return {
			provider: request.provider,
			backend,
			session: request.session,
			cwd: request.cwd,
			events,
			text: textParts.join(""),
			exitCode,
			success,
		};
	} catch (error) {
		const message = controller.signal.aborted ? "external agent timed out" : errorMessage(error);
		emitEvent(events, request, onEvent, { type: "error", message });
		return {
			provider: request.provider,
			backend,
			session: request.session,
			cwd: request.cwd,
			events,
			text: textParts.join(""),
			exitCode: null,
			success: false,
		};
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

async function runTmuxAgent(
	request: ExternalAgentRequest,
	onEvent: ExternalAgentEventHandler | undefined,
): Promise<ExternalAgentResult> {
	const backend = getBackend(request);
	const session = createSessionName(request.provider, request.session);
	const events: ExternalAgentEvent[] = [];
	const newSessionCommand = ["tmux", "new-session", "-d", "-s", session, request.provider];
	const sendCommand = ["tmux", "send-keys", "-t", session, request.prompt, "C-m"];
	emitEvent(events, request, onEvent, { type: "status", message: "starting tmux external agent" });
	emitEvent(events, request, onEvent, {
		type: "terminal",
		session,
		command: newSessionCommand,
		message: "creating tmux session",
	});
	const newSession = await runCommand(newSessionCommand, request.cwd);
	if (newSession.stderr.trim().length > 0)
		emitEvent(events, request, onEvent, { type: "error", message: newSession.stderr.trim() });
	if (newSession.exitCode !== 0) {
		return {
			provider: request.provider,
			backend,
			session,
			cwd: request.cwd,
			events,
			text: "",
			exitCode: newSession.exitCode,
			success: false,
		};
	}
	emitEvent(events, request, onEvent, {
		type: "terminal",
		session,
		command: sendCommand,
		message: "sending prompt to tmux session",
	});
	const send = await runCommand(sendCommand, request.cwd);
	if (send.stderr.trim().length > 0)
		emitEvent(events, request, onEvent, { type: "error", message: send.stderr.trim() });
	const success = send.exitCode === 0;
	emitEvent(events, request, onEvent, {
		type: "status",
		message: success ? "tmux external agent started" : "tmux external agent failed",
	});
	return {
		provider: request.provider,
		backend,
		session,
		cwd: request.cwd,
		events,
		text: "",
		exitCode: send.exitCode,
		success,
	};
}

async function runCmuxAgent(
	request: ExternalAgentRequest,
	onEvent: ExternalAgentEventHandler | undefined,
): Promise<ExternalAgentResult> {
	const backend = getBackend(request);
	const events: ExternalAgentEvent[] = [];
	const newSplitCommand = ["cmux", "new-split", "right"];
	const sendCommand = ["cmux", "send", `${request.provider} ${request.prompt}`];
	emitEvent(events, request, onEvent, { type: "status", message: "starting cmux external agent" });
	emitEvent(events, request, onEvent, { type: "terminal", command: newSplitCommand, message: "creating cmux split" });
	const newSplit = await runCommand(newSplitCommand, request.cwd);
	if (newSplit.stderr.trim().length > 0)
		emitEvent(events, request, onEvent, { type: "error", message: newSplit.stderr.trim() });
	if (newSplit.exitCode !== 0) {
		return {
			provider: request.provider,
			backend,
			session: request.session,
			cwd: request.cwd,
			events,
			text: "",
			exitCode: newSplit.exitCode,
			success: false,
		};
	}
	emitEvent(events, request, onEvent, {
		type: "terminal",
		command: sendCommand,
		message: "sending command to cmux split",
	});
	const send = await runCommand(sendCommand, request.cwd);
	if (send.stderr.trim().length > 0)
		emitEvent(events, request, onEvent, { type: "error", message: send.stderr.trim() });
	const success = send.exitCode === 0;
	emitEvent(events, request, onEvent, {
		type: "status",
		message: success ? "cmux external agent started" : "cmux external agent failed",
	});
	return {
		provider: request.provider,
		backend,
		session: request.session,
		cwd: request.cwd,
		events,
		text: "",
		exitCode: send.exitCode,
		success,
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
