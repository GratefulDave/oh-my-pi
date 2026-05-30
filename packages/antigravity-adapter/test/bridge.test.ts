import { describe, expect, it } from "bun:test";
import type { Api, Context, Model } from "@oh-my-pi/pi-ai";
import type { OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/utils/oauth/types";
import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import type { AuthMethod, PluginResult } from "opencode-antigravity-auth/dist/src/plugin/types";
import {
	deserializeBridgeCredentials,
	findUpstreamOAuthMethod,
	loginWithUpstreamOAuth,
	serializeBridgeCredentials,
	toOAuthCredentials,
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
	it("registers only the opencode-antigravity provider namespace", async () => {
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
		expect(typeof registered[0].config.oauth?.login).toBe("function");
	});
});
