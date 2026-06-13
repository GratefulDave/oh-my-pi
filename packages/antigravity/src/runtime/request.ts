import type { OAuthCredentials } from "@oh-my-pi/pi-ai";
import { isJsonObject, type JsonObject, normalizeSchemaForCCA } from "@oh-my-pi/pi-ai/utils/schema";
import {
	ANTIGRAVITY_CONTENT_HEADERS,
	ANTIGRAVITY_DEFAULT_PROJECT_ID,
	ANTIGRAVITY_ENDPOINT_PROD,
	ANTIGRAVITY_SYSTEM_INSTRUCTION,
	GEMINI_CLI_HEADERS,
} from "./constants";
import { parseRefreshParts } from "./credentials";
import { type AntigravityHeaderStyle, resolveModelForHeaderStyle } from "./model-resolver";

export interface PreparedAntigravityRequest {
	request: string | URL | Request;
	init?: RequestInit;
	streaming: boolean;
	requestedModel?: string;
	effectiveModel?: string;
	projectId?: string;
	endpoint?: string;
	sessionId?: string;
	headerStyle: AntigravityHeaderStyle;
}

export interface PrepareAntigravityRequestOptions {
	headerStyle?: AntigravityHeaderStyle;
	endpoint?: string;
	forceThinkingRecovery?: boolean;
}

const STREAM_ACTION = "streamGenerateContent";
const INT63_MASK = 0x7fff_ffff_ffff_ffffn;
const ANTIGRAVITY_RANDOM_BOUND = 9_000_000_000_000_000_000n;

export function isGenerativeLanguageRequest(input: string): boolean {
	return input.includes("generativelanguage.googleapis.com") || /\/models\/[^/:]+:\w+/.test(input);
}

export async function prepareAntigravityRequest(
	input: string | URL | Request,
	init: RequestInit | undefined,
	credentials: OAuthCredentials,
	options: PrepareAntigravityRequestOptions = {},
): Promise<PreparedAntigravityRequest> {
	const [url, baseInit] = await inputToUrlAndInit(input, init);
	const headers = new Headers(baseInit?.headers ?? {});
	const headerStyle = options.headerStyle ?? "antigravity";
	if (!isGenerativeLanguageRequest(url))
		return { request: url, init: { ...baseInit, headers }, streaming: false, headerStyle };

	headers.set("Authorization", `Bearer ${credentials.access}`);
	headers.delete("x-api-key");
	headers.delete("x-goog-api-key");
	headers.delete("x-goog-user-project");

	const match = url.match(/\/models\/([^:]+):(\w+)/);
	if (!match) return { request: url, init: { ...baseInit, headers }, streaming: false, headerStyle };
	const [, requestedModel = "", action = ""] = match;
	const resolved = resolveModelForHeaderStyle(requestedModel, headerStyle);
	const streaming = action === STREAM_ACTION;
	const endpoint = `${options.endpoint ?? ANTIGRAVITY_ENDPOINT_PROD}/v1internal:${action}${streaming ? "?alt=sse" : ""}`;
	const refreshParts = parseRefreshParts(credentials.refresh);
	const projectId =
		refreshParts.managedProjectId ||
		refreshParts.projectId ||
		credentials.projectId ||
		ANTIGRAVITY_DEFAULT_PROJECT_ID;
	let body = baseInit?.body;
	let sessionId: string | undefined;

	if (typeof body === "string" && body.length > 0) {
		const parsed = parseJsonObject(body);
		if (parsed) {
			const wrapped = typeof parsed.project === "string" && "request" in parsed;
			if (wrapped) {
				parsed.model = resolved.actualModel;
				const request = parsed.request;
				if (isJsonObject(request)) {
					sessionId = deriveAntigravitySessionId(JSON.stringify(request));
					request.sessionId = sessionId;
				}
				body = JSON.stringify(parsed);
			} else {
				normalizeToolSchemas(parsed);
				delete parsed.model;
				ensureAntigravitySystemInstruction(parsed);
				sessionId = deriveAntigravitySessionId(body);
				parsed.sessionId = sessionId;
				body = JSON.stringify({
					project: projectId,
					model: resolved.actualModel,
					request: parsed,
					requestType: "agent",
					userAgent: "antigravity",
					requestId: `agent/${crypto.randomUUID()}/${Date.now()}/${crypto.randomUUID()}/1`,
				});
			}
		}
	}

	if (streaming && headerStyle !== "antigravity") headers.set("Accept", "text/event-stream");
	if (
		resolved.actualModel.toLowerCase().includes("claude") &&
		resolved.actualModel.toLowerCase().includes("thinking")
	) {
		const current = headers.get("anthropic-beta");
		headers.set(
			"anthropic-beta",
			current ? `${current},interleaved-thinking-2025-05-14` : "interleaved-thinking-2025-05-14",
		);
	}
	if (headerStyle === "antigravity") {
		for (const [name, value] of Object.entries(ANTIGRAVITY_CONTENT_HEADERS)) {
			headers.set(name, value);
		}
		headers.delete("Accept");
		headers.delete("Client-Metadata");
		headers.delete("X-Goog-Api-Client");
		headers.delete("X-Cloudcode-User-Agent");
		headers.delete("X-Allowed-Feature-Ids");
	} else {
		headers.set("User-Agent", GEMINI_CLI_HEADERS["User-Agent"]);
		headers.set("X-Goog-Api-Client", GEMINI_CLI_HEADERS["X-Goog-Api-Client"]);
		headers.set("Client-Metadata", GEMINI_CLI_HEADERS["Client-Metadata"]);
	}

	return {
		request: endpoint,
		init: { ...baseInit, headers, body },
		streaming,
		requestedModel,
		effectiveModel: resolved.actualModel,
		projectId,
		endpoint,
		...(sessionId ? { sessionId } : {}),
		headerStyle,
	};
}

