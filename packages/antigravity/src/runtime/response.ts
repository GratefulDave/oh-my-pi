export const THINKING_RECOVERY_NEEDED = "THINKING_RECOVERY_NEEDED";

export interface AntigravityResponseContext {
	requestedModel?: string;
	effectiveModel?: string;
	projectId?: string;
	endpoint?: string;
	sessionId?: string;
}

export async function transformAntigravityResponse(
	response: Response,
	streaming: boolean,
	context: AntigravityResponseContext = {},
): Promise<Response> {
	const contentType = response.headers.get("content-type") ?? "";
	const isJson = contentType.includes("application/json");
	const isEventStream = contentType.includes("text/event-stream");
	if (streaming && response.ok && isEventStream && response.body) {
		return new Response(transformAntigravitySseBody(response.body), {
			status: response.status,
			statusText: response.statusText,
			headers: new Headers(response.headers),
		});
	}
	if (!isJson && !isEventStream) return response;
	try {
		const headers = new Headers(response.headers);
		const text = await response.text();
		if (!response.ok) return transformErrorResponse(response, headers, text, context);

		const usageFromSse = streaming && isEventStream ? extractUsageFromSsePayload(text) : null;
		const parsed = !streaming || !isEventStream ? parseJson(text) : null;
		const body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
		const usage = usageFromSse ?? (body ? extractUsageMetadata(body) : null);
		setUsageHeaders(headers, usage);
		const init = { status: response.status, statusText: response.statusText, headers };
		if (body && "response" in body) return new Response(JSON.stringify(body.response), init);
		return new Response(text, init);
	} catch (error) {
		if (error instanceof Error && error.message === THINKING_RECOVERY_NEEDED) throw error;
		return response;
	}
}

function transformAntigravitySseBody(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let pending = "";
	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				pending += decoder.decode(chunk, { stream: true });
				let newline = pending.indexOf("\n");
				while (newline >= 0) {
					const line = pending.slice(0, newline);
					pending = pending.slice(newline + 1);
					controller.enqueue(encoder.encode(`${transformSseLine(line)}\n`));
					newline = pending.indexOf("\n");
				}
			},
			flush(controller) {
				const tail = pending + decoder.decode();
				if (tail.length > 0) controller.enqueue(encoder.encode(transformSseLine(tail)));
			},
		}),
	);
}

function transformSseLine(line: string): string {
	const data = line.startsWith("data:") ? line.slice(5).trim() : "";
	if (data.length === 0 || data === "[DONE]") return line;
	const parsed = parseJson(data);
	if (!parsed || typeof parsed !== "object") return line;
	const response = (parsed as Record<string, unknown>).response;
	return response && typeof response === "object" ? `data: ${JSON.stringify(response)}` : line;
}

function transformErrorResponse(
	response: Response,
	headers: Headers,
	text: string,
	context: AntigravityResponseContext,
): Response {
	const parsed = parseJson(text);
	const body =
		parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : { error: { message: text } };
	const error = body.error;
	if (error && typeof error === "object") {
		const errorRecord = error as Record<string, unknown>;
		const raw =
			typeof errorRecord.message === "string" && errorRecord.message.length > 0
				? errorRecord.message
				: "Unknown error";
		errorRecord.message = `${raw}\n\n[Debug Info]\nRequested Model: ${context.requestedModel ?? "Unknown"}\nEffective Model: ${context.effectiveModel ?? "Unknown"}\nProject: ${context.projectId ?? "Unknown"}\nEndpoint: ${context.endpoint ?? "Unknown"}\nStatus: ${response.status}\nRequest ID: ${headers.get("x-request-id") ?? "N/A"}`;
		const lower = String(errorRecord.message).toLowerCase();
		if (lower.includes("thinking_block_order")) throw new Error(THINKING_RECOVERY_NEEDED);
		if (
			lower.includes("prompt is too long") ||
			lower.includes("context length exceeded") ||
			lower.includes("context_length_exceeded") ||
			lower.includes("maximum context length")
		) {
			headers.set("x-antigravity-context-error", "prompt_too_long");
		}
		if (
			lower.includes("tool_use") &&
			lower.includes("tool_result") &&
			(lower.includes("without") || lower.includes("immediately after"))
		) {
			headers.set("x-antigravity-context-error", "tool_pairing");
		}
	}
	applyRetryHeaders(headers, body);
	return new Response(JSON.stringify(body), { status: response.status, statusText: response.statusText, headers });
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function applyRetryHeaders(headers: Headers, body: Record<string, unknown>): void {
	const error = body.error;
	if (!error || typeof error !== "object") return;
	const details = (error as Record<string, unknown>).details;
	if (!Array.isArray(details)) return;
	const retryInfo = details.find(detail => {
		if (!detail || typeof detail !== "object") return false;
		return (detail as Record<string, unknown>)["@type"] === "type.googleapis.com/google.rpc.RetryInfo";
	});
	if (!retryInfo || typeof retryInfo !== "object") return;
	const retryDelay = (retryInfo as Record<string, unknown>).retryDelay;
	if (typeof retryDelay !== "string") return;
	const seconds = Number.parseFloat(retryDelay.match(/^([\d.]+)s$/)?.[1] ?? "");
	if (!Number.isFinite(seconds) || seconds <= 0) return;
	headers.set("Retry-After", Math.ceil(seconds).toString());
	headers.set("retry-after-ms", Math.ceil(seconds * 1000).toString());
}

function extractUsageFromSsePayload(text: string): Record<string, unknown> | null {
	for (const line of text.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const parsed = parseJson(line.slice(5).trim());
		const body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
		const usage = body ? extractUsageMetadata(body) : null;
		if (usage) return usage;
	}
	return null;
}

function extractUsageMetadata(body: Record<string, unknown>): Record<string, unknown> | null {
	const direct = body.usageMetadata;
	if (direct && typeof direct === "object") return direct as Record<string, unknown>;
	const response = body.response;
	if (response && typeof response === "object") {
		const nested = (response as Record<string, unknown>).usageMetadata;
		if (nested && typeof nested === "object") return nested as Record<string, unknown>;
	}
	return null;
}

function setUsageHeaders(headers: Headers, usage: Record<string, unknown> | null): void {
	if (!usage) return;
	for (const [field, header] of [
		["cachedContentTokenCount", "x-antigravity-cached-content-token-count"],
		["totalTokenCount", "x-antigravity-total-token-count"],
		["promptTokenCount", "x-antigravity-prompt-token-count"],
		["candidatesTokenCount", "x-antigravity-candidates-token-count"],
	] as const) {
		const value = usage[field];
		if (typeof value === "number") headers.set(header, String(value));
	}
}
