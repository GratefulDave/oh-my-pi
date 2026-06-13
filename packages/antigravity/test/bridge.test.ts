import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	AssistantMessageEventStream,
	Context,
	FetchImpl,
	OAuthCredentials,
	OAuthLoginCallbacks,
} from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import antigravityExtension from "../src/extension";
import { ANTIGRAVITY_API, ANTIGRAVITY_MODELS, GOOGLE_GENERATIVE_LANGUAGE_BASE, PROVIDER_ID } from "../src/models";
import {
	deserializeAntigravityCredentials,
	refreshAntigravityCredentials,
	serializeAntigravityCredentials,
} from "../src/runtime/credentials";
import { resolveModelForHeaderStyle } from "../src/runtime/model-resolver";
import { loginAntigravity } from "../src/runtime/oauth";
import { classifyQuotaGroup, fetchAntigravityModels, quotaExhaustionFromGroup } from "../src/runtime/quota";
import { prepareAntigravityRequest } from "../src/runtime/request";
import { transformAntigravityResponse } from "../src/runtime/response";
import { createAntigravityStream, type GoogleStream } from "../src/stream-adapter";

interface FetchCall {
	input: string;
	init?: RequestInit;
}

function credentials(overrides: Partial<OAuthCredentials> = {}): OAuthCredentials {
	return {
		refresh: "refresh|project-id|managed-project-id",
		access: "access",
		expires: Date.now() + 60_000,
		projectId: "project-id",
		...overrides,
	};
}

interface JsonResponseInit {
	status?: number;
	statusText?: string;
	headers?: Record<string, string>;
}

function jsonResponse(payload: unknown, init: JsonResponseInit = {}): Response {
	return new Response(JSON.stringify(payload), {
		status: init.status ?? 200,
		statusText: init.statusText,
		headers: { "content-type": "application/json", ...(init.headers ?? {}) },
	});
}

function callsFetcher(responses: Response[]): { calls: FetchCall[]; fetcher: FetchImpl } {
	const calls: FetchCall[] = [];
	return {
		calls,
		fetcher: async (input, init) => {
			calls.push({ input: String(input), init });
			const response = responses.shift();
			if (!response) throw new Error("unexpected fetch");
			return response;
		},
	};
}

async function sourceFiles(dir: string): Promise<string[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await sourceFiles(full)));
		else if (entry.isFile() && full.endsWith(".ts")) files.push(full);
	}
	return files;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Antigravity extension registration", () => {
	it("registers only the self-contained antigravity provider", async () => {
		const registered: Array<{ name: string; config: ProviderConfig }> = [];
		const pi = {
			setLabel: vi.fn(),
			registerProvider: (name: string, config: ProviderConfig) => registered.push({ name, config }),
		} as unknown as ExtensionAPI;

		await antigravityExtension(pi);
		expect(pi.setLabel).toHaveBeenCalledWith("Antigravity");
		expect(pi.setLabel).toHaveBeenCalledTimes(1);

		expect(registered.map(item => item.name)).toEqual(["antigravity"]);
		expect(registered.map(item => item.name)).not.toContain("opencode-antigravity");
		expect(registered.map(item => item.name)).not.toContain("google");
		expect(registered.map(item => item.name)).not.toContain("google-antigravity");
		const config = registered[0]?.config;
		expect(config?.api).toBe("antigravity-google");
		expect(typeof config?.streamSimple).toBe("function");
		expect(typeof config?.fetchDynamicModels).toBe("function");
		expect((config as unknown as { fetchModels?: unknown }).fetchModels).toBeUndefined();
	});

	it("forbids opencode and native provider coupling", async () => {
		const forbidden = [
			"opencode-antigravity-auth",
			'"opencode-antigravity"',
			"packages/ai/src/providers/google-gemini-cli",
			"registry/oauth/google-antigravity",
			'provider: "google-antigravity"',
		];
		for (const file of await sourceFiles(path.join(import.meta.dir, "../src"))) {
			const text = await Bun.file(file).text();
			for (const needle of forbidden) expect(text.includes(needle), `${file} contains ${needle}`).toBe(false);
		}
	});
});

