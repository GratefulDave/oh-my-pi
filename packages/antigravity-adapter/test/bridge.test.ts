import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, Context, Model, Tool } from "@oh-my-pi/pi-ai";
import type { OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/utils/oauth/types";
import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import type { AuthMethod, PluginResult } from "opencode-antigravity-auth/dist/src/plugin/types";
import {
	checkBridgeQuotaExhaustion,
	classifyQuotaGroup,
	deserializeBridgeCredentials,
	fetchBridgeModels,
	findUpstreamOAuthMethod,
	loginWithUpstreamOAuth,
	refreshBridgeCredentials,
	serializeBridgeCredentials,
	toOAuthCredentials,
	toPluginAccountMetadata,
} from "../src/auth-adapter";
import opencodeAntigravityBridge from "../src/extension";
import { BRIDGE_API, GOOGLE_GENERATIVE_LANGUAGE_BASE, OPENCODE_ANTIGRAVITY_MODELS, PROVIDER_ID } from "../src/models";
import { createBridgeFetch, createOpencodeAntigravityStream } from "../src/stream-adapter";

function callbacks(manualCode = "manual-code"): OAuthLoginCallbacks {
	return {
		onAuth: () => {},
		onPrompt: async () => "",
		onManualCodeInput: async () => manualCode,
	};
}

function model(id = "antigravity-gemini-3.1-pro"): Model<Api> {
	return {
		id,
		provider: PROVIDER_ID,
		api: BRIDGE_API,
		name: id,
		baseUrl: GOOGLE_GENERATIVE_LANGUAGE_BASE,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1024,
		maxTokens: 128,
	};
}

function context(): Context {
	return { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
}

/** Minimal no-op PluginClient — refreshAccessToken does not use the client at all. */
const noopClient = {} as Parameters<typeof refreshBridgeCredentials>[1];

afterEach(() => {
	vi.restoreAllMocks();
});

describe("OpenCode Antigravity auth adapter", () => {
	it("converts upstream OAuth success into OMP credentials and preserves packed refresh", () => {
		const credentials = toOAuthCredentials({
			type: "success",
			refresh: "refresh-token|project-id|managed-project-id",
			access: "access-token",
			expires: 123,
			email: "user@example.com",
			projectId: "project-id",
		});

		expect(credentials).toEqual({
			refresh: "refresh-token|project-id|managed-project-id",
			access: "access-token",
			expires: 123,
			email: "user@example.com",
			projectId: "project-id",
		});
		expect(deserializeBridgeCredentials(serializeBridgeCredentials(credentials))).toEqual(credentials);
	});

	it("refreshBridgeCredentials throws when refresh token segment is missing", async () => {
		// refreshAccessToken returns undefined when refreshToken segment is empty;
		// refreshBridgeCredentials must convert that to a thrown error.
		await expect(
			refreshBridgeCredentials(
				{ refresh: "|project-id|managed-project-id", access: "old-access", expires: 1 },
				noopClient,
			),
		).rejects.toThrow("missing a refresh token");
	});

	it("fetches dynamic bridge models from production endpoint only; never autopush or sandbox", async () => {
		const credentials = serializeBridgeCredentials({
			refresh: "refresh|project-id|managed-project-id",
			access: "access",
			expires: 123,
		});
		const requestedUrls: string[] = [];
		let requestedBody: unknown;

		const models = await fetchBridgeModels(credentials, async (_input, init) => {
			const url = _input.toString();
			requestedUrls.push(url);
			requestedBody = JSON.parse(String(init?.body));
			return Response.json({
				models: {
					"gemini-3.5-flash": {
						displayName: "Gemini 3.5 Flash",
						supportsImages: true,
						supportsThinking: true,
						maxTokens: 1048576,
						maxOutputTokens: 65536,
					},
				},
			});
		});

		expect(requestedUrls).toEqual(["https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels"]);
		expect(requestedUrls.some(u => u.includes("autopush"))).toBe(false);
		expect(requestedUrls.some(u => u.includes("sandbox"))).toBe(false);
		expect(requestedBody).toEqual({ project: "managed-project-id" });

		expect(models).toHaveLength(1);
		expect(models?.[0]).toMatchObject({
			id: "gemini-3.5-flash",
			provider: PROVIDER_ID,
			api: BRIDGE_API,
			baseUrl: GOOGLE_GENERATIVE_LANGUAGE_BASE,
		});
		expect((models ?? []).every(m => m.provider !== "google-antigravity")).toBe(true);
	});

	it("treats all-endpoint 4xx in model discovery as non-fatal; returns empty array", async () => {
		const credentials = serializeBridgeCredentials({ refresh: "refresh", access: "access", expires: 123 });

		const models = await fetchBridgeModels(credentials, async () => new Response("forbidden", { status: 403 }));

		expect(models).toEqual([]);
	});

	it("fetchBridgeModels filters out isInternal models", async () => {
		const credentials = serializeBridgeCredentials({ refresh: "refresh", access: "access", expires: 123 });
		let hitCount = 0;

		const models = await fetchBridgeModels(credentials, async input => {
			const url = input.toString();
			if (!url.includes("cloudcode-pa.googleapis.com") || url.includes("daily")) {
				return new Response("not found", { status: 404 });
			}
			hitCount++;
			return Response.json({
				models: {
					"public-model": { displayName: "Public", supportsImages: false, supportsThinking: false },
					"internal-model": { displayName: "Internal", isInternal: true },
				},
			});
		});

		expect(hitCount).toBe(1);
		expect(models).toHaveLength(1);
		expect(models?.[0]?.id).toBe("public-model");
	});

	it("uses the upstream code callback with OMP manual-code input", async () => {
		let receivedCode = "";
		const method = findUpstreamOAuthMethod([
			{
				type: "oauth",
				label: "OAuth",
				authorize: async () => ({
					url: "https://accounts.google.com/o/oauth2/v2/auth",
					instructions: "Paste code",
					method: "code",
					callback: async code => {
						receivedCode = code;
						return { type: "success", refresh: "refresh", access: "access", expires: 456, projectId: "" };
					},
				}),
			},
		]);

		const credentials = await loginWithUpstreamOAuth(method, callbacks("redirect-url-with-code"));

		expect(receivedCode).toBe("redirect-url-with-code");
		expect(credentials.refresh).toBe("refresh");
		expect(credentials.access).toBe("access");
		expect(credentials.expires).toBe(456);
	});

	it("surfaces upstream OAuth failure", async () => {
		const method = findUpstreamOAuthMethod([
			{
				type: "oauth",
				label: "OAuth",
				authorize: async () => ({
					url: "https://accounts.google.com/o/oauth2/v2/auth",
					instructions: "Sign in",
					method: "auto",
					callback: async () => ({ type: "failed", error: "denied" }),
				}),
			},
		]);

		await expect(loginWithUpstreamOAuth(method, callbacks())).rejects.toThrow("denied");
	});
});

describe("OpenCode Antigravity quota helpers", () => {
	it("toPluginAccountMetadata maps packed refresh credentials to AccountMetadataV3 shape", () => {
		const credentials = {
			refresh: "tok-refresh|my-project|my-managed-project",
			access: "acc",
			expires: 999,
			email: "dev@example.com",
		};
		const meta = toPluginAccountMetadata(credentials, 1_000);

		expect(meta.refreshToken).toBe("tok-refresh");
		expect(meta.projectId).toBe("my-project");
		expect(meta.managedProjectId).toBe("my-managed-project");
		expect(meta.email).toBe("dev@example.com");
		expect(meta.enabled).toBe(true);
		expect(meta.addedAt).toBe(1_000);
		expect(meta.lastUsed).toBe(1_000);
	});

	it("toPluginAccountMetadata handles missing optional segments gracefully", () => {
		const credentials = { refresh: "tok-only", access: "acc", expires: 1 };
		const meta = toPluginAccountMetadata(credentials);

		expect(meta.refreshToken).toBe("tok-only");
		expect(meta.projectId).toBeUndefined();
		expect(meta.managedProjectId).toBeUndefined();
		expect(meta.email).toBeUndefined();
	});

	it("toPluginAccountMetadata handles refresh with projectId but no managedProjectId", () => {
		const credentials = { refresh: "tok|proj|", access: "acc", expires: 1 };
		const meta = toPluginAccountMetadata(credentials);

		expect(meta.refreshToken).toBe("tok");
		expect(meta.projectId).toBe("proj");
		expect(meta.managedProjectId).toBeUndefined();
	});

	it("checkBridgeQuotaExhaustion uses plugin quota and returns reset metadata for exhausted group", async () => {
		const resetTime = new Date(Date.now() + 60_000).toISOString();
		const requestedUrls: string[] = [];
		const fetchMock = Object.assign(
			async (input: Parameters<typeof fetch>[0]) => {
				const url = input.toString();
				requestedUrls.push(url);
				if (url === "https://oauth2.googleapis.com/token") {
					return Response.json({ access_token: "fresh-access", expires_in: 3600 });
				}
				if (url === "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels") {
					return Response.json({
						models: {
							"gemini-3.5-flash": {
								displayName: "Gemini 3.5 Flash",
								quotaInfo: { remainingFraction: 0, resetTime },
							},
						},
					});
				}
				if (url === "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota") {
					return Response.json({ buckets: [] });
				}
				return new Response("unexpected", { status: 404 });
			},
			{ preconnect: () => {} },
		) satisfies typeof fetch;
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		const quota = await checkBridgeQuotaExhaustion(
			{ refresh: "refresh-token|project-id|managed-project-id", access: "stale-access", expires: 1 },
			"gemini-3.5-flash",
			noopClient,
		);

		expect(requestedUrls).toContain("https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels");
		expect(requestedUrls.some(url => url.includes("autopush"))).toBe(false);
		expect(quota).toMatchObject({
			quotaGroup: "gemini-flash",
			remainingFraction: 0,
			resetTime,
		});
		expect(quota?.resetMs).toBeGreaterThan(Date.now());
	});

	it("classifyQuotaGroup correctly classifies Claude models", () => {
		expect(classifyQuotaGroup("antigravity-claude-sonnet-4-6")).toBe("claude");
		expect(classifyQuotaGroup("antigravity-claude-opus-4-6-thinking")).toBe("claude");
		expect(classifyQuotaGroup("claude-3-5-sonnet")).toBe("claude");
	});

	it("classifyQuotaGroup correctly classifies Gemini 3 flash models", () => {
		expect(classifyQuotaGroup("antigravity-gemini-3.1-flash")).toBe("gemini-flash");
		expect(classifyQuotaGroup("gemini-3-flash")).toBe("gemini-flash");
		expect(classifyQuotaGroup("gemini-3.5-flash")).toBe("gemini-flash");
		expect(classifyQuotaGroup("gemini-3-flash-preview")).toBe("gemini-flash");
	});

	it("classifyQuotaGroup correctly classifies Gemini 3 pro models", () => {
		expect(classifyQuotaGroup("antigravity-gemini-3.1-pro")).toBe("gemini-pro");
		expect(classifyQuotaGroup("gemini-3-pro")).toBe("gemini-pro");
		expect(classifyQuotaGroup("gemini-3.1-pro-preview")).toBe("gemini-pro");
	});

	it("classifyQuotaGroup returns null for Gemini 2.x models (not an AG quota group)", () => {
		expect(classifyQuotaGroup("gemini-2.5-flash")).toBeNull();
		expect(classifyQuotaGroup("gemini-2.5-pro")).toBeNull();
		expect(classifyQuotaGroup("gemini-2.5-flash-lite")).toBeNull();
	});

	it("classifyQuotaGroup returns null for unrecognized model ids", () => {
		expect(classifyQuotaGroup("gpt-5")).toBeNull();
		expect(classifyQuotaGroup("openai-codex")).toBeNull();
	});
});

describe("OpenCode Antigravity fetch bridge", () => {
	it("strips OMP's placeholder Google API key and preserves abort signals", async () => {
		const controller = new AbortController();
		let sawSignal = false;
		let apiKeyHeader: string | null = "not-called";
		const fetch = createBridgeFetch(async (_input, init) => {
			sawSignal = init?.signal === controller.signal;
			apiKeyHeader = new Headers(init?.headers).get("x-goog-api-key");
			return new Response("{}", { status: 200 });
		});

		await fetch("https://generativelanguage.googleapis.com/v1beta/models/test:streamGenerateContent?alt=sse", {
			method: "POST",
			signal: controller.signal,
			headers: { "x-goog-api-key": "placeholder", accept: "text/event-stream" },
		});

		expect(sawSignal).toBe(true);
		expect(apiKeyHeader).toBeNull();
	});

	it("passes Request inputs to upstream plugin as URL strings so the plugin intercepts them", async () => {
		const controller = new AbortController();
		let requestedInput: string | URL | Request | undefined;
		let requestedBody = "";
		let apiKeyHeader: string | null = "not-called";
		let sawSignal = false;
		const fetch = createBridgeFetch(async (input, init) => {
			requestedInput = input;
			requestedBody = String(init?.body ?? "");
			apiKeyHeader = new Headers(init?.headers).get("x-goog-api-key");
			sawSignal = init?.signal === controller.signal;
			return new Response("{}", { status: 200 });
		});
		const request = new Request(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse",
			{
				method: "POST",
				signal: controller.signal,
				headers: { "x-goog-api-key": "placeholder", accept: "text/event-stream" },
				body: JSON.stringify({ contents: [] }),
			},
		);

		await fetch(request);

		expect(requestedInput).toBe(request.url);
		expect(requestedBody).toBe(JSON.stringify({ contents: [] }));
		expect(apiKeyHeader).toBeNull();
		expect(sawSignal).toBe(true);
	});

	it("rewrites Google parametersJsonSchema tools to legacy parameters before upstream fetch", async () => {
		const credentials = { refresh: "refresh", access: "access", expires: Date.now() + 60_000 };
		let requestedBody: unknown;
		const auth: PluginResult["auth"] = {
			provider: "google",
			methods: [] as AuthMethod[],
			loader: async () => ({
				apiKey: "",
				fetch: async (_input, init) => {
					requestedBody = JSON.parse(String(init?.body));
					return new Response(
						'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n',
						{ headers: { "content-type": "text/event-stream" } },
					);
				},
			}),
		};
		const tools: Tool[] = [
			{
				name: "bash",
				description: "Run bash",
				parameters: {
					type: "object",
					properties: {
						env: {
							type: "object",
							propertyNames: { type: "string", pattern: "^[A-Z_]+$" },
							additionalProperties: { type: "string" },
						},
					},
					required: ["env"],
					additionalProperties: false,
				},
			},
		];
		const streamSimple = createOpencodeAntigravityStream(auth);

		await streamSimple(
			model(),
			{ ...context(), tools },
			{
				apiKey: serializeBridgeCredentials(credentials),
			},
		).result();

		const body = requestedBody as { tools?: Array<{ functionDeclarations?: Array<Record<string, unknown>> }> };
		const declaration = body.tools?.[0]?.functionDeclarations?.[0];
		expect(declaration?.parametersJsonSchema).toBeUndefined();
		expect(declaration?.parameters).toBeDefined();
		expect(JSON.stringify(declaration?.parameters)).not.toContain("propertyNames");
	});

	it("routes OMP Google streaming through the upstream loader fetch", async () => {
		const credentials = { refresh: "refresh", access: "access", expires: Date.now() + 60_000 };
		let requestedUrl = "";
		let strippedHeader: string | null = "not-called";
		let upstreamAuthRefresh = "";
		const auth: PluginResult["auth"] = {
			provider: "google",
			methods: [] as AuthMethod[],
			loader: async (getAuth, provider) => {
				const upstreamAuth = await getAuth();
				if (upstreamAuth.type !== "oauth" || typeof upstreamAuth.refresh !== "string") {
					throw new Error("Expected OAuth upstream auth");
				}
				upstreamAuthRefresh = upstreamAuth.refresh;
				expect(provider.models?.[OPENCODE_ANTIGRAVITY_MODELS[0].id]).toBeDefined();
				return {
					apiKey: "",
					fetch: async (input, init) => {
						requestedUrl = input instanceof Request ? input.url : input.toString();
						strippedHeader = new Headers(init?.headers).get("x-goog-api-key");
						return new Response(
							'data: {"candidates":[{"content":{"parts":[{"text":"hello"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}\n\n',
							{ headers: { "content-type": "text/event-stream" } },
						);
					},
				};
			},
		};
		const streamSimple = createOpencodeAntigravityStream(auth);

		const result = await streamSimple(model(), context(), {
			apiKey: serializeBridgeCredentials(credentials),
		}).result();

		expect(requestedUrl).toContain(`${GOOGLE_GENERATIVE_LANGUAGE_BASE}/models/antigravity-gemini-3.1-pro`);
		expect(strippedHeader).toBeNull();
		expect(upstreamAuthRefresh).toBe("refresh");
		expect(result.content).toEqual([{ type: "text", text: "hello", textSignature: undefined }]);
	});
});

describe("OpenCode Antigravity extension registration", () => {
	it("registers only the opencode-antigravity provider namespace, never google or google-antigravity", async () => {
		const registered: Array<{ name: string; config: ProviderConfig }> = [];
		const pi = {
			setLabel: () => {},
			registerProvider: (name: string, config: ProviderConfig) => {
				registered.push({ name, config });
			},
			logger: {
				debug: () => {},
				warn: () => {},
				error: () => {},
			},
		} as unknown as ExtensionAPI;

		await opencodeAntigravityBridge(pi);

		expect(registered.map(entry => entry.name)).toEqual([PROVIDER_ID]);
		expect(registered[0].name).not.toBe("google");
		expect(registered[0].name).not.toBe("google-antigravity");
		expect(registered[0].config.models?.map(entry => entry.id)).toContain("antigravity-claude-sonnet-4-6");
		expect(registered[0].config.api).toBe(BRIDGE_API);
		expect(typeof registered[0].config.streamSimple).toBe("function");
		expect(typeof registered[0].config.fetchModels).toBe("function");
		expect(typeof registered[0].config.oauth?.login).toBe("function");
		expect(typeof registered[0].config.oauth?.refreshToken).toBe("function");
	});

	it("extension refreshToken uses plugin-compatible refresh (not google-antigravity native)", async () => {
		const registered: Array<{ name: string; config: ProviderConfig }> = [];
		const pi = {
			setLabel: () => {},
			registerProvider: (name: string, config: ProviderConfig) => {
				registered.push({ name, config });
			},
			logger: {
				debug: () => {},
				warn: () => {},
				error: () => {},
			},
		} as unknown as ExtensionAPI;

		await opencodeAntigravityBridge(pi);

		const config = registered[0]?.config;
		expect(config?.oauth?.refreshToken).toBeDefined();
		// Plugin refresh with empty refresh token segment must throw a meaningful error,
		// not silently return stale credentials (which the old no-op would do).
		await expect(
			config!.oauth!.refreshToken!({ refresh: "|proj|managed", access: "stale", expires: 1 }),
		).rejects.toThrow();
	});
});