export function normalizeBodyForAntigravity(init?: RequestInit): RequestInit | undefined {
	if (!init?.body || typeof init.body !== "string") return init;
	const body = parseJsonObject(init.body);
	if (!body) return init;
	const changed = normalizeToolSchemas(body);
	return changed ? { ...init, body: JSON.stringify(body) } : init;
}

async function inputToUrlAndInit(
	input: string | URL | Request,
	init: RequestInit | undefined,
): Promise<[string, RequestInit | undefined]> {
	if (input instanceof Request) {
		const headers = new Headers(init?.headers ?? input.headers);
		headers.delete("x-api-key");
		headers.delete("x-goog-api-key");
		headers.delete("x-goog-user-project");
		const nextInit: RequestInit = {
			...init,
			method: init?.method ?? input.method,
			headers,
			signal: init?.signal ?? input.signal,
		};
		if (!init?.body && input.body && input.method !== "GET" && input.method !== "HEAD")
			nextInit.body = await input.text();
		return [input.url, nextInit];
	}
	return [String(input), stripApiKeyFromInit(init)];
}

function stripApiKeyFromInit(init: RequestInit | undefined): RequestInit | undefined {
	if (!init?.headers) return init;
	const headers = new Headers(init.headers);
	headers.delete("x-api-key");
	headers.delete("x-goog-api-key");
	headers.delete("x-goog-user-project");
	return { ...init, headers };
}

function parseJsonObject(text: string): JsonObject | null {
	try {
		const value = JSON.parse(text);
		return isJsonObject(value) ? value : null;
	} catch {
		return null;
	}
}

function normalizeToolSchemas(body: JsonObject): boolean {
	let changed = normalizeToolList(body.tools);
	const request = body.request;
	if (isJsonObject(request)) changed = normalizeToolList(request.tools) || changed;
	return changed;
}

function normalizeToolList(tools: unknown): boolean {
	if (!Array.isArray(tools)) return false;
	let changed = false;
	for (const tool of tools) {
		if (!isJsonObject(tool) || !Array.isArray(tool.functionDeclarations)) continue;
		for (const declaration of tool.functionDeclarations) {
			if (!isJsonObject(declaration) || !("parametersJsonSchema" in declaration)) continue;
			if (!("parameters" in declaration))
				declaration.parameters = normalizeSchemaForCCA(declaration.parametersJsonSchema);
			delete declaration.parametersJsonSchema;
			changed = true;
		}
	}
	return changed;
}

function ensureAntigravitySystemInstruction(requestPayload: JsonObject): void {
	const existing = requestPayload.systemInstruction;
	if (isJsonObject(existing)) {
		existing.role = "user";
		const parts = existing.parts;
		if (Array.isArray(parts) && parts.length > 0) {
			const firstPart = parts[0];
			if (isJsonObject(firstPart) && typeof firstPart.text === "string")
				firstPart.text = `${ANTIGRAVITY_SYSTEM_INSTRUCTION}\n\n${firstPart.text}`;
			else parts.unshift({ text: ANTIGRAVITY_SYSTEM_INSTRUCTION });
		} else {
			existing.parts = [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }];
		}
		return;
	}
	if (typeof existing === "string") {
		requestPayload.systemInstruction = {
			role: "user",
			parts: [{ text: `${ANTIGRAVITY_SYSTEM_INSTRUCTION}\n\n${existing}` }],
		};
		return;
	}
	requestPayload.systemInstruction = { role: "user", parts: [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }] };
}

function deriveAntigravitySessionId(seed: string): string {
	if (seed.trim().length === 0) return randomSignedDecimalSessionId();
	const digest = new Bun.CryptoHasher("sha256").update(seed).digest();
	let value = 0n;
	for (let index = 0; index < 8; index += 1) value = (value << 8n) | BigInt(digest[index] ?? 0);
	return `-${(value & INT63_MASK).toString()}`;
}

function randomSignedDecimalSessionId(): string {
	while (true) {
		const bytes = new Uint8Array(8);
		crypto.getRandomValues(bytes);
		let value = 0n;
		for (const byte of bytes) value = (value << 8n) | BigInt(byte);
		value &= INT63_MASK;
		if (value < ANTIGRAVITY_RANDOM_BOUND) return `-${value.toString()}`;
	}
}