describe("Antigravity model namespace", () => {
	it("publishes static bare ids under antigravity", () => {
		expect(PROVIDER_ID).toBe("antigravity");
		expect(ANTIGRAVITY_API).toBe("antigravity-google");
		for (const entry of ANTIGRAVITY_MODELS) {
			expect(entry.id.startsWith("antigravity-")).toBe(false);
		}
		const ids = ANTIGRAVITY_MODELS.map(entry => entry.id);
		expect(ids).toContain("gemini-3.5-flash-extra-low");
		expect(ids).toContain("gemini-3.5-flash-low");
		expect(ids).toContain("gemini-3-flash-agent");
		expect(ids).toContain("gemini-3.1-pro-low");
		expect(ids).toContain("gemini-pro-agent");
		expect(ids).toContain("claude-sonnet-4-6");
		expect(ids).toContain("claude-opus-4-6-thinking");
		expect(ids).toContain("gpt-oss-120b-medium");
		expect(ids).toContain("gemini-3.1-flash-lite");
		expect(ids).not.toContain("gemini-2.5-pro");
		expect(ids).not.toContain("gemini-3.5-flash");
		expect(ids).not.toContain("gemini-3.1-pro");
		expect(ids).not.toContain("claude-sonnet-4-6-thinking");
	});

	it("resolves visible selectors to Antigravity Cloud Code effective models", () => {
		expect(resolveModelForHeaderStyle("antigravity/gemini-3.5-flash-extra-low", "antigravity").actualModel).toBe(
			"gemini-3.5-flash-extra-low",
		);
		expect(resolveModelForHeaderStyle("antigravity/gemini-3.5-flash-low", "antigravity").actualModel).toBe(
			"gemini-3.5-flash-low",
		);
		expect(resolveModelForHeaderStyle("antigravity/gemini-3-flash-agent", "antigravity").actualModel).toBe(
			"gemini-3-flash-agent",
		);
		expect(resolveModelForHeaderStyle("antigravity/gemini-pro-agent", "antigravity").actualModel).toBe(
			"gemini-pro-agent",
		);
		expect(resolveModelForHeaderStyle("antigravity/claude-sonnet-4-6", "antigravity").actualModel).toBe(
			"claude-sonnet-4-6",
		);
	});

	it("uses captured Antigravity daily model-discovery endpoint", async () => {
		const modelEntry = {
			displayName: "Captured Model",
			supportsImages: true,
			supportsThinking: true,
			maxTokens: 123,
			maxOutputTokens: 45,
		};
		const { calls, fetcher } = callsFetcher([
			jsonResponse({
				models: {
					"antigravity-gemini-3.5-flash-extra-low": modelEntry,
					"antigravity-gemini-3.5-flash-low": modelEntry,
					"antigravity-gemini-3-flash-agent": modelEntry,
					"antigravity-gemini-3.1-pro-low": modelEntry,
					"antigravity-gemini-pro-agent": modelEntry,
					"antigravity-claude-sonnet-4-6": modelEntry,
					"antigravity-claude-opus-4-6-thinking": modelEntry,
					"antigravity-gpt-oss-120b-medium": { ...modelEntry, supportsImages: false },
					"antigravity-gemini-3.1-flash-lite": { ...modelEntry, supportsThinking: false },
					"antigravity-gemini-2.5-pro": modelEntry,
					"antigravity-gemini-3.1-pro-high": modelEntry,
					chat_20706: modelEntry,
					tab_flash_lite_preview: modelEntry,
					internal: { isInternal: true },
				},
			}),
		]);

		const models = await fetchAntigravityModels(serializeAntigravityCredentials(credentials()), fetcher);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.input).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels");
		const headers = new Headers(calls[0]?.init?.headers);
		expect(headers.get("x-goog-api-client")).toBeNull();
		expect(headers.get("User-Agent")).toBe("antigravity/cli/1.0.6 darwin/arm64");
		expect(headers.get("Authorization")).toStartWith("Bearer ");
		expect(calls[0]?.init?.body).toBe(JSON.stringify({ project: "managed-project-id" }));
		expect(models.map(model => model.id)).toEqual([
			"gemini-3.5-flash-extra-low",
			"gemini-3.5-flash-low",
			"gemini-3-flash-agent",
			"gemini-3.1-pro-low",
			"gemini-pro-agent",
			"claude-sonnet-4-6",
			"claude-opus-4-6-thinking",
			"gpt-oss-120b-medium",
			"gemini-3.1-flash-lite",
		]);
	});
});

