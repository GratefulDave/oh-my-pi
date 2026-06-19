import { afterEach, describe, expect, it, vi } from "bun:test";
import * as upstreamPlugin from "opencode-antigravity-auth";
import type { PluginResult } from "opencode-antigravity-auth/dist/src/plugin/types";
import type { streamGoogle } from "../../ai/src/providers/google";
import type { OAuthCredentials } from "../../ai/src/registry/oauth/types";
import type { AssistantMessage, Context, Model } from "../../ai/src/types";
import { AssistantMessageEventStream } from "../../ai/src/utils/event-stream";
import { Effort } from "../../catalog/src/effort";
import type { ExtensionAPI, ProviderConfig } from "../../coding-agent/src/extensibility/extensions/types";
import { deserializeAgCredentials, fetchAgModels, serializeAgCredentials } from "../src/auth-adapter";
import agExtension from "../src/extension";
import { AG_API, AG_BASE_URL, AG_MODELS } from "../src/models";
import { createAgStream } from "../src/stream-adapter";

function createCredential(): OAuthCredentials {
	return {
		access: "access-token",
		refresh: "refresh-token|proj-123|managed-456",
		expires: Date.now() + 60_000,
		projectId: "proj-123",
		email: "user@example.com",
	};
}

function createContext(): Context {
	return { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
}

function createDoneMessage(modelId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "google-generative-ai",
		provider: "ag",
		model: modelId,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("AG auth adapter", () => {
	it("round-trips serialized OAuth credentials", () => {
		const credentials = createCredential();
		expect(deserializeAgCredentials(serializeAgCredentials(credentials))).toEqual(credentials);
	});

	it("maps discovered AG models to restored selectors", async () => {
		const fetcher = vi.fn(async () =>
			Response.json({
				models: {
					"gemini-3.5-flash": {
						displayName: "Gemini 3.5 Flash",
						supportsImages: true,
						supportsThinking: true,
						maxTokens: 1_048_576,
						maxOutputTokens: 65_536,
					},
					"claude-sonnet-4-6": {
						displayName: "Claude Sonnet 4.6",
						supportsImages: true,
						supportsThinking: false,
						maxTokens: 200_000,
						maxOutputTokens: 65_536,
					},
				},
			}),
		);

		const models = await fetchAgModels(serializeAgCredentials(createCredential()), fetcher);
		expect(fetcher).toHaveBeenCalledWith(
			"https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ project: "managed-456" }),
				headers: expect.objectContaining({
					Authorization: "Bearer access-token",
					"Content-Type": "application/json",
					"User-Agent": expect.stringContaining("Antigravity/"),
				}),
			}),
		);
		expect(models.map(model => model.id)).toEqual(expect.arrayContaining(["gemini-3.5-flash", "claude-sonnet-4-6"]));
	});
});

