/**
 * Regression: subagents must inherit async-registered extension providers.
 *
 * An extension can register a provider AFTER an `await` in its default function
 * (e.g. an OAuth bridge that resolves credentials before calling
 * `pi.registerProvider`). That registration lands on the shared ModelRegistry as a
 * runtime overlay + a global custom streaming API keyed by `api`/sourceId.
 *
 * When a subagent session is created, sdk.ts calls
 * `modelRegistry.syncExtensionSources(activeExtensionSources)`, which PRUNES any
 * registered provider source that is not in the active set. If the spawn path does
 * not forward the parent's already-loaded extensions (preloadedExtensions), the
 * subagent re-discovers extensions; a provider whose source is not re-discovered
 * (e.g. a bundled-binary extension) is pruned from the shared registry, and its
 * model then resolves to the bare baseUrl without the plugin fetch closure — an
 * HTTP 404 at first model call.
 *
 * These tests lock the AG-agnostic invariant: forwarding the parent's active
 * sources (what preloadedExtensions enables) keeps the provider + its custom API
 * intact; dropping them loses both. No live provider API is contacted.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type AssistantMessageEventStream, clearCustomApis, getCustomApi } from "@oh-my-pi/pi-ai";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { Snowflake } from "@oh-my-pi/pi-utils";

describe("subagent provider inheritance (async-registered extension providers)", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;

	// Mirrors how an OAuth bridge extension registers itself: source id == extension path.
	const extensionSourceId = "ext://bundled-async-provider";
	const customApiId = "subagent-inherit-custom-api";

	const baseModel: NonNullable<ProviderConfigInput["models"]>[number] = {
		id: "async-model",
		name: "Async Model",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};

	// Closure stands in for the plugin fetch loader (fingerprint headers) the real
	// bridge captures; the test only asserts the closure survives, never calls it.
	const streamSimple: NonNullable<ProviderConfigInput["streamSimple"]> = () =>
		({}) as unknown as AssistantMessageEventStream;

	function buildAsyncProviderConfig(): ProviderConfigInput {
		return {
			baseUrl: "https://bridge.example.com/v1",
			apiKey: "ASYNC_KEY",
			api: customApiId,
			streamSimple,
			models: [baseModel],
		};
	}

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-subagent-provider-inherit-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
	});

	afterEach(() => {
		clearCustomApis();
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("provider + custom streaming API survive when parent active sources are propagated (preloadedExtensions path)", () => {
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		registry.registerProvider("async-bridge", buildAsyncProviderConfig(), extensionSourceId);

		// Parent registered the provider: overlay + global custom API present.
		expect(registry.find("async-bridge", "async-model")).toBeDefined();
		expect(getCustomApi(customApiId)).toBeDefined();

		// Subagent createAgentSession syncs sources from the parent's loaded extensions.
		// preloadedExtensions forwards the bridge extension path, so its source stays active.
		registry.syncExtensionSources([extensionSourceId]);

		// Provider + plugin-fetch custom API must remain — no 404 on first model call.
		expect(registry.find("async-bridge", "async-model")).toBeDefined();
		expect(getCustomApi(customApiId)).toBeDefined();
	});

	test("provider + custom streaming API are pruned when active sources are dropped (pre-fix re-discovery path)", () => {
		const registry = new ModelRegistry(authStorage, modelsJsonPath);
		registry.registerProvider("async-bridge", buildAsyncProviderConfig(), extensionSourceId);

		expect(registry.find("async-bridge", "async-model")).toBeDefined();
		expect(getCustomApi(customApiId)).toBeDefined();

		// Reproduces the bug: subagent re-discovers extensions and the bundled async
		// provider's source is absent from the active set, so syncExtensionSources prunes it.
		registry.syncExtensionSources([]);

		// Demonstrates the failure mode the fix prevents: overlay + custom API gone,
		// so the model id would resolve to the bare baseUrl (HTTP 404).
		expect(registry.find("async-bridge", "async-model")).toBeUndefined();
		expect(getCustomApi(customApiId)).toBeUndefined();
	});
});