describe("Antigravity OAuth and credentials", () => {
	it("generates Google OAuth URL and exchanges manual callback codes", async () => {
		let authUrl = "";
		const { calls, fetcher } = callsFetcher([
			jsonResponse({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 1800 }),
			jsonResponse({ email: "user@example.com", id: "acct" }),
			jsonResponse({ cloudaicompanionProject: { id: "project-123" } }),
		]);
		const callbacks: OAuthLoginCallbacks = {
			onAuth: info => {
				authUrl = info.url;
			},
			onPrompt: async () => "",
			onManualCodeInput: async () => "https://antigravity.google/oauth-callback?code=manual-code&state=ignored",
			fetch: fetcher,
		};

		const result = await loginAntigravity(callbacks);
		const url = new URL(authUrl);

		expect(url.host).toBe("accounts.google.com");
		expect(url.pathname).toBe("/o/oauth2/v2/auth");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("access_type")).toBe("offline");
		expect(url.searchParams.get("prompt")).toBe("consent");
		expect(url.searchParams.get("redirect_uri")).toBe("https://antigravity.google/oauth-callback");
		for (const scope of [
			"openid",
			"https://www.googleapis.com/auth/cloud-platform",
			"https://www.googleapis.com/auth/userinfo.email",
			"https://www.googleapis.com/auth/userinfo.profile",
			"https://www.googleapis.com/auth/cclog",
			"https://www.googleapis.com/auth/experimentsandconfigs",
		]) {
			expect(url.searchParams.get("scope")?.split(" ")).toContain(scope);
		}
		const tokenHeaders = new Headers(calls[0]?.init?.headers);
		expect(calls[0]?.input).toBe("https://oauth2.googleapis.com/token");
		expect(tokenHeaders.get("Content-Type")).toBe("application/x-www-form-urlencoded");
		expect(tokenHeaders.get("Accept")).toBeNull();
		expect(tokenHeaders.get("Accept-Encoding")).toBe("gzip");
		expect(tokenHeaders.get("User-Agent")).toBe("Go-http-client/2.0");
		const tokenBody = new URLSearchParams(String(calls[0]?.init?.body));
		expect(tokenBody.get("grant_type")).toBe("authorization_code");
		expect(tokenBody.get("code")).toBe("manual-code");
		expect(tokenBody.get("redirect_uri")).toBe("https://antigravity.google/oauth-callback");
		expect(tokenBody.get("code_verifier")?.length).toBeGreaterThan(20);
		expect(calls[1]?.input).toBe("https://www.googleapis.com/oauth2/v2/userinfo");
		const userInfoHeaders = new Headers(calls[1]?.init?.headers);
		expect(userInfoHeaders.get("User-Agent")).toBe("Go-http-client/2.0");
		expect(calls[2]?.input).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist");
		expect(calls[2]?.init?.body).toBe(JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }));
		const projectHeaders = new Headers(calls[2]?.init?.headers);
		expect(projectHeaders.get("User-Agent")).toBe("antigravity/cli/1.0.6 darwin/arm64");
		expect(result.refresh).toBe("refresh-token|project-123");
		expect(result.email).toBe("user@example.com");
	});

	it("serializes, rejects corrupt credentials, and refreshes while preserving project segments", async () => {
		const packed = serializeAntigravityCredentials(credentials());
		expect(deserializeAntigravityCredentials(packed).access).toBe("access");
		expect(() => deserializeAntigravityCredentials("antigravity:v1:%7Bbad")).toThrow("corrupt");
		const { calls, fetcher } = callsFetcher([jsonResponse({ access_token: "new-access", expires_in: 10 })]);

		const refreshed = await refreshAntigravityCredentials(credentials(), fetcher);

		expect(refreshed.access).toBe("new-access");
		expect(refreshed.refresh).toBe("refresh|project-id|managed-project-id");
		const body = new URLSearchParams(String(calls[0]?.init?.body));
		expect(body.get("grant_type")).toBe("refresh_token");
		expect(body.get("refresh_token")).toBe("refresh");
	});
});