describe("AG stream adapter", () => {
	it("uses the upstream plugin fetch path and normalizes the forwarded request", async () => {
		let forwardedBody: Record<string, unknown> | undefined;
		let forwardedHeaders: Headers | undefined;
		let capturedModelId = "";
		const upstreamFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			forwardedHeaders = new Headers(init?.headers);
			forwardedBody =
				typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
			return Response.json({ ok: true });
		});
		const auth: PluginResult["auth"] = {
			provider: "google",
			methods: [],
			loader: async (_getAuth, _provider) => ({ apiKey: "upstream", fetch: upstreamFetch }),
		};
		const googleStream: typeof streamGoogle = (model, _context, options) => {
			capturedModelId = model.id;
			const stream = new AssistantMessageEventStream();
			void (async () => {
				await options?.fetch?.("https://example.test/stream", {
					method: "POST",
					headers: { "x-goog-api-key": "secret" },
					body: JSON.stringify({
						generationConfig: { thinkingConfig: { includeThoughts: true, thinkingLevel: "medium" } },
						tools: [
							{
								functionDeclarations: [
									{
										name: "read",
										parametersJsonSchema: {
											type: "object",
											properties: { path: { type: "string" } },
											required: ["path"],
										},
									},
								],
							},
						],
					}),
				});
				stream.push({ type: "done", reason: "stop", message: createDoneMessage(model.id) });
				stream.end();
			})();
			return stream;
		};

		const streamSimple = createAgStream(auth, googleStream);
		const model = AG_MODELS.find(entry => entry.id === "claude-sonnet-4-6");
		if (!model) throw new Error("Missing claude-sonnet-4-6 test model.");
		// Test fixture uses ProviderModelConfig; cast to runtime Model because compat is resolved during registry build, not in the static list.
		const runtimeModel = {
			...model,
			api: AG_API,
			provider: "ag",
			baseUrl: AG_BASE_URL,
		} as unknown as Model<typeof AG_API>;
		const result = await streamSimple(runtimeModel, createContext(), {
			apiKey: serializeAgCredentials(createCredential()),
			reasoning: Effort.Medium,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(capturedModelId).toBe("antigravity-claude-sonnet-4-6");
		expect(forwardedHeaders?.get("x-goog-api-key")).toBeNull();
		expect(JSON.stringify(forwardedBody)).not.toContain("thinkingConfig");
		expect(JSON.stringify(forwardedBody)).not.toContain("parametersJsonSchema");
		expect(JSON.stringify(forwardedBody)).toContain("parameters");
	});

	it("maps Gemini 3.5 Flash low effort to the upstream Antigravity low-tier id", async () => {
		let capturedModelId = "";
		const auth: PluginResult["auth"] = {
			provider: "google",
			methods: [],
			loader: async () => ({ apiKey: "upstream", fetch: async () => Response.json({ ok: true }) }),
		};
		const googleStream: typeof streamGoogle = (model, _context, _options) => {
			capturedModelId = model.id;
			const stream = new AssistantMessageEventStream();
			void (async () => {
				stream.push({ type: "done", reason: "stop", message: createDoneMessage(model.id) });
				stream.end();
			})();
			return stream;
		};

		const streamSimple = createAgStream(auth, googleStream);
		const model = AG_MODELS.find(entry => entry.id === "gemini-3.5-flash");
		if (!model) throw new Error("Missing gemini-3.5-flash test model.");
		const runtimeModel = {
			...model,
			api: AG_API,
			provider: "ag",
			baseUrl: AG_BASE_URL,
		} as unknown as Model<typeof AG_API>;
		const result = await streamSimple(runtimeModel, createContext(), {
			apiKey: serializeAgCredentials(createCredential()),
			reasoning: Effort.Low,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(capturedModelId).toBe("antigravity-gemini-3-flash-low");
		expect(capturedModelId).not.toContain("-low-low");
	});
});

describe("AG extension", () => {
	it("registers provider ag with upstream-backed stream config", async () => {
		const pluginResult: PluginResult = {
			auth: {
				provider: "google",
				methods: [
					{
						type: "oauth",
						label: "OAuth",
						authorize: async () => ({
							method: "code",
							url: "https://example.test/auth",
							instructions: "paste code",
							callback: async (_code: string) => ({
								type: "success",
								refresh: "refresh|proj|managed",
								access: "access",
								expires: Date.now() + 60_000,
								projectId: "proj",
							}),
						}),
					},
				],
				loader: async (_getAuth, _provider) => ({
					apiKey: "upstream",
					fetch: async () => Response.json({ ok: true }),
				}),
			},
		};
		vi.spyOn(upstreamPlugin, "AntigravityCLIOAuthPlugin").mockResolvedValue(pluginResult);
		const providers = new Map<string, ProviderConfig>();
		const pi = {
			setLabel: vi.fn(),
			logger: { debug: vi.fn() },
			registerProvider(providerId: string, config: ProviderConfig) {
				providers.set(providerId, config);
			},
		} as unknown as ExtensionAPI;

		await agExtension(pi);

		expect(pi.setLabel).toHaveBeenCalledWith("Antigravity (AG extension)");
		expect(providers.get("ag")).toEqual(
			expect.objectContaining({
				api: AG_API,
				baseUrl: AG_BASE_URL,
				models: AG_MODELS,
				oauth: expect.objectContaining({ name: "Antigravity (AG extension)" }),
			}),
		);
	});
});
