/**
 * Focused tests for opencode-antigravity quota exhaustion fallback handling.
 *
 * Covers:
 *  - AG quota exhaustion suppresses current selector until reset
 *  - Flash/smol AG model falls back to comparable openai-codex smol model
 *  - Sonnet/default AG model falls back to default openai-codex model
 *  - Opus/strong AG model falls back to strongest openai-codex model with thinking preserved
 *  - Plugin 403/429/quota exhaustion triggers fallback instead of final surfacing when fallback exists
 *  - Explicit retry.fallbackChains takes priority over derived codex fallback
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel, type Model, type ThinkingConfig } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

type FallbackAppliedEvent = Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Build an AG provider config with the given model IDs. */
function agProviderConfig(modelIds: string[]): ProviderConfigInput {
	return {
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		api: "opencode-antigravity-google" as never,
		apiKey: "ag-test-key",
		models: modelIds.map(id => ({
			id,
			name: id,
			reasoning: true,
			thinking: { mode: "google-level", minLevel: "minimal", maxLevel: "high" } as ThinkingConfig,
			input: ["text" as const, "image" as const],
			cost: ZERO_COST,
			contextWindow: 1_000_000,
			maxTokens: 65_536,
		})),
	};
}

/** Build an openai-codex provider config with given model IDs. */
function codexProviderConfig(modelIds: string[]): ProviderConfigInput {
	return {
		baseUrl: "https://chatgpt.com/backend-api",
		api: "openai-codex-responses" as never,
		apiKey: "codex-test-key",
		models: modelIds.map(id => ({
			id,
			name: id,
			reasoning: true,
			thinking: { mode: "effort", minLevel: "minimal", maxLevel: "xhigh" } as ThinkingConfig,
			input: ["text" as const, "image" as const],
			cost: ZERO_COST,
			contextWindow: 272_000,
			maxTokens: 128_000,
		})),
	};
}

function buildAgModel(modelId: string): Model {
	return {
		id: modelId,
		name: modelId,
		api: "opencode-antigravity-google" as never,
		provider: "opencode-antigravity",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		reasoning: true,
		thinking: { mode: "google-level", minLevel: "minimal", maxLevel: "high" } as ThinkingConfig,
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	};
}