describe("Antigravity request and response path", () => {
	it("rewrites Google stream requests with captured headers and wrapped body", async () => {
		const prepared = await prepareAntigravityRequest(
			"https://generativelanguage.googleapis.com/v1beta/models/claude-sonnet-4-6:streamGenerateContent?alt=sse",
			{
				method: "POST",
				headers: {
					"x-api-key": "placeholder",
					"x-goog-api-key": "placeholder",
					"x-goog-user-project": "wrong",
					"X-Goog-Api-Client": "wrong",
					"X-Cloudcode-User-Agent": "wrong",
					"X-Allowed-Feature-Ids": "wrong",
					"Client-Metadata": "wrong",
					Accept: "text/event-stream",
				},
				body: JSON.stringify({
					generationConfig: { thinkingConfig: { includeThoughts: true, thinkingBudget: 4000 } },
					tools: [
						{
							functionDeclarations: [
								{
									name: "run",
									parametersJsonSchema: { type: "object", properties: { ok: { type: "boolean" } } },
								},
							],
						},
					],
				}),
			},
			credentials({ refresh: "refresh|project-id" }),
		);

		expect(prepared.request).toBe("https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
		const headers = new Headers(prepared.init?.headers);
		expect(headers.get("Authorization")).toBe("Bearer access");
		expect(headers.get("Accept")).toBeNull();
		expect(headers.get("User-Agent")).toBe("antigravity/cli/1.0.6 darwin/arm64");
		expect(headers.has("X-Goog-Api-Client")).toBe(false);
		expect(headers.has("X-Cloudcode-User-Agent")).toBe(false);
		expect(headers.has("X-Allowed-Feature-Ids")).toBe(false);
		expect(headers.has("x-api-key")).toBe(false);
		expect(headers.has("x-goog-api-key")).toBe(false);
		expect(headers.has("x-goog-user-project")).toBe(false);
		expect(headers.has("Client-Metadata")).toBe(false);
		const body = JSON.parse(String(prepared.init?.body)) as Record<string, unknown>;
		expect(body.project).toBe("project-id");
		expect(body.model).toBe("claude-sonnet-4-6");
		expect(body.requestType).toBe("agent");
		expect(body.userAgent).toBe("antigravity");
		expect(String(body.requestId)).toStartWith("agent/");
		const request = body.request as Record<string, unknown>;
		expect(request.sessionId).toBeString();
		expect((request.generationConfig as Record<string, unknown> | undefined)?.thinkingConfig).toEqual({
			includeThoughts: true,
			thinkingBudget: 4000,
		});
		const tools = request.tools as Array<{ functionDeclarations: Array<Record<string, unknown>> }>;
		expect(tools[0]?.functionDeclarations[0]?.parameters).toBeDefined();
		expect(tools[0]?.functionDeclarations[0]?.parametersJsonSchema).toBeUndefined();
	});

	it("annotates Antigravity errors with context and retry headers", async () => {
		const response = jsonResponse(
			{
				error: {
					message: "prompt is too long",
					details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "1.2s" }],
				},
			},
			{ status: 429, statusText: "Too Many Requests", headers: { "x-request-id": "rid" } },
		);

		const transformed = await transformAntigravityResponse(response, false, {
			requestedModel: "gemini-pro-agent",
			effectiveModel: "gemini-pro-agent",
			projectId: "project-id",
			endpoint: "endpoint",
		});
		const body = (await transformed.json()) as { error: { message: string } };

		expect(transformed.headers.get("x-antigravity-context-error")).toBe("prompt_too_long");
		expect(transformed.headers.get("Retry-After")).toBe("2");
		expect(transformed.headers.get("retry-after-ms")).toBe("1200");
		expect(body.error.message).toContain("Requested Model: gemini-pro-agent");
		expect(body.error.message).toContain("Request ID: rid");
	});

	it("unwraps Cloud Code streaming envelopes for Google stream parser", async () => {
		const response = new Response(
			'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}],"usageMetadata":{"totalTokenCount":2}}}\n\n',
			{ headers: { "content-type": "text/event-stream" } },
		);

		const transformed = await transformAntigravityResponse(response, true);
		const text = await transformed.text();

		expect(text).toContain('data: {"candidates"');
		expect(text).toContain('"finishReason":"STOP"');
		expect(text).not.toContain('"response":');
	});
	it("matches captured Antigravity Cloud Code request contract", async () => {
		const serializedCredentials = serializeAntigravityCredentials(credentials());
		const prepared = await prepareAntigravityRequest(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-pro-agent:streamGenerateContent?alt=sse",
			{
				method: "POST",
				headers: {
					"x-goog-api-key": "stale-key",
					"x-goog-user-project": "stale-project",
					"Client-Metadata": "stale-metadata",
				},
				body: JSON.stringify({
					contents: [{ role: "user", parts: [{ text: "hello" }] }],
					generationConfig: {
						maxOutputTokens: 8,
						thinkingConfig: { includeThoughts: true, thinkingBudget: 10000 },
					},
				}),
			},
			deserializeAntigravityCredentials(serializedCredentials),
		);

		expect(prepared.request).toBe("https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
		const headers = new Headers(prepared.init?.headers);
		expect(headers.get("Authorization")).toBe("Bearer access");
		expect(headers.has("x-goog-api-key")).toBe(false);
		expect(headers.has("x-goog-user-project")).toBe(false);
		expect(headers.has("Client-Metadata")).toBe(false);
		expect(headers.has("Accept")).toBe(false);
		expect(headers.has("X-Goog-Api-Client")).toBe(false);
		expect(headers.has("X-Cloudcode-User-Agent")).toBe(false);
		expect(headers.has("X-Allowed-Feature-Ids")).toBe(false);
		expect(headers.get("User-Agent")).toBe("antigravity/cli/1.0.6 darwin/arm64");

		const body = JSON.parse(String(prepared.init?.body)) as {
			project?: unknown;
			model?: unknown;
			request?: { contents?: unknown; generationConfig?: unknown };
			requestType?: unknown;
			userAgent?: unknown;
			requestId?: unknown;
		};
		expect(body.project).toBe("managed-project-id");
		expect(body.model).toBe("gemini-pro-agent");
		expect(body.request?.contents).toEqual([{ role: "user", parts: [{ text: "hello" }] }]);
		expect(body.request?.generationConfig).toEqual({
			maxOutputTokens: 8,
			thinkingConfig: { includeThoughts: true, thinkingBudget: 10000 },
		});
		expect(body.requestType).toBe("agent");
		expect(body.userAgent).toBe("antigravity");
		expect(String(body.requestId)).toStartWith("agent/");
	});

	it("streamSimple bridge hits Cloud Code endpoint through injected fetch", async () => {
		const fetchResult = Promise.withResolvers<Response>();
		const googleStream: GoogleStream = (_model, _context, options) => {
			const upstreamFetch = options.fetch;
			if (!upstreamFetch) {
				fetchResult.reject(new Error("missing injected fetch"));
			} else {
				void upstreamFetch(
					"https://generativelanguage.googleapis.com/v1beta/models/claude-sonnet-4-6:streamGenerateContent?alt=sse",
					{
						method: "POST",
						headers: { "x-goog-api-key": "stale-key", "Client-Metadata": "stale-metadata" },
						body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hello" }] }] }),
					},
				).then(fetchResult.resolve, fetchResult.reject);
			}
			return {} as AssistantMessageEventStream;
		};
		const { calls, fetcher } = callsFetcher([
			new Response('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n', {
				headers: { "content-type": "text/event-stream" },
			}),
		]);
		const stream = createAntigravityStream(googleStream, fetcher);
		const model = buildModel({
			id: "claude-sonnet-4-6",
			name: "Claude Sonnet 4.6",
			api: ANTIGRAVITY_API,
			provider: PROVIDER_ID,
			baseUrl: GOOGLE_GENERATIVE_LANGUAGE_BASE,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 65_536,
		});

		stream(model, { messages: [] } as unknown as Context, {
			apiKey: serializeAntigravityCredentials(credentials()),
		});
		await fetchResult.promise;

		expect(calls).toHaveLength(1);
		expect(calls[0]?.input).toBe("https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
		expect(calls[0]?.input).not.toContain("generativelanguage.googleapis.com");
		const headers = new Headers(calls[0]?.init?.headers);
		expect(headers.get("User-Agent")).toBe("antigravity/cli/1.0.6 darwin/arm64");
		expect(headers.has("X-Goog-Api-Client")).toBe(false);
		expect(headers.has("X-Cloudcode-User-Agent")).toBe(false);
		expect(headers.has("X-Allowed-Feature-Ids")).toBe(false);
	});
});

describe("Antigravity quota helpers", () => {
	it("classifies quota groups and reports only currently exhausted groups", () => {
		expect(classifyQuotaGroup("claude-sonnet-4-6")).toBe("claude");
		expect(classifyQuotaGroup("gemini-3-flash-agent")).toBe("gemini-flash");
		expect(classifyQuotaGroup("gemini-pro-agent")).toBe("gemini-pro");
		expect(classifyQuotaGroup("gemini-2.5-flash")).toBeNull();
		const resetTime = new Date(Date.now() + 60_000).toISOString();
		expect(quotaExhaustionFromGroup("gemini-pro-agent", { remainingFraction: 0, resetTime })?.quotaGroup).toBe(
			"gemini-pro",
		);
		expect(quotaExhaustionFromGroup("gemini-pro-agent", { remainingFraction: 0.1, resetTime })).toBeNull();
	});
});