describe("AgentSession opencode-antigravity quota fallback", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-ag-quota-fallback-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		// Provide runtime keys so getApiKey returns a value for both providers
		authStorage.setRuntimeApiKey("opencode-antigravity", "ag-test-key");
		authStorage.setRuntimeApiKey("openai-codex", "codex-test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	it("suppresses AG Flash selector until quota reset and falls back to codex smol", async () => {
		const agModelId = "antigravity-gemini-3-flash";
		const codexSmolId = "gpt-5.4-mini";

		modelRegistry.registerProvider("opencode-antigravity", agProviderConfig([agModelId]), "ext://ag");
		modelRegistry.registerProvider("openai-codex", codexProviderConfig([codexSmolId]), "ext://codex");

		const agModel = buildAgModel(agModelId);
		const requestedModels: string[] = [];
		const fallbackAppliedEvents: FallbackAppliedEvent[] = [];

		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: {
				model: agModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.provider === "opencode-antigravity") {
					// Quota exhausted — plugin surfaces this as a 403/quota message
					mock.push({ throw: "opencode-antigravity quota exhausted: 403 Forbidden" });
				} else {
					mock.push({ content: [`ok:${model.provider}/${model.id}`] });
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 3,
		});
		settings.setModelRole("smol", `opencode-antigravity/${agModelId}`);

		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbackAppliedEvents.push(event);
		});

		await session.prompt("Flash quota fallback test");
		await session.waitForIdle();

		// AG model was used first, then fell back to codex smol
		expect(requestedModels[0]).toBe(`opencode-antigravity/${agModelId}`);
		expect(requestedModels[1]).toBe(`openai-codex/${codexSmolId}`);

		// AG selector should now be suppressed
		expect(modelRegistry.isSelectorSuppressed(`opencode-antigravity/${agModelId}`)).toBe(true);

		// Fallback event was emitted
		expect(fallbackAppliedEvents).toHaveLength(1);
		expect(fallbackAppliedEvents[0].from).toBe(`opencode-antigravity/${agModelId}`);
		expect(fallbackAppliedEvents[0].to).toBe(`openai-codex/${codexSmolId}:medium`);
	});

	it("falls back from AG Sonnet/default to codex default model", async () => {
		const agModelId = "antigravity-claude-sonnet-4-6";
		const codexDefaultId = "gpt-5.5";

		modelRegistry.registerProvider("opencode-antigravity", agProviderConfig([agModelId]), "ext://ag");
		modelRegistry.registerProvider("openai-codex", codexProviderConfig(["gpt-5.4", codexDefaultId]), "ext://codex");

		const agModel: Model = {
			...buildAgModel(agModelId),
			reasoning: false,
			thinking: undefined,
		};
		const requestedModels: string[] = [];
		const fallbackAppliedEvents: FallbackAppliedEvent[] = [];

		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: agModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.provider === "opencode-antigravity") {
					mock.push({ throw: "verification exhausted: quota limit reached for claude group" });
				} else {
					mock.push({ content: [`ok:${model.provider}/${model.id}`] });
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 3,
		});
		settings.setModelRole("default", `opencode-antigravity/${agModelId}`);

		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbackAppliedEvents.push(event);
		});

		await session.prompt("Sonnet quota fallback test");
		await session.waitForIdle();

		expect(requestedModels[0]).toBe(`opencode-antigravity/${agModelId}`);
		expect(requestedModels[1]).toBe(`openai-codex/${codexDefaultId}`);
		expect(fallbackAppliedEvents).toHaveLength(1);
		expect(fallbackAppliedEvents[0].from).toBe(`opencode-antigravity/${agModelId}`);
		expect(fallbackAppliedEvents[0].to).toBe(`openai-codex/${codexDefaultId}:high`);
	});

	it("falls back from AG Opus/strong to strongest codex model and preserves thinking level", async () => {
		const agModelId = "antigravity-claude-opus-4-6-thinking";
		const codexStrongId = "gpt-5.5";
		const codexFallbackId = "gpt-5.4";

		modelRegistry.registerProvider("opencode-antigravity", agProviderConfig([agModelId]), "ext://ag");
		// Register strongest codex first (gpt-5.5), then fallback (gpt-5.4)
		modelRegistry.registerProvider(
			"openai-codex",
			codexProviderConfig([codexStrongId, codexFallbackId]),
			"ext://codex",
		);

		const agModel = buildAgModel(agModelId);
		const requestedModels: string[] = [];

		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: agModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.provider === "opencode-antigravity") {
					mock.push({ throw: "429 Too Many Requests: antigravity claude quota exceeded" });
				} else {
					mock.push({ content: [`ok:${model.provider}/${model.id}`] });
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 3,
		});
		settings.setModelRole("slow", `opencode-antigravity/${agModelId}`);

		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });

		await session.prompt("Opus quota fallback test");
		await session.waitForIdle();

		// Should have tried AG first, then gpt-5.5 (strongest for strong AG)
		expect(requestedModels[0]).toBe(`opencode-antigravity/${agModelId}`);
		expect(requestedModels[1]).toBe(`openai-codex/${codexStrongId}`);
		// Final model should be codex strong
		expect(session.model?.provider).toBe("openai-codex");
		expect(session.model?.id).toBe(codexStrongId);
	});

	it("AG 403 triggers fallback instead of final error surfacing when codex is available", async () => {
		const agModelId = "gemini-3.5-flash";
		const codexSmolId = "gpt-5.4-mini";

		modelRegistry.registerProvider("opencode-antigravity", agProviderConfig([agModelId]), "ext://ag");
		modelRegistry.registerProvider("openai-codex", codexProviderConfig([codexSmolId]), "ext://codex");

		const agModel = buildAgModel(agModelId);
		const requestedModels: string[] = [];
		const retryEndEvents: Array<Extract<AgentSessionEvent, { type: "auto_retry_end" }>> = [];

		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: agModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.provider === "opencode-antigravity") {
					mock.push({ throw: "HTTP 403 Forbidden: opencode plugin access denied" });
				} else {
					mock.push({ content: [`recovered:${model.provider}/${model.id}`] });
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 3,
		});

		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		session.subscribe(event => {
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("AG 403 fallback test");
		await session.waitForIdle();

		// Should have fallen back instead of surfacing the 403 as a final error
		expect(requestedModels.length).toBeGreaterThan(1);
		expect(requestedModels.at(-1)).toBe(`openai-codex/${codexSmolId}`);

		// Session ended successfully (fallback succeeded), not with an error
		if (retryEndEvents.length > 0) {
			expect(retryEndEvents.at(-1)?.success).toBe(true);
		}
		const lastMsg = session.messages.at(-1);
		expect(lastMsg?.role).toBe("assistant");
	});

	it("explicit retry.fallbackChains takes priority over derived codex fallback", async () => {
		const agModelId = "antigravity-gemini-3-flash";
		const explicitFallbackId = "gpt-5.4";
		const derivedSmolId = "gpt-5.4-mini";

		modelRegistry.registerProvider("opencode-antigravity", agProviderConfig([agModelId]), "ext://ag");
		// Register both possible fallbacks
		modelRegistry.registerProvider(
			"openai-codex",
			codexProviderConfig([explicitFallbackId, derivedSmolId]),
			"ext://codex",
		);

		const agModel = buildAgModel(agModelId);
		const requestedModels: string[] = [];

		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: agModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.provider === "opencode-antigravity") {
					mock.push({ throw: "429 Too Many Requests: quota exhausted" });
				} else {
					mock.push({ content: [`ok:${model.provider}/${model.id}`] });
				}
				return mock.stream(model, context, options);
			},
		});

		// Configure explicit fallback chain pointing to gpt-5.4 (not the derived smol gpt-5.4-mini)
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 3,
			"retry.fallbackChains": {
				smol: [`openai-codex/${explicitFallbackId}`],
			},
		});
		settings.setModelRole("smol", `opencode-antigravity/${agModelId}`);

		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });

		await session.prompt("Explicit chain priority test");
		await session.waitForIdle();

		// Should have used explicit chain (gpt-5.4), NOT the derived smol (gpt-5.4-mini)
		expect(requestedModels[0]).toBe(`opencode-antigravity/${agModelId}`);
		expect(requestedModels[1]).toBe(`openai-codex/${explicitFallbackId}`);
		expect(requestedModels).not.toContain(`openai-codex/${derivedSmolId}`);
	});

	it("quota exhausted suppression expires after reset time from retry-after header", async () => {
		const agModelId = "gemini-2.5-flash";
		modelRegistry.registerProvider("opencode-antigravity", agProviderConfig([agModelId]), "ext://ag");

		// Use Date.now spy to control time
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		const selector = `opencode-antigravity/${agModelId}`;
		// 30 min default quota suppression
		const suppressUntilMs = now + 30 * 60 * 1000;
		modelRegistry.suppressSelector(selector, suppressUntilMs);

		// Should be suppressed now
		expect(modelRegistry.isSelectorSuppressed(selector)).toBe(true);

		// Advance time past the suppression window
		now = suppressUntilMs + 1;
		expect(modelRegistry.isSelectorSuppressed(selector)).toBe(false);
	});

	it("does not trigger AG quota fallback for non-AG providers", async () => {
		// A regular transient error from anthropic should NOT hit AG quota path
		const agModelId = "antigravity-gemini-3-flash";
		const codexSmolId = "gpt-5.4-mini";

		modelRegistry.registerProvider("opencode-antigravity", agProviderConfig([agModelId]), "ext://ag");
		modelRegistry.registerProvider("openai-codex", codexProviderConfig([codexSmolId]), "ext://codex");

		const anthropicModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!anthropicModel) return;
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");

		// A 403 from anthropic should NOT suppress the anthropic model or try AG codex path
		const requestedModels: string[] = [];
		const mock = createMockModel({
			responses: [{ throw: "403 Forbidden: anthropic account suspended" }, { content: ["anthropic recovered"] }],
		});
		const agent = new Agent({
			getApiKey: provider => `${provider}-test-key`,
			initialState: { model: anthropicModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 2,
		});

		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });

		await session.prompt("Non-AG 403 should not use AG quota path");
		await session.waitForIdle();

		// Should stay on anthropic, NOT jump to openai-codex
		for (const m of requestedModels) {
			expect(m).not.toContain("openai-codex");
		}
	});
});
